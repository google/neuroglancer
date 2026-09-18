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

import neuroglancer
import neuroglancer.skeleton
import numpy as np

dimensions = neuroglancer.CoordinateSpace(
    names=["x", "y", "z"], units="nm", scales=[1, 1, 1]
)


class SkeletonSource(neuroglancer.skeleton.SkeletonSource):
    def __init__(self):
        super().__init__(dimensions=dimensions)

    def get_skeleton(self, object_id):
        return neuroglancer.skeleton.Skeleton(
            vertex_positions=[[0, 0, 0]],
            edges=[[0, 0]],
        )


def test_skeleton_options(webdriver):
    with webdriver.viewer.txn() as s:
        s.dimensions = dimensions
        s.position = [0, 0, 0]
        s.layout = "xy"
        s.layers.append(
            name="a",
            layer=neuroglancer.SegmentationLayer(
                source=SkeletonSource(),
                segments=[1],
            ),
        )
        s.layers[0].skeleton_rendering.line_width2d = 100
        s.layers[0].skeleton_rendering.shader = """
#uicontrol vec3 color color(default="white")
void main () {
  emitRGB(color);
}
"""
        s.layers[0].skeleton_rendering.shader_controls["color"] = "#f00"
        s.show_axis_lines = False
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    opaque_pixels_2d = screenshot.image_pixels.copy()
    np.testing.assert_array_equal(
        opaque_pixels_2d,
        np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)),
    )

    with webdriver.viewer.txn() as s:
        s.layers[0].source[0].subsources["default"] = False
    background_pixels_2d = webdriver.viewer.screenshot(
        size=[10, 10]
    ).screenshot.image_pixels.copy()

    with webdriver.viewer.txn() as s:
        s.layers[0].source[0].subsources["default"] = True
        s.layers[0].object_alpha = 0.5
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    pixels = screenshot.image_pixels
    np.testing.assert_allclose(
        pixels[..., :3],
        opaque_pixels_2d[..., :3] * 0.5 + background_pixels_2d[..., :3] * 0.5,
        atol=2,
    )
    np.testing.assert_array_equal(pixels[..., 3], 255)

    with webdriver.viewer.txn() as s:
        s.layout = "3d"
        s.layers[0].object_alpha = 1.0
        s.layers[0].skeleton_rendering.line_width3d = 100
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    opaque_pixels = screenshot.image_pixels.copy()
    np.testing.assert_array_equal(
        opaque_pixels,
        np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)),
    )

    # Perspective OIT requires premultiplied RGB, so reducing opacity must
    # reduce the red intensity rather than leave it saturated or brighten it.
    with webdriver.viewer.txn() as s:
        s.layers[0].object_alpha = 0.5
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    pixels = screenshot.image_pixels
    np.testing.assert_allclose(pixels[..., 0], opaque_pixels[..., 0] * 0.5, atol=2)
    np.testing.assert_array_equal(pixels[..., 1], 0)
    np.testing.assert_array_equal(pixels[..., 2], 0)
    np.testing.assert_array_equal(pixels[..., 3], 255)

    with webdriver.viewer.txn() as s:
        s.layers[0].source[0].subsources["default"] = False

    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    np.testing.assert_array_equal(
        screenshot.image_pixels,
        np.tile(np.array([0, 0, 0, 255], dtype=np.uint8), (10, 10, 1)),
    )
