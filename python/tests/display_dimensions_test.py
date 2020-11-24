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
"""Tests that display_dimensions can be set."""

import numpy as np
import neuroglancer
import pytest


@pytest.mark.parametrize('display_dimensions,layout,key,expected_position', [
    (['x', 'y', 'z'], 'xy', 'LEFT', [5, 5, 4]),
    (['x', 'y', 'z'], 'xy', 'RIGHT', [5, 5, 6]),
    (['x', 'y', 'z'], 'xy', 'UP', [5, 4, 5]),
    (['x', 'y', 'z'], 'xy', 'DOWN', [5, 6, 5]),
    (['x', 'y', 'z'], 'xy', ',', [4, 5, 5]),
    (['x', 'y', 'z'], 'xy', '.', [6, 5, 5]),
    (['z', 'y', 'x'], 'xy', 'LEFT', [4, 5, 5]),
    (['z', 'y', 'x'], 'xy', 'RIGHT', [6, 5, 5]),
    (['z', 'y', 'x'], 'xy', 'UP', [5, 4, 5]),
    (['z', 'y', 'x'], 'xy', 'DOWN', [5, 6, 5]),
    (['z', 'y', 'x'], 'xy', ',', [5, 5, 4]),
    (['z', 'y', 'x'], 'xy', '.', [5, 5, 6]),
])
def test_display_dimensions(webdriver, display_dimensions, layout, key, expected_position):
    from selenium.webdriver.common.keys import Keys
    if len(key) > 0 and hasattr(Keys, key):
        key = getattr(Keys, key)
    a = np.zeros((10, 10, 10), dtype=np.uint8)
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["z", "y", "x"],
                                                    units="nm",
                                                    scales=[1, 1, 1])
        s.layers.append(
            name="a",
            layer=neuroglancer.ImageLayer(
                source=neuroglancer.LocalVolume(data=a, dimensions=s.dimensions),
            ),
        )
        s.display_dimensions = display_dimensions
        s.layout = layout
    webdriver.sync()
    webdriver.action_chain().move_to_element_with_offset(webdriver.root_element, 100, 100).click().send_keys(key).perform()
    webdriver.sync()
    assert np.floor(webdriver.viewer.state.position).tolist() == expected_position
