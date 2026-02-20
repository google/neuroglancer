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


def setup_viewer(viewer: neuroglancer.Viewer) -> None:
    with viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y", "z"], units="nm", scales=[1, 1, 1]
        )
        s.layers.append(
            name="a",
            layer=neuroglancer.LocalAnnotationLayer(
                dimensions=s.dimensions,
                shader="void main() { setPointMarkerSize(1.0); }",
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


def check_pick(webdriver: neuroglancer.webdriver.Webdriver, offset_x: int) -> bool:
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
    chain.move_to_element(webdriver.root_element)
    if offset_x != 0:
        chain.move_by_offset(offset_x, 0)
    chain.click()
    chain.perform()

    event.wait(timeout=2.0)

    action_state = result[0]
    if action_state is None:
        return False

    print(action_state)

    layer_selected_value = action_state.selected_values.get("a")
    return (
        layer_selected_value is not None and layer_selected_value.annotation_id == "1"
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

    # Case 6: Click offset 3 - expect failure
    assert check_pick(webdriver, 3) is False
