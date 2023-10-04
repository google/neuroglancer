# Copied from https://github.com/manzt/zarrita.js/blob/ac2559c310bd945470a2651526f730a505b2d5c9/fixtures/v3/generate-v3.py
#
# MIT License
#
# Copyright (c) 2020 Trevor Manz
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

import shutil

import numpy as np
import zarrita

shutil.rmtree("data.zarr", ignore_errors=True)

store = zarrita.LocalStore("data.zarr")
zarrita.Group.create(store)

# 1d.contiguous.gzip.i2
a = zarrita.Array.create(
    store / "1d.contiguous.gzip.i2",
    dtype="int16",
    shape=(4,),
    chunk_shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.gzip_codec(),
    ],
)
a[:] = [1, 2, 3, 4]

# 1d.contiguous.blosc.i2
a = zarrita.Array.create(
    store / "1d.contiguous.blosc.i2",
    dtype="int16",
    shape=(4,),
    chunk_shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [1, 2, 3, 4]

# 1d.contiguous.raw.i2
a = zarrita.Array.create(
    store / "1d.contiguous.raw.i2",
    dtype="int16",
    shape=(4,),
    chunk_shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(),
    ],
)
a[:] = [1, 2, 3, 4]


# 1d.contiguous.i4
a = zarrita.Array.create(
    store / "1d.contiguous.i4",
    dtype="int32",
    chunk_shape=(4,),
    shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [1, 2, 3, 4]


# 1d.contiguous.u1
a = zarrita.Array.create(
    store / "1d.contiguous.u1",
    dtype="uint8",
    chunk_shape=(4,),
    shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [255, 0, 255, 0]


# 1d.contiguous.<f4
a = zarrita.Array.create(
    store / "1d.contiguous.f4.le",
    dtype="float32",
    chunk_shape=(4,),
    shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [-1000.5, 0, 1000.5, 0]

# 1d.contiguous.>f4
a = zarrita.Array.create(
    store / "1d.contiguous.f4.be",
    dtype="float32",
    chunk_shape=(4,),
    shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(endian="big"),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [-1000.5, 0, 1000.5, 0]

# 1d.contiguous.f8
a = zarrita.Array.create(
    store / "1d.contiguous.f8",
    dtype="float64",
    chunk_shape=(4,),
    shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [1.5, 2.5, 3.5, 4.5]


# 1d.contiguous.b1
a = zarrita.Array.create(
    store / "1d.contiguous.b1",
    dtype="bool",
    chunk_shape=(4,),
    shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [True, False, True, False]


# 1d.chunked.i2
a = zarrita.Array.create(
    store / "1d.chunked.i2",
    dtype="int16",
    chunk_shape=(2,),
    shape=(4,),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [1, 2, 3, 4]

# 1d.chunked.ragged.i2
a = zarrita.Array.create(
    store / "1d.chunked.ragged.i2",
    dtype="int16",
    chunk_shape=(2,),
    shape=(5,),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [1, 2, 3, 4, 5]

# 2d.contiguous.i2
a = zarrita.Array.create(
    store / "2d.contiguous.i2",
    dtype="int16",
    chunk_shape=(2, 2),
    shape=(2, 2),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [[1, 2], [3, 4]]

# 2d.chunked.i2
a = zarrita.Array.create(
    store / "2d.chunked.i2",
    dtype="int16",
    chunk_shape=(1, 1),
    shape=(2, 2),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [[1, 2], [3, 4]]

# 2d.chunked.ragged.i2
a = zarrita.Array.create(
    store / "2d.chunked.ragged.i2",
    dtype="int16",
    chunk_shape=(2, 2),
    shape=(3, 3),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]

# 3d.contiguous.i2
a = zarrita.Array.create(
    store / "3d.contiguous.i2",
    dtype="int16",
    chunk_shape=(3, 3, 3),
    shape=(3, 3, 3),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = np.arange(27).reshape(3, 3, 3)

# 3d.chunked.i2
a = zarrita.Array.create(
    store / "3d.chunked.i2",
    dtype="int16",
    chunk_shape=(1, 1, 1),
    shape=(3, 3, 3),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = np.arange(27).reshape(3, 3, 3)

# 3d.chunked.mixed.i2.C
a = zarrita.Array.create(
    store / "3d.chunked.mixed.i2.C",
    dtype="int16",
    chunk_shape=(3, 3, 1),
    shape=(3, 3, 3),
    codecs=[
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = np.arange(27).reshape(3, 3, 3)

# 3d.chunked.mixed.i2.F
a = zarrita.Array.create(
    store / "3d.chunked.mixed.i2.F",
    dtype="int16",
    chunk_shape=(3, 3, 1),
    shape=(3, 3, 3),
    codecs=[
        zarrita.codecs.transpose_codec(order="F"),
        zarrita.codecs.bytes_codec(),
        zarrita.codecs.blosc_codec(typesize=4),
    ],
)
a[:] = np.arange(27).reshape(3, 3, 3)

#####

# 1d.contiguous.compressed.sharded.i2
data = np.array([1, 2, 3, 4], dtype="i2")
path = "1d.contiguous.compressed.sharded.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(4,),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(4,),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:] = data

# 1d.contiguous.compressed.sharded.i4
data = np.array([1, 2, 3, 4], dtype="i4")
path = "1d.contiguous.compressed.sharded.i4"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(4,),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(4,),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:] = data

# 1d.contiguous.compressed.sharded.u1
data = np.array([255, 0, 255, 0], dtype="u1")
path = "1d.contiguous.compressed.sharded.u1"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(4,),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(4,),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:] = data


# 1d.contiguous.compressed.sharded.<f4
data = np.array([-1000.5, 0, 1000.5, 0], dtype="f4")
path = "1d.contiguous.compressed.sharded.f4"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(4,),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(4,),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:] = data

# 1d.contiguous.compressed.sharded.f8
data = np.array([1.5, 2.5, 3.5, 4.5], dtype="f8")
path = "1d.contiguous.compressed.sharded.f8"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(4,),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(4,),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:] = data


# 1d.contiguous.compressed.sharded.b1
data = np.array([True, False, True, False], dtype="b1")
path = "1d.contiguous.compressed.sharded.b1"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype="bool",
    chunk_shape=(4,),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(4,),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:] = data

# 1d.chunked.compressed.sharded.i2
data = np.array([1, 2, 3, 4], dtype="i2")
path = "1d.chunked.compressed.sharded.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(2,),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(1,),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:] = data

# 1d.chunked.filled.compressed.sharded.i2
data = np.array([1, 2, 0, 0], dtype="i2")
path = "1d.chunked.filled.compressed.sharded.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(2,),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(1,),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:] = data

# # 1d.chunked.ragged.compressed.sharded.i2 (TypeError: 'int' object is not iterable)
# data = array([1, 2, 3, 4, 5], dtype="i2")
# path = "1d.chunked.ragged.compressed.sharded.i2"
# a = zarrita.Array.create(
#     store / path,
#     shape=data.shape,
#     dtype=data.dtype,
#     chunk_shape=(2,),
#     codecs=[
#         zarrita.codecs.sharding_codec(
#             chunk_shape=(1,),
#             codecs=[
#                 zarrita.codecs.blosc_codec(
#                     typesize=data.dtype.itemsize, cname="gzip"
#                 )
#             ],
#         )
#     ],
# )
# a[:] = data

# 2d.contiguous.compressed.sharded.i2
data = np.arange(1, 5, dtype="i2").reshape(2, 2)
path = "2d.contiguous.compressed.sharded.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(2, 2),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(2, 2),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:, :] = data

# 2d.chunked.compressed.sharded.filled.i2
data = np.arange(16, dtype="i2").reshape(4, 4)
path = "2d.chunked.compressed.sharded.filled.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(2, 2),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(1, 1),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:, :] = data

# 2d.chunked.compressed.sharded.i2
data = np.arange(16, dtype="i2").reshape(4, 4) + 1
path = "2d.chunked.compressed.sharded.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(2, 2),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(1, 1),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:, :] = data

# 2d.chunked.ragged.compressed.sharded.i2
data = np.arange(1, 10, dtype="i2").reshape(3, 3)
path = "2d.chunked.ragged.compressed.sharded.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(2, 2),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(1, 1),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:, :] = data


# 3d.contiguous.compressed.sharded.i2
data = np.arange(27, dtype="i2").reshape(3, 3, 3)
path = "3d.contiguous.compressed.sharded.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(3, 3, 3),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(3, 3, 3),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:, :, :] = data

# 3d.chunked.compressed.sharded.i2
data = np.arange(64, dtype="i2").reshape(4, 4, 4)
path = "3d.chunked.compressed.sharded.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(2, 2, 2),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(1, 1, 1),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:, :, :] = data

# 3d.chunked.mixed.compressed.sharded.i2
data = np.arange(27, dtype="i2").reshape(3, 3, 3)
path = "3d.chunked.mixed.compressed.sharded.i2"
a = zarrita.Array.create(
    store / path,
    shape=data.shape,
    dtype=data.dtype,
    chunk_shape=(3, 3, 3),
    codecs=[
        zarrita.codecs.sharding_codec(
            chunk_shape=(3, 3, 1),
            codecs=[zarrita.codecs.bytes_codec(), zarrita.codecs.gzip_codec()],
        )
    ],
)
a[:, :, :] = data
