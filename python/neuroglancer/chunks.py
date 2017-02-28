# @license
# Copyright 2016 Google Inc.
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

def encode_npz(subvol):
    """
    This file format is unrelated to np.savez
    We are just saving as .npy and the compressing
    using zlib. 
    The .npy format contains metadata indicate
    shape and dtype, in opositon to just doing np.tobytes
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

def encode_jpeg(subvol):
    shape = subvol.shape
    reshaped = subvol.reshape(shape[0] * shape[1], shape[2])
    img = Image.fromarray(reshaped)
    f = io.BytesIO()
    img.save(f, "JPEG")
    return f.getvalue()


def encode_raw(subvol):
    return subvol.tostring('C')