from __future__ import print_function

import argparse
import webbrowser

import numpy as np

import neuroglancer
import neuroglancer.cli

ap = argparse.ArgumentParser()
neuroglancer.cli.add_server_arguments(ap)
args = ap.parse_args()
neuroglancer.cli.handle_server_arguments(args)

viewer = neuroglancer.Viewer()

a = np.zeros((3, 100, 100, 100), dtype=np.uint8)
ix, iy, iz = np.meshgrid(* [np.linspace(0, 1, n) for n in a.shape[1:]], indexing='ij')
a[0, :, :, :] = np.abs(np.sin(4 * (ix + iy))) * 255
a[1, :, :, :] = np.abs(np.sin(4 * (iy + iz))) * 255
a[2, :, :, :] = np.abs(np.sin(4 * (ix + iz))) * 255

with viewer.txn() as s:
    s.layers['image'] = neuroglancer.ImageLayer(
        source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/image',
    )
    s.layers['ground_truth'] = neuroglancer.SegmentationLayer(
        source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth',
    )
    s.layers['overlay'] = neuroglancer.ImageLayer(
        source=neuroglancer.LocalVolume(
            a,
            dimensions=neuroglancer.CoordinateSpace(
                scales=[1, 8, 8, 8],
                units=['', 'nm', 'nm', 'nm'],
                names=['c^', 'x', 'y', 'z']),
            voxel_offset=[0, 3000, 3000, 3000]),
        shader="""
void main() {
  emitRGB(vec3(toNormalized(getDataValue(0)),
               toNormalized(getDataValue(1)),
               toNormalized(getDataValue(2))));
}
""",
    )
    s.voxel_coordinates = [3000, 3000, 3000]
print(viewer.state)
print(viewer)
webbrowser.open_new(viewer.get_viewer_url())
