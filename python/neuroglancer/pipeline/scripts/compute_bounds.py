#!/usr/bin/python

"""
This script can be used to determine the actual bounding box
of a given layer. When a layer is first generated, it can
come from any pipeline. e.g. ChunkFlow.jl or another custom
method. These other methods are often agnostic to configuring
neuroglancer info files correctly, which is critical to viewing
the generated layer in neuroglancer and for processing them with
the pipeline. This script can be run to find the right parameters
for the info file.

Example Command:

  python compute_bounds.py gs://neuroglancer/DATASET/LAYER/

Example Output to stdout:

  bounds=Bbox([10,10,10], [138,138,138]) (size: [128,128,128]); chunk_size=[64,64,64]
  
"""

import sys
import os

from tqdm import tqdm

from neuroglancer.lib import Bbox, max2
from neuroglancer.pipeline import Storage
from neuroglancer.pipeline.volumes import CloudVolume

layer_path = sys.argv[1]

cv = CloudVolume(layer_path)

print cv.key

bboxes = []

with Storage(layer_path) as stor:
  for filename in tqdm(stor.list_files(prefix=cv.key), desc="Computing Bounds"):
    bboxes.append( Bbox.from_filename(filename) )

bounds = Bbox.expand(*bboxes)
chunk_size = reduce(max2, map(lambda bbox: bbox.size3(), bboxes))
print('bounds={} (size: {}); chunk_size={}'.format(bounds, bounds.size3(), chunk_size))







