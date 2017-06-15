#!/usr/bin/python

"""
This script is used to convert hdf5 segmentation remap files
to npy format. Ran Lu's and Nick Turner's MST to remap converter 
generates hdf5s using Julia. The format of these remap files is 
simple. It's an array where the index of the array is the key
and the value is the remap value. If the remap array is [5,2,39],
this means remap segment ID 1 to 5, 2 to 2, and 3 to 39.

This script reformats this array to be zero indexed to suit python
and converts the array to npy format which will be used by the 
WatershedRemapTask in the pipeline.

Example Command Sequence:
  gsutil cp path/to/remap.h5 .
  python remap2npy.py remap.h5 # outputs remap.npy
  gsutil cp -Z remap.npy gs://neuroglancer/DATASET/LAYER/
"""

import sys

import h5py
import numpy as np

if len(sys.argv) == 1:
  print "You must specify a remap .h5 file."
  sys.exit()

in_file = sys.argv[1]
out_file = in_file.replace('.h5', '')

with h5py.File(in_file,'r') as f:
  arr = f['main'][:]

print arr.shape, arr.dtype

# These remap files are often created by julia or
# matlab which assume 1-indexing. Add a new index
# at 0 to realign with python's 0-indexing. 
arr = np.concatenate( (np.array([0]), arr) )
arr = arr.astype(np.uint32)

np.save(out_file, arr)




