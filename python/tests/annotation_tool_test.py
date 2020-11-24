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
"""Tests that annotation tools can be selected from Python."""

import neuroglancer
import numpy as np
import pytest


def setup_viewer(viewer):
    with viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y", "z"],
                                                    units="nm",
                                                    scales=[1, 1, 1])
        s.layers.append(name="seg",
                        layer=neuroglancer.SegmentationLayer(source=neuroglancer.LocalVolume(
                            data=np.array([[[42]]], dtype=np.uint32), dimensions=s.dimensions)))
        s.layers.append(
            name="a",
            layer=neuroglancer.LocalAnnotationLayer(dimensions=s.dimensions,
                                                    linked_segmentation_layer={'segments': 'seg'},
                                                    filter_by_segmentation=['segments'],
                                                    ignore_null_segment_filter=False),
        )
        s.layout = 'xy'
        s.cross_section_scale = 1e-6
        s.show_axis_lines = False
        s.selected_layer.layer = 'a'


@pytest.mark.parametrize('tool,tool_class,annotation_class,num_clicks', [
    ('annotatePoint', neuroglancer.PlacePointTool, neuroglancer.PointAnnotation, 1),
    ('annotateLine', neuroglancer.PlaceLineTool, neuroglancer.LineAnnotation, 2),
    ('annotateBoundingBox', neuroglancer.PlaceBoundingBoxTool,
     neuroglancer.AxisAlignedBoundingBoxAnnotation, 2),
    ('annotateSphere', neuroglancer.PlaceEllipsoidTool, neuroglancer.EllipsoidAnnotation, 2),
])
def test_annotate(webdriver, tool, tool_class, annotation_class, num_clicks):
    from selenium.webdriver.common.keys import Keys
    setup_viewer(viewer=webdriver.viewer)
    with webdriver.viewer.txn() as s:
        s.layers['a'].tool = tool
        assert isinstance(s.layers['a'].tool, tool_class)
    webdriver.sync()
    chain = webdriver.action_chain().key_down(Keys.CONTROL)
    for i in range(num_clicks):
        chain = chain.move_to_element_with_offset(webdriver.root_element, 300 + 50 * i,
                                                  300 + 50 * i).click()
    chain.key_up(Keys.CONTROL)
    chain.perform()
    webdriver.sync()
    annotations = webdriver.viewer.state.layers['a'].annotations
    assert len(annotations) == 1
    assert isinstance(annotations[0], annotation_class)
    if tool in ('annotatePoint', 'annotateLine'):
        assert list(annotations[0].segments[0]) == [42]
