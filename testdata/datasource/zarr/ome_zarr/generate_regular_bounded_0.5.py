"""Writes `regular_bounded_0.5`: the `simple_0.5` image grown in front by 3 rows and 2 columns.

Requires a zarr-python with `Array.prepend` (zarr-developers/zarr-python#4516). Both levels are
grown with `prepend`, and each level's `translation` moves to its new first element, as OME-NGFF
defines the array index space, so the original elements keep their physical positions.
"""

import json
import pathlib
import shutil

import numpy as np
import zarr

root = pathlib.Path(__file__).parent / "regular_bounded_0.5"
shutil.rmtree(root, ignore_errors=True)
root.mkdir()


def level(path, data):
    a = zarr.create_array(
        store=str(root / path),
        shape=data.shape,
        chunks=(5, 5),
        dtype="uint16",
        fill_value=0,
        compressors=None,
        dimension_names=["y", "x"],
    )
    a[:] = data
    return a


# Level 0: 10 x 10 at 4 x 30 nm, then rows [-3, 0) and columns [-2, 0) in front.
s0 = level("scale0/image", np.arange(100, dtype="uint16").reshape(10, 10))
s0.prepend(np.arange(30, dtype="uint16").reshape(3, 10) + 1000, axis=0)
s0.prepend(np.arange(26, dtype="uint16").reshape(13, 2) + 2000, axis=1)

# Level 1: 2 x 2 bins on even level-0 coordinates: rows [-4, 10), columns [-2, 10).
grown = np.zeros((14, 12), dtype="float64")
grown[1:] = s0[:]
binned = grown.reshape(7, 2, 6, 2).mean(axis=(1, 3)).astype("uint16")
s1 = level("scale1/image", binned[2:, 1:])
s1.prepend(binned[:2, 1:], axis=0)
s1.prepend(binned[:, :1], axis=1)

# Translations are voxel centres of each level's first element:
# level 0 row -3 -> 4 * -3 = -12 nm, column -2 -> 30 * -2 = -60 nm;
# level 1 rows {-4, -3} -> -14 nm, columns {-2, -1} -> -45 nm.
ome = {
    "version": "0.5",
    "multiscales": [
        {
            "name": "image",
            "axes": [
                {"name": "y", "type": "space", "unit": "nanometer"},
                {"name": "x", "type": "space", "unit": "nanometer"},
            ],
            "datasets": [
                {
                    "path": "scale0/image",
                    "coordinateTransformations": [
                        {"type": "scale", "scale": [4, 30]},
                        {"type": "translation", "translation": [-12, -60]},
                    ],
                },
                {
                    "path": "scale1/image",
                    "coordinateTransformations": [
                        {"type": "scale", "scale": [8, 60]},
                        {"type": "translation", "translation": [-14, -45]},
                    ],
                },
            ],
        }
    ],
}
for group in (root, root / "scale0", root / "scale1"):
    attrs = {"ome": ome} if group == root else {}
    (group / "zarr.json").write_text(
        json.dumps({"zarr_format": 3, "node_type": "group", "attributes": attrs}, indent=2)
    )
