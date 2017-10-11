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

import io
import zlib

import numpy as np
from PIL import Image


def encode_jpeg(subvol):
    shape = subvol.shape
    reshaped = subvol.reshape(shape[0] * shape[1], shape[2])
    img = Image.fromarray(reshaped)
    f = io.BytesIO()
    img.save(f, "JPEG")
    return f.getvalue()


def encode_npz(subvol):
    fileobj = io.BytesIO()
    if len(subvol.shape) == 3:
        subvol = np.expand_dims(subvol, 0)
    np.save(fileobj, subvol)
    cdz = zlib.compress(fileobj.getvalue())
    return cdz


def encode_raw(subvol):
    return subvol.tostring('C')
