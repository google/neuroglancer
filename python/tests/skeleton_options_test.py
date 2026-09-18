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


def test_segment_color_shader_alpha_makes_skeleton_transparent(webdriver):
    image_data = np.zeros((20, 20, 20), dtype=np.uint8)
    image_data[1:19, 1:19, 11:20] = 255

    with webdriver.viewer.txn() as s:
        s.dimensions = dimensions
        s.layers.append(
            name="image",
            layer=neuroglancer.ImageLayer(
                source=neuroglancer.LocalVolume(data=image_data, dimensions=dimensions),
                volume_rendering_mode="Max",
                shader="""
#uicontrol invlerp normalized
void main() {
  emitRGBA(vec4(0.0, 0.0, normalized(), 1.0));
}
""",
            ),
        )
        s.layers.append(
            name="skeleton",
            layer=neuroglancer.SegmentationLayer(
                source=SkeletonSource(vertex_positions=[(10, 10, 5)]),
                segments=[1],
                segment_color_shader="""
vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
  return vec4(color.rgb, 0.5);
}
""",
                skeleton_shader="""
void main() {
  emitRGB(vec3(1.0, 0.0, 0.0));
}
""",
            ),
        )
        s.layers["skeleton"].skeleton_rendering.line_width3d = 100
        s.layout = "3d"
        s.show_axis_lines = False
        s.position = [10, 10, 10]
        s.projection_scale = 15

    webdriver.sync()
    pixels = webdriver.viewer.screenshot(size=[10, 10]).screenshot.image_pixels
    assert np.all(pixels[..., 0] > 0)
    assert np.all(pixels[..., 2] > 0)
