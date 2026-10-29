# @license
# Copyright 2018 Google Inc.
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


import os

import numpy as np
from neuroglancer import local_volume, test_util, viewer_state

testdata_dir = os.path.join(os.path.dirname(__file__), "..", "..", "testdata", "mesh")


def test_simple_mesh():
    # Keep coordinates, spacing, and padding fixed: these inputs were checked with
    # Clang contraction enabled and disabled on ARM64 and x86-64.
    data = np.pad(
        np.array(
            [
                [
                    [1, 0, 0, 0, 0, 0, 0, 0, 0],
                    [0, 0, 0, 0, 0, 0, 0, 2, 2],
                ],
                [
                    [1, 0, 0, 0, 0, 0, 2, 2, 2],
                    [1, 1, 0, 0, 0, 0, 0, 0, 2],
                ],
            ],
            dtype=np.uint64,
        ),
        1,
        "constant",
    )
    dimensions = viewer_state.CoordinateSpace(
        names=["x", "y", "z"],
        scales=[1, 1, 1],
        units=["m", "m", "m"],
    )
    vol = local_volume.LocalVolume(
        data,
        dimensions=dimensions,
        mesh_options=dict(
            max_quadrics_error=1,
        ),
    )
    test_util.check_golden_contents(
        os.path.join(testdata_dir, "stable_bend"), vol.get_object_mesh(1)
    )
    test_util.check_golden_contents(
        os.path.join(testdata_dir, "stable_branch"), vol.get_object_mesh(2)
    )
