# @license
# Copyright 2021 Google Inc.
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
"""Tests for linked_segmentation_{,color}group."""

from __future__ import absolute_import

import neuroglancer
import numpy as np


def test_linked_segmentation_group(webdriver):
    a = np.array([[[42]]], dtype=np.uint8)
    b = np.array([[[43]]], dtype=np.uint8)
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y", "z"],
                                                    units="nm",
                                                    scales=[1, 1, 1])
        s.layers.append(
            name="a",
            layer=neuroglancer.SegmentationLayer(
                source=neuroglancer.LocalVolume(data=a, dimensions=s.dimensions),
                segment_default_color='#f00',
                segments=[43],
            ),
            visible=False,
        )
        s.layers.append(
            name="b",
            layer=neuroglancer.SegmentationLayer(
                source=neuroglancer.LocalVolume(data=b, dimensions=s.dimensions),
                linked_segmentation_group='a',
            ),
        )
        s.layout = 'xy'
        s.cross_section_scale = 1e-6
        s.show_axis_lines = False
        s.position = [0.5, 0.5, 0.5]
    webdriver.sync()
    screenshot_response = webdriver.viewer.screenshot(size=[10, 10])
    assert screenshot_response.viewer_state.layers[0].segment_default_color == '#ff0000'
    screenshot = screenshot_response.screenshot
    np.testing.assert_array_equal(screenshot.image_pixels,
                                  np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)))
    with webdriver.viewer.txn() as s:
        s.layers[1].linked_segmentation_color_group = False
        s.layers[1].segment_default_color = '#0f0'
    webdriver.sync()
    screenshot_response = webdriver.viewer.screenshot(size=[10, 10])
    screenshot = screenshot_response.screenshot
    np.testing.assert_array_equal(screenshot.image_pixels,
                                  np.tile(np.array([0, 255, 0, 255], dtype=np.uint8), (10, 10, 1)))
