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
"""Tests the zarr datasource."""

import pathlib

import neuroglancer
import numpy as np
import pytest

TEST_DATA_DIR = (
    pathlib.Path(__file__).parent.parent.parent / "testdata" / "datasource" / "zarr"
)


@pytest.mark.parametrize(
    "spec",
    [
        {"driver": "zarr"},
        {"driver": "zarr", "metadata": {"compressor": {"id": "zlib"}}},
        {"driver": "zarr", "schema": {"chunk_layout": {"inner_order": [2, 1, 0]}}},
        {"driver": "zarr3"},
        {"driver": "zarr3", "schema": {"chunk_layout": {"inner_order": [2, 1, 0]}}},
        {"driver": "zarr3", "schema": {"dimension_units": ["nm", None, ""]}},
        {
            "driver": "zarr3",
            "schema": {
                "chunk_layout": {
                    "read_chunk": {"shape": [2, 3, 4]},
                    "write_chunk": {"shape": [6, 12, 20]},
                }
            },
        },
        {
            "driver": "zarr3",
            "schema": {
                "chunk_layout": {
                    "inner_order": [2, 0, 1],
                    "read_chunk": {"shape": [2, 3, 4]},
                    "write_chunk": {"shape": [6, 12, 20]},
                }
            },
        },
        {
            "driver": "zarr3",
            "schema": {
                "chunk_layout": {
                    "inner_order": [2, 0, 1],
                    "read_chunk": {"shape": [2, 3, 4]},
                    "write_chunk": {"shape": [6, 12, 20]},
                }
            },
            "kvstore": {"driver": "ocdbt"},
        },
        {
            "driver": "zarr3",
            "schema": {"chunk_layout": {"write_chunk": {"shape": [6, 12, 24]}}},
            "metadata": {
                "codecs": [
                    {"name": "transpose", "configuration": {"order": [0, 2, 1]}},
                    {
                        "name": "sharding_indexed",
                        "configuration": {
                            "chunk_shape": [2, 3, 4],
                            "index_codecs": [
                                {
                                    "name": "transpose",
                                    "configuration": {"order": [3, 1, 0, 2]},
                                },
                                {
                                    "name": "bytes",
                                    "configuration": {"endian": "little"},
                                },
                            ],
                            "codecs": [
                                {
                                    "name": "transpose",
                                    "configuration": {"order": [2, 1, 0]},
                                },
                                {
                                    "name": "bytes",
                                    "configuration": {"endian": "little"},
                                },
                                {"name": "gzip"},
                            ],
                        },
                    },
                ]
            },
        },
        {
            "driver": "zarr3",
            "schema": {"chunk_layout": {"write_chunk": {"shape": [6, 12, 24]}}},
            "metadata": {
                "codecs": [
                    {"name": "transpose", "configuration": {"order": [0, 2, 1]}},
                    {
                        "name": "sharding_indexed",
                        "configuration": {
                            "chunk_shape": [2, 3, 4],
                            "index_location": "start",
                            "index_codecs": [
                                {
                                    "name": "transpose",
                                    "configuration": {"order": [3, 1, 0, 2]},
                                },
                                {
                                    "name": "bytes",
                                    "configuration": {"endian": "little"},
                                },
                            ],
                            "codecs": [
                                {
                                    "name": "transpose",
                                    "configuration": {"order": [2, 1, 0]},
                                },
                                {
                                    "name": "bytes",
                                    "configuration": {"endian": "little"},
                                },
                                {"name": "gzip"},
                            ],
                        },
                    },
                ]
            },
        },
    ],
    ids=str,
)
def test_zarr(tempdir_server: tuple[pathlib.Path, str], webdriver, spec):
    import tensorstore as ts

    tmp_path, server_url = tempdir_server

    shape = [10, 20, 30]

    a = np.arange(np.prod(shape), dtype=np.int32).reshape(shape)

    file_spec = {
        "driver": "file",
        "path": str(tmp_path),
    }

    if "kvstore" in spec:
        full_spec = {**spec, "kvstore": {**spec["kvstore"], "base": file_spec}}
    else:
        full_spec = {**spec, "kvstore": file_spec}

    store = ts.open(full_spec, create=True, dtype=ts.int32, shape=shape).result()
    store[...] = a

    with webdriver.viewer.txn() as s:
        s.layers.append(name="a", layer=neuroglancer.ImageLayer(source=server_url))

    vol = webdriver.viewer.volume("a").result()
    b = vol.read().result()
    np.testing.assert_equal(a, b)


def test_zarr_corrupt(tempdir_server: tuple[pathlib.Path, str], webdriver):
    import tensorstore as ts

    tmp_path, server_url = tempdir_server

    shape = [10, 20, 30]

    a = np.arange(np.prod(shape), dtype=np.int32).reshape(shape)

    full_spec_for_chunks = {
        "driver": "zarr3",
        "kvstore": {
            "driver": "file",
            "path": str(tmp_path),
        },
        "metadata": {"codecs": ["zstd"]},
    }

    full_spec_for_metadata = {
        "driver": "zarr3",
        "kvstore": {
            "driver": "file",
            "path": str(tmp_path),
        },
        "metadata": {"codecs": ["gzip"]},
    }

    ts.open(full_spec_for_metadata, create=True, dtype=ts.int32, shape=shape).result()
    store = ts.open(
        full_spec_for_chunks,
        open=True,
        assume_metadata=True,
        dtype=ts.int32,
        shape=shape,
    ).result()
    store[...] = a

    with webdriver.viewer.txn() as s:
        s.layers.append(
            name="a", layer=neuroglancer.ImageLayer(source=f"zarr3://{server_url}")
        )

    vol = webdriver.viewer.volume("a").result()
    with pytest.raises(ValueError, match=".*Failed to decode gzip"):
        vol.read().result()


EXCLUDED_ZARR_V2_CASES = {
    ".zgroup",
    ".zattrs",
    ".zmetadata",
    # bool not supported by neuroglancer
    "1d.contiguous.b1",
    # float64 not supported by neuroglancer
    "1d.contiguous.f8",
    # LZ4 not supported by neuroglancer or tensorstore
    "1d.contiguous.lz4.i2",
    # S not supported by neuroglancer
    "1d.contiguous.S7",
    # U not supported by neuroglancer
    "1d.contiguous.U13.be",
    "1d.contiguous.U13.le",
    "1d.contiguous.U7",
    "2d.chunked.U7",
    # VLenUTF8 not supported by neuroglancer
    "3d.chunked.O",
}

EXCLUDED_ZARR_V3_CASES = {
    "zarr.json",
    # bool not supported by neuroglancer
    "1d.contiguous.b1",
    "1d.contiguous.compressed.sharded.b1",
    # float64 not supported by neuroglancer
    "1d.contiguous.f8",
    "1d.contiguous.compressed.sharded.f8",
}


@pytest.mark.parametrize(
    "driver,data_dir",
    [
        ("zarr", p)
        for p in TEST_DATA_DIR.glob("zarr_v2/from_zarr-python/data.zarr/*")
        if p.name != ".zgroup" and p.name not in EXCLUDED_ZARR_V2_CASES
    ]
    + [
        ("zarr3", p)
        for p in TEST_DATA_DIR.glob("zarr_v3/from_zarrita/data.zarr/*")
        if p.name not in EXCLUDED_ZARR_V3_CASES
    ],
    ids=str,
)
def test_data(driver: str, data_dir: pathlib.Path, static_file_server, webdriver):
    import tensorstore as ts

    server_url = static_file_server(data_dir)
    full_spec = {
        "driver": driver,
        "kvstore": {
            "driver": "file",
            "path": str(data_dir),
        },
    }
    store = ts.open(full_spec, open=True, read=True).result()
    a = store.read().result()

    with webdriver.viewer.txn() as s:
        s.layers.append(
            name="a", layer=neuroglancer.ImageLayer(source=f"zarr://{server_url}")
        )

    vol = webdriver.viewer.volume("a").result()
    b = vol.read().result()
    np.testing.assert_equal(a, b)
