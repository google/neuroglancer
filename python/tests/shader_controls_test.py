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
from selenium.common.exceptions import NoSuchElementException, TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.support.wait import WebDriverWait


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


def read_hidden_count(driver):
    return driver.find_element(
        By.CSS_SELECTOR, ".neuroglancer-shader-controls-hidden-count"
    ).text


def expect_hidden_count(webdriver, text):
    webdriver.sync()
    try:
        WebDriverWait(
            webdriver.driver, 5, ignored_exceptions=[NoSuchElementException]
        ).until(lambda driver: read_hidden_count(driver) == text)
    except TimeoutException:
        assert read_hidden_count(webdriver.driver) == text


def test_hidden_controls_follow_the_shaders_that_draw(webdriver):
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y", "z"], units="nm", scales=[1, 1, 1]
        )
        s.layers.append(
            name="image",
            layer=neuroglancer.ImageLayer(
                source=neuroglancer.LocalVolume(
                    dimensions=s.dimensions,
                    data=np.full(shape=(4, 4, 4), dtype=np.uint8, fill_value=42),
                ),
                volume_rendering_mode="On",
                hide_inactive_shader_controls=True,
                tab="rendering",
                shader="""
#uicontrol invlerp contrast
#uicontrol transferFunction tf
#uicontrol vec3 sliceTint color
#uicontrol float sliceGain slider(min=0, max=2, default=1)
void main() {
  if (VOLUME_RENDERING) {
    emitRGBA(tf() * contrast());
  } else {
    emitRGB(sliceTint * sliceGain * contrast());
  }
}
""",
            ),
        )
        s.selected_layer.layer = "image"
        s.selected_layer.visible = True
        s.layout = "4panel"

    def click_layout_button(layout):
        webdriver.driver.find_element(
            By.CSS_SELECTOR, f'button[title="Switch to {layout} layout."]'
        ).click()

    def set_volume_rendering_mode(mode):
        with webdriver.viewer.txn() as s:
            s.layers["image"].volume_rendering_mode = mode

    expect_hidden_count(webdriver, "")
    # Only the volume rendering shader draws: sliceTint and sliceGain hide.
    click_layout_button("3d")
    expect_hidden_count(webdriver, "(2 hidden)")
    click_layout_button("4panel-alt")
    expect_hidden_count(webdriver, "")
    # Only the slice shader draws: tf hides.
    click_layout_button("xy")
    expect_hidden_count(webdriver, "(1 hidden)")
    click_layout_button("4panel-alt")
    expect_hidden_count(webdriver, "")
    set_volume_rendering_mode("Off")
    expect_hidden_count(webdriver, "(1 hidden)")
    set_volume_rendering_mode("On")
    expect_hidden_count(webdriver, "")
