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

from __future__ import absolute_import

import os

import numpy as np
from neuroglancer import local_volume
from neuroglancer import viewer_state
from neuroglancer import test_util

testdata_dir = os.path.join(os.path.dirname(__file__), '..', 'testdata', 'mesh')


def test_simple_mesh():
    data = np.array(
        [
            [[1, 1, 1, 2, 2, 2], [1, 1, 1, 2, 2, 2], [1, 1, 1, 2, 2, 2]],
            [[1, 1, 1, 2, 2, 2], [1, 1, 1, 2, 2, 2], [1, 1, 1, 2, 2, 2]],
        ],
        dtype=np.uint64).transpose()
    data = np.pad(data, 1, 'constant')
    dimensions = viewer_state.CoordinateSpace(names=['x', 'y', 'z'],
                                              scales=[1, 1, 1],
                                              units=['m', 'm', 'm'],)
    vol = local_volume.LocalVolume(
        data, dimensions=dimensions,
        mesh_options=dict(
            max_quadrics_error=1e6,
        ),
    )
    test_util.check_golden_contents(os.path.join(testdata_dir, 'simple1'), vol.get_object_mesh(1))
    test_util.check_golden_contents(os.path.join(testdata_dir, 'simple2'), vol.get_object_mesh(2))
