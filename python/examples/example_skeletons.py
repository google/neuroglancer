from __future__ import print_function

import argparse

import numpy as np

import neuroglancer
import neuroglancer.cli

voxel_size = np.array([10, 10, 10])

shape = (100, 100, 100)

segmentation = np.arange(np.prod(shape), dtype=np.uint32).reshape(shape)


class SkeletonSource(neuroglancer.skeleton.SkeletonSource):
    def __init__(self, dimensions):
        super(SkeletonSource, self).__init__(dimensions)
        self.vertex_attributes['affinity'] = neuroglancer.skeleton.VertexAttributeInfo(
            data_type=np.float32,
            num_components=1,
        )
        self.vertex_attributes['affinity2'] = neuroglancer.skeleton.VertexAttributeInfo(
            data_type=np.float32,
            num_components=1,
        )

    def get_skeleton(self, i):
        pos = np.unravel_index(i, shape, order='C')
        vertex_positions = [pos, pos + np.random.randn(3) * 30]
        edges = [[0, 1]]
        return neuroglancer.skeleton.Skeleton(
            vertex_positions=vertex_positions,
            edges=edges,
            vertex_attributes=dict(affinity=np.random.rand(2), affinity2=np.random.rand(2)))


viewer = neuroglancer.Viewer()
dimensions = neuroglancer.CoordinateSpace(
    names=['x', 'y', 'z'],
    units='nm',
    scales=[10, 10, 10],
)
with viewer.txn() as s:
    s.layers.append(
        name='a',
        layer=neuroglancer.SegmentationLayer(
            source=[
                neuroglancer.LocalVolume(
                    data=segmentation,
                    dimensions=dimensions,
                ),
                SkeletonSource(dimensions),
            ],
            skeleton_shader='void main() { emitRGB(colormapJet(affinity)); }',
            selected_alpha=0,
            not_selected_alpha=0,
            segments=[395750],
        ))
    # Can adjust the skeleton rendering options
    s.layers[0].skeleton_rendering.mode2d = 'lines'
    s.layers[0].skeleton_rendering.line_width2d = 3
    s.layers[0].skeleton_rendering.mode3d = 'lines_and_points'
    s.layers[0].skeleton_rendering.line_width3d = 10

    # Can adjust visibility of layer side panel
    s.selected_layer.layer = 'a'
    s.selected_layer.visible = True

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    print(viewer)
