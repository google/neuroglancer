# @license
# Copyright 2023 Google Inc.
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
"""Tests the n5 datasource."""

import pathlib

import neuroglancer
import numpy as np
import pytest


@pytest.mark.parametrize(
    "spec",
    [
        {
            "driver": "neuroglancer_precomputed",
            "scale_metadata": {"encoding": "png", "chunk_size": [8, 9, 1]},
            "dtype": "uint8",
            "schema": {"domain": {"shape": [10, 20, 5, num_channels]}},
        }
        for num_channels in [1, 2, 3, 4]
    ]
    + [
        # Currently TensorStore does not support uint16 with more than one channel.
        {
            "driver": "neuroglancer_precomputed",
            "scale_metadata": {"encoding": "png"},
            "dtype": "uint16",
            "schema": {"domain": {"shape": [10, 20, 5, 1]}},
        }
    ]
    + [
        # Due to a tensorstore bug (https://github.com/google/neuroglancer/issues/677)
        # the block shape must be square.
        {
            "driver": "neuroglancer_precomputed",
            "scale_metadata": {"encoding": "jpeg", "chunk_size": [10, 10, 1]},
            "dtype": "uint8",
            "schema": {"domain": {"shape": [10, 20, 1, num_channels]}},
        }
        for num_channels in [1, 3]
    ],
    ids=str,
)
def test_precomputed(tempdir_server: tuple[pathlib.Path, str], webdriver, spec):
    import tensorstore as ts

    tmp_path, server_url = tempdir_server

    full_spec = {
        "kvstore": {
            "driver": "file",
            "path": str(tmp_path),
        }
    }
    full_spec.update(spec)

    store = ts.open(full_spec, create=True).result()

    a = np.arange(np.prod(store.shape), dtype=store.dtype.numpy_dtype).reshape(
        store.shape
    )

    store[...] = a

    with webdriver.viewer.txn() as s:
        s.layers.append(
            name="a",
            layer=neuroglancer.ImageLayer(source=f"precomputed://{server_url}"),
        )

    if store.shape[-1] == 1:
        # Neuroglancer elides the channel dimension if there is only 1 channel
        store = store[..., 0]

    vol = webdriver.viewer.volume("a").result()
    b = vol.read().result()

    if spec["scale_metadata"]["encoding"] == "jpeg":
        np.testing.assert_allclose(store.read().result(), b, atol=4, rtol=0)
    else:
        np.testing.assert_equal(store.read().result(), b)
