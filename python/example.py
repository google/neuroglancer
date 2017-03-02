from __future__ import print_function

import numpy as np
import h5py
import webbrowser
import neuroglancer

viewer = neuroglancer.Viewer()
neuroglancer.set_static_content_source(url='http://localhost:8080')

viewer.add(volume_type='image', data=np.zeros(shape=(100,100,100), dtype=np.uint8), name='image', voxel_size=[6, 6, 40])
viewer.add(volume_type='point', name='point')
viewer.add(volume_type='synapse', name='synapse')

# f = h5py.File('./snemi3d/machine_labels.h5')
# # 0 pad is useful to make the meshes that are in contact with the borders
# # of the volume have a planar cap
# seg = np.pad(f['main'][:], 1, 'constant', constant_values=0)
# viewer.add(
#   volume_type='segmentation', 
#   data=seg, 
#   name='segmentation', 
#   voxel_size=[6, 6, 40], 
#   graph='./snemi3d/snemi3d_graph.pickle'
# )

webbrowser.open(viewer.get_viewer_url())
