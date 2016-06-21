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

from __future__ import absolute_import

import numpy as np

from .token import make_random_token
from .chunks import encode_jpeg, encode_npz, encode_raw

class ServedVolume(object):
  def __init__(self,
               data,
               offset=(0, 0, 0),
               voxel_size=(1, 1, 1),
               encoding='npz',
               chunk_data_sizes=None,
               volume_type=None):
    """Initializes a ServedVolume.

    @param data 3-d [z, y, x] array or 4-d [channel, z, y, x] array.
    """
    self.token = make_random_token()
    if len(data.shape) == 3:
      self.num_channels = 1
      self.shape = data.shape[::-1]
    else:
      if len(data.shape) != 4:
        raise ValueError('data array must be 3- or 4-dimensional.')
      self.num_channels = data.shape[0]
      self.shape = data.shape[1:][::-1]

    self.data = data
    self.voxel_size = voxel_size
    self.offset = offset
    self.data_type = data.dtype.name
    self.encoding = encoding
    if chunk_data_sizes is not None:
      arr = np.array(chunk_data_sizes)
      if (len(arr.shape) != 2 or arr.shape[1] != 3 or np.any(arr < 1) or
          np.any(np.cast[int](arr) != arr)):
        raise ValueError(
            'chunk_data_sizes must be a sequence of 3-element non-negative integers')
    self.chunk_data_sizes = chunk_data_sizes
    if volume_type is None:
      if self.num_channels == 1 and (self.data_type == 'uint16' or
                                     self.data_type == 'uint32' or
                                     self.data_type == 'uint64'):
        volume_type = 'segmentation'
      else:
        volume_type = 'image'
    self.volume_type = volume_type

  def info(self):
    upper_voxel_bound = tuple(np.array(self.offset) + np.array(self.shape))
    info = dict(volumeType=self.volume_type,
                dataType=self.data_type,
                encoding=self.encoding,
                numChannels=self.num_channels,
                scales=[
                    dict(key=self.token,
                         lowerVoxelBound=self.offset,
                         upperVoxelBound=upper_voxel_bound,
                         voxelSize=self.voxel_size),
                ])
    if self.chunk_data_sizes is not None:
      info['chunkDataSizes'] = self.chunk_data_sizes
    return info

  def get_encoded_subvolume(self, data_format, start, end):
    offset = self.offset
    shape = self.shape
    for i in xrange(3):
      if end[i] < start[i] or offset[i] > start[i] or end[i] - offset[i] > shape[i]:
        raise ValueError('Out of bounds data request.')

    indexing_expr = tuple(np.s_[start[i] - offset[i]:end[i] - offset[i]] for i in (2,1,0))
    if len(self.data.shape) == 3:
      subvol = self.data[indexing_expr]
    else:
      subvol = self.data[(np.s_[:],) + indexing_expr]
    content_type = 'application/octet-stream'
    if data_format == 'jpeg':
      data = encode_jpeg(subvol)
      content_type = 'image/jpeg'
    elif data_format == 'npz':
      data = encode_npz(subvol)
    elif data_format == 'raw':
      data = encode_raw(subvol)
    else:
      raise ValueError('Invalid data format requested.')
    return data, content_type

  def get_object_mesh(self, object_id):
    raise ValueError('Meshes not yet supported.')
