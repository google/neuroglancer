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

"""Reads annotations in the Precomputed annotation format."""

import collections
import json
import struct
import time
import typing

import numpy as np
import tensorstore as ts

from . import coordinate_space, viewer_state, write_annotations

K = typing.TypeVar("K")
V = typing.TypeVar("V")


def _get_uint64_key_encoder(metadata):
    if metadata is not None and "sharding" in metadata:
        return lambda n: struct.pack(">Q", n)
    return lambda n: str(n).encode("utf-8")


def _zorder_compressed(coords, grid_shape):
    zindex = 0
    output_bit = 0
    for bit in range(32):
        for coord, size in zip(coords, grid_shape):
            coord = int(coord)
            if (size - 1) >> bit:
                zindex |= ((coord >> bit) & 1) << output_bit
                output_bit += 1
    return zindex


def _get_spatial_key_encoder(metadata):
    if "sharding" in metadata:
        grid_shape = metadata["grid_shape"]
        return lambda coords: struct.pack(">Q", _zorder_compressed(coords, grid_shape))
    return lambda coords: "_".join(str(coord) for coord in coords).encode("utf-8")


class AnnotationMap(typing.Generic[K, V]):
    """Map interface for accessing an annotation index."""

    metadata: dict[str, typing.Any]
    """Raw JSON metadata associated with this annotation index."""

    def __init__(
        self,
        kvstore: ts.KvStore | None,
        metadata,
        key_encoder: typing.Callable[[K], bytes],
        value_decoder: typing.Callable[[K, bytes], V],
        staleness_bound: float | None = None,
    ):
        self._kvstore = kvstore
        self.metadata = metadata
        self._key_encoder = key_encoder
        self._value_decoder = value_decoder
        self.staleness_bound = staleness_bound

    def __bool__(self):
        return self._kvstore is not None

    def __getitem__(self, key: K) -> V:
        """Reads a given key."""
        if self._kvstore is None:
            raise KeyError("required index kind not available")
        read_result = self._kvstore.read(
            self._key_encoder(key), staleness_bound=self.staleness_bound
        ).result()
        if read_result.state != "value":
            raise KeyError(key)
        return self._value_decoder(key, read_result.value)

    def __contains__(self, key: K) -> bool:
        """Checks if a given key is present."""
        if self._kvstore is None:
            raise KeyError("required index kind not available")
        return self._key_encoder(key) in self._kvstore  # type: ignore[operator]

    def get(self, key: K, batch: ts.Batch | None = None) -> ts.Future[V | None]:
        """Reads a given key, returning a Future."""
        if self._kvstore is None:
            raise KeyError("required index kind not available")
        promise, future = ts.Promise[V | None].new()

        def done_callback(future):
            try:
                read_result = future.result()
                if read_result.state != "value":
                    promise.set_result(None)
                promise.set_result(self._value_decoder(key, read_result.value))
            except Exception as e:
                promise.set_exception(e)

        self._kvstore.read(
            self._key_encoder(key), staleness_bound=self.staleness_bound
        ).add_done_callback(done_callback)
        return future

    async def get_async(self, key: K, batch: ts.Batch | None = None) -> V:
        """Asynchronously reads a given key."""
        if self._kvstore is None:
            raise KeyError("required index kind not available")
        read_result = await self._kvstore.read(
            self._key_encoder(key), staleness_bound=self.staleness_bound, batch=batch
        )
        if read_result.state != "value":
            raise KeyError(key)
        return self._value_decoder(key, read_result.value)


AnnotationType = write_annotations.AnnotationType
"""Specifies the annotation type."""


def _decode_point_annotation(geom, rank: int, props, segments, id: str):
    return viewer_state.PointAnnotation(
        point=geom, props=props, segments=segments, id=id
    )


def _decode_line_annotation(geom, rank: int, props, segments, id: str):
    return viewer_state.LineAnnotation(
        point_a=geom[:rank], point_b=geom[rank:], props=props, segments=segments, id=id
    )


def _decode_axis_aligned_bounding_box_annotation(
    geom, rank: int, props, segments, id: str
):
    return viewer_state.AxisAlignedBoundingBoxAnnotation(
        point_a=geom[:rank], point_b=geom[rank:], props=props, segments=segments, id=id
    )


def _decode_ellipsoid_annotation(geom, rank: int, props, segments, id: str):
    return viewer_state.EllipsoidAnnotation(
        center=geom[:rank], radii=geom[rank:], props=props, segments=segments, id=id
    )


def _decode_polyline_annotation(geom, rank: int, props, segments, id: str):
    return viewer_state.PolyLineAnnotation(
        points=geom.reshape((-1, rank)), props=props, segments=segments, id=id
    )


_ANNOTATION_TYPE_CONSTRUCTORS = {
    "point": _decode_point_annotation,
    "line": _decode_line_annotation,
    "axis_aligned_bounding_box": _decode_axis_aligned_bounding_box_annotation,
    "ellipsoid": _decode_ellipsoid_annotation,
    "polyline": _decode_polyline_annotation,
}


def _point_check_bounds(annotation, lower_bound, upper_bound):
    point = annotation.point
    return np.all(point >= lower_bound) and np.all(point <= upper_bound)


def _bbox_check_bounds(min_pt, max_pt, lower_bound, upper_bound):
    return np.all(min_pt <= upper_bound) and np.all(max_pt <= lower_bound)


def _line_check_bounds(annotation, lower_bound, upper_bound):
    # For now, just perform a bounding box check for simplicity.
    # TODO(jbms): perform a more precise check
    point_a = annotation.point_a
    point_b = annotation.point_b
    min_pt = np.minimum(point_a, point_b)
    max_pt = np.maximum(point_a, point_b)
    return _bbox_check_bounds(min_pt, max_pt, lower_bound, upper_bound)


def _axis_aligned_bounding_box_check_bounds(annotation, lower_bound, upper_bound):
    point_a = annotation.point_a
    point_b = annotation.point_b
    min_pt = np.minimum(point_a, point_b)
    max_pt = np.maximum(point_a, point_b)
    return _bbox_check_bounds(min_pt, max_pt, lower_bound, upper_bound)


def _ellipsoid_check_bounds(annotation, lower_bound, upper_bound):
    center = annotation.point_a
    radii = annotation.radii
    return _bbox_check_bounds(center - radii, center + radii, lower_bound, upper_bound)


def _polyline_check_bounds(annotation, lower_bound, upper_bound):
    points = annotation.points
    min_pt = np.min(points, axis=0)
    max_pt = np.max(points, axis=0)
    return _bbox_check_bounds(min_pt, max_pt, lower_bound, upper_bound)


_ANNOTATION_TYPE_CHECK_BOUNDS = {
    "point": _point_check_bounds,
    "line": _line_check_bounds,
    "axis_aligned_bounding_box": _axis_aligned_bounding_box_check_bounds,
    "ellipsoid": _ellipsoid_check_bounds,
    "polyline": _polyline_check_bounds,
}


class AnnotationReader:
    """Provides read access to a Neuroglancer Precomputed annotation dataset."""

    _context: ts.Context

    coordinate_space: coordinate_space.CoordinateSpace
    """Coordinate space of annotations.

    Group:
      Accessors
    """

    staleness_bound: float
    """Staleness bound to use when reading.

    Group:
      Accessors
    """

    annotation_type: AnnotationType
    """Type of annotations.

    Group:
      Accessors
    """

    metadata: dict[str, typing.Any]
    """Raw Precomputed Annotation JSON metadata.

    Group:
      Accessors
    """

    properties: list[viewer_state.AnnotationPropertySpec]
    """Per-annotation properties included in the dataset.

    Group:
      Accessors
    """

    by_id: AnnotationMap[int, viewer_state.Annotation]
    """Annotations indexed by their 64-bit annotation id.

    If the by_id index is not present in `.metadata`, lookups raise errors.

    Group:
      I/O
    """

    relationships: dict[str, AnnotationMap[int, list[viewer_state.Annotation]]]
    """Related segment maps for each relationship.

    Group:
      I/O
    """

    lower_bound: tuple[float, ...]
    """Lower bound of all annotations within `.coordinate_space`.

    Group:
      Accessors
    """

    upper_bound: tuple[float, ...]
    """Upper bound of all annotations within `.coordinate_space`.

    Group:
      Accessors
    """

    def __init__(
        self,
        base_spec: typing.Any | ts.KvStore.Spec,
        context: ts.Context | None = None,
        staleness_bound: float | typing.Literal["open"] = "open",
    ):
        """Constructs an annotation reader.

        Args:
          base_spec: URL or TensorStore KvStore spec for the precomputed
              annotation directory.
          context: Optional TensorStore context to use.

          staleness_bound: Staleness bound for caching sharding metadata.  If not
              specified, defaults to the time at which the `AnnotationReader` is
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
        self.metadata = json.loads(
            ts.KvStore.open(self.base_spec, context=self._context).result()["info"]
        )
        self.lower_bound = tuple(self.metadata["lower_bound"])
        self.upper_bound = tuple(self.metadata["upper_bound"])
        if staleness_bound == "open":
            staleness_bound = time.time()
        self.staleness_bound = staleness_bound
        self.by_id = self._get_child_uint64_map(
            self.metadata["by_id"], self._decode_single_annotation
        )

        self.coordinate_space = coordinate_space.CoordinateSpace(
            self.metadata["dimensions"]
        )
        self.annotation_type = self.metadata["annotation_type"].lower()

        self.relationships = {
            relationship_metadata["id"]: self._get_child_uint64_map(
                relationship_metadata, self._decode_multiple_annotations
            )
            for relationship_metadata in self.metadata.get("relationships", [])
        }
        self.properties = [
            viewer_state.AnnotationPropertySpec(prop)
            for prop in self.metadata.get("properties", [])
        ]
        self._property_dtype = write_annotations._get_dtype_for_properties(
            self.properties
        )
        self._dtype = (
            write_annotations._get_dtype_for_geometry(
                self.annotation_type, self.coordinate_space.rank
            )
            + self._property_dtype
        )
        self.spatial = [
            self._get_child_spatial_map(spatial_metadata)
            for spatial_metadata in self.metadata.get("spatial", [])
        ]

    def _get_dtype(self, encoded: bytes) -> np.dtype:
        """Returns the dtype for the encoded annotation."""
        if self.annotation_type == "polyline":
            num_points_value = np.frombuffer(encoded, dtype="<u4", count=1)[0]
            num_points = ("num_points", "<u4")
            geometry = (
                "geometry",
                "<f4",
                (num_points_value * self.coordinate_space.rank,),
            )
            return np.dtype([num_points, geometry] + self._property_dtype)
        return self._dtype

    def _decode_single_annotation(
        self, annotation_id: int, encoded: bytes
    ) -> viewer_state.Annotation:
        dtype = self._get_dtype(encoded)
        decoded = np.frombuffer(encoded, dtype=dtype, count=1)[0]
        geom = decoded["geometry"]
        props = [decoded[f"property{i}"] for i in range(len(self.properties))]
        offset = decoded.nbytes
        segments = []
        for i in range(len(self.relationships)):
            count = np.frombuffer(encoded, dtype="<u4", count=1, offset=offset)[0]
            offset += 4
            segments.append(
                np.frombuffer(encoded, dtype="<u8", count=count, offset=offset)
            )
            offset += 8 * count
        return _ANNOTATION_TYPE_CONSTRUCTORS[self.annotation_type](
            geom, self.coordinate_space.rank, props, segments, str(annotation_id)
        )

    def _decode_multiple_annotations(
        self, unused_key, encoded: bytes
    ) -> list[viewer_state.Annotation]:
        count = np.frombuffer(encoded, dtype="<u8", count=1)[0]
        offset = 8
        if self.annotation_type == "polyline":
            decoded_parts = []
            for _ in range(count):
                encoded_subset = encoded[offset:]
                dtype = self._get_dtype(encoded_subset)
                decoded_polyline = np.frombuffer(encoded_subset, dtype=dtype, count=1)[
                    0
                ]
                decoded_parts.append(decoded_polyline)
                offset += decoded_polyline.nbytes
            decoded = np.array(decoded_parts, dtype=object)
        else:
            decoded = np.frombuffer(
                encoded, dtype=self._dtype, count=count, offset=offset
            )
            offset += decoded.nbytes
        ids = np.frombuffer(encoded, dtype="<u8", count=count, offset=offset)
        offset += ids.nbytes
        if offset != len(encoded):
            raise ValueError(
                f"Expected encoded size to be {offset} bytes but actual size is {len(encoded)}"
            )
        constructor = _ANNOTATION_TYPE_CONSTRUCTORS[self.annotation_type]
        rank = self.coordinate_space.rank
        num_properties = len(self.properties)
        return [
            constructor(
                decoded[annotation_i]["geometry"],
                rank,
                [decoded[annotation_i][f"property{i}"] for i in range(num_properties)],
                None,
                str(ids[annotation_i]),
            )
            for annotation_i in range(count)
        ]

    def _get_child_kvstore(self, metadata: typing.Any) -> ts.KvStore | None:
        if metadata is None:
            return None
        base_spec = self.base_spec.copy()
        base_spec.path += metadata["key"] + "/"
        if "sharding" in metadata:
            return ts.KvStore.open(
                {
                    "driver": "neuroglancer_uint64_sharded",
                    "base": base_spec,
                    "metadata": metadata["sharding"],
                },
                context=self._context,
            ).result()
        return ts.KvStore.open(base_spec, context=self._context).result()

    def _get_child_uint64_map(
        self, metadata: typing.Any, value_decoder: typing.Callable[[K, bytes], V]
    ):
        return AnnotationMap(
            kvstore=self._get_child_kvstore(metadata),
            metadata=metadata,
            key_encoder=_get_uint64_key_encoder(metadata),
            value_decoder=value_decoder,
            staleness_bound=self.staleness_bound,
        )

    def _get_child_spatial_map(self, metadata):
        return AnnotationMap(
            kvstore=self._get_child_kvstore(metadata),
            metadata=metadata,
            key_encoder=_get_spatial_key_encoder(metadata),
            value_decoder=self._decode_multiple_annotations,
            staleness_bound=self.staleness_bound,
        )

    def get_within_spatial_bounds(
        self,
        *,
        lower_bound: typing.Sequence[float] | None = None,
        upper_bound: typing.Sequence[float] | None = None,
        min_spatial_index_level=0,
        limit: int | None = None,
        max_parallelism: int = 128,
    ) -> typing.Iterator[viewer_state.Annotation]:
        """Returns an iterator over the annotations within the specified bounds.

        Args:
          lower_bound: Lower bound within `.coordinate_space`.
              If not specified, defaults to `.lower_bound`.
          upper_bound: Upper bound within `.coordinate_space`.
              If not specified, defaults to `.upper_bound`.
          min_spatial_index_level: Minimum spatial index level to use.
          limit: Maximum number of iterations to return.

        Group:
          I/O
        """
        if lower_bound is None:
            lower_bound = self.lower_bound
        else:
            lower_bound = np.maximum(self.lower_bound, lower_bound)  # type: ignore[assignment]

        if upper_bound is None:
            upper_bound = self.upper_bound
        else:
            upper_bound = np.minimum(self.upper_bound, upper_bound)  # type: ignore[assignment]

        if np.any(upper_bound < lower_bound):  # type: ignore[operator]
            return

        check_bounds = _ANNOTATION_TYPE_CHECK_BOUNDS[self.annotation_type]

        count = 0
        outstanding_requests: collections.deque[
            tuple[
                ts.Future, np.typing.NDArray[np.float64], np.typing.NDArray[np.float64]
            ]
        ] = collections.deque()

        def handle_outstanding_request():
            nonlocal count

            future, req_lower_bound, req_upper_bound = outstanding_requests.pop()
            annotations = future.result()
            if annotations is None:
                return
            if np.all(req_lower_bound >= lower_bound) and np.all(
                req_upper_bound <= upper_bound
            ):
                annotation_iter = iter(annotations)
            else:
                annotation_iter = (
                    annotation
                    for annotation in annotations
                    if check_bounds(annotation, lower_bound, upper_bound)
                )
            for annotation in annotation_iter:
                if limit is not None and count >= limit:
                    break
                yield annotation
                count += 1

        def add_request(spatial_index, coords, req_lower_bound, req_upper_bound):
            while len(outstanding_requests) >= max_parallelism:
                yield from handle_outstanding_request()

            if limit is not None and count >= limit:
                return
            outstanding_requests.appendleft(
                (spatial_index.get(coords), req_lower_bound, req_upper_bound)
            )

        for level in range(len(self.spatial) - 1, min_spatial_index_level - 1, -1):
            if limit is not None and count >= limit:
                return
            spatial_index = self.spatial[level]
            metadata = spatial_index.metadata
            chunk_size = metadata["chunk_size"]
            grid_shape = metadata["grid_shape"]
            min_chunk = np.asarray(
                (np.array(lower_bound) - self.lower_bound) // chunk_size, dtype=np.int64
            )
            max_chunk = (
                np.asarray(
                    (np.array(upper_bound) - self.lower_bound) // chunk_size,
                    dtype=np.int64,
                )
                + 1
            )
            min_chunk = np.maximum(0, min_chunk)
            max_chunk = np.minimum(grid_shape, max_chunk)
            for coords in np.ndindex(*(max_chunk - min_chunk)):
                if limit is not None and count >= limit:
                    return
                coords = coords + min_chunk  # type: ignore[assignment]
                req_lower_bound = coords * chunk_size + self.lower_bound
                req_upper_bound = np.minimum(
                    self.upper_bound, req_lower_bound + chunk_size
                )
                yield from add_request(
                    spatial_index, coords, req_lower_bound, req_upper_bound
                )

        while outstanding_requests:
            yield from handle_outstanding_request()
