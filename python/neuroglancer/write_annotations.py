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

"""Writes annotations in the Precomputed annotation format.

This provides a simple way to write annotations in the precomputed format, but
has a number of limitations that makes it suitable only for a relatively small
amount of annotation data:

- All annotations are buffered in memory.

- Only a trivial spatial index consisting of a single grid cell at a single
  level is generated.  Consequently, Neuroglancer will be forced to download all
  annotations at once.

- All indices are written in the unsharded format.  Consequently, there is at
  least one file written per annotation.
"""

import json
import numbers
import os
import pathlib
import struct
from collections.abc import Sequence
from typing import Literal, NamedTuple, cast

import numpy as np

from . import coordinate_space, viewer_state


class Annotation(NamedTuple):
    id: int
    encoded: bytes
    relationships: Sequence[Sequence[int]]


_PROPERTY_DTYPES: dict[str, tuple[tuple[str] | tuple[str, tuple[int, ...]], int]] = {
    "uint8": (("|u1",), 1),
    "uint16": (("<u2",), 2),
    "uint32": (("<u4",), 3),
    "int8": (("|i1",), 1),
    "int16": (("<i2",), 2),
    "int32": (("<i4",), 4),
    "float32": (("<f4",), 4),
    "rgb": (("|u1", (3,)), 1),
    "rgba": (("|u1", (4,)), 1),
}

AnnotationType = Literal["point", "line", "axis_aligned_bounding_box", "ellipsoid"]


def _get_dtype_for_geometry(annotation_type: AnnotationType, rank: int):
    geometry_size = rank if annotation_type == "point" else 2 * rank
    return [("geometry", "<f4", geometry_size)]


def _get_dtype_for_properties(
    properties: Sequence[viewer_state.AnnotationPropertySpec],
):
    dtype = []
    offset = 0
    for i, p in enumerate(properties):
        dtype_entry, alignment = _PROPERTY_DTYPES[p.type]
        if offset % alignment:
            padded_offset = (offset + alignment - 1) // alignment * alignment
            padding = padded_offset - offset
            dtype.append((f"padding{offset}", "|u1", (padding,)))
            offset += padding
        dtype.append((f"property{i}", *dtype_entry))  # type: ignore[arg-type]
        size = np.dtype(dtype[-1:]).itemsize
        offset += size
    alignment = 4
    if offset % alignment:
        padded_offset = (offset + alignment - 1) // alignment * alignment
        padding = padded_offset - offset
        dtype.append((f"padding{offset}", "|u1", (padding,)))
        offset += padding
    return dtype


def _convert_rgb_to_uint8(rgb: str) -> tuple[int, int, int]:
    """Convert an RGB hex string to a tuple of uint8 values."""
    if rgb.startswith("#"):
        rgb = rgb[1:]
    if len(rgb) != 6:
        raise ValueError(f"Invalid RGB format: {rgb}")
    return (int(rgb[0:2], 16), int(rgb[2:4], 16), int(rgb[4:6], 16))


def _convert_rgba_to_uint8(rgba: str) -> tuple[int, int, int, int]:
    """Convert an RGBA hex string to a tuple of uint8 values."""
    if rgba.startswith("#"):
        rgba = rgba[1:]
    if len(rgba) != 8:
        raise ValueError(f"Invalid RGBA format: {rgba}")
    color = _convert_rgb_to_uint8(rgba[:6])
    alpha = int(rgba[6:8], 16)
    return (*color, alpha)


class AnnotationWriter:
    annotations: list[Annotation]
    related_annotations: list[dict[int, list[Annotation]]]
    lower_bound: np.typing.NDArray[np.float64]
    upper_bound: np.typing.NDArray[np.float64]

    def __init__(
        self,
        coordinate_space: coordinate_space.CoordinateSpace,
        annotation_type: AnnotationType,
        relationships: Sequence[str] = (),
        properties: Sequence[viewer_state.AnnotationPropertySpec] = (),
    ):
        self.coordinate_space = coordinate_space
        self.relationships = list(relationships)
        self.annotation_type = annotation_type
        self.properties = list(properties)
        self.properties.sort(key=lambda p: -_PROPERTY_DTYPES[p.type][1])
        self.annotations = []
        self.rank = coordinate_space.rank
        self.dtype = _get_dtype_for_geometry(
            annotation_type, coordinate_space.rank
        ) + _get_dtype_for_properties(self.properties)
        self.lower_bound = np.full(
            shape=(self.rank,), fill_value=float("inf"), dtype=np.float32
        )
        self.upper_bound = np.full(
            shape=(self.rank,), fill_value=float("-inf"), dtype=np.float32
        )
        self.related_annotations = [{} for _ in self.relationships]

    def add_point(self, point: Sequence[float], id: int | None = None, **kwargs):
        if self.annotation_type != "point":
            raise ValueError(
                f"Expected annotation type point, but received: {self.annotation_type}"
            )
        if len(point) != self.coordinate_space.rank:
            raise ValueError(
                f"Expected point to have length {self.coordinate_space.rank}, but received: {len(point)}"
            )

        self.lower_bound = np.minimum(self.lower_bound, point)
        self.upper_bound = np.maximum(self.upper_bound, point)
        self._add_obj(point, id, **kwargs)

    def add_axis_aligned_bounding_box(
        self,
        point_a: Sequence[float],
        point_b: Sequence[float],
        id: int | None = None,
        **kwargs,
    ):
        if self.annotation_type != "axis_aligned_bounding_box":
            raise ValueError(
                f"Expected annotation type axis_aligned_bounding_box, but received: {self.annotation_type}"
            )
        self._add_two_point_obj(point_a, point_b, id, **kwargs)

    def add_line(
        self,
        point_a: Sequence[float],
        point_b: Sequence[float],
        id: int | None = None,
        **kwargs,
    ):
        if self.annotation_type != "line":
            raise ValueError(
                f"Expected annotation type line, but received: {self.annotation_type}"
            )
        self._add_two_point_obj(point_a, point_b, id, **kwargs)

    def _add_two_point_obj(
        self,
        point_a: Sequence[float],
        point_b: Sequence[float],
        id: int | None = None,
        **kwargs,
    ):
        if len(point_a) != self.coordinate_space.rank:
            raise ValueError(
                f"Expected coordinates to have length {self.coordinate_space.rank}, but received: {len(point_a)}"
            )

        if len(point_b) != self.coordinate_space.rank:
            raise ValueError(
                f"Expected coordinates to have length {self.coordinate_space.rank}, but received: {len(point_b)}"
            )

        self.lower_bound = np.minimum(self.lower_bound, point_a)
        self.upper_bound = np.maximum(self.upper_bound, point_b)
        coords = np.concatenate((point_a, point_b))
        self._add_obj(cast(Sequence[float], coords), id, **kwargs)

    def _add_obj(self, coords: Sequence[float], id: int | None, **kwargs):
        encoded = np.zeros(shape=(), dtype=self.dtype)
        encoded[()]["geometry"] = coords  # type: ignore[call-overload]

        for i, p in enumerate(self.properties):
            default_value = p.default
            if p.id in kwargs:
                default_value = kwargs.pop(p.id)
            if isinstance(default_value, str) and p.type in ("rgb", "rgba"):
                if p.type == "rgb":
                    default_value = _convert_rgb_to_uint8(default_value)
                else:
                    default_value = _convert_rgba_to_uint8(default_value)
            if default_value is not None:
                encoded[()][f"property{i}"] = default_value  # type: ignore[call-overload]

        related_ids = []
        for relationship in self.relationships:
            ids = kwargs.pop(relationship, None)
            if ids is None:
                ids = []
            if isinstance(ids, numbers.Integral):
                ids = [ids]
            related_ids.append(ids)

        if kwargs:
            raise ValueError(f"Unexpected keyword arguments {kwargs}")

        if id is None:
            id = len(self.annotations)

        annotation = Annotation(
            id=id, encoded=encoded.tobytes(), relationships=related_ids
        )

        self.annotations.append(annotation)

        for i, segment_ids in enumerate(related_ids):
            for segment_id in segment_ids:
                rel_index = self.related_annotations[i]
                rel_index_list = rel_index.setdefault(segment_id, [])
                rel_index_list.append(annotation)

    def _serialize_annotations(self, f, annotations: list[Annotation]):
        f.write(struct.pack("<Q", len(annotations)))
        for annotation in annotations:
            f.write(annotation.encoded)
        for annotation in annotations:
            f.write(struct.pack("<Q", annotation.id))

    def _serialize_annotation(self, f, annotation: Annotation):
        f.write(annotation.encoded)
        for related_ids in annotation.relationships:
            f.write(struct.pack("<I", len(related_ids)))
            for related_id in related_ids:
                f.write(struct.pack("<Q", related_id))

    def write(self, path: str | pathlib.Path):
        metadata = {
            "@type": "neuroglancer_annotations_v1",
            "dimensions": self.coordinate_space.to_json(),
            "lower_bound": [float(x) for x in self.lower_bound],
            "upper_bound": [float(x) for x in self.upper_bound],
            "annotation_type": self.annotation_type,
            "properties": [p.to_json() for p in self.properties],
            "relationships": [
                {"id": relationship, "key": f"rel_{relationship}"}
                for relationship in self.relationships
            ],
            "by_id": {
                "key": "by_id",
            },
            "spatial": [
                {
                    "key": "spatial0",
                    "grid_shape": [1] * self.rank,
                    "chunk_size": [
                        max(1, float(x)) for x in self.upper_bound - self.lower_bound
                    ],
                    "limit": len(self.annotations),
                },
            ],
        }

        os.makedirs(path, exist_ok=True)
        for relationship in self.relationships:
            os.makedirs(os.path.join(path, f"rel_{relationship}"), exist_ok=True)
        os.makedirs(os.path.join(path, "by_id"), exist_ok=True)
        os.makedirs(os.path.join(path, "spatial0"), exist_ok=True)

        with open(os.path.join(path, "info"), "w") as f:
            f.write(json.dumps(metadata))

        with open(
            os.path.join(path, "spatial0", "_".join("0" for _ in range(self.rank))),
            "wb",
        ) as f:
            self._serialize_annotations(f, self.annotations)

        for annotation in self.annotations:
            with open(os.path.join(path, "by_id", str(annotation.id)), "wb") as f:
                self._serialize_annotation(f, annotation)

        for i, relationship in enumerate(self.relationships):
            rel_index = self.related_annotations[i]
            for segment_id, annotations in rel_index.items():
                with open(
                    os.path.join(path, f"rel_{relationship}", str(segment_id)), "wb"
                ) as f:
                    self._serialize_annotations(f, annotations)
