#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "matplotlib",
#     "numpy",
#     "tensorstore",
# ]
# ///
"""Generate src/webgl/colormaps.zarr/ as a Zarr v3 array from matplotlib.

The array has shape (N, 256, 3) uint8 where N is the number of colormaps
declared in NAMES below. Each slice colormaps[i, :, :] is the 256x3 RGB
LUT for the colormap whose name is `attributes["colormap_names"][i]`. The
order MUST match COLORMAP_BIN_NAMES in src/webgl/colormaps.ts.

The array uses the Zarr v3 `sharding_indexed` codec so all N logical
chunks (one per colormap, shape (1, 256, 3)) live in a single physical
shard file at c/0/0/0. The shard's trailing index makes per-colormap HTTP
Range fetches possible without downloading the full table.

Colormap-first ordering keeps each LUT's 768 bytes contiguous in C-order,
which matches the byte layout of the JS-side `getColormapBytes` accessor.

Re-run this script after adding or reordering colormaps. CI does not run
this: the produced colormaps.zarr directory is committed to the repo.

Usage (uv reads the PEP 723 header above to set up the env automatically):
    uv run --no-project build_tools/generate_colormaps_zarr.py
"""

from __future__ import annotations

import pathlib
import shutil
import sys

# Order MUST match COLORMAP_BIN_NAMES in src/webgl/colormaps.ts.
# (`jet` is kept at the end as a back-compat-only colormap, reachable via the
# `colormapJet` free GLSL function but hidden from the dropdown.)
NAMES = (
    "grayscale",
    "viridis",
    "plasma",
    "cividis",
    "magma",
    "coolwarm",
    "rdbu",
    "turbo",
    "cubehelix",
    "oranges",
    "jet",
)

# Aliases for names that differ between matplotlib and Neuroglancer.
ALIASES = {
    "grayscale": "gray",
    "rdbu": "RdBu",
    "oranges": "Oranges",
}


def main() -> int:
    # matplotlib/numpy/tensorstore aren't installed in the mypy nox session's
    # env (they're supplied at runtime via the PEP 723 header above), so
    # silence the import-not-found warnings here.
    try:
        import matplotlib  # type: ignore[import-not-found]
        import numpy as np  # type: ignore[import-not-found]
        import tensorstore as ts  # type: ignore[import-not-found]
    except ImportError as e:
        print(f"missing dependency: {e}", file=sys.stderr)
        return 1

    try:
        cmaps = matplotlib.colormaps
    except AttributeError:  # matplotlib < 3.7
        import matplotlib.cm as cmaps  # type: ignore

    t = np.linspace(0.0, 1.0, 256)
    # Build (N, 256, 3) uint8 array. Each colormap's 256 RGB rows are a
    # contiguous 768-byte block in C-order, matching the JS-side accessor.
    array = np.zeros((len(NAMES), 256, 3), dtype=np.uint8)
    for i, name in enumerate(NAMES):
        mpl_name = ALIASES.get(name, name)
        cmap = (
            cmaps.get_cmap(mpl_name) if hasattr(cmaps, "get_cmap") else cmaps[mpl_name]
        )
        rgb = cmap(t)[:, :3]  # (256, 3) floats in [0, 1]
        array[i, :, :] = np.clip(np.rint(rgb * 255.0), 0, 255).astype(np.uint8)

    target_dir = (
        pathlib.Path(__file__).resolve().parent.parent
        / "src"
        / "webgl"
        / "colormaps.zarr"
    )
    # Wipe any existing zarr.json + chunk tree so this script is idempotent.
    # The README.md (if any) is preserved.
    if (target_dir / "zarr.json").exists():
        (target_dir / "zarr.json").unlink()
    chunk_root = target_dir / "c"
    if chunk_root.exists():
        shutil.rmtree(chunk_root)

    # One outer chunk of full-array shape = a single shard at c/0/0/0.
    # The sharding codec subdivides that shard into one inner chunk per
    # colormap (shape (1, 256, 3)). Inner data codec is `bytes` (uncompressed
    # uint8). Index codec chain is `bytes` + `crc32c` (the default).
    spec = {
        "driver": "zarr3",
        "kvstore": {"driver": "file", "path": str(target_dir)},
        "metadata": {
            "shape": list(array.shape),
            "data_type": "uint8",
            "chunk_grid": {
                "name": "regular",
                "configuration": {"chunk_shape": list(array.shape)},
            },
            "chunk_key_encoding": {
                "name": "default",
                "configuration": {"separator": "/"},
            },
            "codecs": [
                {
                    "name": "sharding_indexed",
                    "configuration": {
                        "chunk_shape": [1, 256, 3],
                        "codecs": [
                            {"name": "bytes", "configuration": {"endian": "little"}},
                        ],
                        "index_codecs": [
                            {"name": "bytes", "configuration": {"endian": "little"}},
                            {"name": "crc32c"},
                        ],
                        "index_location": "end",
                    },
                },
            ],
            "fill_value": 0,
            "dimension_names": ["colormap", "entry", "channel"],
            "attributes": {
                "colormap_names": list(NAMES),
            },
        },
        "create": True,
    }
    store = ts.open(spec).result()
    store.write(array).result()

    # Round-trip self-check.
    read = ts.open(
        {
            "driver": "zarr3",
            "kvstore": {"driver": "file", "path": str(target_dir)},
        }
    ).result()
    assert tuple(read.shape) == array.shape, (read.shape, array.shape)
    assert read.dtype.numpy_dtype == np.uint8, read.dtype
    round_tripped_names = read.spec().to_json()["metadata"]["attributes"][
        "colormap_names"
    ]
    assert tuple(round_tripped_names) == NAMES, (round_tripped_names, NAMES)

    print(f"wrote {target_dir} ({len(NAMES)} colormaps, shape {tuple(array.shape)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
