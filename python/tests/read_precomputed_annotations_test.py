# @license
# Copyright 2026 Google Inc.
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

import pathlib

import neuroglancer
import numpy as np
import pytest
from neuroglancer import write_annotations

pytest.importorskip("tensorstore")

from neuroglancer import read_precomputed_annotations  # noqa: E402


def _coordinate_space(rank: int = 3):
    return neuroglancer.CoordinateSpace(
        names=["x", "y", "z"][:rank], units="nm", scales=[1] * rank
    )


def _open_reader(path: pathlib.Path):
    return read_precomputed_annotations.AnnotationReader(
        {"driver": "file", "path": str(path)}
    )


def _props_by_id(reader, annotation):
    return {
        p.id: np.asarray(v).tolist()
        for p, v in zip(reader.properties, annotation.props)
    }


def test_properties_not_sorted_by_alignment(tmp_path: pathlib.Path):
    # Properties are listed in an order that differs from the encoded order
    # (decreasing alignment).
    properties = [
        neuroglancer.AnnotationPropertySpec(id="color", type="rgb"),
        neuroglancer.AnnotationPropertySpec(id="flag", type="uint8"),
        neuroglancer.AnnotationPropertySpec(id="size", type="float32"),
        neuroglancer.AnnotationPropertySpec(id="cell_type", type="uint16"),
    ]
    writer = write_annotations.AnnotationWriter(
        coordinate_space=_coordinate_space(),
        annotation_type="point",
        properties=properties,
    )
    writer.add_point(
        [1, 2, 3], id=5, color=(10, 20, 30), flag=7, size=2.5, cell_type=16
    )
    writer.add_point(
        [4, 5, 6], id=6, color=(40, 50, 60), flag=8, size=0.5, cell_type=17
    )
    writer.write(tmp_path)

    reader = _open_reader(tmp_path)
    expected = {
        "5": {"color": [10, 20, 30], "flag": 7, "size": 2.5, "cell_type": 16},
        "6": {"color": [40, 50, 60], "flag": 8, "size": 0.5, "cell_type": 17},
    }
    assert [p.id for p in reader.properties] == [p.id for p in properties]
    assert _props_by_id(reader, reader.by_id[5]) == expected["5"]
    assert _props_by_id(reader, reader.by_id[6]) == expected["6"]
    assert {
        a.id: _props_by_id(reader, a) for a in reader.get_within_spatial_bounds()
    } == expected


def test_polyline_properties_not_sorted_by_alignment(tmp_path: pathlib.Path):
    properties = [
        neuroglancer.AnnotationPropertySpec(id="color", type="rgba"),
        neuroglancer.AnnotationPropertySpec(id="cell_type", type="uint16"),
        neuroglancer.AnnotationPropertySpec(id="size", type="float32"),
    ]
    writer = write_annotations.AnnotationWriter(
        coordinate_space=_coordinate_space(),
        annotation_type="polyline",
        properties=properties,
    )
    writer.add_polyline(
        [[0, 0, 0], [1, 2, 3], [4, 5, 6]],
        id=1,
        color=(1, 2, 3, 4),
        cell_type=12,
        size=6,
    )
    writer.write(tmp_path)

    reader = _open_reader(tmp_path)
    expected = {"color": [1, 2, 3, 4], "cell_type": 12, "size": 6.0}
    assert _props_by_id(reader, reader.by_id[1]) == expected
    (annotation,) = reader.get_within_spatial_bounds()
    assert _props_by_id(reader, annotation) == expected


def test_get_within_spatial_bounds_line(tmp_path: pathlib.Path):
    lines = {
        0: ([0, 0, 0], [10, 10, 10]),  # Passes through the query box.
        1: ([40, 40, 40], [50, 50, 50]),  # Entirely above the query box.
        2: ([0, 0, 0], [1, 1, 1]),  # Entirely below the query box.
    }
    writer = write_annotations.AnnotationWriter(
        coordinate_space=_coordinate_space(), annotation_type="line"
    )
    for annotation_id, (point_a, point_b) in lines.items():
        writer.add_line(point_a, point_b, id=annotation_id)
    writer.write(tmp_path)

    reader = _open_reader(tmp_path)
    assert sorted(a.id for a in reader.get_within_spatial_bounds()) == ["0", "1", "2"]
    result = reader.get_within_spatial_bounds(
        lower_bound=[4, 4, 4], upper_bound=[6, 6, 6]
    )
    assert [a.id for a in result] == ["0"]


def test_get_within_spatial_bounds_ellipsoid(tmp_path: pathlib.Path):
    writer = write_annotations.AnnotationWriter(
        coordinate_space=_coordinate_space(), annotation_type="ellipsoid"
    )
    writer.add_ellipsoid([5, 5, 5], [20, 20, 20], id=0)
    writer.write(tmp_path)

    reader = _open_reader(tmp_path)
    # The query box lies within `[center - radii, center + radii]`.
    result = reader.get_within_spatial_bounds(
        lower_bound=[6, 6, 6], upper_bound=[8, 8, 8]
    )
    assert [a.id for a in result] == ["0"]
