# @license
# Copyright 2020 Google Inc.
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
"""Tests that skeleton rendering options can be controlled via ViewerState."""

import numpy as np
import neuroglancer
import neuroglancer.skeleton
import threading
import pytest

dimensions = neuroglancer.CoordinateSpace(names=['x', 'y', 'z'], units='nm', scales=[1, 1, 1])


class SkeletonSource(neuroglancer.skeleton.SkeletonSource):
    def __init__(self):
        super(SkeletonSource, self).__init__(dimensions=dimensions)

    def get_skeleton(self, object_id):
        return neuroglancer.skeleton.Skeleton(
            vertex_positions=[[0, 0, 0]],
            edges=[[0, 0]],
        )


def test_skeleton_options(webdriver):
    with webdriver.viewer.txn() as s:
        s.dimensions = dimensions
        s.layout = 'xy'
        s.layers.append(
            name='a',
            layer=neuroglancer.SegmentationLayer(
                source=SkeletonSource(),
                segments=[1],
            ),
        )
        s.layers[0].skeleton_rendering.line_width2d = 100
        s.layers[0].skeleton_rendering.shader = '''
#uicontrol vec3 color color(default="white")
void main () {
  emitRGB(color);
}
'''
        s.layers[0].skeleton_rendering.shader_controls['color'] = '#f00'
        s.show_axis_lines = False
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    np.testing.assert_array_equal(screenshot.image_pixels,
                                  np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)))

    with webdriver.viewer.txn() as s:
        s.layout = '3d'
        s.layers[0].skeleton_rendering.line_width3d = 100
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    np.testing.assert_array_equal(screenshot.image_pixels,
                                  np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)))

    with webdriver.viewer.txn() as s:
        s.layers[0].source[0].subsources['default'] = False

    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    np.testing.assert_array_equal(screenshot.image_pixels,
                                  np.tile(np.array([0, 0, 0, 255], dtype=np.uint8), (10, 10, 1)))
