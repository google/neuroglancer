#!/usr/bin/env python3

import argparse
import os
import shutil
import subprocess
import sys

script_dir = os.path.dirname(sys.argv[0])
src_dir = os.path.join(script_dir, 'ext/src')
dest_openmesh_dir = os.path.join(script_dir, 'ext/third_party/openmesh/OpenMesh')

ap = argparse.ArgumentParser()
ap.add_argument('openmesh_directory', help='Path to OpenMesh root directory')
args = ap.parse_args()

openmesh_dir = os.path.abspath(args.openmesh_directory)

deps = subprocess.check_output(
    ['gcc', '-pthread', '-I', os.path.join(openmesh_dir, 'src'), '-c', 'openmesh_dependencies.cc',
     'on_demand_object_mesh_generator.cc', '-MM', '-MF', '/dev/stdout',
     '-fopenmp', '-std=c++11'], cwd=src_dir).split()
deps = [x[len(openmesh_dir)+1:] for x in deps if x.startswith(openmesh_dir + '/')] + ['LICENSE', 'VERSION']

if os.path.exists(dest_openmesh_dir):
  shutil.rmtree(dest_openmesh_dir)

for dep in deps:
  dest_path = os.path.join(dest_openmesh_dir, dep)
  dest_dir = os.path.dirname(dest_path)
  if not os.path.exists(dest_dir):
    os.makedirs(dest_dir)
  shutil.copyfile(os.path.join(openmesh_dir, dep), dest_path)
