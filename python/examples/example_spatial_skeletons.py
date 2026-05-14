import argparse

import neuroglancer
import neuroglancer.cli
import numpy as np

voxel_size = np.array([10, 10, 10])

shape = (100, 100, 100)

segmentation = np.arange(np.prod(shape), dtype=np.uint32).reshape(shape)

viewer = neuroglancer.Viewer()
dimensions = neuroglancer.CoordinateSpace(
    names=["x", "y", "z"],
    units="nm",
    scales=[10, 10, 10],
)
with viewer.txn() as s:
    s.layers.append(
        name="a",
        layer=neuroglancer.SegmentationLayer(
            source=[
                neuroglancer.LocalVolume(
                    data=segmentation,
                    dimensions=dimensions,
                ),  # example of segmentation that could accompany the skeleton
                "catmaid://http://localhost:8000/4",  # replace with your catmaid URL/project ID
            ],
            tab="skeleton",
        ),
    )
    # Can adjust the skeleton rendering options
    s.layers[0].skeleton_rendering.mode2d = "lines"
    s.layers[0].skeleton_rendering.line_width2d = 3
    s.layers[0].skeleton_rendering.mode3d = "lines_and_points"
    s.layers[0].skeleton_rendering.line_width3d = 10

    # Can adjust visibility of layer side panel
    s.selected_layer.layer = "a"
    s.selected_layer.visible = True

    # Can set the new spatial related options
    layer = s.layers[0]
    layer.spatial_skeleton_node_query = "1"
    layer.spatial_skeleton_node_filter = neuroglancer.SpatialSkeletonNodeFilterType.LEAF
    layer.hidden_object_alpha = 0.8
    layer.skeleton_cross_section_render_scale = 4.0
    layer.skeleton_perspective_render_scale = 4.0
    layer.visible_segments = [649]

    # Can pick a specific segment and node to select
    selection_for_layers = s.selection.layers
    selection_for_layers["a"] = {"value": "649", "nodeId": "131"}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    print(viewer)
