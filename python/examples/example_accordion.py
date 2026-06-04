import argparse

import neuroglancer
import neuroglancer.cli
import numpy as np


def add_example_layers(state):
    state.dimensions = neuroglancer.CoordinateSpace(
        names=["x", "y", "z"], units="nm", scales=[10, 10, 10]
    )
    state.layers.append(
        name="example_layer",
        layer=neuroglancer.LocalVolume(
            data=np.ones((10, 10, 10)).astype(np.float32),
            dimensions=state.dimensions,
        ),
    )
    return state.layers[0]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        add_example_layers(s)
        s.layers[0].annotations_accordion.annotations_expanded = False
        s.layers[0].annotations_accordion.related_segments_expanded = True
        s.layers[0].rendering_accordion.slice_expanded = True
        s.layers[0].rendering_accordion.shader_expanded = False
        s.selected_layer.layer = "example_layer"
        s.selected_layer.visible = True

    print(viewer)
