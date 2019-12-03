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
import math
import threading

import numpy as np
import six

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

class LocalVolume(trackable_state.ChangeNotifier):
    def __init__(self,
                 data,
                 dimensions,
                 volume_type=None,
                 voxel_offset=None,
                 encoding='npz',
                 max_voxels_per_chunk_log2=None,
                 mesh_options=None,
                 downsampling='3d',
                 chunk_layout=None,
                 max_downsampling=downsample_scales.DEFAULT_MAX_DOWNSAMPLING,
                 max_downsampled_size=downsample_scales.DEFAULT_MAX_DOWNSAMPLED_SIZE,
                 max_downsampling_scales=downsample_scales.DEFAULT_MAX_DOWNSAMPLING_SCALES):
        """Initializes a LocalVolume.

        @param data: Source data.

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
        self.token = make_random_token()
        self.data = data
        self.shape = data.shape
        rank = self.rank = len(self.shape)
        if rank != dimensions.rank:
            raise ValueError('rank of data (%d) must match rank of coordinate space (%d)' %
                             (rank, dimensions.rank))
        if voxel_offset is None:
            voxel_offset = np.zeros(rank, dtype=np.int64)
        else:
            voxel_offset = np.array(voxel_offset, dtype=np.int64)
        if voxel_offset.shape != (rank,):
            raise ValueError('voxel_offset must have shape of (%d,)' % (rank,))
        self.voxel_offset = voxel_offset
        self.dimensions = dimensions
        self.data_type = np.dtype(data.dtype).name
        if self.data_type == 'float64':
            self.data_type = 'float32'
        self.encoding = encoding
        if volume_type is None:
            if self.rank == 3 and (self.data_type == 'uint16' or
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

        self.max_voxels_per_chunk_log2 = max_voxels_per_chunk_log2

        self.downsampling_layout = downsampling
        if chunk_layout is None:
            if downsampling == '2d':
                chunk_layout = 'flat'
            else:
                chunk_layout = 'isotropic'
        self.chunk_layout = chunk_layout

        self.max_downsampling = max_downsampling
        self.max_downsampled_size = max_downsampled_size
        self.max_downsampling_scales = max_downsampling_scales

    def info(self):
        info = dict(dataType=self.data_type,
                    encoding=self.encoding,
                    generation=self.change_count,
                    coordinateSpace=self.dimensions.to_json(),
                    shape=self.shape,
                    volumeType=self.volume_type,
                    voxelOffset=self.voxel_offset,
                    chunkLayout=self.chunk_layout,
                    downsamplingLayout=self.downsampling_layout,
                    maxDownsampling=None if math.isinf(self.max_downsampling) else self.max_downsampling,
                    maxDownsampledSize=None if math.isinf(self.max_downsampled_size) else self.max_downsampled_size,
                    maxDownsamplingScales=None if math.isinf(self.max_downsampling_scales) else self.max_downsampling_scales,
        )
        if self.max_voxels_per_chunk_log2 is not None:
            info['maxVoxelsPerChunkLog2'] = self.max_voxels_per_chunk_log2

        return info

    def get_encoded_subvolume(self, data_format, start, end, scale_key):
        rank = self.rank
        if len(start) != rank or len(end) != rank:
            raise ValueError('Invalid request')
        downsample_factor = np.array(scale_key.split(','), dtype=np.int64)
        if (len(downsample_factor) != rank or np.any(downsample_factor < 1)
            or np.any(downsample_factor > self.max_downsampling)
            or np.prod(downsample_factor) > self.max_downsampling):
            raise ValueError('Invalid downsampling factor.')
        downsampled_shape = np.cast[np.int64](np.ceil(self.shape / downsample_factor))
        if np.any(end < start) or np.any(start < 0) or np.any(end > downsampled_shape):
            raise ValueError('Out of bounds data request.')

        indexing_expr = tuple(np.s_[start[i] * downsample_factor[i]:end[i] * downsample_factor[i]]
                              for i in range(rank))
        subvol = self.data[indexing_expr]
        if subvol.dtype == 'float64':
            subvol = np.cast[np.float32](subvol)

        if np.any(downsample_factor != 1):
            if self.volume_type == 'image':
                subvol = downsample.downsample_with_averaging(subvol, downsample_factor)
            else:
                subvol = downsample.downsample_with_striding(subvol, downsample_factor)
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
                if not (self.rank == 3 and
                        (self.data_type == 'uint8' or self.data_type == 'uint16' or
                         self.data_type == 'uint32' or self.data_type == 'uint64')):
                    raise MeshesNotSupportedForVolume()
                pending_obj = object()
                self._mesh_generator_pending = pending_obj
            data = self.data
            new_mesh_generator = _neuroglancer.OnDemandObjectMeshGenerator(
                data.transpose(),
                self.dimensions.scales, np.zeros(3), **self._mesh_options)
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
