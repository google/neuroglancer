from __future__ import print_function

import argparse
import numpy as np

import neuroglancer
import neuroglancer.cli


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        s.layers['mesh'] = neuroglancer.SingleMeshLayer(
            source=
            'vtk://https://storage.googleapis.com/neuroglancer-fafb-data/elmr-data/FAFB.surf.vtk.gz'
        )
    print(viewer)
