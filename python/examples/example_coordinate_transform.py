import argparse

import neuroglancer
import neuroglancer.cli
import numpy as np

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()

    ix, iy, iz = np.meshgrid(
        *[np.linspace(0, 1, n) for n in [100, 100, 100]], indexing="ij"
    )
    data = np.asarray(
        np.floor(np.sqrt((ix - 0.5) ** 2 + (iy - 0.5) ** 2 + (iz - 0.5) ** 2) * 10),
        dtype=np.uint32,
    )
    data = np.pad(data, 1, "constant")
    dimensions = neuroglancer.CoordinateSpace(
        names=["x", "y", "z"], units="nm", scales=[10, 10, 10]
    )

    with viewer.txn() as s:
        s.dimensions = dimensions
        s.layers["original"] = neuroglancer.SegmentationLayer(
            source=[
                neuroglancer.LayerDataSource(
                    neuroglancer.LocalVolume(data=data, dimensions=dimensions)
                )
            ],
        )
        s.layers["transformed"] = neuroglancer.SegmentationLayer(
            source=[
                neuroglancer.LayerDataSource(
                    neuroglancer.LocalVolume(data=data, dimensions=dimensions),
                    transform=neuroglancer.CoordinateSpaceTransform(
                        output_dimensions=dimensions,
                        matrix=[[1, 0, 0, 0], [1, 1, 0, 0], [0, 0, 1, 0]],
                    ),
                )
            ],
        )
    print(viewer)
