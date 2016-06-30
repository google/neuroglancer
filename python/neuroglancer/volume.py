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

from __future__ import absolute_import, division

import collections
import numpy as np

from .chunks import encode_jpeg, encode_npz, encode_raw
from .token import make_random_token
from . import downsample
from . import downsample_scales

DownsamplingScaleInfo = collections.namedtuple('DownsamplingScaleInfo', ['key',
                                                                         'downsample_factor',
                                                                         'voxel_size',
                                                                         'shape', ])


def get_scale_key(scale):
    return '%d,%d,%d' % scale


class ServedVolume(object):
    def __init__(self,
                 data,
                 offset=None,
                 voxel_offset=None,
                 voxel_size=(1, 1, 1),
                 encoding='npz',
                 max_voxels_per_chunk_log2=None,
                 volume_type=None,
                 downsampling='3d',
                 max_downsampling=downsample_scales.DEFAULT_MAX_DOWNSAMPLING,
                 max_downsampled_size=downsample_scales.DEFAULT_MAX_DOWNSAMPLED_SIZE,
                 max_downsampling_scales=downsample_scales.DEFAULT_MAX_DOWNSAMPLING_SCALES):
        """Initializes a ServedVolume.

    @param data: 3-d [z, y, x] array or 4-d [channel, z, y, x] array.

    @param downsampling: '3d' to use isotropic downsampling, '2d' to downsample
        separately in XY, XZ, and YZ, None to use no downsampling.

    @param max_downsampling: Maximum amount by which on-the-fly downsampling may
        reduce the volume of a chunk.  For example, 4x4x4 downsampling reduces
        the volume by 64.
    """
        self.token = make_random_token()
        self.max_voxels_per_chunk_log2 = max_voxels_per_chunk_log2
        self.data = data
        if voxel_offset is not None:
            if offset is not None:
                raise ValueError('Must specify at most one of \'offset\' and \'voxel_offset\'.')
            offset = tuple(voxel_offset * voxel_size)
        self.offset = offset
        self.data_type = data.dtype.name
        self.encoding = encoding
        if len(data.shape) == 3:
            self.num_channels = 1
            original_shape = data.shape[::-1]
        else:
            if len(data.shape) != 4:
                raise ValueError('data array must be 3- or 4-dimensional.')
            self.num_channels = data.shape[0]
            original_shape = data.shape[1:][::-1]
        original_shape = np.array(original_shape)
        if volume_type is None:
            if self.num_channels == 1 and (self.data_type == 'uint16' or
                                           self.data_type == 'uint32' or
                                           self.data_type == 'uint64'):
                volume_type = 'segmentation'
            else:
                volume_type = 'image'
        self.volume_type = volume_type

        voxel_size = np.array(voxel_size)

        self.two_dimensional_scales = None
        self.three_dimensional_scales = None

        if downsampling is None:
            downsampling_scales = self.three_dimensional_scales = [(1, 1, 1)]
        elif downsampling == '3d':
            self.three_dimensional_scales = downsample_scales.compute_near_isotropic_downsampling_scales(
                size=original_shape,
                voxel_size=voxel_size,
                dimensions_to_downsample=[0, 1, 2],
                max_downsampling=max_downsampling,
                max_downsampled_size=max_downsampled_size,
                max_scales=max_downsampling_scales)
            downsampling_scales = self.three_dimensional_scales
        elif downsampling == '2d':
            self.two_dimensional_scales = downsample_scales.compute_two_dimensional_near_isotropic_downsampling_scales(
                size=original_shape,
                voxel_size=voxel_size,
                max_downsampling=max_downsampling,
                max_downsampled_size=max_downsampled_size,
                max_scales=max_downsampling_scales)
            downsampling_scales = [s for level in self.two_dimensional_scales for s in level]
        downsampling_scale_info = self.downsampling_scale_info = {}
        for scale in downsampling_scales:
            info = DownsamplingScaleInfo(key=get_scale_key(scale),
                                         voxel_size=tuple(voxel_size * scale),
                                         downsample_factor=scale,
                                         shape=tuple(np.cast[int](np.ceil(original_shape / scale))))
            downsampling_scale_info[info.key] = info

    def info(self):
        info = dict(volumeType=self.volume_type,
                    dataType=self.data_type,
                    encoding=self.encoding,
                    numChannels=self.num_channels)
        if self.max_voxels_per_chunk_log2 is not None:
            info['maxVoxelsPerChunkLog2'] = self.max_voxels_per_chunk_log2

        def get_scale_info(s):
            info = self.downsampling_scale_info[get_scale_key(s)]
            return dict(key='%s/%s' % (self.token, info.key),
                        offset=self.offset,
                        sizeInVoxels=info.shape,
                        voxelSize=info.voxel_size)

        if self.two_dimensional_scales is not None:
            info['twoDimensionalScales'] = [[get_scale_info(s) for s in level]
                                            for level in self.two_dimensional_scales]
        if self.three_dimensional_scales is not None:
            info['threeDimensionalScales'] = [get_scale_info(s)
                                              for s in self.three_dimensional_scales]
        return info

    def get_encoded_subvolume(self, data_format, start, end, scale_key='1,1,1'):
        scale_info = self.downsampling_scale_info.get(scale_key)
        if scale_info is None:
            raise ValueError('Invalid scale.')
        shape = scale_info.shape
        downsample_factor = scale_info.downsample_factor
        for i in xrange(3):
            if end[i] < start[i] or start[i] < 0 or end[i] > shape[i]:
                raise ValueError('Out of bounds data request.')

        indexing_expr = tuple(np.s_[start[i] * downsample_factor[i]:end[i] * downsample_factor[i]]
                              for i in (2, 1, 0))
        if len(self.data.shape) == 3:
            full_downsample_factor = downsample_factor[::-1]
            subvol = self.data[indexing_expr]
        else:
            full_downsample_factor = (1, ) + downsample_factor[::-1]
            subvol = self.data[(np.s_[:], ) + indexing_expr]

        if downsample_factor != (1, 1, 1):
            if self.volume_type == 'image':
                subvol = downsample.downsample_with_averaging(subvol, full_downsample_factor)
            else:
                subvol = downsample.downsample_with_striding(subvol, full_downsample_factor)
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

    def get_object_mesh(self, object_id):  # pylint: disable=unused-argument,no-self-use
        raise ValueError('Meshes not yet supported.')
