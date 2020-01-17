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

from __future__ import absolute_import

from neuroglancer import viewer_state
import collections
import numpy as np

def test_coordinate_space_from_json():
    x = viewer_state.CoordinateSpace(collections.OrderedDict([
        ['x', [4e-9, 'm']],
        ['y', [5e-9, 'm']],
        ['z', [6e-9, 'm']],
        ['t', [2, 's']],
    ]))
    assert x.names == ('x', 'y', 'z', 't')
    np.testing.assert_array_equal(x.scales, [4e-9, 5e-9, 6e-9, 2])
    assert x.units == ('m', 'm', 'm', 's')
    assert x.rank == 4
    assert x[0] == viewer_state.DimensionScale(4e-9, 'm')
    assert x[0:2] == [viewer_state.DimensionScale(4e-9, 'm'),
                      viewer_state.DimensionScale(5e-9, 'm')]
    assert x['x'] == viewer_state.DimensionScale(4e-9, 'm')
    assert x[1] == viewer_state.DimensionScale(5e-9, 'm')
    assert x['y'] == viewer_state.DimensionScale(5e-9, 'm')
    assert x[2] == viewer_state.DimensionScale(6e-9, 'm')
    assert x['z'] == viewer_state.DimensionScale(6e-9, 'm')
    assert x[3] == viewer_state.DimensionScale(2, 's')
    assert x['t'] == viewer_state.DimensionScale(2, 's')
    assert x.to_json() == collections.OrderedDict([
        ['x', [4e-9, 'm']],
        ['y', [5e-9, 'm']],
        ['z', [6e-9, 'm']],
        ['t', [2, 's']],
    ])

def test_coordinate_space_from_split():
    x = viewer_state.CoordinateSpace(names=['x', 'y', 'z', 't'],
                                     scales=[4, 5, 6, 2],
                                     units=['nm', 'nm', 'nm', 's'])
    assert x.to_json() == collections.OrderedDict([
        ['x', [4e-9, 'm']],
        ['y', [5e-9, 'm']],
        ['z', [6e-9, 'm']],
        ['t', [2, 's']],
    ])
