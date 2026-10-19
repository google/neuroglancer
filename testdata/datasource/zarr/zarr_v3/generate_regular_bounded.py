"""Writes `examples/regular_bounded`: a 6 x 7 array grown in front by 3 rows and 2 columns.

Requires a zarr-python with `Array.prepend` (zarr-developers/zarr-python#4516).
"""

import json
import pathlib
import shutil

import numpy as np
import zarr

out = pathlib.Path(__file__).parent / "examples" / "regular_bounded"
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

# `examples/regular_bounded_origin`: chunk 0 starts at (1, -1), the first element at (-1, 0).

out = pathlib.Path(__file__).parent / "examples" / "regular_bounded_origin"
shutil.rmtree(out, ignore_errors=True)
zarr.create_array(
    store=str(out),
    shape=(3, 4),
    chunks=(2, 3),
    dtype="uint16",
    fill_value=0,
    compressors=None,
)
meta = json.loads((out / "zarr.json").read_text())
meta["chunk_grid"] = {
    "name": "regular_bounded",
    "configuration": {"chunk_shape": [2, 3], "origin": [1, -1], "lower_bound": [-1, 0]},
}
(out / "zarr.json").write_text(json.dumps(meta, indent=2))
zarr.open_array(str(out), mode="r+")[:] = (
    np.arange(12, dtype="uint16").reshape(3, 4) + 1
)
