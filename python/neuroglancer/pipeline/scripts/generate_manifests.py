#!/usr/bin/python

"""
This script is an alternative to deploying a cloud task.
The first step is to download the mesh files:

gsutil ls gs://neuroglancer/DATASET/LAYER/mesh/ > DATASET.txt

Then you run this script:

python generate_manifests.py DATASET

You can probably do this faster in the cloud, but if you 
want to keep things simple, you can process Pinky40_v11 
in a few hrs or s1_v0.1 in an hour when they are meshed
at a near isotropic mip level.
"""

from tqdm import tqdm
import os
import re
import json
from collections import defaultdict
from neuroglancer.pipeline import Storage
import sys

lsfilename = '{}.txt'.format(sys.argv[1])

with open(lsfilename) as f:
  files = f.readlines()

layer_path = os.path.dirname(files[0])
files = [ os.path.basename(fname)[:-1] for fname in files ]

segids = defaultdict(list)

for fname in files:
  segid, = re.match('(\d+):', fname).groups()
  segid = int(segid)
  segids[segid].append(fname)

print(layer_path)
with Storage(layer_path) as stor:
  for segid, frags in tqdm(segids.items()):
    stor.put_file(
      file_path='{}:0'.format(segid),
      content=json.dumps({ "fragments": frags }),
      content_type='application/json',
    )



  
