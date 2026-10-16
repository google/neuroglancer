#!/usr/bin/env python3
# @license
# Copyright 2025 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
#
# Generates zarr v3 test stores that exercise the `reshape` + `jpegxl` codec
# chain (plus `transpose`), and a manifest of expected decoded values used by
# tests/codec/jpegxl_zarr.browser_test.ts.
#
# To keep the number of committed files small, each array is written as a single
# `sharding_indexed` shard: one shard file (plus zarr.json) per array, holding
# all sub-chunks.  Each sub-chunk is C-order reshaped/transposed to the native
# JPEG XL image shape (`[frames, height, width, samples]`, unit axes dropped)
# and JPEG XL encoded losslessly, so the decoded samples are bit-exact.
#
# Requires numpy + imagecodecs (with JPEG XL support).  Run with a Python that
# has them installed, e.g. the zarr-vectors-tools venv:
#
#   .../zarr-vectors-tools/.venv/bin/python \
#       build_tools/generate_zarr_jpegxl_fixtures.py

import itertools
import json
import os
import shutil
import struct

import numpy as np
import imagecodecs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "testdata", "zarr_jpegxl")

# Castagnoli CRC-32C (reflected), as used by the zarr `crc32c` codec.
def crc32c(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82F63B78 if (crc & 1) else 0)
    return crc ^ 0xFFFFFFFF


def chunk_image(chunk_c_order, image_shape, transpose_order):
    """Apply the (optional) transpose + reshape that the codec chain applies
    before jpegxl, yielding the native JXL image array."""
    arr = chunk_c_order
    if transpose_order is not None:
        arr = np.transpose(arr, transpose_order)
    return np.ascontiguousarray(arr).reshape(image_shape)


def encode_chunk(chunk_c_order, image_shape, transpose_order) -> bytes:
    image = chunk_image(chunk_c_order, image_shape, transpose_order)
    return imagecodecs.jpegxl_encode(image, lossless=True)


def build_shard(index_entries, data_bytes):
    """Build a sharding_indexed shard with the index at the end, encoded with
    the default index codecs (bytes little-endian + crc32c)."""
    flat = []
    for offset, length in index_entries:
        flat.append(offset)
        flat.append(length)
    index_bytes = struct.pack("<%dQ" % len(flat), *flat)
    index_bytes += struct.pack("<I", crc32c(index_bytes))
    return data_bytes + index_bytes


def write_store(
    name,
    shape,
    sub_chunk_shape,
    dtype_name,
    dimension_names,
    dimension_units,
    inner_codecs,
    image_shape_of,
    data,
    manifest_chunks,
    transpose_order=None,
):
    store_dir = os.path.join(OUT_DIR, name)
    os.makedirs(store_dir)

    codecs = [
        {
            "name": "sharding_indexed",
            "configuration": {
                "chunk_shape": list(sub_chunk_shape),
                "codecs": inner_codecs,
                "index_codecs": [
                    {"name": "bytes", "configuration": {"endian": "little"}},
                    {"name": "crc32c"},
                ],
                "index_location": "end",
            },
        }
    ]

    # A single shard covers the whole array.
    zarr_json = {
        "zarr_format": 3,
        "node_type": "array",
        "shape": list(shape),
        "data_type": dtype_name,
        "chunk_grid": {
            "name": "regular",
            "configuration": {"chunk_shape": list(shape)},
        },
        "chunk_key_encoding": {
            "name": "default",
            "configuration": {"separator": "/"},
        },
        "fill_value": 0,
        "codecs": codecs,
        "dimension_names": list(dimension_names),
        "attributes": {"dimension_units": list(dimension_units)},
    }
    with open(os.path.join(store_dir, "zarr.json"), "w") as f:
        json.dump(zarr_json, f, indent=2)

    sub_grid = [shape[i] // sub_chunk_shape[i] for i in range(len(shape))]
    data_parts = []
    index_entries = []
    manifest_entries = []
    cursor = 0
    for grid_index in itertools.product(*[range(g) for g in sub_grid]):
        slices = tuple(
            slice(gi * cs, gi * cs + cs)
            for gi, cs in zip(grid_index, sub_chunk_shape)
        )
        chunk = data[slices]
        assert tuple(chunk.shape) == tuple(sub_chunk_shape)
        enc = encode_chunk(chunk, image_shape_of(sub_chunk_shape), transpose_order)
        # Sanity check: imagecodecs must round-trip the encoded image losslessly.
        image = chunk_image(chunk, image_shape_of(sub_chunk_shape), transpose_order)
        dec = imagecodecs.jpegxl_decode(enc)
        assert np.array_equal(dec.reshape(-1), image.reshape(-1)), (name, grid_index)
        index_entries.append((cursor, len(enc)))
        cursor += len(enc)
        data_parts.append(enc)
        if grid_index in manifest_chunks:
            manifest_entries.append(
                {"subChunk": list(grid_index), "values": chunk.reshape(-1).tolist()}
            )

    shard = build_shard(index_entries, b"".join(data_parts))
    shard_key = ["c"] + ["0"] * len(shape)
    shard_path = os.path.join(store_dir, *shard_key)
    os.makedirs(os.path.dirname(shard_path), exist_ok=True)
    with open(shard_path, "wb") as f:
        f.write(shard)

    return {
        "dir": name,
        "shardKey": "/".join(shard_key),
        "chunks": manifest_entries,
    }


def main():
    if os.path.exists(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR)

    manifest = {}

    # --- Array 1: 5-D [t, z, y, x, c] uint8, sub-chunk [10,5,5,5,3] reshaped to
    # the 50-frame RGB image [f=t*z, y, x, c]. ---
    shape1 = (10, 10, 10, 10, 3)
    chunk1 = (10, 5, 5, 5, 3)
    data1 = (np.arange(int(np.prod(shape1)), dtype=np.uint8) % 251).reshape(shape1)
    manifest["array1_fzyxc_u8"] = write_store(
        name="array1_fzyxc_u8",
        shape=shape1,
        sub_chunk_shape=chunk1,
        dtype_name="uint8",
        dimension_names=["t", "z", "y", "x", "c"],
        dimension_units=["1s", "1um", "1um", "1um", ""],
        inner_codecs=[
            {"name": "reshape", "configuration": {"shape": [[0, 1], [2], [3], [4]]}},
            {"name": "jpegxl", "configuration": {}},
        ],
        image_shape_of=lambda cs: (cs[0] * cs[1], cs[2], cs[3], cs[4]),
        data=data1,
        manifest_chunks={(0, 0, 0, 0, 0), (0, 1, 1, 1, 0)},
    )

    # --- Array 2: 5-D [t, c, x, y, z] float32 (float16 requested, but
    # neuroglancer has no float16 data type), sub-chunk [1,1,5,5,5] reshaped to
    # the 5-frame grayscale image [x, y, z]. ---
    shape2 = (10, 3, 10, 10, 10)
    chunk2 = (1, 1, 5, 5, 5)
    n2 = int(np.prod(shape2))
    data2 = ((np.arange(n2, dtype=np.float32) % 97) * 0.03125 - 1.5).reshape(shape2)
    manifest["array2_fxy_f32"] = write_store(
        name="array2_fxy_f32",
        shape=shape2,
        sub_chunk_shape=chunk2,
        dtype_name="float32",
        dimension_names=["t", "c", "x", "y", "z"],
        dimension_units=["1s", "", "1um", "1um", "1um"],
        inner_codecs=[
            {"name": "reshape", "configuration": {"shape": [[2], [3], [4]]}},
            {"name": "jpegxl", "configuration": {}},
        ],
        image_shape_of=lambda cs: (cs[2], cs[3], cs[4]),
        data=data2,
        manifest_chunks={(0, 0, 0, 0, 0), (5, 2, 1, 1, 1), (9, 2, 1, 1, 1)},
    )

    # --- Array 3: [x, y, c] uint16, sub-chunk [5,5,3] encoded directly as an
    # [h, w, c] RGB image (no reshape). ---
    shape3 = (10, 10, 3)
    chunk3 = (5, 5, 3)
    data3 = (np.arange(int(np.prod(shape3)), dtype=np.uint16) * 211 % 65521).reshape(
        shape3
    )
    manifest["array3_xyc_u16"] = write_store(
        name="array3_xyc_u16",
        shape=shape3,
        sub_chunk_shape=chunk3,
        dtype_name="uint16",
        dimension_names=["x", "y", "c"],
        dimension_units=["1um", "1um", ""],
        inner_codecs=[{"name": "jpegxl", "configuration": {}}],
        image_shape_of=lambda cs: (cs[0], cs[1], cs[2]),
        data=data3,
        manifest_chunks={(0, 0, 0), (1, 1, 0)},
    )

    # --- Array 4: [x, y, c] uint8, sub-chunk [5,5,1] reshaped to the grayscale
    # image [x, y]. ---
    shape4 = (10, 10, 3)
    chunk4 = (5, 5, 1)
    data4 = (np.arange(int(np.prod(shape4)), dtype=np.uint8) % 251).reshape(shape4)
    manifest["array4_xy_u8"] = write_store(
        name="array4_xy_u8",
        shape=shape4,
        sub_chunk_shape=chunk4,
        dtype_name="uint8",
        dimension_names=["x", "y", "c"],
        dimension_units=["1um", "1um", ""],
        inner_codecs=[
            {"name": "reshape", "configuration": {"shape": [[0], [1]]}},
            {"name": "jpegxl", "configuration": {}},
        ],
        image_shape_of=lambda cs: (cs[0], cs[1]),
        data=data4,
        manifest_chunks={(0, 0, 0), (1, 1, 2)},
    )

    # --- Array 5: [t, x, y, c, z] uint8 with the channel axis *between* the
    # spatial axes. A transpose reorders [t,x,y,c,z] -> [t,c,z,x,y] so the
    # non-spatial axes are outermost, a reshape merges them into frames
    # [t*c*z, x, y], and jpegxl encodes each as a grayscale frame (f,x,y). On
    # decode the channel axis returns to the middle of the spatial axes. ---
    shape5 = (2, 10, 10, 3, 2)
    chunk5 = (2, 5, 5, 3, 2)
    data5 = (np.arange(int(np.prod(shape5)), dtype=np.uint8) % 251).reshape(shape5)
    manifest["array5_txycz_transpose_u8"] = write_store(
        name="array5_txycz_transpose_u8",
        shape=shape5,
        sub_chunk_shape=chunk5,
        dtype_name="uint8",
        dimension_names=["t", "x", "y", "c", "z"],
        dimension_units=["1s", "1um", "1um", "", "1um"],
        inner_codecs=[
            {"name": "transpose", "configuration": {"order": [0, 3, 4, 1, 2]}},
            {"name": "reshape", "configuration": {"shape": [[0, 1, 2], [3], [4]]}},
            {"name": "jpegxl", "configuration": {}},
        ],
        image_shape_of=lambda cs: (cs[0] * cs[3] * cs[4], cs[1], cs[2]),
        transpose_order=(0, 3, 4, 1, 2),
        data=data5,
        manifest_chunks={(0, 0, 0, 0, 0), (0, 1, 1, 0, 0)},
    )

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))

    print(f"Wrote sharded zarr v3 JPEG XL fixtures to {OUT_DIR}")


if __name__ == "__main__":
    main()
