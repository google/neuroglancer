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
"""Tests WebGL context lose/restore handling."""

import neuroglancer
import numpy as np


def test_context_lost(webdriver):
    a = np.array([[[255]]], dtype=np.uint8)
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y", "z"], units="nm", scales=[1, 1, 1]
        )
        s.layers.append(
            name="a",
            layer=neuroglancer.ImageLayer(
                source=neuroglancer.LocalVolume(data=a, dimensions=s.dimensions),
                shader="void main () { emitRGB(vec3(1.0, 0.0, 0.0)); }",
            ),
        )
        s.layout = "xy"
        s.cross_section_scale = 1e-6
        s.position = [0.5, 0.5, 0.5]
        s.show_axis_lines = False
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    np.testing.assert_array_equal(
        screenshot.image_pixels,
        np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)),
    )
    with webdriver.wait_for_log_message("Lost WebGL context.*", timeout=3):
        webdriver.driver.execute_script(
            """
window.webglLoseContext = viewer.gl.getExtension('WEBGL_lose_context');
window.webglLoseContext.loseContext();
"""
        )
    with webdriver.wait_for_log_message("WebGL context restored.*", timeout=3):
        webdriver.driver.execute_script(
            """
window.webglLoseContext.restoreContext();
"""
        )
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    np.testing.assert_array_equal(
        screenshot.image_pixels,
        np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)),
    )
