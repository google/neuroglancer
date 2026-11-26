"""Writes `examples/bounds`: a 6 x 7 array grown in front by 3 rows and 2 columns, so that its
metadata carries `bounds` in place of `shape` (ZEP 12).

Also writes `examples/offset_grid` and `examples/offset_grid_transpose`: a 3 x 4 array whose
first element is at (-1, 0) on an `offset` chunk grid (zarr-extensions#81) whose chunk 0 begins
at (1, -1), the second with a `transpose` codec. Requires a zarr-python that reads `bounds` and
the `offset` grid and has `Array.prepend` (zarr-developers/zarr-python#4516).
"""

import json
import pathlib
import shutil

import numpy as np
import zarr
from zarr.codecs import TransposeCodec

examples = pathlib.Path(__file__).parent / "examples"

out = examples / "bounds"
shutil.rmtree(out, ignore_errors=True)
z = zarr.create_array(
    store=str(out),
    shape=(6, 7),
    chunks=(4, 5),
    dtype="uint16",
    fill_value=0,
    compressors=None,
)
z[:] = np.arange(42, dtype="uint16").reshape(6, 7) + 100
z.prepend(np.arange(21, dtype="uint16").reshape(3, 7) + 1, axis=0)
z.prepend(np.full((9, 2), 900, dtype="uint16"), axis=1)


def offset_grid(name, filters):
    out = examples / name
    shutil.rmtree(out, ignore_errors=True)
    zarr.create_array(
        store=str(out),
        shape=(3, 4),
        chunks=(2, 3),
        dtype="uint16",
        fill_value=0,
        filters=filters,
        compressors=None,
    )
    meta = json.loads((out / "zarr.json").read_text())
    meta = {("bounds" if k == "shape" else k): v for k, v in meta.items()}
    meta["bounds"] = {"inclusive_min": [-1, 0], "exclusive_max": [2, 4]}
    meta["chunk_grid"] = {
        "name": "offset",
        "configuration": {
            "offset": [1, -1],
            "base_chunk_grid": {
                "name": "regular",
                "configuration": {"chunk_shape": [2, 3]},
            },
        },
    }
    (out / "zarr.json").write_text(json.dumps(meta, indent=2))
    zarr.open_array(str(out), mode="r+")[:] = (
        np.arange(12, dtype="uint16").reshape(3, 4) + 1
    )


offset_grid("offset_grid", None)
offset_grid("offset_grid_transpose", [TransposeCodec(order=(1, 0))])
