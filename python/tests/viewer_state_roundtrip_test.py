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
"""Tests that ViewerState round trips through the Neuroglancer client."""

import numpy as np
import neuroglancer
import threading
import pytest


def test_mesh_silhouette(webdriver):
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y", "z"],
                                                    units="nm",
                                                    scales=[1, 1, 1])
        s.layers.append(
            name='a',
            layer=neuroglancer.SegmentationLayer(source=neuroglancer.LocalVolume(
                data=np.zeros((10, 10, 10), dtype=np.uint8), dimensions=s.dimensions),
                                                 mesh_silhouette_rendering=2),
        )

    state = webdriver.sync()
    assert state.layers['a'].mesh_silhouette_rendering == 2


def test_layer_subsources(webdriver):
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y", "z"],
                                                    units="nm",
                                                    scales=[1, 1, 1])
        s.layers.append(
            name='a',
            layer=neuroglancer.SegmentationLayer(
                source=neuroglancer.LayerDataSource(url=neuroglancer.LocalVolume(
                    data=np.zeros((10, 10, 10), dtype=np.uint8), dimensions=s.dimensions),
                                                    enable_default_subsources=False,
                                                    subsources={
                                                        'default': True,
                                                        'bounds': False,
                                                        'meshes': False
                                                    })),
        )

    state = webdriver.sync()
    assert state.layers['a'].source[0].subsources['default'].enabled == True
    assert 'bounds' not in state.layers['a'].source[0].subsources
    assert 'meshes' not in state.layers['a'].source[0].subsources
    assert state.layers['a'].source[0].enable_default_subsources == False

    with webdriver.viewer.txn() as s:
        s.layers[0].source[0].enable_default_subsources = True
        s.layers[0].source[0].subsources['bounds'] = False
        s.layers[0].source[0].subsources['meshes'] = False

    state = webdriver.sync()
    assert state.layers[0].source[0].enable_default_subsources == True
    assert sorted(state.layers[0].source[0].subsources.keys()) == ['bounds', 'meshes']
    assert state.layers[0].source[0].subsources['bounds'].enabled == False
    assert state.layers[0].source[0].subsources['meshes'].enabled == False
