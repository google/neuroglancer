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

# This example displays layers useful for testing the behavior of the invlerp UI
# control's CDF widget.

from __future__ import print_function

import argparse
import numpy as np

import neuroglancer
import neuroglancer.cli


def add_cdf_test_layer(state, dtype, min_value=None, max_value=None):
    dimensions = neuroglancer.CoordinateSpace(names=['x'], units='', scales=[1])
    state.dimensions = dimensions
    if min_value is None or max_value is None:
        info = np.iinfo(dtype)
        if min_value is None:
            min_value = info.min
        if max_value is None:
            max_value = info.max
    data = np.linspace(start=min_value, stop=max_value, endpoint=True, dtype=dtype, num=256)
    state.layers[np.dtype(dtype).name] = neuroglancer.ImageLayer(source=neuroglancer.LocalVolume(
        data=data,
        dimensions=dimensions,
    ))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        add_cdf_test_layer(s, np.uint8)
        add_cdf_test_layer(s, np.uint16)
        add_cdf_test_layer(s, np.int16)
        add_cdf_test_layer(s, np.uint64)
        add_cdf_test_layer(s, np.float32, 0, 1)
    print(viewer)
