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

import argparse
import numpy as np

import neuroglancer
import neuroglancer.cli


def add_dask_layer(state):
    """Adds a lazily-computed data source backed by dask."""
    # https://docs.dask.org/en/latest/array-creation.html#using-dask-delayed
    import dask
    import dask.array

    def make_array(k):
        print('Computing k=%d' % (k, ))
        return np.full(shape=(256, 256), fill_value=k, dtype=np.uint8)

    lazy_make_array = dask.delayed(make_array, pure=True)
    lazy_chunks = [lazy_make_array(k) for k in range(255)]
    sample = lazy_chunks[0].compute()  # load the first chunk (assume rest are same shape/dtype)
    arrays = [
        dask.array.from_delayed(lazy_chunk, dtype=sample.dtype, shape=sample.shape)
        for lazy_chunk in lazy_chunks
    ]
    x = dask.array.concatenate(arrays)
    state.layers['dask'] = neuroglancer.ImageLayer(source=neuroglancer.LocalVolume(x))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        add_dask_layer(s)
    print(viewer)
