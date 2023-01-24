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

from __future__ import absolute_import

import os
import pathlib

import neuroglancer
from neuroglancer import write_annotations


def test_annotation_writer_axis_aligned_bounding_box(tmp_path: pathlib.Path):
  dim_dict = {'names': ['x', 'y'], 'units': ['m', 'm'], 'scales': [1, 1]}
  coordinate_space = neuroglancer.CoordinateSpace(**dim_dict)
  writer = write_annotations.AnnotationWriter(
      coordinate_space=coordinate_space,
      annotation_type='axis_aligned_bounding_box')
  writer.add_axis_aligned_bounding_box([2, 5], [3, 6])
  writer.write(tmp_path)
  assert os.path.exists(os.path.join(tmp_path, 'info'))
  assert os.path.exists(os.path.join(tmp_path, 'spatial0'))
  assert os.path.exists(os.path.join(tmp_path, 'by_id'))


def test_annotation_writer_point(tmp_path: pathlib.Path):
  dim_dict = {'names': ['x', 'y'], 'units': ['m', 'm'], 'scales': [1, 1]}
  coordinate_space = neuroglancer.CoordinateSpace(**dim_dict)
  writer = write_annotations.AnnotationWriter(
      coordinate_space=coordinate_space,
      annotation_type='point')
  writer.add_point([2, 5])
  writer.write(tmp_path)
  assert os.path.exists(os.path.join(tmp_path, 'info'))
  assert os.path.exists(os.path.join(tmp_path, 'spatial0'))
  assert os.path.exists(os.path.join(tmp_path, 'by_id'))

