import argparse
import numpy as np

import neuroglancer
import neuroglancer.cli


def add_example_layer(state):
    ix, iy, iz = np.meshgrid(*[np.linspace(0, 1, n) for n in [100, 100, 100]], indexing='ij')
    b = np.cast[np.int32](np.floor(np.sqrt((ix - 0.5)**2 + (iy - 0.5)**2 + (iz - 0.5)**2) * 10)) - 2
    b = np.pad(b, 1, 'constant')
    dimensions = neuroglancer.CoordinateSpace(names=['x', 'y', 'z'],
                                              units='nm',
                                              scales=[10, 10, 10])

    state.dimensions = dimensions
    state.layers.append(
        name='b',
        layer=neuroglancer.SegmentationLayer(source=neuroglancer.LocalVolume(
            data=b,
            dimensions=dimensions,
        )),
    )
    return b


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        add_example_layer(s)
    print(viewer)
