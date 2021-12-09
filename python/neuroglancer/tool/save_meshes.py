#!/usr/bin/env python
# @license
# Copyright 2020 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Tool for saving object meshes from Neuroglancer using cloud-volume.

Usage:

python -m neuroglancer.tool.save_meshes --url 'https://neuroglancer-demo.appspot.com/#!%7B%22dimensions%22:%7B%22x%22:%5B8e-9%2C%22m%22%5D%2C%22y%22:%5B8e-9%2C%22m%22%5D%2C%22z%22:%5B8e-9%2C%22m%22%5D%7D%2C%22position%22:%5B2911.677978515625%2C3100.916748046875%2C4024.5%5D%2C%22crossSectionScale%22:3.762185354999915%2C%22projectionOrientation%22:%5B-0.4241213798522949%2C-0.04451639577746391%2C0.07846356928348541%2C-0.9011008739471436%5D%2C%22projectionScale%22:6078.433160286794%2C%22layers%22:%5B%7B%22type%22:%22image%22%2C%22source%22:%22precomputed://gs://neuroglancer-public-data/flyem_fib-25/image%22%2C%22name%22:%22image%22%7D%2C%7B%22type%22:%22segmentation%22%2C%22source%22:%22precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth%22%2C%22segments%22:%5B%2210319%22%2C%2224436%22%2C%222515%22%2C%2226353%22%2C%2250%22%5D%2C%22name%22:%22ground-truth%22%7D%5D%2C%22showSlices%22:false%2C%22layout%22:%224panel%22%2C%22partialViewport%22:%5B0%2C0%2C1%2C1%5D%7D' --output-dir mesh-output-dir

"""

import argparse
import os
import sys

import neuroglancer
import neuroglancer.cli

try:
    import cloudvolume
except ImportError:
    print('cloud-volume package is required: pip install cloud-volume')
    sys.exit(1)


def save_meshes(state, output_dir, output_format, lod):
    for layer in state.layers:
        if not isinstance(layer.layer, neuroglancer.SegmentationLayer): continue
        if not layer.visible: return False
        for source in layer.source:
            if not source.url.startswith('precomputed://'):
                continue
            vol = cloudvolume.CloudVolume(source.url, parallel=True, progress=True)
            if len(layer.segments) == 0: continue
            get_mesh_kwargs = {}
            if lod != 0:
                get_mesh_kwargs.update(lod=lod)
            for segment in layer.segments:
                output_path = os.path.join(output_dir, '%d.%s' % (segment, output_format))
                print('Saving layer %r object %s -> %s' % (layer.name, segment, output_path))
                os.makedirs(output_dir, exist_ok=True)
                mesh = vol.mesh.get(segment, **get_mesh_kwargs)
                if isinstance(mesh, dict):
                    mesh = list(mesh.values())[0]
                if output_format == 'obj':
                    data = mesh.to_obj()
                elif output_format == 'ply':
                    data = mesh.to_ply()
                elif output_format == 'precomputed':
                    data = mesh.to_precomputed()
                with open(output_path, 'wb') as f:
                    f.write(data)
            return
    print('No segmentation layer found')
    sys.exit(1)


def main(args=None):
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_state_arguments(ap, required=True)
    ap.add_argument('--format', choices=['obj', 'ply'], default='obj')
    ap.add_argument('--lod', type=int, default=0, help='Mesh level of detail to download')
    ap.add_argument('--output-dir', default='.')
    parsed_args = ap.parse_args()
    save_meshes(state=parsed_args.state,
                output_dir=parsed_args.output_dir,
                output_format=parsed_args.format,
                lod=parsed_args.lod)


if __name__ == '__main__':
    main()
