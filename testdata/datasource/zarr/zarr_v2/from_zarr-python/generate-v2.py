# Copied from https://github.com/manzt/zarrita.js/blob/ac2559c310bd945470a2651526f730a505b2d5c9/fixtures/v2/generate-v2.py
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
import zarr
from numcodecs import LZ4, Blosc, VLenUTF8, Zlib, Zstd

shutil.rmtree("data.zarr", ignore_errors=True)

store = zarr.DirectoryStore("data.zarr")
root = zarr.open_group(store)
root.attrs["answer"] = 42

# 1d.contiguous.zlib.i2
root.create_dataset(
    "1d.contiguous.zlib.i2",
    data=[1, 2, 3, 4],
    dtype="i2",
    chunks=(4,),
    compressor=Zlib(),
)

# 1d.contiguous.blosc.i2
root.create_dataset(
    "1d.contiguous.blosc.i2",
    data=[1, 2, 3, 4],
    dtype="i2",
    chunks=(4,),
    compressor=Blosc(),
)

# 1d.contiguous.lz4.i2
root.create_dataset(
    "1d.contiguous.lz4.i2", data=[1, 2, 3, 4], dtype="i2", chunks=(4,), compressor=LZ4()
)

# 1d.contiguous.zstd.i2
root.create_dataset(
    "1d.contiguous.zstd.i2",
    data=[1, 2, 3, 4],
    dtype="i2",
    chunks=(4,),
    compressor=Zstd(),
)

# 1d.contiguous.raw.i2
root.create_dataset(
    "1d.contiguous.raw.i2", data=[1, 2, 3, 4], dtype="i2", chunks=(4,), compressor=None
)


# 1d.contiguous.i4
root.create_dataset("1d.contiguous.i4", data=[1, 2, 3, 4], dtype="i4", chunks=(4,))

# 1d.contiguous.u1
root.create_dataset("1d.contiguous.u1", data=[255, 0, 255, 0], dtype="u1", chunks=(4,))

# 1d.contiguous.<f4
root.create_dataset(
    "1d.contiguous.f4.le", data=[-1000.5, 0, 1000.5, 0], dtype="<f4", chunks=(4,)
)

# 1d.contiguous.>f4
root.create_dataset(
    "1d.contiguous.f4.be", data=[-1000.5, 0, 1000.5, 0], dtype=">f4", chunks=(4,)
)

# 1d.contiguous.f8
root.create_dataset(
    "1d.contiguous.f8", data=[1.5, 2.5, 3.5, 4.5], dtype="f8", chunks=(4,)
)

# 1d.contiguous.<U13
root.create_dataset(
    "1d.contiguous.U13.le", data=["a", "b", "cc", "d"], dtype="<U13", chunks=(4,)
)

# 1d.contiguous.>U13
root.create_dataset(
    "1d.contiguous.U13.be", data=["a", "b", "cc", "d"], dtype=">U13", chunks=(4,)
)

# 1d.contiguous.U7
root.create_dataset(
    "1d.contiguous.U7", data=["a", "b", "cc", "d"], dtype="U7", chunks=(4,)
)

# 1d.contiguous.S7
root.create_dataset(
    "1d.contiguous.S7", data=["a", "b", "cc", "d"], dtype="S7", chunks=(4,)
)

# 1d.contiguous.b1
root.create_dataset(
    "1d.contiguous.b1", data=[True, False, True, False], dtype="b1", chunks=(4,)
)


# 1d.chunked.i2
root.create_dataset("1d.chunked.i2", data=[1, 2, 3, 4], dtype="i2", chunks=(2,))

# 1d.chunked.ragged.i2
root.create_dataset(
    "1d.chunked.ragged.i2", data=[1, 2, 3, 4, 5], dtype="i2", chunks=(2,)
)


# 2d.contiguous.i2
root.create_dataset(
    "2d.contiguous.i2", data=[[1, 2], [3, 4]], dtype="i2", chunks=(2, 2)
)

# 2d.chunked.i2
root.create_dataset("2d.chunked.i2", data=[[1, 2], [3, 4]], dtype="i2", chunks=(1, 1))

# 2d.chunked.U7
root.create_dataset(
    "2d.chunked.U7", data=[["a", "b"], ["cc", "d"]], dtype="U7", chunks=(1, 1)
)

# 2d.chunked.ragged.i2
root.create_dataset(
    "2d.chunked.ragged.i2",
    data=[[1, 2, 3], [4, 5, 6], [7, 8, 9]],
    dtype="i2",
    chunks=(2, 2),
)

# 3d.contiguous.i2
root.create_dataset(
    "3d.contiguous.i2",
    data=np.arange(27).reshape(3, 3, 3),
    dtype="i2",
    chunks=(3, 3, 3),
)

# 3d.chunked.i2
root.create_dataset(
    "3d.chunked.i2", data=np.arange(27).reshape(3, 3, 3), dtype="i2", chunks=(1, 1, 1)
)

# 3d.chunked.mixed.i2.C
root.create_dataset(
    "3d.chunked.mixed.i2.C",
    data=np.arange(27).reshape(3, 3, 3),
    dtype="i2",
    chunks=(3, 3, 1),
)

# 3d.chunked.mixed.i2.F
arr = root.create_dataset(
    "3d.chunked.mixed.i2.F",
    data=np.arange(27).reshape(3, 3, 3),
    order="F",
    dtype="i2",
    chunks=(3, 3, 1),
)


# 3d.chunked.o
data = np.array(
    [
        [["a", "aa"], ["aaa", "aaaa"]],
        [["b", "bb"], ["bbb", "bbbb"]],
    ],
    dtype=object,
)
root.create_dataset(
    "3d.chunked.O",
    data=data,
    object_codec=VLenUTF8(),
    dtype="O",
    chunks=(1, 1, 2),
)

zarr.consolidate_metadata(store)
