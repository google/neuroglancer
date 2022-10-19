# @license
# Copyright 2022 Google Inc.
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

import pathlib
from typing import Tuple

import neuroglancer
import numpy as np
import pytest

ts = pytest.importorskip("tensorstore")


def check_screenshot_color(webdriver, source, expected_value):

    with webdriver.viewer.txn() as s:
        # s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y", "z", "c"],
        #                                             units=["nm", "nm", "nm", ""],
        #                                             scales=[1, 1, 1, 1])
        s.layout = 'xy'
        # s.cross_section_scale = 1e-6
        s.show_axis_lines = False
        s.layers.append(
            name="a",
            layer=neuroglancer.SegmentationLayer(source=neuroglancer.LayerDataSource(
                url=source,
                # transform=neuroglancer.CoordinateSpaceTransform(input_dimensions=s.dimensions,
                #                                                 output_dimensions=s.dimensions)
            ),
                                                 hide_segment_zero=False,
                                                 hover_highlight=False,
                                                 segment_colors={expected_value: "#ff0000"}))

    webdriver.sync()
    screenshot_response = webdriver.viewer.screenshot(size=[10, 10])
    screenshot = screenshot_response.screenshot
    np.testing.assert_array_equal(screenshot.image_pixels,
                                  np.tile(np.array([255, 0, 0, 255], dtype=np.uint8), (10, 10, 1)))


@pytest.mark.parametrize("driver", ["neuroglancer_precomputed", "zarr", "n5"])
def test_zero_fill_value(tempdir_server: Tuple[pathlib.Path, str], webdriver, driver: str):
    tmp_path, server_url = tempdir_server
    ts.open({
        "driver": driver,
        "kvstore": {
            "driver": "file",
            "path": str(tmp_path)
        }
    },
            create=True,
            dtype=ts.uint8,
            shape=[100, 200, 300, 1]).result()

    protocol = driver if driver != "neuroglancer_precomputed" else "precomputed"
    check_screenshot_color(webdriver, f"{protocol}://{server_url}", expected_value=0)


def test_nonzero_fill_value(tempdir_server: Tuple[pathlib.Path, str], webdriver):
    tmp_path, server_url = tempdir_server
    ts.open({
        "driver": "zarr",
        "kvstore": {
            "driver": "file",
            "path": str(tmp_path)
        }
    },
            create=True,
            fill_value=42,
            dtype=ts.uint8,
            shape=[100, 200, 300, 1]).result()

    protocol = "zarr"
    check_screenshot_color(webdriver, f"{protocol}://{server_url}", expected_value=42)


@pytest.mark.parametrize("dtype", [ts.uint32, ts.uint64])
def test_compressed_segmentation_fill_value(tempdir_server: Tuple[pathlib.Path, str], webdriver, dtype: ts.dtype):
    tmp_path, server_url = tempdir_server
    ts.open({
        "driver": "neuroglancer_precomputed",
        "kvstore": {
            "driver": "file",
            "path": str(tmp_path)
        },
        "scale_metadata": {
            "encoding": "compressed_segmentation",
        },
    },
            create=True,
            dtype=dtype,
            shape=[100, 200, 300, 1]).result()

    protocol = "precomputed"
    check_screenshot_color(webdriver, f"{protocol}://{server_url}", expected_value=0)
