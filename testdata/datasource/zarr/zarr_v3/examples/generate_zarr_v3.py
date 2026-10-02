#!/usr/bin/env python3

import os

import numpy as np
import tensorstore as ts

example_dir = os.path.abspath(os.path.dirname(__file__))


def write_single_res():
    store = ts.open(
        {
            "driver": "zarr3",
            "kvstore": {
                "driver": "file",
                "path": os.path.join(example_dir, "single_res"),
            },
        },
        create=True,
        delete_existing=True,
        dtype=ts.uint16,
        shape=[6, 7],
        chunk_layout=ts.ChunkLayout(chunk_shape=[4, 5]),
    ).result()
    store[...] = np.arange(np.prod(store.shape), dtype=store.dtype.numpy_dtype).reshape(
        store.shape
    )


def write_transpose():
    # Interleaved channels: array dimensions are [t, c, y, x], but chunks are
    # stored as [t, y, x, c].  The permutation is not its own inverse.
    store = ts.open(
        {
            "driver": "zarr3",
            "kvstore": {
                "driver": "file",
                "path": os.path.join(example_dir, "transpose"),
            },
            "metadata": {
                "codecs": [
                    {"name": "transpose", "configuration": {"order": [0, 2, 3, 1]}},
                    {"name": "bytes", "configuration": {"endian": "little"}},
                ],
            },
        },
        create=True,
        delete_existing=True,
        dtype=ts.uint16,
        shape=[4, 3, 5, 6],
        chunk_layout=ts.ChunkLayout(chunk_shape=[4, 3, 5, 6]),
    ).result()
    store[...] = np.arange(np.prod(store.shape), dtype=store.dtype.numpy_dtype).reshape(
        store.shape
    )


write_single_res()
write_transpose()
