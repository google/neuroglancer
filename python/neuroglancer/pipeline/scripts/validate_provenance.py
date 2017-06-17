import os
import re
import subprocess
import sys

from neuroglancer.pipeline import Storage
from neuroglancer.pipeline.volumes.provenance import DataLayerProvenance

def ls(cloudpath):
  listing = subprocess.check_output(['gsutil', 'ls', cloudpath])
  listing = listing.split('\n')
  return [ x for x in listing if x ]

valid_paths = re.compile(r'^(gs|file|s3)://([/\d\w_\.\-]+)/([\d\w_\.\-]+)/([\d\w_\.\-]+)/?')

datasets = ls('gs://neuroglancer') + ls('s3://neuroglancer')

missing_report = []
invalid_report = []

for dataset in datasets:
  layers = ls(dataset)

  for layer in layers:
    if not valid_paths.match(layer):
      continue 

    with Storage(layer, n_threads=0) as stor:
      if stor.exists('provenance'):
        missing_report.append(layer)
      else:
        try:
          DataLayerProvenance(layer)
        except:
          invalid_report.append(layer)

if len(missing_report):
  print "The following data layers are missing a provenance file:"
  print ",".join(missing_report)

if len(invalid_report):
  print "The following data layers have invalid provenance files:"
  print ",".join(invalid_report)

print 'done.'



