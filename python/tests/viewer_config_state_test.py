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

from neuroglancer import viewer_config_state


def test_config_state_pick_radius():
    c = viewer_config_state.ConfigState()
    assert c.pick_radius == 5
    assert c.pickRadius == 5

    c.pick_radius = 10
    assert c.pick_radius == 10
    assert c.pickRadius == 10
    assert c.to_json()["pickRadius"] == 10

    c2 = viewer_config_state.ConfigState(pickRadius=20)
    assert c2.pick_radius == 20
    assert c2.pickRadius == 20
