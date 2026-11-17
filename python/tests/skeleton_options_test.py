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
"""Screenshot tests for skeleton rendering.

`test_skeleton_options` checks that a skeleton layer draws, that the layer
opacity blends it with the background, and that turning its subsource off stops
it. `test_skeleton_opacity` checks how the layer opacity combines with each
shader output. `test_skeleton_render_mode` checks that each render mode
produces the shading it is supposed to, and that the modes which enlarge the nodes
cover more than the ones that do not.
"""

import neuroglancer
import neuroglancer.skeleton
import numpy as np
import pytest

dimensions = neuroglancer.CoordinateSpace(
    names=["x", "y", "z"], units="nm", scales=[1, 1, 1]
)

USER_SHADER = """
#uicontrol vec3 color color(default="white")
void main () {
  emitRGB(color);
}
"""

DEFAULT_SHADER = """
void main () {
  emitDefault();
}
"""

# getLineAlpha belongs to the edge program alone, so the node program cannot
# compile this.
EDGE_ONLY_SHADER = """
#uicontrol vec3 color color(default="white")
void main () {
  emitRGB(color * getLineAlpha());
}
"""


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


def two_node_skeleton_source():
    return SkeletonSource(
        vertex_positions=[[-20, -20, 0], [20, 20, 0]],
        edges=[[0, 1]],
    )


def screenshot_pixels(webdriver, size):
    return webdriver.viewer.screenshot(size=[size, size]).screenshot.image_pixels


def render_skeleton(
    webdriver,
    source,
    *,
    layout,
    line_width,
    size,
    mode=None,
    shader=USER_SHADER,
    object_alpha=None,
):
    """Draws one red skeleton on black and returns the screenshot pixels."""
    with webdriver.viewer.txn() as s:
        s.dimensions = dimensions
        s.position = [0, 0, 0]
        s.layout = layout
        s.projection_scale = 120
        s.cross_section_scale = 0.6
        # Otherwise grey in the slice view, and these tests read black as not drawn.
        s.cross_section_background_color = "#000000"
        s.show_axis_lines = False
        s.show_scale_bar = False
        s.layers.clear()
        s.layers.append(
            name="a",
            layer=neuroglancer.SegmentationLayer(source=source, segments=[1]),
        )
        # Red either way: a user shader reads the control, the default shader reads
        # the segment colour.
        s.layers[0].segment_default_color = "#f00"
        if object_alpha is not None:
            s.layers[0].object_alpha = object_alpha
        rendering = s.layers[0].skeleton_rendering
        rendering.line_width2d = line_width
        rendering.line_width3d = line_width
        if mode is not None:
            if layout == "3d":
                rendering.mode3d = mode
            else:
                rendering.mode2d = mode
        rendering.shader = shader
        rendering.shader_controls["color"] = "#f00"
    return screenshot_pixels(webdriver, size)


def drawn_pixel_count(image):
    return int((image[..., 0] != 0).sum())


def brightest_red(image):
    return int(image[..., 0].max())


def assert_solid_color(image, color):
    np.testing.assert_array_equal(
        image, np.tile(np.array(color, dtype=np.uint8), image.shape[:2] + (1,))
    )


def test_skeleton_options(webdriver):
    # A marker wider than the viewport, so the colour can be checked exactly.
    image = render_skeleton(
        webdriver,
        SkeletonSource(),
        layout="xy",
        line_width=100,
        size=10,
    )
    assert_solid_color(image, [255, 0, 0, 255])
    opaque_pixels_2d = image.copy()

    with webdriver.viewer.txn() as s:
        s.layers[0].source[0].subsources["default"] = False
    background_pixels_2d = screenshot_pixels(webdriver, 10).copy()

    with webdriver.viewer.txn() as s:
        s.layers[0].source[0].subsources["default"] = True
        s.layers[0].object_alpha = 0.5
    pixels = screenshot_pixels(webdriver, 10)
    np.testing.assert_allclose(
        pixels[..., :3],
        opaque_pixels_2d[..., :3] * 0.5 + background_pixels_2d[..., :3] * 0.5,
        atol=2,
    )
    np.testing.assert_array_equal(pixels[..., 3], 255)

    with webdriver.viewer.txn() as s:
        s.layout = "3d"
        s.layers[0].object_alpha = 1.0
    opaque_pixels = screenshot_pixels(webdriver, 10).copy()
    assert_solid_color(opaque_pixels, [255, 0, 0, 255])

    # Perspective OIT requires premultiplied RGB, so reducing opacity must
    # reduce the red intensity rather than leave it saturated or brighten it.
    with webdriver.viewer.txn() as s:
        s.layers[0].object_alpha = 0.5
    pixels = screenshot_pixels(webdriver, 10)
    np.testing.assert_allclose(pixels[..., 0], opaque_pixels[..., 0] * 0.5, atol=2)
    np.testing.assert_array_equal(pixels[..., 1], 0)
    np.testing.assert_array_equal(pixels[..., 2], 0)
    np.testing.assert_array_equal(pixels[..., 3], 255)

    with webdriver.viewer.txn() as s:
        s.layers[0].source[0].subsources["default"] = False
    assert_solid_color(screenshot_pixels(webdriver, 10), [0, 0, 0, 255])


# Each entry pairs a mode with the only shading signature it produces. What
# separates them is how the brightness of the drawn pixels is distributed, not how
# dark the darkest one is: a feathered edge and a lit surface both reach down toward
# zero, so the minimum alone cannot tell them apart.
#
# FLAT       every drawn pixel is fully bright
# FEATHERED  a majority fully bright, with a thin partial rim
# LIT        few fully bright, because the surface normal turns across the whole
#            surface. The lighting factor is `abs(dot(normal, light)) + ambient`
#            with ambient 0.2 and directional 0.8, so a lit pixel runs over
#            [0.2, 1.0] of full brightness.
FEATHERED = "feathered"
FLAT = "flat"
LIT = "lit"

FULL_BRIGHTNESS = 255
# A feathered rim is a perimeter effect, so most of the line is still fully bright.
MIN_FULLY_BRIGHT_FRACTION_WHEN_FEATHERED = 0.5
# A lit surface varies everywhere, so almost nothing sits at exactly full.
MAX_FULLY_BRIGHT_FRACTION_WHEN_LIT = 0.2
# Lighting runs over [0.2, 1.0], and a side-on view sweeps most of that range.
MIN_BRIGHTNESS_SPREAD_WHEN_LIT = 0.4 * FULL_BRIGHTNESS

RENDER_MODES = [
    ("xy", "lines", FEATHERED),
    ("xy", "lines_and_points", FEATHERED),
    ("3d", "lines", FLAT),
    ("3d", "lines_and_points", FLAT),
    ("3d", "cylinders", LIT),
    ("3d", "cylinders_and_balls", LIT),
]

ENLARGED_PAIRS = [
    ("xy", "lines", "lines_and_points"),
    ("3d", "lines", "lines_and_points"),
    ("3d", "cylinders", "cylinders_and_balls"),
]


def test_skeleton_render_mode(webdriver):
    drawn_counts = {}
    for layout, mode, shading in RENDER_MODES:
        case = f"{layout}/{mode}"
        image = render_skeleton(
            webdriver,
            two_node_skeleton_source(),
            layout=layout,
            line_width=10,
            size=100,
            mode=mode,
        )
        red, green, blue = (image[..., i].astype(int) for i in range(3))
        # A pure red shader leaves the other channels untouched in every mode.
        np.testing.assert_array_equal(
            green, 0, err_msg=f"{case} put light in the green channel"
        )
        np.testing.assert_array_equal(
            blue, 0, err_msg=f"{case} put light in the blue channel"
        )
        drawn_red = red[red != 0]
        assert (
            len(drawn_red) > 200
        ), f"{case} drew {len(drawn_red)} pixels, too few to judge the shading"
        drawn_counts[(layout, mode)] = len(drawn_red)

        fully_bright = (drawn_red == FULL_BRIGHTNESS).mean()
        brightest, darkest = drawn_red.max(), drawn_red.min()

        if shading is FLAT:
            np.testing.assert_array_equal(
                drawn_red,
                FULL_BRIGHTNESS,
                err_msg=(
                    f"{case} should shade nothing, so every drawn pixel should be "
                    f"{FULL_BRIGHTNESS}, but they run {darkest} to {brightest}"
                ),
            )
        elif shading is FEATHERED:
            assert fully_bright < 1.0, (
                f"{case} has every drawn pixel at {FULL_BRIGHTNESS}, so its edge "
                "is not feathered"
            )
            assert fully_bright > MIN_FULLY_BRIGHT_FRACTION_WHEN_FEATHERED, (
                f"{case} has only {fully_bright:.0%} of drawn pixels at full "
                "brightness. A feather is a rim, so the interior should stay full. "
                "This looks like shading across the whole surface"
            )
        else:
            assert fully_bright < MAX_FULLY_BRIGHT_FRACTION_WHEN_LIT, (
                f"{case} has {fully_bright:.0%} of drawn pixels at full brightness. "
                "A lit surface turns its normal everywhere, so few should be flat "
                "out. This looks like a feathered edge on flat colour"
            )
            assert brightest - darkest > MIN_BRIGHTNESS_SPREAD_WHEN_LIT, (
                f"{case} spans only {brightest - darkest} brightness levels "
                f"({darkest} to {brightest}). Lighting runs over "
                f"[0.2, 1.0], so a side-on view should sweep most of it"
            )

    for layout, plain, enlarged in ENLARGED_PAIRS:
        plain_count = drawn_counts[(layout, plain)]
        enlarged_count = drawn_counts[(layout, enlarged)]
        assert enlarged_count > plain_count, (
            f"{layout}/{enlarged} drew {enlarged_count} pixels against "
            f"{plain_count} for {layout}/{plain}. Enlarging the nodes should cover "
            "strictly more"
        )


# A half opaque line measured 128.
MIN_BRIGHTNESS_FOR_A_HALF_OPAQUE_LINE = 122


def test_cylinder_default_shader_object_alpha(webdriver):
    # The line is the reference because its emitDefault does not premultiply twice.
    # A tube overlaps itself at a joint, so it can only read above the line.
    def brightest(mode):
        return brightest_red(
            render_skeleton(
                webdriver,
                two_node_skeleton_source(),
                layout="3d",
                line_width=10,
                size=100,
                mode=mode,
                shader=DEFAULT_SHADER,
                object_alpha=0.5,
            )
        )

    line = brightest("lines")
    tube = brightest("cylinders")
    assert (
        line > MIN_BRIGHTNESS_FOR_A_HALF_OPAQUE_LINE
    ), f"the half opaque line reached only {line}, too dark to compare against"
    assert tube >= line, (
        f"the half opaque tube reached {tube} against {line} for a line of the same "
        f"colour and opacity. About {line // 2} means the object alpha was likely applied "
        "twice"
    )


def test_edge_only_user_shader_still_draws_edges(webdriver):
    # The node program's fallback is that same source, so it ends up with no shader.
    image = render_skeleton(
        webdriver,
        two_node_skeleton_source(),
        layout="xy",
        line_width=10,
        size=100,
        shader=EDGE_ONLY_SHADER,
    )
    assert drawn_pixel_count(image) > 200, (
        f"drew {drawn_pixel_count(image)} pixels, so a node shader that failed to "
        "compile meant the edge pass never happened"
    )


@pytest.mark.parametrize("layout", ["xy", "3d"])
@pytest.mark.parametrize("primitive", ["edge", "node"])
@pytest.mark.parametrize(
    "shader_output,shader_alpha",
    [
        ("rgba", 1),
        ("rgba", 0.5),
        ("rgb", 1),
        ("default", 1),
        ("segment-rgb", 1),
        ("segment-rgba", 1),
    ],
)
@pytest.mark.parametrize("layer_alpha", [1, 0.5])
def test_skeleton_opacity(
    webdriver, layout, primitive, shader_output, shader_alpha, layer_alpha
):
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
                segment_colors={1: "#ff8040"},
            ),
        )
        rendering = s.layers[0].skeleton_rendering
        rendering.mode2d = "lines"
        rendering.mode3d = "lines"
        rendering.line_width2d = 16
        rendering.line_width3d = 16
        if shader_output == "rgba":
            rendering.shader = f"""
void main() {{
  emitRGBA(vec4(1.0, 0.5, 0.25, {shader_alpha:.1f}));
}}
"""
        elif shader_output == "rgb":
            rendering.shader = "void main() { emitRGB(vec3(1.0, 0.5, 0.25)); }"
        elif shader_output == "default":
            rendering.shader = "void main() { emitDefault(); }"
        elif shader_output == "segment-rgb":
            rendering.shader = "void main() { emitRGB(segmentColor().rgb); }"
        else:
            rendering.shader = "void main() { emitRGBA(segmentColor()); }"

    pixels = webdriver.viewer.screenshot(size=[32, 32]).screenshot.image_pixels
    color = (
        np.array([255, 128, 64])
        if shader_output in ("default", "segment-rgb", "segment-rgba")
        else np.array([255, 127.5, 63.75])
    )
    expected_rgb = color * shader_alpha * layer_alpha
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
