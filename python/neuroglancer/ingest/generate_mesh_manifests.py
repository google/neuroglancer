#!/usr/bin/python

"""Neuroglancer Cloud Ingest"""

import argparse
import json
import numpy as np
import os
import sys
from itertools import product
from neuroglancer import chunks
from neuroglancer import downsample_scales
from collections import defaultdict
from tqdm import tqdm
import subprocess
import shutil
import re

from google.cloud import storage

import lib
from lib import mkdir, format_cloudpath, cloudpath_to_hierarchy

STAGING_DIR = mkdir(os.path.join(lib.COMMON_STAGING_DIR, 'fragments'))

def generate_mesh_manifests(chunk_manifests):

  segidfrags = defaultdict(list)
  for chunk_name, segids in chunk_manifests:
    for segid in segids:
      segidfrags[segid].append(chunk_name)

  def frag_generator():
    for segid, chunks in segidfrags.iteritems():
      fragids = [ "{}:0:{}".format(segid, chunk) for chunk in chunks ]
      yield (segid, json.dumps({
        "fragments": fragids
      }))

  return frag_generator()

def upload_mesh_manifests(fragments, cloudpath):

  paths = []

  for segid, fragmentjson in tqdm(fragments):
    filename = '{}:0'.format(segid)
    
    path = os.path.join(STAGING_DIR, filename)

    with open(path, 'w') as f:
      f.write(fragmentjson)

    paths.append(path)

  lib.upload_to_gcloud(
    filenames=paths,
    cloudpath=os.path.join(cloudpath, 'mesh'),
    headers={ 'Content-Type': 'application/json' },
    compress=True,
  )

  shutil.rmtree(STAGING_DIR)


def pull_chunk_manifests(cloudpath):
  bucket_name, dataset, layer = cloudpath_to_hierarchy(cloudpath)
  prefix_path = '{}/{}/build/manifests/'.format(dataset, layer)
  client = storage.Client(project=lib.GCLOUD_PROJECT)
  bucket = client.get_bucket(bucket_name)
  manifests = []
  for blob in tqdm(bucket.list_blobs(prefix=prefix_path)):
    chunk_name = os.path.basename(blob.name)

    if chunk_name == '':
      continue

    chunk_name = os.path.splitext(chunk_name)[0] # clip off .json if present
    try:
      payload = json.loads(blob.download_as_string())
    except:
      print('failed to download:', blob)
      continue
      
    manifests.append( (chunk_name, payload) )

  return manifests

  
if __name__ == '__main__':
  parser = argparse.ArgumentParser(description="""Finalize mesh generation by post-processing chunk fragment lists into mesh fragment manifests. 
    These are necessary for neuroglancer to know which mesh fragments to download for a given segid.""")

  parser.add_argument('--cloudpath', 
    dest='cloudpath', action='store', metavar='CLOUD_PATH',
    help='/[BUCKET]/[DATASET]/[LAYER] Path to gcloud bucket layer. e.g. /neuroglancer/snemi3d/images ; e.g. /neuroglancer/golden_cube_3x3/segmentation', 
    required=True)

  args = parser.parse_args()

  cloudpath = format_cloudpath(args.cloudpath)
  chunk_manifests = pull_chunk_manifests(cloudpath)
  mesh_manifests = generate_mesh_manifests(chunk_manifests)
  upload_mesh_manifests(mesh_manifests, cloudpath)
