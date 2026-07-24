# @license
# Copyright 2026 Google Inc.
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
"""Test volume rendering picking."""

import threading

import neuroglancer
import numpy as np


def test_volume_rendering_picking_does_not_occlude_mesh(webdriver):
    """Volume rendering must not steal pick buffer entries from a transparent entry in front of it.

    Scene: a transparent segmentation mesh occupies the near half of the volume (low z,
    close to the default camera which looks in the +z direction), and an image volume
    occupies the far half (high z).  Clicking the centre of the 3-D view should pick
    the mesh, not the image.

    The regression being guarded: before the fix, volume rendering wrote the near-plane
    depth (≈ 0) to the picking buffer, making it appear closer than any real geometry
    and stealing pick buffer entries from meshes that were geometrically in front of it.
    """
    shape = (20, 20, 20)

    # Image data in the far half of the volume (high z = far from default camera,
    # which looks in the +z direction so low z is nearest).
    image_data = np.zeros(shape, dtype=np.uint8)
    image_data[:, :, 10:20] = 200

    # Segmentation cube in the near half (low z = close to default camera).
    # The cube must not touch any array boundary so that marching cubes generates
    # a fully closed mesh rather than an open plane.
    seg_data = np.zeros(shape, dtype=np.uint64)
    seg_data[2:18, 2:18, 2:9] = 1

    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y", "z"], units="nm", scales=[1, 1, 1]
        )
        s.layers.append(
            name="image",
            layer=neuroglancer.ImageLayer(
                source=neuroglancer.LocalVolume(
                    data=image_data, dimensions=s.dimensions
                ),
                volume_rendering_mode="On",
            ),
        )
        s.layers.append(
            name="seg",
            layer=neuroglancer.SegmentationLayer(
                source=neuroglancer.LocalVolume(data=seg_data, dimensions=s.dimensions),
                segments=[1],
                object_alpha=0.5,
            ),
        )
        s.layout = "3d"
        s.show_axis_lines = False
        s.position = [10, 10, 10]
        s.projection_scale = 30

    # threading.Event is required because the pick callback fires on a background
    # thread (browser → Python action dispatch), not on the test's main thread.
    event = threading.Event()
    result = [None]

    def pick_action(action_state):
        result[0] = action_state
        event.set()

    webdriver.viewer.actions.add("pick-action", pick_action)
    with webdriver.viewer.config_state.txn() as cs:
        cs.show_ui_controls = False
        cs.show_panel_borders = False
        cs.input_event_bindings.perspective_view["click0"] = "pick-action"

    webdriver.sync()

    webdriver.action_chain().move_to_element(webdriver.root_element).click().perform()

    assert event.wait(timeout=30.0), "Pick action was not triggered"
    action_state = result[0]
    assert action_state is not None

    seg_pick = action_state.selected_values.get("seg")
    assert seg_pick is not None, (
        "Segmentation mesh was not picked — volume rendering may be incorrectly "
        "occluding it via a wrong picking depth"
    )
    assert seg_pick.value == 1

    # Flip camera 180° around Y so it now looks from +z toward -z.  The image
    # volume (high z) is now in front of the mesh (low z), so the volume should
    # be picked instead.
    event.clear()
    result[0] = None
    with webdriver.viewer.txn() as s:
        s.projection_orientation = [0, 1, 0, 0]
    webdriver.sync()

    webdriver.action_chain().move_to_element(webdriver.root_element).click().perform()

    assert event.wait(timeout=30.0), "Pick action was not triggered after camera flip"
    action_state = result[0]
    assert action_state is not None

    image_pick = action_state.selected_values.get("image")
    assert (
        image_pick is not None
    ), "Image volume was not picked when it is in front of the mesh"
    # We don't assert the value because currently volume rendering reports 0
