#!/usr/bin/env python3
"""Generate src/webgl/colormaps.bin from matplotlib's named colormaps.

The file is a concatenation of N x 256 x 3 uint8 RGB triples, one 768-byte
block per colormap in the order of NAMES below. The order MUST match
COLORMAP_NAMES in src/webgl/colormaps.ts.

Re-run this script after adding or reordering colormaps. CI does not run this:
the produced colormaps.bin is committed to the repo.

Usage (requires uv + matplotlib + numpy):
    uv run --with matplotlib --with numpy --no-project \
        build_tools/generate_colormaps_bin.py
"""

from __future__ import annotations

import pathlib
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
    try:
        import matplotlib
        import numpy as np
    except ImportError as e:
        print(f"missing dependency: {e}", file=sys.stderr)
        return 1

    try:
        cmaps = matplotlib.colormaps
    except AttributeError:  # matplotlib < 3.7
        import matplotlib.cm as cmaps  # type: ignore

    t = np.linspace(0.0, 1.0, 256)
    out = bytearray()
    for name in NAMES:
        mpl_name = ALIASES.get(name, name)
        cmap = (
            cmaps.get_cmap(mpl_name) if hasattr(cmaps, "get_cmap") else cmaps[mpl_name]
        )
        rgb = cmap(t)[:, :3]  # (256, 3) floats in [0, 1]
        rgb_u8 = np.clip(np.rint(rgb * 255.0), 0, 255).astype(np.uint8)
        out.extend(rgb_u8.tobytes())

    expected = len(NAMES) * 256 * 3
    if len(out) != expected:
        print(f"size mismatch: got {len(out)} expected {expected}", file=sys.stderr)
        return 1

    target = (
        pathlib.Path(__file__).resolve().parent.parent
        / "src"
        / "webgl"
        / "colormaps.bin"
    )
    target.write_bytes(out)
    print(f"wrote {target} ({len(out)} bytes, {len(NAMES)} colormaps)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
