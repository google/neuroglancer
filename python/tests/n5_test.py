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
        {"driver": "n5", "metadata": {"compression": {"type": "raw"}}},
        {"driver": "n5", "metadata": {"compression": {"type": "gzip"}}},
        {
            "driver": "n5",
            "metadata": {"compression": {"type": "gzip", "useZlib": True}},
        },
        {
            "driver": "n5",
            "metadata": {
                "compression": {
                    "type": "blosc",
                    "cname": "lz4",
                    "clevel": 5,
                    "shuffle": 1,
                }
            },
        },
        {"driver": "n5", "metadata": {"compression": {"type": "zstd"}}},
    ],
    ids=str,
)
def test_n5(tempdir_server: tuple[pathlib.Path, str], webdriver, spec):
    import tensorstore as ts

    tmp_path, server_url = tempdir_server

    shape = [10, 20, 30]

    a = np.arange(np.prod(shape), dtype=np.int32).reshape(shape)

    full_spec = {
        "kvstore": {
            "driver": "file",
            "path": str(tmp_path),
        }
    }
    full_spec.update(spec)

    store = ts.open(full_spec, create=True, dtype=ts.int32, shape=shape).result()
    store[...] = a

    with webdriver.viewer.txn() as s:
        s.layers.append(
            name="a", layer=neuroglancer.ImageLayer(source=f"n5://{server_url}")
        )

    vol = webdriver.viewer.volume("a").result()
    b = vol.read().result()
    np.testing.assert_equal(a, b)
