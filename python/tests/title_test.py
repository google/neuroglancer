# @license
# Copyright 2021 Google Inc.
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
"""Tests that shader control parameters can be specified from Python."""

import neuroglancer
import numpy as np
import pytest


def test_title(webdriver):
    a = np.array([[[255]]], dtype=np.uint8)
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y", "z"],
                                                    units="nm",
                                                    scales=[1, 1, 1])
        s.layers.append(
            name="a",
            layer=neuroglancer.ImageLayer(source=neuroglancer.LocalVolume(data=a,
                                                                          dimensions=s.dimensions),
                                          ),
        )

    webdriver.sync()

    assert webdriver.driver.title == 'neuroglancer'

    with webdriver.viewer.txn() as s:
        s.title = 'the title'

    webdriver.sync()

    assert webdriver.driver.title == 'the title - neuroglancer'

    with webdriver.viewer.txn() as s:
        s.title = None

    webdriver.sync()

    assert webdriver.driver.title == 'neuroglancer'
