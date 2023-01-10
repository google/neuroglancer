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
"""Tests for segment_colors and segment_default_color."""

from __future__ import absolute_import

import neuroglancer
from neuroglancer.segment_colors import (hash_function, hex_string_from_segment_id)
import numpy as np


def test_hash_function():
    """Test that the Python implementation of the modified murmur hash function
    returns the same result as the javascript implementation for a few different
    color seed/segment id combinations
    """
    color_seed = 0
    segment_id = 39
    result = hash_function(state=color_seed, value=segment_id)
    assert result == 761471253

    color_seed = 0
    segment_id = 92
    result = hash_function(state=color_seed, value=segment_id)
    assert result == 2920775201

    color_seed = 1125505311
    segment_id = 47
    result = hash_function(state=color_seed, value=segment_id)
    assert result == 251450508

    color_seed = 1125505311
    segment_id = 30
    result = hash_function(state=color_seed, value=segment_id)
    assert result == 2403373702


def test_hex_string_from_segment_id():
    """ Test that the hex string obtained
    via the Python implementation is identical to
    the value obtained using the javascript implementation
    for a few different color seed/segment id combinations """
    color_seed = 0
    segment_id = 39
    result = hex_string_from_segment_id(color_seed, segment_id)
    assert result.upper() == "#992CFF"

    color_seed = 1965848648
    segment_id = 40
    result = hex_string_from_segment_id(color_seed, segment_id)
    assert result.upper() == "#FF981E"

    color_seed = 2183424408
    segment_id = 143
    result = hex_string_from_segment_id(color_seed, segment_id)
    assert result.upper() == "#0410FF"

    color_seed = 2092967958
    segment_id = 58
    result = hex_string_from_segment_id(color_seed, segment_id)
    assert result.upper() == "#FF4ACE"


def test_segment_colors(webdriver):
    a = np.array([[[42]]], dtype=np.uint8)
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y", "z"],
                                                    units="nm",
                                                    scales=[1, 1, 1])
        s.layers.append(
            name="a",
            layer=neuroglancer.SegmentationLayer(
                source=neuroglancer.LocalVolume(data=a, dimensions=s.dimensions),
                segment_colors={42: '#f00'},
            ),
        )
        s.layout = 'xy'
        s.cross_section_scale = 1e-6
        s.show_axis_lines = False
        s.position = [0.5, 0.5, 0.5]
        assert list(s.layers[0].segment_colors.keys()) == [42]
        assert s.layers[0].segment_colors[42] == '#f00'
    webdriver.sync()
    screenshot_response = webdriver.viewer.screenshot(size=[10, 10])
    assert screenshot_response.viewer_state.layers[0].segment_colors[42] == '#ff0000'
    screenshot = screenshot_response.screenshot
    np.testing.assert_array_equal(screenshot.image_pixels,
                                  np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)))
    with webdriver.viewer.txn() as s:
        s.layers[0].segment_colors[42] = '#0f0'
    webdriver.sync()
    screenshot_response = webdriver.viewer.screenshot(size=[10, 10])
    assert screenshot_response.viewer_state.layers[0].segment_colors[42] == '#00ff00'
    screenshot = screenshot_response.screenshot
    np.testing.assert_array_equal(screenshot.image_pixels,
                                  np.tile(np.array([0, 255, 0, 255], dtype=np.uint8), (10, 10, 1)))

    # Changing segment_default_color does not affect the color since an explicit color is specified.
    with webdriver.viewer.txn() as s:
        s.layers[0].segment_default_color = '#fff'
    webdriver.sync()
    screenshot_response = webdriver.viewer.screenshot(size=[10, 10])
    assert screenshot_response.viewer_state.layers[0].segment_default_color == '#ffffff'
    screenshot = screenshot_response.screenshot
    np.testing.assert_array_equal(screenshot.image_pixels,
                                  np.tile(np.array([0, 255, 0, 255], dtype=np.uint8), (10, 10, 1)))

    # Removing the explicit color causes the default color to be used.
    with webdriver.viewer.txn() as s:
        del s.layers[0].segment_colors[42]
    webdriver.sync()
    screenshot_response = webdriver.viewer.screenshot(size=[10, 10])
    screenshot = screenshot_response.screenshot
    np.testing.assert_array_equal(
        screenshot.image_pixels, np.tile(np.array([255, 255, 255, 255], dtype=np.uint8),
                                         (10, 10, 1)))
