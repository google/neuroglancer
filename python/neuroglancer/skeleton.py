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


import collections
import io
import struct

import numpy as np

from . import random_token, trackable_state


class Skeleton:
    def __init__(self, vertex_positions, edges, vertex_attributes=None):
        self.vertex_positions = np.array(vertex_positions, dtype="<f4")
        if self.vertex_positions.ndim != 2 or self.vertex_positions.shape[1] != 3:
            raise ValueError("vertex_positions must be array of shape (N, 3)")
        self.edges = np.array(edges, dtype="<u4")
        if self.edges.ndim != 2 or self.edges.shape[1] != 2:
            raise ValueError("edges must be array of shape (N, 2)")
        self.vertex_attributes = vertex_attributes

    def encode(self, source):
        result = io.BytesIO()
        edges = self.edges
        vertex_positions = self.vertex_positions
        vertex_attributes = self.vertex_attributes
        result.write(struct.pack("<II", vertex_positions.shape[0], edges.shape[0]))
        result.write(vertex_positions.tobytes())
        result.write(edges.tobytes())
        if len(source.vertex_attributes) > 0:
            for name, info in source.vertex_attributes.items():
                attribute = np.array(
                    vertex_attributes[name], np.dtype(info.data_type).newbyteorder("<")
                )
                expected_shape = (vertex_positions.shape[0], info.num_components)
                if attribute.shape[0] != expected_shape[0] or attribute.size != np.prod(
                    expected_shape
                ):
                    raise ValueError(
                        f"Expected attribute {name!r} to have shape {expected_shape!r}, but was: {attribute.shape!r}"
                    )
                result.write(attribute.tobytes())
        return result.getvalue()


VertexAttributeInfo = collections.namedtuple(
    "VertexAttributeInfo", ["data_type", "num_components"]
)


class SkeletonSource(trackable_state.ChangeNotifier):
    def __init__(self, dimensions, voxel_offset=None):
        super().__init__()
        self.dimensions = dimensions
        if voxel_offset is None:
            voxel_offset = np.zeros(dimensions.rank, dtype=np.float64)
        self.voxel_offset = voxel_offset
        self.vertex_attributes = {}
        self.token = random_token.make_random_token()

    def info(self):
        return dict(
            coordinateSpace=self.dimensions.to_json(),
            voxelOffset=self.voxel_offset,
            attributes=self.get_vertex_attributes_spec(),
        )

    def get_skeleton(self, object_id):
        """Retrieves the skeleton corresponding to the specified `object_id`.

        @param object_id: uint64 object id.

        @returns The Skeleton object representing the skeleton, or `None` if there is no
            corresponding skeleton.
        """
        raise NotImplementedError

    def get_vertex_attributes_spec(self):
        temp = {}
        for k, v in self.vertex_attributes.items():
            temp[k] = dict(
                dataType=np.dtype(v.data_type).name, numComponents=v.num_components
            )
        return temp

    def invalidate(self):
        """Mark the data invalidated.  Clients will refetch the data."""
        self._dispatch_changed_callbacks()
