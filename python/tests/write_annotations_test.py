# @license
# Copyright 2023 Google Inc.
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


import os
import pathlib

import neuroglancer
import numpy as np
from neuroglancer import write_annotations


def test_annotation_writer_axis_aligned_bounding_box(tmp_path: pathlib.Path):
    coordinate_space = neuroglancer.CoordinateSpace(names=["x", "y"], units="m")
    writer = write_annotations.AnnotationWriter(
        coordinate_space=coordinate_space, annotation_type="axis_aligned_bounding_box"
    )
    writer.add_axis_aligned_bounding_box([2, 5], [3, 6])
    writer.write(tmp_path)
    assert os.path.exists(os.path.join(tmp_path, "info"))
    assert os.path.exists(os.path.join(tmp_path, "spatial0"))
    assert os.path.exists(os.path.join(tmp_path, "by_id"))


def test_annotation_writer_point(tmp_path: pathlib.Path):
    coordinate_space = neuroglancer.CoordinateSpace(names=["x", "y"], units="m")
    writer = write_annotations.AnnotationWriter(
        coordinate_space=coordinate_space, annotation_type="point"
    )
    writer.add_point([2, 5])
    writer.write(tmp_path)
    assert os.path.exists(os.path.join(tmp_path, "info"))
    assert os.path.exists(os.path.join(tmp_path, "spatial0"))
    assert os.path.exists(os.path.join(tmp_path, "by_id"))


def test_annotation_writer_line(tmp_path: pathlib.Path):
    coordinate_space = neuroglancer.CoordinateSpace(names=["x", "y"], units="m")
    writer = write_annotations.AnnotationWriter(
        coordinate_space=coordinate_space, annotation_type="line"
    )
    writer.add_line([2, 5], [3, 6])
    writer.write(tmp_path)
    assert os.path.exists(os.path.join(tmp_path, "info"))
    assert os.path.exists(os.path.join(tmp_path, "spatial0"))
    assert os.path.exists(os.path.join(tmp_path, "by_id"))


def test_annotation_writer_ellipsoid(tmp_path: pathlib.Path):
    coordinate_space = neuroglancer.CoordinateSpace(names=["x", "y"], units="m")
    writer = write_annotations.AnnotationWriter(
        coordinate_space=coordinate_space, annotation_type="ellipsoid"
    )
    writer.add_ellipsoid([2, 5], [3, 6])
    writer.write(tmp_path)
    assert os.path.exists(os.path.join(tmp_path, "info"))
    assert os.path.exists(os.path.join(tmp_path, "spatial0"))
    assert os.path.exists(os.path.join(tmp_path, "by_id"))


def test_annotation_writer_polyline(tmp_path: pathlib.Path):
    def check_polyline_contents(contents, line, id_, offset, end_offset):
        num_points = len(line)
        point_offset = num_points * 3 * 4
        # The next 4 bytes are the number of points in the polyline
        u_int32 = np.frombuffer(contents[offset : offset + 4], dtype=np.uint32)
        # Then, for each point there are rank number of floats (in this case 3)
        floats = np.frombuffer(
            contents[offset + 4 : offset + 4 + point_offset], dtype=np.float32
        )
        # Finally it ends with the ids as uint64s
        u_int64_id = np.frombuffer(contents[end_offset:], dtype=np.uint64)
        assert u_int32[0] == num_points
        assert np.allclose(floats, np.array(line).flatten())
        assert u_int64_id[0] == id_

        # check properties
        # size
        size = np.frombuffer(
            contents[offset + 4 + point_offset : offset + 8 + point_offset],
            dtype=np.float32,
        )
        assert size[0] == 10
        # cell_type
        cell_type = np.frombuffer(
            contents[offset + 8 + point_offset : offset + 10 + point_offset],
            dtype=np.uint16,
        )
        assert cell_type[0] == 16
        # point_color
        point_color = np.frombuffer(
            contents[offset + 10 + point_offset : offset + 14 + point_offset],
            dtype=np.uint8,
        )
        assert np.allclose(point_color, [0, 255, 0, 255])
        return offset + 4 + point_offset

    coordinate_space = neuroglancer.CoordinateSpace(names=["x", "y", "z"], units="m")
    writer = write_annotations.AnnotationWriter(
        coordinate_space=coordinate_space,
        annotation_type="polyline",
        properties=[
            neuroglancer.AnnotationPropertySpec(id="size", type="float32"),
            neuroglancer.AnnotationPropertySpec(id="cell_type", type="uint16"),
            neuroglancer.AnnotationPropertySpec(id="point_color", type="rgba"),
        ],
    )
    line_sizes = [10, 5, 2, 2, 4]
    random_generator = np.random.default_rng(42)
    polylines = [random_generator.random((size, 3)) for size in line_sizes]
    ids = [10, 20, 30, 40, 50]
    for polyline, id_ in zip(polylines, ids):
        writer.add_polyline(
            polyline,  # type: ignore
            id=id_,
            size=10,
            cell_type=16,
            point_color=(0, 255, 0, 255),
        )

    writer.write(tmp_path)
    assert os.path.exists(os.path.join(tmp_path, "info"))
    assert os.path.exists(os.path.join(tmp_path, "spatial0"))
    assert os.path.exists(os.path.join(tmp_path, "by_id"))

    # Now let's check the contents of the spatial0
    # Read the bytes from the file
    contents = np.fromfile(os.path.join(tmp_path, "spatial0", "0_0_0"), dtype=np.uint8)
    offset = 8
    total = len(polylines)
    property_bytes = 12
    for i, (polyline, id_) in enumerate(zip(polylines, ids)):
        offset = check_polyline_contents(
            contents, polyline, id_, end_offset=8 * (i - total), offset=offset
        )
        offset += property_bytes

    # The first 8 bytes are the total count of the number of elements
    num_points = np.frombuffer(contents[0:8], dtype=np.uint64)
    assert num_points[0] == len(polylines)
