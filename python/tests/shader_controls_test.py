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
"""Tests that shader control parameters can be specified from Python."""

import neuroglancer
import numpy as np


def test_invlerp(webdriver):
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y"], units="nm", scales=[1, 1]
        )
        s.position = [0.5, 0.5]
        s.layers.append(
            name="image",
            layer=neuroglancer.ImageLayer(
                source=neuroglancer.LocalVolume(
                    dimensions=s.dimensions,
                    data=np.full(shape=(1, 1), dtype=np.uint32, fill_value=42),
                ),
            ),
            visible=True,
            shader_controls={
                "normalized": {
                    "range": [0, 42],
                },
            },
        )
        s.layout = "xy"
        s.cross_section_scale = 1e-6
        s.show_axis_lines = False

    control = webdriver.viewer.state.layers["image"].shader_controls["normalized"]
    assert isinstance(control, neuroglancer.InvlerpParameters)
    np.testing.assert_equal(control.range, [0, 42])

    def expect_color(color):
        webdriver.sync()
        screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
        np.testing.assert_array_equal(
            screenshot.image_pixels,
            np.tile(np.array(color, dtype=np.uint8), (10, 10, 1)),
        )

    expect_color([255, 255, 255, 255])
    with webdriver.viewer.txn() as s:
        s.layers["image"].shader_controls = {
            "normalized": neuroglancer.InvlerpParameters(range=[42, 100]),
        }
    expect_color([0, 0, 0, 255])


def test_transfer_function(webdriver):
    shader = """
#uicontrol transferFunction colormap
void main() {
    emitRGBA(colormap());
}
"""
    shaderControls = {
        "colormap": {
            "controlPoints": [[0, "#000000", 0.0], [84, "#ffffff", 1.0]],
            "window": [0, 50],
            "channel": [],
            "defaultColor": "#ff00ff",
        }
    }
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y"], units="nm", scales=[1, 1]
        )
        s.position = [0.5, 0.5]
        s.layers.append(
            name="image",
            layer=neuroglancer.ImageLayer(
                source=neuroglancer.LocalVolume(
                    dimensions=s.dimensions,
                    data=np.full(shape=(1, 1), dtype=np.uint64, fill_value=63),
                ),
            ),
            visible=True,
            shader=shader,
            shader_controls=shaderControls,
            opacity=1.0,
            blend="additive",
        )
        s.layout = "xy"
        s.cross_section_scale = 1e-6
        s.show_axis_lines = False
    control = webdriver.viewer.state.layers["image"].shader_controls["colormap"]
    assert isinstance(control, neuroglancer.TransferFunctionParameters)
    np.testing.assert_equal(control.window, [0, 50])
    assert control.defaultColor == "#ff00ff"

    def expect_color(color):
        webdriver.sync()
        screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
        np.testing.assert_array_equal(
            screenshot.image_pixels,
            np.tile(np.array(color, dtype=np.uint8), (10, 10, 1)),
        )

    # Ensure that the value 63 is mapped to the expected color.
    # The value 63 is 3/4 of the way between 0 and 84, so the expected color
    # is 3/4 of the way between black and white.
    # Additionally, the opacity is 0.75, and the mode is additive, so the
    # the final color is 0.75 * 0.75 * 255.
    mapped_opacity = 0.75
    mapped_color = 0.75 * 255
    mapped_value = int(mapped_color * mapped_opacity)
    expected_color = [mapped_value] * 3 + [255]
    expect_color(expected_color)
    with webdriver.viewer.txn() as s:
        s.layers["image"].shader_controls = {
            "colormap": neuroglancer.TransferFunctionParameters(
                controlPoints=[[0, "#000000", 0.0], [84, "#ffffff", 1.0]],
                window=[500, 5000],
                channel=[],
                defaultColor="#ff0000",
            )
        }
    control = webdriver.viewer.state.layers["image"].shader_controls["colormap"]
    np.testing.assert_equal(control.window, [500, 5000])
    assert control.defaultColor == "#ff0000"
    expect_color(expected_color)


def test_slider(webdriver):
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y"], units="nm", scales=[1, 1]
        )
        s.position = [0.5, 0.5]
        s.layers.append(
            name="image",
            layer=neuroglancer.ImageLayer(
                source=neuroglancer.LocalVolume(
                    dimensions=s.dimensions,
                    data=np.full(shape=(1, 1), dtype=np.uint32, fill_value=42),
                ),
            ),
            visible=True,
            shader="""
#uicontrol float color slider(min=0, max=10)

void main() {
  emitGrayscale(color);
}
""",
            shader_controls={
                "color": 1,
            },
        )
        s.layout = "xy"
        s.cross_section_scale = 1e-6
        s.show_axis_lines = False

    control = webdriver.viewer.state.layers["image"].shader_controls["color"]
    assert control == 1

    def expect_color(color):
        webdriver.sync()
        screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
        np.testing.assert_array_equal(
            screenshot.image_pixels,
            np.tile(np.array(color, dtype=np.uint8), (10, 10, 1)),
        )

    expect_color([255, 255, 255, 255])
    with webdriver.viewer.txn() as s:
        s.layers["image"].shader_controls = {
            "color": 0,
        }
    expect_color([0, 0, 0, 255])


def test_interpolation(webdriver):
    data = np.array([[0, 22], [50, 100]], dtype=np.uint32)

    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y"], units="nm", scales=[0.5, 0.5]
        )
        s.position = [1.0, 1.0]  # Center of the 2x2 grid
        s.layers.append(
            name="image",
            layer=neuroglancer.ImageLayer(
                source=neuroglancer.LocalVolume(
                    dimensions=s.dimensions,
                    data=data,
                ),
            ),
            visible=True,
            shader="""
#uicontrol invlerp normalized
void main() {
    emitGrayscale(normalized());
}
""",
            shader_controls={
                "normalized": {
                    "range": [0, 255],
                },
            },
        )
        s.layout = "xy"
        s.cross_section_scale = 1e-6
        s.show_axis_lines = False

    webdriver.sync()
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    # Repeat 0 for top left 5x5, 50 for top right 5x5, 22 for bottom left 5x5, and 100 for bottom right 5x5
    expected_pixels = np.block(
        [
            [np.zeros((5, 5), dtype=np.uint8), np.full((5, 5), 50, dtype=np.uint8)],
            [
                np.full((5, 5), 22, dtype=np.uint8),
                np.full((5, 5), 100, dtype=np.uint8),
            ],
        ]
    )
    # Grayscale so can just check the red channel
    np.testing.assert_array_equal(screenshot.image_pixels[:, :, 0], expected_pixels)

    # Now test with interpolated normalized(true)
    with webdriver.viewer.txn() as s:
        s.layers["image"].shader = """
#uicontrol invlerp normalized
void main() {
    emitGrayscale(normalized(true));
}
"""

    webdriver.sync()
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    # Interpolates as (0 + 22 + 50 + 100) / 4 = 43
    expected_pixels = np.tile([43, 43, 43, 255], (10, 10, 1)).astype(np.uint8)
    np.testing.assert_array_equal(screenshot.image_pixels, expected_pixels)
