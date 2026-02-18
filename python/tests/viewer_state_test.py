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
    # Create a state with outputDimensions in object format
    # Ensure to fill all possible coordinateSpace types
    state_with_object_dimensions = {
        "layers": [
            {
                "name": "abc",
                "type": "image",
                "localDimensions": [
                   {
                     "name": "c'",
                     "scale": [
                       1,
                       ""
                     ]
                   }
                 ],
                "source": [
                    {
                        "url": "s3://my.zarr",
                        "transform": {
                            "outputDimensions": {
                                "c^": {"labels": ["Channel:0", "Channel:1", "Channel:2"], "coordinates": [0, 1, 2]},
                                "z": [0.0001, "m"],
                                "y": [3.5e-07, "m"],
                                "x": [3.5e-07, "m"],
                            },
                            "inputDimensions": {
                                    "x": [1.5e-7, "m"],
                                    "y": [3.5e-7, "m"],
                                    "z": [0.0001, "m"],
                                    "c^": [1, ""],
                            }
                        }}]}
        ],
        "layout": "xy",
        "dimensions": {
            "x": [
                3.5e-7,
                "m"
            ],
            "y": [
                3.5e-7,
                "m"
            ],
            "z": [
                0.0001,
                "m"
            ]
        }
    }

    # Create ViewerState with outputDimensions in object format
    viewer_state_obj = viewer_state.ViewerState(state_with_object_dimensions)
    converted_state = viewer_state_obj.to_json()

    # Verify root-level dimensions are converted to array format
    assert isinstance(converted_state["dimensions"], list)
    assert len(converted_state["dimensions"]) == 3

    # Verify dimension ordering is preserved
    dim_names = [dim["name"] for dim in converted_state["dimensions"]]
    assert dim_names == ["x", "y", "z"]

    # Verify layer outputDimensions are also converted
    layer = converted_state["layers"][0]
    assert isinstance(layer["source"][0]["transform"]["outputDimensions"], list)
    assert len(layer["source"][0]["transform"]["outputDimensions"]) == 4

    # Find the coordinate array dimension
    channel_dim = next((d for d in layer["source"][0]["transform"]["outputDimensions"] if d["name"] == "c^"), None)
    assert channel_dim is not None
    assert "coordinates" in channel_dim
    assert "labels" in channel_dim
    assert channel_dim["coordinates"] == [0, 1, 2]

    # Verify layer dimension ordering is preserved
    layer_dim_names = [dim["name"] for dim in layer["source"][0]["transform"]["outputDimensions"]]
    assert layer_dim_names == ["c^", "z", "y", "x"]

    # Verify layer inputDimensions are also converted
    assert isinstance(layer["source"][0]["transform"]["inputDimensions"], list)
    assert len(layer["source"][0]["transform"]["inputDimensions"]) == 4

    # Verify layer input dimension ordering is preserved
    input_dim_names = [dim["name"] for dim in layer["source"][0]["transform"]["inputDimensions"]]
    assert input_dim_names == ["x", "y", "z", "c^"]

    # x in outputDimensions scale should be a different scale than x in inputDimensions
    output_x_dim = next((d for d in layer["source"][0]["transform"]["outputDimensions"] if d["name"] == "x"), None)
    input_x_dim = next((d for d in layer["source"][0]["transform"]["inputDimensions"] if d["name"] == "x"), None)
    assert output_x_dim is not None
    assert input_x_dim is not None
    output_x_dim_scale = output_x_dim["scale"]
    input_x_dim_scale = input_x_dim["scale"]
    assert(output_x_dim_scale == [3.5e-7, "m"])
    assert(input_x_dim_scale == [1.5e-7, "m"])

    # Verify localDimensions are also converted
    assert isinstance(layer["localDimensions"], list)
    assert len(layer["localDimensions"]) == 1
    local_dim = layer["localDimensions"][0]
    assert local_dim["name"] == "c'"
    assert local_dim["scale"] == [1, ""]
