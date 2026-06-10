# @license
# Copyright 2025 Google Inc.
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
"""Tests for pick_radius functionality."""

import threading

import neuroglancer
import neuroglancer.viewer_config_state
import neuroglancer.webdriver


def setup_viewer(viewer: neuroglancer.Viewer, point_marker_size: float = 1.0) -> None:
    shader = f"void main() {{ setPointMarkerSize({point_marker_size}); }}"
    with viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y", "z"], units="nm", scales=[1, 1, 1]
        )
        s.layers.append(
            name="a",
            layer=neuroglancer.LocalAnnotationLayer(
                dimensions=s.dimensions,
                shader=shader,
            ),
        )
        s.layout = "xy"
        s.position = [0, 0, 0]
        s.cross_section_scale = 1
        s.show_axis_lines = False
        s.show_scale_bar = False

    with viewer.txn() as s:
        s.layers["a"].annotations.append(
            neuroglancer.PointAnnotation(id="1", point=[0, 0, 0])
        )


def check_pick(
    webdriver: neuroglancer.webdriver.Webdriver,
    offset_x: int = 0,
    offset_y: int = 0,
    annotation_id="1",
    should_move=True,
) -> bool:
    event = threading.Event()
    result: list[neuroglancer.viewer_config_state.ActionState | None] = [None]

    def my_action(s: neuroglancer.viewer_config_state.ActionState) -> None:
        result[0] = s
        event.set()

    webdriver.viewer.actions.add("pick-action", my_action)
    with webdriver.viewer.config_state.txn() as s:
        s.show_ui_controls = False
        s.show_panel_borders = True
        s.input_event_bindings.slice_view["click0"] = "pick-action"

    webdriver.sync()

    chain = webdriver.action_chain()
    # For a particular test, we need to cursor
    # to stay where it is after the first action chain call
    if should_move:
        chain.move_to_element(webdriver.root_element)
        if offset_x != 0 or offset_y != 0:
            chain.move_by_offset(offset_x, offset_y)
    else:
        chain.move_by_offset(offset_x, offset_y)
    chain.click()
    chain.perform()

    event.wait(timeout=2.0)

    action_state = result[0]
    if action_state is None:
        return False

    # Can add back for debugging
    # print(action_state)

    layer_selected_value = action_state.selected_values.get("a")
    return (
        layer_selected_value is not None
        and layer_selected_value.annotation_id == annotation_id
    )


def test_pick_radius(webdriver: neuroglancer.webdriver.Webdriver) -> None:
    setup_viewer(webdriver.viewer)
    webdriver.sync()

    # Default pick radius is 5.

    # Case 1: Click near center (offset 3) - expect success
    assert check_pick(webdriver, 3) is True

    # Case 2: Click far (offset 20) - expect failure
    assert check_pick(webdriver, 20) is False

    # Case 3: Increase pick radius to 30
    with webdriver.viewer.config_state.txn() as s:
        s.pick_radius = 30
    webdriver.sync()

    # Case 4: Click far (offset 20) - expect success now
    assert check_pick(webdriver, 20) is True

    # Case 5: Decrease pick radius to 1
    with webdriver.viewer.config_state.txn() as s:
        s.pick_radius = 1
    webdriver.sync()

    # Case 6: Click just beyond the rendered marker footprint - expect failure.
    #
    # `pick_radius = 1` checks the clicked pixel and its immediate neighbors.
    # `setPointMarkerSize(1.0)` only sets the marker interior size; the default
    # 1px marker border and 1px feather on both sides still make the 2D
    # pickable footprint about 5px wide.  Therefore offset 3 can still overlap
    # a pixel containing the annotation pick id, while offset 4 is the first
    # horizontal offset whose radius-1 pick window no longer overlaps that
    # footprint.
    assert check_pick(webdriver, 4) is False


def test_pick_y_border_offset(webdriver: neuroglancer.webdriver.Webdriver) -> None:
    """Regression test for the Y-coordinate border sign fix.

    rendered_data_panel.ts previously used ``+ element.clientTop`` instead of
    ``- element.clientTop`` when converting the mouse Y position to panel-content
    coordinates.
    """
    setup_viewer(webdriver.viewer)
    webdriver.sync()
    # Default pick_radius is 5

    # Take values inside and outside the pickable footprint, and verify that
    # the pick radius is correctly applied.
    # Radius is 5px, assume points are at least 3px in size
    # it is a bit unreliable whether the points extend to a 5px
    # window because of the feather weight, but 3px is a safe bet
    # So we check being within 2px of the pick window border and expect to find the pick value
    # while 4px or more away is outside the pickable footprint
    assert check_pick(webdriver, 0, 6) is True
    assert check_pick(webdriver, 0, -6) is True
    assert check_pick(webdriver, 0, 9) is False
    assert check_pick(webdriver, 0, -9) is False

    # Moving along x and y at the same time should also work
    assert check_pick(webdriver, 4, 4) is True
    assert check_pick(webdriver, 2, 3) is True
    assert check_pick(webdriver, 6, 6) is False


def test_pick_2d_oob_clear(webdriver: neuroglancer.webdriver.Webdriver) -> None:
    """Test for 2D picking out-of-bounds clear.

    The idea of this test is to set up a picking buffer containing two
    points. The expected behaviour is that picking returns a point
    only if it lies within the panel bounds.

    We use a very large pick_radius and point marker size since the
    exact distance is not important. All we care about is that the
    implementation only finds points that are within the panel bounds.

    This test is useful to have, although it unfortunately does not
    form a full end-to-end regression test for the original picking bug.
    If the steps are followed manually, the bug should be reproducible.
    The test still checks a real use case that the implementation must
    handle correctly; it simply cannot reliably verify the behaviour of
    clearOutOfBoundsPickData directly. However, clearOutOfBoundsPickData
    is covered by a TypeScript unit test, so the combination of the two
    tests should catch regressions.

    The bug involved the picking buffer and WebGL readPixels interacting
    such that valid pick IDs could remain stored outside the viewport
    bounds. Manual interaction, such as dragging the panel to change the
    position, can leave pick IDs present in locations outside the visible
    viewport. This is why clearOutOfBoundsPickData is required.

    In this automated test, however, it is difficult to reliably create
    a pick buffer containing stale out-of-bounds pick IDs. As a result,
    the test may still pass even if clearOutOfBoundsPickData is broken,
    simply because there are no out-of-bounds pick IDs available for it
    to clear.
    """
    setup_viewer(webdriver.viewer, point_marker_size=100.0)

    with webdriver.viewer.config_state.txn() as s:
        s.pick_radius = 100

    with webdriver.viewer.txn() as s:
        s.layers["a"].annotations.append(
            neuroglancer.PointAnnotation(id="oob", point=[500, 0, 0])
        )
        s.position = [20, 0, 0]
    webdriver.sync()

    # We move to see the oob point and can pick it
    assert check_pick(webdriver, 400, 0, "oob") is True

    with webdriver.viewer.txn() as s:
        s.position = [10, 0, 0]
    webdriver.sync()

    # When the oob point is no longer visible, we shouldn't be able to pick it anymore
    assert check_pick(webdriver, 1, 0, annotation_id="oob", should_move=False) is False


def test_pick_2d_search_order(webdriver: neuroglancer.webdriver.Webdriver) -> None:
    """Regression test for 2D picking order fix.

    The idea of this test is to setup a picking buffer with two points both in the picking buffer. The correct code should always return the point that is closer to the pick window centre. While the bugged code doesn't use distance order correctly and instead will return the pickID found in buffer index order.

    While setPointMarkerSize to 1.0 does not exactly create a one pixel marker, the test setup places the points far enough apart that the extra size of the point does not matter.

    Setup (pick_radius=5, pickDiameter=11 (11 x 11 pixel buffer), click at view centre):
    - "bottom" point at (0, 5, 0): maps to the pick window location (relativeX=5, relativeY=0) -> buffer index 5.
      Sequential scan ignores distance order and reaches i=4 in the buffer (i=4 instead of i=5 due to 1px feather), and finds a valid pick ID. So bugged code returns "bottom".
    - "center" point at (0, 0, 0): maps to pick window location(relativeX=5, relativeY=5)
      -> buffer index 60. Distance from click = 0 (nearest). Distance-sorted scan
      gives pickOffsetSequence[0]=60 and finds the pickID for the "center" point. So correct code returns "center".

    """

    setup_viewer(webdriver.viewer)

    with webdriver.viewer.txn() as s:
        s.layers["pts"].annotations.append(
            neuroglancer.PointAnnotation(id="bottom", point=[0, 5, 0])
        )

    webdriver.sync()

    assert (
        check_pick(
            webdriver,
            0,
            0,
        )
        is True
    )
