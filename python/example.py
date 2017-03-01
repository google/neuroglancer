from __future__ import print_function

import numpy as np
import h5py
import webbrowser
import neuroglancer

neuroglancer.set_static_content_source(url='https://neuroglancer-demo.appspot.com')

viewer = neuroglancer.Viewer(voxel_size=[10, 10, 10])
neuroglancer.set_static_content_source(url='http://localhost:8080')
viewer = neuroglancer.Viewer()

# def initialize(state):
#   state['layers']['point']['points'] = synapses.failed
#   state['layers']['synapse']['points'] = synapses.parsed
#   return state

# viewer.initialize_state = initialize

# def on_state_changed(state):
#   try:
#     visible_segments =  map(int, state['layers']['segmentation']['segments'])
#   except KeyError:
#     visible_segments = []
#   print (visible_segments)

# viewer.on_state_changed = on_state_changed

img =  h5py.File('./snemi3d/image.h5')

# img = np.pad(f['main'][:], 1, 'constant', constant_values=0)
viewer.add(volume_type='image', data=img['main'], name='image', voxel_size=[6, 6, 40])

# if you add this layer by itself neuroglancer doesn't know the dataset size
# viewer.add(volume_type='point', name='point')

# if you add this layer by itself neuroglancer doesn't know the dataset size
viewer.add(volume_type='synapse', name='synapse')


f = h5py.File('./snemi3d/machine_labels.h5')

# 0 pad is useful to make the meshes that are in contact with the borders
# of the volume have a planar cap
seg = np.pad(f['main'][:], 1, 'constant', constant_values=0)
viewer.add(
  volume_type='segmentation', 
  data=seg, 
  name='segmentation', 
  voxel_size=[6, 6, 40], 
  graph='./snemi3d/snemi3d_graph.pickle'
)

webbrowser.open(viewer.get_viewer_url())
