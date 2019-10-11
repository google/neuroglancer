from __future__ import print_function

import argparse

import numpy as np

import neuroglancer

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
        edges = [0, 1]
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
        ))

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--static-content-url')
    ap.add_argument('-a', '--bind-address')
    args = ap.parse_args()
    neuroglancer.server.debug = True
    if args.bind_address:
        neuroglancer.set_server_bind_address(args.bind_address)
    if args.static_content_url:
        neuroglancer.set_static_content_source(url=args.static_content_url)
    print(viewer)
