# @license
# Copyright 2017 The Neuroglancer Authors
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

import zlib
import io
import numpy as np
from PIL import Image

def encode(img_chunk, encoding):
  if encoding == "jpeg":
    return encode_jpeg(img_chunk)
  elif encoding == "npz":
    return encode_npz(img_chunk)
  elif encoding == "npz_uint8":
    chunk = img_chunk * 255
    chunk = chunk.astype(np.uint8)
    return encode_npz(chunk)
  elif encoding == "raw":
    return encode_raw(img_chunk)
  else:
    raise NotImplementedError(encoding)

def decode(filedata, encoding, shape=None, dtype=None):
  if (shape is None or dtype is None) and encoding is not 'npz':
    raise ValueError("Only npz encoding can omit shape and dtype arguments. {}".format(encoding))

  if filedata is None or len(filedata) == 0:
    return np.zeros(shape=shape, dtype=dtype)
  elif encoding == 'jpeg':
    return decode_jpeg(filedata, shape=shape, dtype=dtype)
  elif encoding == 'raw':
    return decode_raw(filedata, shape=shape, dtype=dtype)
  elif encoding == 'npz':
    return decode_npz(filedata)
  else:
    raise NotImplementedError(encoding)

def encode_jpeg(arr):
    assert arr.dtype == np.uint8

    # simulate multi-channel array for single channel arrays
    if len(arr.shape) == 3:
        arr = np.expand_dims(arr, 3) # add channels to end of x,y,z

    arr = arr.transpose((3,2,1,0)) # channels, z, y, x
    reshaped = arr.reshape(arr.shape[3] * arr.shape[2], arr.shape[1] * arr.shape[0])
    if arr.shape[0] == 1:
        img = Image.fromarray(reshaped, mode='L')
    elif arr.shape[0] == 3:
        img = Image.fromarray(reshaped, mode='RGB')
    else:
        raise ValueError("Number of image channels should be 1 or 3. Got: {}".format(arr.shape[3]))

    f = io.BytesIO()
    img.save(f, "JPEG")
    return f.getvalue()

def decode_jpeg(bytestring, shape=(64,64,64), dtype=np.uint8):
    img = Image.open(io.BytesIO(bytestring))
    data = np.array(img.getdata(), dtype=dtype)

    return data.reshape(shape[::-1]).T

def encode_npz(subvol):
    """
    This file format is unrelated to np.savez
    We are just saving as .npy and the compressing
    using zlib. 
    The .npy format contains metadata indicating
    shape and dtype, instead of np.tobytes which doesn't
    contain any metadata.
    """
    fileobj = io.BytesIO()
    if len(subvol.shape) == 3:
        subvol = np.expand_dims(subvol, 0)
    np.save(fileobj, subvol)
    cdz = zlib.compress(fileobj.getvalue())
    return cdz

def decode_npz(string):
    fileobj = io.BytesIO(zlib.decompress(string))
    return np.load(fileobj)

def encode_raw(subvol):
    return subvol.tostring('F')

def decode_raw(bytestring, shape=(64,64,64), dtype=np.uint32):
    return np.frombuffer(bytestring, dtype=dtype).reshape(shape[::-1]).T

