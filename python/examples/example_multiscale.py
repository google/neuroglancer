from __future__ import print_function

import argparse
import webbrowser
import numpy as np

import neuroglancer

ap = argparse.ArgumentParser()
ap.add_argument(
    '-a',
    '--bind-address',
    help='Bind address for Python web server.  Use 127.0.0.1 (the default) to restrict access '
    'to browers running on the local machine, use 0.0.0.0 to permit access from remote browsers.')
ap.add_argument(
    '--static-content-url', help='Obtain the Neuroglancer client code from the specified URL.')
args = ap.parse_args()
if args.bind_address:
    neuroglancer.set_server_bind_address(args.bind_address)
if args.static_content_url:
    neuroglancer.set_static_content_source(url=args.static_content_url)

# Create a three scales of a simply array
import numpy as np
dim = 20
d2 = np.arange(dim*dim*dim, dtype=np.uint64).reshape(dim, dim, dim)
# Make zoomed in versions (2x)
d1 = np.repeat(np.repeat(np.repeat(d2, 2, 0), 2, 1), 2, 2)
d0 = np.repeat(np.repeat(np.repeat(d2, 4, 0), 4, 1), 4, 2)

viewer = neuroglancer.Viewer()
with viewer.txn() as s:
    s.layers['grid'] = neuroglancer.SegmentationLayer(
        source = neuroglancer.LocalMultiscaleVolume(
            [
                neuroglancer.LocalVolume(data=d0, voxel_size=(1,1,1)),
                neuroglancer.LocalVolume(data=d1, voxel_size=(2,2,2)),
                neuroglancer.LocalVolume(data=d2, voxel_size=(4,4,4)),
            ]
        )
    )

print(viewer)
webbrowser.open_new(viewer.get_viewer_url())
