import argparse

import neuroglancer
import neuroglancer.cli
import numpy as np


def add_example_layers(state):
    a = np.zeros((3, 100, 100, 100), dtype=np.uint8)
    ix, iy, iz = np.meshgrid(
        *[np.linspace(0, 1, n) for n in a.shape[1:]], indexing="ij"
    )
    a[0, :, :, :] = np.abs(np.sin(4 * (ix + iy))) * 255
    a[1, :, :, :] = np.abs(np.sin(4 * (iy + iz))) * 255
    a[2, :, :, :] = np.abs(np.sin(4 * (ix + iz))) * 255

    b = np.asarray(
        np.floor(np.sqrt((ix - 0.5) ** 2 + (iy - 0.5) ** 2 + (iz - 0.5) ** 2) * 10),
        dtype=np.uint32,
    )
    b = np.pad(b, 1, "constant")
    dimensions = neuroglancer.CoordinateSpace(
        names=["x", "y", "z"], units="nm", scales=[10, 10, 10]
    )

    state.dimensions = dimensions
    state.layers.append(
        name="a",
        layer=neuroglancer.LocalVolume(
            data=a,
            dimensions=neuroglancer.CoordinateSpace(
                names=["c^", "x", "y", "z"],
                units=["", "nm", "nm", "nm"],
                scales=[1, 10, 10, 10],
                coordinate_arrays=[
                    neuroglancer.CoordinateArray(labels=["red", "green", "blue"]),
                    None,
                    None,
                    None,
                ],
            ),
            voxel_offset=(0, 20, 30, 15),
        ),
        shader="""
void main() {
  emitRGB(vec3(toNormalized(getDataValue(0)),
               toNormalized(getDataValue(1)),
               toNormalized(getDataValue(2))));
}
""",
    )
    state.layers.append(
        name="b",
        layer=neuroglancer.LocalVolume(
            data=b,
            dimensions=dimensions,
        ),
    )
    return a, b


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        a, b = add_example_layers(s)
    print(viewer)
