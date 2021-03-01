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
"""Tests that annotation properties and relationships can be specified from Python."""

import neuroglancer
import numpy as np


def test_annotate(webdriver):
    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y"],
                                                    units="nm",
                                                    scales=[1, 1])
        s.position = [0, 0]
        s.layers.append(
            name='seg1',
            layer=neuroglancer.SegmentationLayer(
                source=neuroglancer.LocalVolume(
                    dimensions=s.dimensions,
                    data=np.full(shape=(1, 1), dtype=np.uint32, fill_value=42),
                ),
            ),
            segments=[42],
            visible=False,
        )
        s.layers.append(
            name='seg2',
            layer=neuroglancer.SegmentationLayer(
                source=neuroglancer.LocalVolume(
                    dimensions=s.dimensions,
                    data=np.full(shape=(1, 1), dtype=np.uint32, fill_value=43),
                ),
            ),
            segments=[],
            visible=False,
        )
        s.layers.append(
            name="a",
            layer=neuroglancer.LocalAnnotationLayer(
                dimensions=s.dimensions,
                annotation_relationships=['a', 'b'],
                linked_segmentation_layer={'a': 'seg1', 'b': 'seg2'},
                filter_by_segmentation=['a', 'b'],
                ignore_null_segment_filter=False,
                annotation_properties=[
                    neuroglancer.AnnotationPropertySpec(
                        id='color',
                        type='rgb',
                        default='red',
                    )
                ],
                annotations=[
                    neuroglancer.PointAnnotation(
                        id='1',
                        point=[0, 0],
                        segments=[[42], []],
                        props=['#0f0'],
                    ),
                    neuroglancer.PointAnnotation(
                        id='2',
                        point=[0, 0],
                        segments=[[], [43]],
                        props=['#00f'],
                    ),
                    neuroglancer.PointAnnotation(
                        id='3',
                        point=[0, 0],
                        segments=[[], [44]],
                        props=['#0ff'],
                    ),
                ],
                shader='''
void main() {
  setColor(prop_color());
  setPointMarkerSize(1000.0);
}
''',
            ),
        )
        s.layout = 'xy'
        s.cross_section_scale = 1e-6
        s.show_axis_lines = False
        s.selected_layer.layer = 'a'

    def expect_color(seg1, seg2, color):
        with webdriver.viewer.txn() as s:
            s.layers['seg1'].segments = seg1
            s.layers['seg2'].segments = seg2
        webdriver.sync()
        screenshot = webdriver.viewer.screenshot(size=[10, 10]).screenshot
        np.testing.assert_array_equal(screenshot.image_pixels,
                                      np.tile(np.array(color, dtype=np.uint8), (10, 10, 1)))

    expect_color(seg1=[42], seg2=[], color=[0, 255, 0, 255])
    expect_color(seg1=[], seg2=[43], color=[0, 0, 255, 255])
    expect_color(seg1=[], seg2=[44], color=[0, 255, 255, 255])
