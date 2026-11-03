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
import pytest

dimensions = neuroglancer.CoordinateSpace(
    names=["x", "y", "z"], units="nm", scales=[1, 1, 1]
)


class SkeletonSource(neuroglancer.skeleton.SkeletonSource):
    def __init__(
        self,
        *,
        vertex_positions=((0, 0, 0),),
        edges=((0, 0),),
    ):
        super().__init__(dimensions=dimensions)
        self.skeleton = neuroglancer.skeleton.Skeleton(
            vertex_positions=vertex_positions,
            edges=edges,
        )

    def get_skeleton(self, object_id):
        return self.skeleton


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
    np.testing.assert_array_equal(
        screenshot.image_pixels,
        np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)),
    )

    with webdriver.viewer.txn() as s:
        s.layout = "3d"
        s.layers[0].skeleton_rendering.line_width3d = 100
    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    np.testing.assert_array_equal(
        screenshot.image_pixels,
        np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)),
    )

    with webdriver.viewer.txn() as s:
        s.layers[0].source[0].subsources["default"] = False

    screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
    np.testing.assert_array_equal(
        screenshot.image_pixels,
        np.tile(np.array([0, 0, 0, 255], dtype=np.uint8), (10, 10, 1)),
    )


@pytest.mark.parametrize("layout", ["xy", "3d"])
@pytest.mark.parametrize("primitive", ["edge", "node"])
@pytest.mark.parametrize(
    "shader_alpha,layer_alpha", [(1, 1), (0.5, 1), (1, 0.5), (0.5, 0.5)]
)
def test_skeleton_rgba_opacity(webdriver, layout, primitive, shader_alpha, layer_alpha):
    if primitive == "edge":
        source = SkeletonSource(
            vertex_positions=[[-100, 0, 0], [100, 0, 0]],
            edges=[[0, 1]],
        )
    else:
        source = SkeletonSource(edges=np.empty((0, 2), dtype=np.uint32))

    with webdriver.viewer.txn() as s:
        s.dimensions = dimensions
        s.position = [0, 0, 0]
        s.layout = layout
        s.cross_section_scale = 1
        s.projection_scale = 32
        s.projection_orientation = [0, 0, 0, 1]
        s.cross_section_background_color = "#000000"
        s.projection_background_color = "#000000"
        s.show_axis_lines = False
        s.show_scale_bar = False
        s.layers.append(
            name="skeleton",
            layer=neuroglancer.SegmentationLayer(
                source=source,
                segments=[1],
                object_alpha=layer_alpha,
            ),
        )
        rendering = s.layers[0].skeleton_rendering
        rendering.mode2d = "lines"
        rendering.mode3d = "lines"
        rendering.line_width2d = 16
        rendering.line_width3d = 16
        rendering.shader = f"""
void main() {{
  emitRGBA(vec4(1.0, 0.5, 0.25, {shader_alpha:.1f}));
}}
"""

    pixels = webdriver.viewer.screenshot(size=[32, 32]).screenshot.image_pixels
    expected_rgb = np.array([1.0, 0.5, 0.25]) * shader_alpha * layer_alpha * 255
    expected = np.tile(np.append(expected_rgb, 255), (4, 4, 1))
    np.testing.assert_allclose(pixels[14:18, 14:18], expected, atol=2, rtol=0)
