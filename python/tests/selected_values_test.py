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
"""Tests that selected values can be retrieved from actions."""

import numpy as np
import neuroglancer
import threading
import pytest


def setup_viewer(viewer, dtype, value, layer_type):
    a = np.array([[[value]]], dtype=dtype)
    with viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y", "z"],
                                                    units="nm",
                                                    scales=[1, 1, 1])
        s.layers.append(
            name="a",
            layer=layer_type(
                source=neuroglancer.LocalVolume(data=a, dimensions=s.dimensions),
            ),
        )
        s.layout = 'xy'
        s.cross_section_scale = 1e-6
        s.show_axis_lines = False

def get_selected_value(webdriver):
    event = threading.Event()
    result = [None]
    def my_action(s):
        result[0] = s
        event.set()
    webdriver.viewer.actions.add('my-action', my_action)
    with webdriver.viewer.config_state.txn() as s:
        s.show_ui_controls = False
        s.show_panel_borders = False
        s.input_event_bindings.slice_view['click0'] = 'my-action'
    webdriver.sync()
    webdriver.action_chain().move_to_element_with_offset(webdriver.root_element, 300,
                                                         300).click().perform()
    event.wait()
    action_state = result[0]
    assert action_state is not None
    np.testing.assert_array_equal(np.floor(action_state.mouse_voxel_coordinates), [0, 0, 0])
    return action_state

@pytest.mark.parametrize('dtype,value,layer_type', [
    (np.uint8, 1, neuroglancer.ImageLayer),
    (np.uint32, 2**32 - 1, neuroglancer.ImageLayer),
    (np.uint64, 2**64 - 1, neuroglancer.ImageLayer),
    (np.uint64, 2**64 - 1, neuroglancer.SegmentationLayer),
    (np.float32, 1.5, neuroglancer.ImageLayer),
])
def test_selected_value(webdriver, dtype, value, layer_type):
    setup_viewer(viewer=webdriver.viewer, dtype=dtype, value=value, layer_type=layer_type)
    action_state = get_selected_value(webdriver)
    assert action_state.selected_values['a'].value == value

def test_selected_value_with_equivalences(webdriver):
    setup_viewer(viewer=webdriver.viewer,
                 dtype=np.uint64,
                 value=2,
                 layer_type=neuroglancer.SegmentationLayer)
    with webdriver.viewer.txn() as s:
        s.layers[0].equivalences = [[1, 2]]
    action_state = get_selected_value(webdriver)
    assert action_state.selected_values['a'].value == neuroglancer.SegmentIdMapEntry(2, 1)
