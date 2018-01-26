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

from __future__ import absolute_import, division, print_function

import collections
import threading

import numpy as np

from . import downsample, downsample_scales
from .chunks import encode_jpeg, encode_npz, encode_raw
from . import trackable_state
from .random_token import make_random_token


class MeshImplementationNotAvailable(Exception):
    pass

class MeshesNotSupportedForVolume(Exception):
    pass

class InvalidObjectIdForMesh(Exception):
    pass

DownsamplingScaleInfo = collections.namedtuple('DownsamplingScaleInfo', ['key',
                                                                         'downsample_factor',
                                                                         'voxel_size',
                                                                         'shape', ])


def get_scale_key(scale):
    return '%d,%d,%d' % scale


class LocalVolume(trackable_state.ChangeNotifier):
    def __init__(self,
                 data,
                 offset=None,
                 voxel_offset=None,
                 skeletons=None,
                 voxel_size=(1, 1, 1),
                 encoding='npz',
                 max_voxels_per_chunk_log2=None,
                 volume_type=None,
                 mesh_options=None,
                 downsampling='3d',
                 max_downsampling=downsample_scales.DEFAULT_MAX_DOWNSAMPLING,
                 max_downsampled_size=downsample_scales.DEFAULT_MAX_DOWNSAMPLED_SIZE,
                 max_downsampling_scales=downsample_scales.DEFAULT_MAX_DOWNSAMPLING_SCALES):
        """Initializes a LocalVolume.

        @param data: 3-d [z, y, x] array or 4-d [channel, z, y, x] array.

        @param downsampling: '3d' to use isotropic downsampling, '2d' to downsample separately in
            XY, XZ, and YZ, None to use no downsampling.

        @param max_downsampling: Maximum amount by which on-the-fly downsampling may reduce the
            volume of a chunk.  For example, 4x4x4 downsampling reduces the volume by 64.

        @param volume_type: either 'image' or 'segmentation'.  If not specified, guessed from the
            data type.

        @param voxel_size: Sequence [x, y, z] of floats.  Specifies the voxel size.

        @param mesh_options: A dict with the following keys specifying options for mesh
            simplification for 'segmentation' volumes:

                - max_quadrics_error: float.  Edge collapses with a larger associated quadrics error
                  than this amount are prohibited.  Set this to a negative number to disable mesh
                  simplification, and just use the original mesh produced by the marching cubes
                  algorithm.  Defaults to 1e6.  The effect of this value depends on the voxel_size.

                - max_normal_angle_deviation: float.  Edge collapses that change a triangle normal
                  by more than this angle are prohibited.  The angle is specified in degrees.
                  Defaults to 90.

                - lock_boundary_vertices: bool.  Retain all vertices along mesh surface boundaries,
                  which can only occur at the boundary of the volume.  Defaults to true.
        """
        super(LocalVolume, self).__init__()
        if hasattr(data, 'attrs'):
            if 'resolution' in data.attrs:
                if voxel_size is None:
                    voxel_size = tuple(data.attrs['resolution'])[::-1]
                if 'offset' in data.attrs:
                    if offset is None and voxel_offset is None:
                        offset = tuple(data.attrs['offset'])[::-1]
        voxel_size = np.array(voxel_size)
        self.token = make_random_token()
        self.max_voxels_per_chunk_log2 = max_voxels_per_chunk_log2
        self.data = data
        self.skeletons = skeletons
        if voxel_offset is not None:
            if offset is not None:
                raise ValueError('Must specify at most one of \'offset\' and \'voxel_offset\'.')
            voxel_offset = np.array(voxel_offset)
            offset = tuple(voxel_offset * voxel_size)
        if offset is None:
            offset = (0, 0, 0)
        self.offset = tuple(offset)
        self.data_type = np.dtype(data.dtype).name
        if self.data_type == 'float64':
            self.data_type = 'float32'
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

        self._mesh_generator = None
        self._mesh_generator_pending = None
        self._mesh_generator_lock = threading.Condition()
        self._mesh_options = mesh_options.copy() if mesh_options is not None else dict()


        voxel_size = np.array(voxel_size)
        self.voxel_size = voxel_size

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
                    numChannels=self.num_channels,
                    generation=self.change_count,
        )
        if self.max_voxels_per_chunk_log2 is not None:
            info['maxVoxelsPerChunkLog2'] = self.max_voxels_per_chunk_log2

        def get_scale_info(s):
            info = self.downsampling_scale_info[get_scale_key(s)]
            return dict(key=info.key,
                        offset=self.offset,
                        sizeInVoxels=info.shape,
                        voxelSize=info.voxel_size)

        if self.two_dimensional_scales is not None:
            info['twoDimensionalScales'] = [[get_scale_info(s) for s in level]
                                            for level in self.two_dimensional_scales]
        if self.three_dimensional_scales is not None:
            info['threeDimensionalScales'] = [get_scale_info(s)
                                              for s in self.three_dimensional_scales]
        if self.skeletons is not None:
            info['skeletonVertexAttributes'] = self.skeletons.get_vertex_attributes_spec()
        return info

    def get_encoded_subvolume(self, data_format, start, end, scale_key='1,1,1'):
        scale_info = self.downsampling_scale_info.get(scale_key)
        if scale_info is None:
            raise ValueError('Invalid scale.')
        shape = scale_info.shape
        downsample_factor = scale_info.downsample_factor
        for i in range(3):
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
        if subvol.dtype == 'float64':
            subvol = np.cast[np.float32](subvol)

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

    def get_object_mesh(self, object_id):
        mesh_generator = self._get_mesh_generator()
        data = mesh_generator.get_mesh(object_id)
        if data is None:
            raise InvalidObjectIdForMesh()
        return data

    def _get_mesh_generator(self):
        if self._mesh_generator is not None:
            return self._mesh_generator
        while True:
            with self._mesh_generator_lock:
                if self._mesh_generator is not None:
                    return self._mesh_generator
                if self._mesh_generator_pending is not None:
                    while self._mesh_generator is None:
                        self._mesh_generator_lock.wait()
                    if self._mesh_generator is not None:
                        return self._mesh_generator
                try:
                    from . import _neuroglancer
                except ImportError:
                    raise MeshImplementationNotAvailable()
                if not (self.num_channels == 1 and
                        (self.data_type == 'uint8' or self.data_type == 'uint16' or
                         self.data_type == 'uint32' or self.data_type == 'uint64')):
                    raise MeshesNotSupportedForVolume()
                pending_obj = object()
                self._mesh_generator_pending = pending_obj
            if len(self.data.shape) == 4:
                data = self.data[0, :, :, :]
            else:
                data = self.data
            new_mesh_generator = _neuroglancer.OnDemandObjectMeshGenerator(
                data, self.voxel_size, self.offset / self.voxel_size, **self._mesh_options)
            with self._mesh_generator_lock:
                if self._mesh_generator_pending is not pending_obj:
                    continue
                self._mesh_generator = new_mesh_generator
                self._mesh_generator_pending = False
                self._mesh_generator_lock.notify_all()
            return new_mesh_generator

    def __deepcopy__(self, memo):
        """Since this type is immutable, we don't need to deepcopy it.

        Actually deep copying would intefere with the use of deepcopy by JsonObjectWrapper.
        """
        return self

    def invalidate(self):
        """Mark the data invalidated.  Clients will refetch the volume."""
        with self._mesh_generator_lock:
            self._mesh_generator_pending = None
            self._mesh_generator = None
        self._dispatch_changed_callbacks()
