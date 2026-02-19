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


import numpy as np
import pytest
from neuroglancer import viewer_state


def test_coordinate_space_from_json():
    x = viewer_state.CoordinateSpace(
        {
            "x": [4e-9, "m"],
            "y": [5e-9, "m"],
            "z": [6e-9, "m"],
            "t": [2, "s"],
        }
    )
    assert x.names == ("x", "y", "z", "t")
    np.testing.assert_array_equal(x.scales, [4e-9, 5e-9, 6e-9, 2])
    assert x.units == ("m", "m", "m", "s")
    assert x.rank == 4
    assert x[0] == viewer_state.DimensionScale(4e-9, "m")
    assert x[0:2] == [
        viewer_state.DimensionScale(4e-9, "m"),
        viewer_state.DimensionScale(5e-9, "m"),
    ]
    assert x["x"] == viewer_state.DimensionScale(4e-9, "m")
    assert x[1] == viewer_state.DimensionScale(5e-9, "m")
    assert x["y"] == viewer_state.DimensionScale(5e-9, "m")
    assert x[2] == viewer_state.DimensionScale(6e-9, "m")
    assert x["z"] == viewer_state.DimensionScale(6e-9, "m")
    assert x[3] == viewer_state.DimensionScale(2, "s")
    assert x["t"] == viewer_state.DimensionScale(2, "s")
    assert x.to_json() == [
        {"name": "x", "scale": [4e-9, "m"]},
        {"name": "y", "scale": [5e-9, "m"]},
        {"name": "z", "scale": [6e-9, "m"]},
        {"name": "t", "scale": [2, "s"]},
    ]


def test_coordinate_space_from_split():
    x = viewer_state.CoordinateSpace(
        names=["x", "y", "z", "t"], scales=[4, 5, 6, 2], units=["nm", "nm", "nm", "s"]
    )
    assert x.to_json() == [
        {"name": "x", "scale": [4e-9, "m"]},
        {"name": "y", "scale": [5e-9, "m"]},
        {"name": "z", "scale": [6e-9, "m"]},
        {"name": "t", "scale": [2, "s"]},
    ]


def test_layers():
    layer_json = [
        {"name": "a", "type": "segmentation", "visible": False},
        {"name": "b", "type": "image"},
    ]
    layers_ro = viewer_state.Layers(layer_json, _readonly=True)
    assert layers_ro[0].name == "a"
    assert isinstance(layers_ro[0].layer, viewer_state.SegmentationLayer)
    assert layers_ro[0].visible is False
    assert isinstance(layers_ro["a"].layer, viewer_state.SegmentationLayer)
    assert layers_ro[1].name == "b"
    assert isinstance(layers_ro[1].layer, viewer_state.ImageLayer)
    assert layers_ro[1].visible is True
    assert isinstance(layers_ro["b"].layer, viewer_state.ImageLayer)

    with pytest.raises(AttributeError):
        layers_ro["c"] = viewer_state.ImageLayer()

    with pytest.raises(AttributeError):
        del layers_ro[0]
    with pytest.raises(AttributeError):
        del layers_ro["a"]
    with pytest.raises(AttributeError):
        del layers_ro[:]

    layers_rw = viewer_state.Layers(layer_json)
    del layers_rw[0]
    assert layers_rw.to_json() == [
        {"name": "b", "type": "image"},
    ]

    layers_rw = viewer_state.Layers(layer_json)
    del layers_rw["a"]
    assert layers_rw.to_json() == [
        {"name": "b", "type": "image"},
    ]

    layers_rw = viewer_state.Layers(layer_json)
    del layers_rw[:]
    assert layers_rw.to_json() == []


def test_tool():
    p = viewer_state.Tool("shaderControl", control="abc")
    assert isinstance(p, viewer_state.ShaderControlTool)
    assert p.control == "abc"

    p2 = viewer_state.ShaderControlTool(control="abc")
    assert p2.control == "abc"


def test_annotation():
    viewer_state.PointAnnotation(point=[1])


def test_converts_output_dimensions_to_array_format():
    """Test that outputDimensions are converted from object to array format to preserve ordering."""

    def _get_dimension_names(dimensions):
        """Helper to extract dimension names from a list of dimension dicts."""
        return [dim["name"] for dim in dimensions]

    def _find_dimension(dimensions, name):
        """Helper to find a dimension by name in a list of dimension dicts."""
        return next((d for d in dimensions if d["name"] == name), None)

    # Input state with dimensions in legacy object (dict) format
    state_with_object_dimensions = {
        "layers": [
            {
                "name": "abc",
                "type": "image",
                "localDimensions": [{"name": "c'", "scale": [1, ""]}],
                "source": [
                    {
                        "url": "s3://my.zarr",
                        "transform": {
                            "outputDimensions": {
                                "c^": {
                                    "labels": ["Channel:0", "Channel:1", "Channel:2"],
                                    "coordinates": [0, 1, 2],
                                },
                                "z": [0.0001, "m"],
                                "y": [3.5e-07, "m"],
                                "x": [3.5e-07, "m"],
                            },
                            "inputDimensions": {
                                "x": [1.5e-7, "m"],
                                "y": [3.5e-7, "m"],
                                "z": [0.0001, "m"],
                                "c^": [1, ""],
                            },
                        },
                    }
                ],
            }
        ],
        "layout": "xy",
        "dimensions": {"x": [3.5e-7, "m"], "y": [3.5e-7, "m"], "z": [0.0001, "m"]},
    }

    # Init ViewerState and get json to change object dimensions to array format
    viewer_state_obj = viewer_state.ViewerState(state_with_object_dimensions)
    converted_state = viewer_state_obj.to_json()

    # Verify root-level dimensions are converted to array
    root_dims = converted_state["dimensions"]
    assert isinstance(root_dims, list)
    assert len(root_dims) == 3
    assert _get_dimension_names(root_dims) == ["x", "y", "z"]

    transform = converted_state["layers"][0]["source"][0]["transform"]

    # Verify layer outputDimensions are converted and preserve ordering (c^, z, y, x)
    output_dims = transform["outputDimensions"]
    assert isinstance(output_dims, list)
    assert len(output_dims) == 4
    assert _get_dimension_names(output_dims) == ["c^", "z", "y", "x"]

    # Verify coordinate array dimension properties
    channel_dim = _find_dimension(output_dims, "c^")
    assert channel_dim is not None
    assert channel_dim["coordinates"] == [0, 1, 2]
    assert channel_dim["labels"] == ["Channel:0", "Channel:1", "Channel:2"]

    # Verify layer inputDimensions are converted and preserve ordering (x, y, z, c^)
    input_dims = transform["inputDimensions"]
    assert isinstance(input_dims, list)
    assert len(input_dims) == 4
    assert _get_dimension_names(input_dims) == ["x", "y", "z", "c^"]

    # Verify different scales for same dimension name in input vs output
    output_x = _find_dimension(output_dims, "x")
    input_x = _find_dimension(input_dims, "x")
    assert output_x is not None
    assert output_x["scale"] == [3.5e-7, "m"]
    assert input_x is not None
    assert input_x["scale"] == [1.5e-7, "m"]

    # Verify layer localDimensions are converted
    local_dims = converted_state["layers"][0]["localDimensions"]
    assert isinstance(local_dims, list)
    assert len(local_dims) == 1
    assert local_dims[0]["name"] == "c'"
    assert local_dims[0]["scale"] == [1, ""]
