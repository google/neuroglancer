from __future__ import print_function

import argparse

import neuroglancer
import neuroglancer.cli

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        s.layers['image'] = neuroglancer.ImageLayer(
            source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/image')
    print(viewer)
