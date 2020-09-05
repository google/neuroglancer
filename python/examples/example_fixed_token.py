from __future__ import print_function

import argparse
import numpy as np

import neuroglancer
import neuroglancer.cli

from example import add_example_layers

if __name__ == '__main__':

    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)

    # Specifying a token disables credentials by default.  Specify
    # `allow_credentials=True` to allow credentials, but in that case you must
    # specify a secure/ungessable token to avoid exposing the credentials.
    viewer = neuroglancer.Viewer(token='mytoken')
    with viewer.txn() as s:
        a, b = add_example_layers(s)

    print(viewer)
