# @license
# Copyright 2025 Google Inc.
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
"""Reads the Precomputed skeleton format."""

import json
import time
import typing

import numpy as np
import osteoid
import tensorstore as ts

from . import coordinate_space, read_precomputed_annotations


class SkeletonReader(read_precomputed_annotations.AnnotationMap[int, osteoid.Skeleton]):
    """Provides read access to the :ref`Precomputed skeleton format<precomputed-skeleton-format>`."""

    _context: ts.Context

    coordinate_space: coordinate_space.CoordinateSpace
    """Coordinate space of annotations.

    Group:
      Accessors
    """

    def __init__(
        self,
        base_spec: typing.Any | ts.KvStore.Spec,
        context: ts.Context | None = None,
        staleness_bound: float | typing.Literal["open"] = "open",
    ):
        """Constructs a skeleton reader.

        Args:
          base_spec: URL or TensorStore KvStore spec for the precomputed
              annotation directory.
          context: Optional TensorStore context to use.

          staleness_bound: Staleness bound for caching sharding metadata.  If not
              specified, defaults to the time at which the `SkeletonReader` is
              constructed.

        Group:
          Constructors
        """
        if context is None:
            context = ts.Context(
                {"cache_pool": {"total_bytes_limit": 1024 * 1024 * 20}}
            )
        self._context = context
        base_spec = ts.KvStore.Spec(base_spec)
        if base_spec.path and not base_spec.path.endswith("/"):
            base_spec.path += "/"
        self.base_spec = base_spec
        metadata = json.loads(
            ts.KvStore.open(self.base_spec, context=self._context).result()["info"]
        )
        if (
            not isinstance(metadata, dict)
            or metadata.get("@type") != "neuroglancer_skeletons"
        ):
            raise ValueError("Invalid skeleton metadata", metadata)
        self.transform = np.array(metadata["transform"], dtype=np.float64).reshape(
            (3, 4)
        )
        if staleness_bound == "open":
            staleness_bound = time.time()
        self.coordinate_space = coordinate_space.CoordinateSpace(
            names=["x", "y", "z"], units="nm"
        )

        super().__init__(
            **read_precomputed_annotations._get_uint64_map_args(
                metadata=metadata,
                base_spec=base_spec,
                context=self._context,
                value_decoder=self._decode_skeleton,
                staleness_bound=staleness_bound,
            )
        )

    def _decode_skeleton(self, key: int, encoded: bytes) -> osteoid.Skeleton:
        skeleton = osteoid.Skeleton.from_precomputed(
            encoded,
            segid=key,
            vertex_attributes=self.metadata["vertex_attributes"] or [],
        )
        skeleton.transform = self.transform
        return skeleton
