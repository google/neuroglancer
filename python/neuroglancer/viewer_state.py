# @license
# Copyright 2017 Google Inc.
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
"""Wrappers for representing the Neuroglancer viewer state."""

from __future__ import annotations

import collections
import collections.abc
import copy
import math
import numbers
import os
import re
import typing

import numpy as np

from . import local_volume, segment_colors, skeleton
from .coordinate_space import CoordinateArray, CoordinateSpace, DimensionScale
from .equivalence_map import EquivalenceMap
from .json_utils import encode_json_for_repr
from .json_wrappers import (
    JsonObjectWrapper,
    List,
    Map,
    _set_type_annotation,
    array_wrapper,
    bool_or_string,
    number_or_string,
    number_or_string_or_array,
    optional,
    typed_list,
    typed_map,
    typed_set,
    wrapped_property,
)

_BUILDING_DOCS = os.environ.get("NEUROGLANCER_BUILDING_DOCS") == "1"


__all__ = ["CoordinateSpace", "DimensionScale", "CoordinateArray"]


def export(obj):
    __all__.append(obj.__name__)
    return obj


T = typing.TypeVar("T")


def interpolate_linear(a, b, t):
    return a * (1 - t) + b * t


def interpolate_linear_optional_vectors(a, b, t):
    if a is not None and b is not None and len(a) == len(b):
        return a * (1 - t) + b * t
    return a


def unit_quaternion():
    return np.array([0, 0, 0, 1], np.float32)


def quaternion_slerp(
    a: np.ndarray | None, b: np.ndarray | None, t: float
) -> np.ndarray:
    """Spherical linear interpolation for unit quaternions.

    This is based on the implementation in the gl-matrix package:
    https://github.com/toji/gl-matrix
    """
    if a is None:
        a = unit_quaternion()
    if b is None:
        b = unit_quaternion()
    # calc cosine
    cosom = np.dot(a, b)
    # adjust signs (if necessary)
    if cosom < 0.0:
        cosom = -cosom
        b = -b

    # calculate coefficients
    if (1.0 - cosom) > 0.000001:
        # standard case (slerp)
        omega = math.acos(cosom)
        sinom = math.sin(omega)
        scale0 = math.sin((1.0 - t) * omega) / sinom
        scale1 = math.sin(t * omega) / sinom
    else:
        # "from" and "to" quaternions are very close
        #  ... so we can do a linear interpolation
        scale0 = 1.0 - t
        scale1 = t
    return scale0 * a + scale1 * b


def interpolate_zoom(a: float | None, b: float | None, t: float) -> float | None:
    if a is None or b is None:
        return a
    scale_change = math.log(b / a)
    return a * math.exp(scale_change * t)


class _ToolMetaclass(type):
    def __call__(self, obj: typing.Any = None, _readonly: bool = False, **kwargs):
        return _factory_new(
            registry=tool_types,
            base_class=Tool,
            cls=self,
            allow_str=True,
            obj=obj,
            _readonly=_readonly,
            kwargs=kwargs,
        )


@export
class Tool(JsonObjectWrapper, metaclass=_ToolMetaclass):
    __slots__ = ()

    type = wrapped_property("type", str)

    TOOL_TYPE: str

    def __init__(self, *args, **kwargs):
        tool_type = self.TOOL_TYPE
        if tool_type is not None:
            kwargs.update(type=tool_type)
        super().__init__(*args, **kwargs)

    def __new__(cls, json_data=None, _readonly: bool = False, **kwargs):
        """Coerces the argument to a `Tool`."""
        return object.__new__(cls)


tool_types = {}


def export_tool(tool_class):
    export(tool_class)
    tool_types[tool_class.TOOL_TYPE] = tool_class
    return tool_class


@export
class LayerTool(Tool):
    __slots__ = ()

    layer = wrapped_property("layer", optional(str))
    """Name of the layer to which this tool applies.

    Only valid for tools contained within `~ToolPalette.tools`.
    """


@export_tool
class PlacePointTool(Tool):
    __slots__ = ()
    TOOL_TYPE = "annotatePoint"


@export_tool
class PlaceLineTool(Tool):
    __slots__ = ()
    TOOL_TYPE = "annotateLine"


@export_tool
class PlaceBoundingBoxTool(Tool):
    __slots__ = ()
    TOOL_TYPE = "annotateBoundingBox"


@export_tool
class PlaceEllipsoidTool(Tool):
    __slots__ = ()
    TOOL_TYPE = "annotateSphere"


@export_tool
class PlacePolylineTool(Tool):
    __slots__ = ()
    TOOL_TYPE = "annotatePolyline"


@export_tool
class BlendTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "blend"


@export_tool
class OpacityTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "opacity"


@export_tool
class VolumeRenderingTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "volumeRendering"


@export_tool
class VolumeRenderingGainTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "volumeRenderingGain"


@export_tool
class VolumeRenderingDepthSamplesTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "volumeRenderingDepthSamples"


@export_tool
class CrossSectionRenderScaleTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "crossSectionRenderScale"


@export_tool
class SelectedAlphaTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "selectedAlpha"


@export_tool
class NotSelectedAlphaTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "notSelectedAlpha"


@export_tool
class ObjectAlphaTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "objectAlpha"


@export_tool
class HideSegmentZeroTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "hideSegmentZero"


@export_tool
class HoverHighlightTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "hoverHighlight"


@export_tool
class BaseSegmentColoringTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "baseSegmentColoring"


@export_tool
class IgnoreNullVisibleSetTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "ignoreNullVisibleSet"


@export_tool
class ColorSeedTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "colorSeed"


@export_tool
class SegmentDefaultColorTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "segmentDefaultColor"


@export_tool
class MeshRenderScaleTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "meshRenderScale"


@export_tool
class MeshSilhouetteRenderingTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "meshSilhouetteRendering"


@export_tool
class SaturationTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "saturation"


@export_tool
class SkeletonRenderingMode2dTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "skeletonRendering.mode2d"


@export_tool
class SkeletonRenderingMode3dTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "skeletonRendering.mode3d"


@export_tool
class SkeletonRenderingLineWidth2dTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "skeletonRendering.lineWidth2d"


@export_tool
class SkeletonRenderingLineWidth3dTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "skeletonRendering.lineWidth3d"


@export_tool
class ShaderControlTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "shaderControl"
    control = wrapped_property("control", str)


@export_tool
class MergeSegmentsTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "mergeSegments"


@export_tool
class SplitSegmentsTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "splitSegments"


@export_tool
class SelectSegmentsTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "selectSegments"


@export_tool
class DimensionTool(LayerTool):
    __slots__ = ()
    TOOL_TYPE = "dimension"
    dimension = wrapped_property("dimension", str)


@export
class SidePanelLocation(JsonObjectWrapper):
    __slots__ = ()
    side = wrapped_property("side", optional(str))
    visible = wrapped_property("visible", optional(bool))
    size = wrapped_property("size", optional(int))
    flex = wrapped_property("flex", optional(float, 1))
    row = wrapped_property("row", optional(int))
    col = wrapped_property("col", optional(int))


@export
class ToolPalette(SidePanelLocation):
    __slots__ = ()
    tools = wrapped_property("tools", typed_list(Tool))
    query = wrapped_property("query", optional(str))


@export
class SelectedLayerState(SidePanelLocation):
    __slots__ = ()
    layer = wrapped_property("layer", optional(str))


@export
class StatisticsDisplayState(SidePanelLocation):
    pass


@export
class LayerSidePanelState(SidePanelLocation):
    tab = wrapped_property("tab", optional(str))
    tabs = wrapped_property("tabs", typed_set(str))


@export
class LayerListPanelState(SidePanelLocation):
    pass


@export
class HelpPanelState(SidePanelLocation):
    pass


@export
class DimensionPlaybackVelocity(JsonObjectWrapper):
    __slot__ = ()
    supports_validation = True

    velocity = wrapped_property("velocity", optional(float, 10))
    at_boundary = atBoundary = wrapped_property("atBoundary", optional(str, "reverse"))
    paused = wrapped_property("paused", optional(bool, True))


@export
class Layer(JsonObjectWrapper):
    __slots__ = ()
    type = wrapped_property("type", optional(str))
    local_dimensions = localDimensions = wrapped_property(
        "localDimensions", CoordinateSpace
    )
    local_position = localPosition = wrapped_property(
        "localPosition", optional(array_wrapper(np.float32))
    )
    local_velocity = localVelocity = wrapped_property(
        "localVelocity", typed_map(key_type=str, value_type=DimensionPlaybackVelocity)
    )

    tab = wrapped_property("tab", optional(str))
    panels = wrapped_property("panels", typed_list(LayerSidePanelState))
    pick = wrapped_property("pick", optional(bool))
    tool_bindings = wrapped_property(
        "toolBindings", typed_map(key_type=str, value_type=Tool)
    )
    tool = wrapped_property("tool", optional(Tool))

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.layer_position = interpolate_linear_optional_vectors(
            a.layer_position, b.layer_position, t
        )
        return c


@export
class PointAnnotationLayer(Layer):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="pointAnnotation", **kwargs)

    points = wrapped_property("points", typed_list(array_wrapper(np.float32, 3)))


@export
class CoordinateSpaceTransform(JsonObjectWrapper):
    __slots__ = ()

    output_dimensions = outputDimensions = wrapped_property(
        "outputDimensions", CoordinateSpace
    )
    input_dimensions = inputDimensions = wrapped_property(
        "inputDimensions", optional(CoordinateSpace)
    )
    source_rank = sourceRank = wrapped_property("sourceRank", optional(int))
    matrix = wrapped_property("matrix", optional(array_wrapper(np.float64)))


def data_source_url(x):
    if isinstance(x, local_volume.LocalVolume | skeleton.SkeletonSource):
        return x
    if not isinstance(x, str):
        raise TypeError
    return x


@export
class LayerDataSubsource(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True

    def __init__(self, json_data=None, *args, **kwargs):
        if isinstance(json_data, bool):
            json_data = {"enabled": json_data}
        super().__init__(json_data, *args, **kwargs)

    enabled = wrapped_property("enabled", optional(bool))


@export
class LayerDataSource(JsonObjectWrapper):
    __slots__ = ()

    def __init__(self, json_data=None, *args, **kwargs):
        if isinstance(json_data, str) or isinstance(
            json_data, local_volume.LocalVolume | skeleton.SkeletonSource
        ):
            json_data = {"url": json_data}
        super().__init__(json_data, *args, **kwargs)

    url = wrapped_property("url", data_source_url)
    transform = wrapped_property("transform", optional(CoordinateSpaceTransform))
    subsources = wrapped_property("subsources", typed_map(str, LayerDataSubsource))
    enable_default_subsources = enableDefaultSubsources = wrapped_property(
        "enableDefaultSubsources", optional(bool, True)
    )


if typing.TYPE_CHECKING or _BUILDING_DOCS:
    _LayerDataSourcesBase = List[LayerDataSource]
else:
    _LayerDataSourcesBase = typed_list(LayerDataSource, validator=LayerDataSource)


@export
class LayerDataSources(_LayerDataSourcesBase):
    __slots__ = ()

    def __init__(self, json_data=None, **kwargs):
        if isinstance(
            json_data,
            LayerDataSource
            | str
            | local_volume.LocalVolume
            | skeleton.SkeletonSource
            | dict,
        ):
            json_data = [json_data]
        elif isinstance(json_data, LayerDataSources):
            json_data = json_data.to_json()
        super().__init__(json_data, **kwargs)


class _AnnotationLayerOptions:
    __slots__ = ()
    annotation_color = annotationColor = wrapped_property(
        "annotationColor", optional(str)
    )


@export
class InvlerpParameters(JsonObjectWrapper):
    range = wrapped_property("range", optional(array_wrapper(numbers.Number, 2)))
    window = wrapped_property("window", optional(array_wrapper(numbers.Number, 2)))
    channel = wrapped_property("channel", optional(typed_list(int)))


@export
class TransferFunctionParameters(JsonObjectWrapper):
    window = wrapped_property("window", optional(array_wrapper(numbers.Number, 2)))
    channel = wrapped_property("channel", optional(typed_list(int)))
    controlPoints = wrapped_property(
        "controlPoints", optional(typed_list(typed_list(number_or_string)))
    )
    defaultColor = wrapped_property("defaultColor", optional(str))


_UINT64_STR_PATTERN = re.compile("[0-9]+")


def _shader_control_parameters(v, _readonly=False):
    if isinstance(v, str):
        # Check if it can be converted to a number
        if _UINT64_STR_PATTERN.fullmatch(v):
            return int(v)
        return v
    if isinstance(v, numbers.Number):
        return v
    if isinstance(v, dict):
        if "controlPoints" in v:
            return TransferFunctionParameters(v, _readonly=_readonly)
        return InvlerpParameters(v, _readonly=_readonly)
    if isinstance(v, InvlerpParameters):
        return v
    if isinstance(v, TransferFunctionParameters):
        return v
    raise TypeError(f"Unexpected shader control parameters type: {type(v)}")


_set_type_annotation(
    _shader_control_parameters,
    numbers.Number | str | InvlerpParameters | TransferFunctionParameters,
)


_shader_control_parameters.supports_readonly = True  # type: ignore[attr-defined]

ShaderControls = typed_map(str, _shader_control_parameters)


@export
class ImageLayer(Layer, _AnnotationLayerOptions):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="image", **kwargs)

    source = wrapped_property("source", LayerDataSources)
    shader = wrapped_property("shader", str)
    shader_controls = shaderControls = wrapped_property(
        "shaderControls", ShaderControls
    )
    opacity = wrapped_property("opacity", optional(float, 0.5))
    blend = wrapped_property("blend", optional(str))
    volume_rendering_mode = volumeRenderingMode = VolumeRendering = volume_rendering = (
        wrapped_property("volumeRendering", optional(bool_or_string, False))
    )
    volume_rendering_gain = volumeRenderingGain = wrapped_property(
        "volumeRenderingGain", optional(float, 0)
    )
    volume_rendering_depth_samples = volumeRenderingDepthSamples = wrapped_property(
        "volumeRenderingDepthSamples", optional(float, 64)
    )
    cross_section_render_scale = crossSectionRenderScale = wrapped_property(
        "crossSectionRenderScale", optional(float, 1)
    )

    @staticmethod
    def interpolate(a, b, t):
        c = Layer.interpolate(a, b, t)
        c.opacity = interpolate_linear(a.opacity, b.opacity, t)
        return c


def uint64_equivalence_map(obj, _readonly=False):
    if isinstance(obj, EquivalenceMap):
        return obj
    if obj is not None:
        obj = [[int(v) for v in group] for group in obj]
    return EquivalenceMap(obj, _readonly=_readonly)


def _linked_segmentation_color_group_value(x):
    if isinstance(x, str):
        return x
    if x is False:
        return x
    raise ValueError(f"Expected str or False, but received: {x!r}")


@export
class SkeletonRenderingOptions(JsonObjectWrapper):
    __slots__ = ()

    shader = wrapped_property("shader", optional(str))
    shader_controls = shaderControls = wrapped_property(
        "shaderControls", ShaderControls
    )
    mode2d = wrapped_property("mode2d", optional(str))
    line_width2d = lineWidth2d = wrapped_property("lineWidth2d", optional(float, 2))
    mode3d = wrapped_property("mode3d", optional(str))
    line_width3d = lineWidth3d = wrapped_property("lineWidth3d", optional(float, 1))


@export
class StarredSegments(collections.abc.MutableMapping[int, bool]):
    supports_readonly = True
    supports_validation = True
    __slots__ = ("_readonly", "_data", "_visible")

    _readonly: bool
    _data: dict[int, bool]
    _visible: dict[int, bool]

    def __init__(self, json_data=None, _readonly=False):
        self._readonly = _readonly
        self._data = {}
        self._visible = {}
        if json_data is None:
            return
        self._update(json_data)

    def _update(self, other):
        if isinstance(other, StarredSegments):
            self._data.update(other._data)
            visible = self._visible
            for k, v in other._data:
                if not v:
                    visible.pop(k, None)
            visible.update(other._visible)
            return

        if isinstance(other, collections.abc.Mapping):
            items = other.items()
        else:
            items = other
        data = self._data
        visible = self._visible
        for item in items:
            if isinstance(item, numbers.Integral):
                k = np.uint64(item)
                if k != item:
                    raise ValueError(f"Invalid uint64: {item!r}")
                v = True
            elif isinstance(item, str):
                v = True
                if item.startswith("!"):
                    v = False
                    item = item[1:]
                k = np.uint64(item)
            elif isinstance(item, tuple):
                k, v = item
                if (
                    not isinstance(k, numbers.Integral)
                    or np.uint64(k) != k
                    or not isinstance(v, bool)
                ):
                    raise TypeError(f"Invalid (uint64, bool) pair: {(k, v)!r}")
                k = np.uint64(k)
            else:
                raise TypeError(
                    f"Expected int | str | Tuple[uint64, bool] but received: {item!r}"
                )

            data[k] = v
            if v:
                visible[k] = True
            else:
                visible.pop(k, None)

    def copy(self):
        """Returns a copy of the starred segment list."""
        return StarredSegments(self)

    def __len__(self) -> int:
        """Returns the number of starred segments."""
        return len(self._data)

    def __contains__(self, segment_id: typing.Any) -> bool:
        """Checks if a segment is starred."""
        return segment_id in self._data

    def keys(self) -> collections.abc.KeysView[int]:
        """Returns a view of the starred segments."""
        return self._data.keys()

    def values(self) -> collections.abc.ValuesView[bool]:
        """Returns a view of the visibility state of each starred segment."""
        return self._data.values()

    def items(self) -> collections.abc.ItemsView[int, bool]:
        """Returns a view of the (segment, visible) pairs."""
        return self._data.items()

    def __eq__(self, other) -> bool:
        if isinstance(other, StarredSegments):
            return self._data == other._data
        return self._data == other

    def add(self, segment_id: int) -> None:
        """Adds a starred segment, marking it visible if not already starred."""
        if self._readonly:
            raise AttributeError
        self.setdefault(segment_id, True)

    @typing.overload
    def get(self, segment_id: int) -> bool | None: ...

    @typing.overload
    def get(self, segment_id: int, default: T) -> bool | T: ...

    def get(self, segment_id: int, default=None):
        """Checks if a segment is visible.

        Args:
          segment_id: Segment to check.
          default: Return value if :py:param:`.segment_id` is not starred.

        Returns:
          `True` if visible, `False` if starred but not visible,
          :py:param:`.default` if not starred.
        """
        return self._data.get(segment_id, default)

    def __getitem__(self, segment_id: int) -> bool:
        """Checks if a starred segment is visible."""
        return self._data[segment_id]

    def remove(self, segment_id: int) -> None:
        """Removes a segment from the starred list.

        Raises:
          KeyError: if the segment is not starred.
        """
        if self._readonly:
            raise AttributeError
        del self._data[segment_id]
        self._visible.pop(segment_id)

    def discard(self, segment_id: int) -> None:
        """Removes a segment from the starred list if present."""
        self._data.pop(segment_id, None)
        self._visible.pop(segment_id, None)

    def __setitem__(self, segment_id: int, visible: bool) -> None:
        """Stars and sets the visibility of a segment."""
        if self._readonly:
            raise AttributeError
        self._data[segment_id] = visible
        if visible:
            self._visible[segment_id] = True
        else:
            self._visible.pop(segment_id, None)

    def __delitem__(self, segment_id: int) -> None:
        """Removes a segment from the starred list.

        Raises:
          KeyError: if the segment is not starred.
        """
        if self._readonly:
            raise AttributeError
        del self._data[segment_id]
        self._visible.pop(segment_id, None)

    def clear(self):
        """Unstars all segments."""
        if self._readonly:
            raise AttributeError
        self._data.clear()
        self._visible.clear()

    def __repr__(self):
        return f"StarredSegments({self._data!r})"

    def update(  # type: ignore[override]
        self,
        other: StarredSegments
        | collections.abc.MutableMapping[int, bool]
        | typing.Iterable[int | str | tuple[int, bool]],
    ):
        """Merges in additional starred segments."""
        if self._readonly:
            raise AttributeError
        self._update(other)

    def to_json(self) -> list[str]:
        """Returns the representation as a list of strings."""
        return [
            f"{segment}" if visible else f"!{segment}"
            for segment, visible in self.items()
        ]

    def __iter__(self) -> typing.Iterator[int]:
        return iter(self._data)

    @property
    def visible(self) -> VisibleSegments:
        return VisibleSegments(self)

    @visible.setter
    def visible(self, segments: collections.abc.Iterable[int]):
        new_dict = {}
        for k in segments:
            num_k = np.uint64(k)
            if num_k != k:
                raise ValueError(f"Invalid uint64 value: {k}")
            new_dict[int(num_k)] = True
        self._data = new_dict
        self._visible = new_dict.copy()


@export
class VisibleSegments(collections.abc.MutableSet[int]):
    """Subset of visible segments within a `StarredSegments` object."""

    def __init__(self, starred_segments: StarredSegments):
        """Constructs a view of the visible segments within a ``StarredSegments`` object."""
        self._starred_segments = starred_segments
        self._visible = self._starred_segments._visible

    def __len__(self) -> int:
        """Returns the number of visible segments."""
        return len(self._visible)

    def clear(self):
        """Unstars all segments."""
        self._starred_segments.clear()

    def __contains__(self, segment_id: typing.Any) -> bool:
        """Checks if a segment is visible."""
        return segment_id in self._visible

    def add(self, segment_id: int) -> None:
        """Stars a segment and marks it visible."""
        self._starred_segments[segment_id] = True

    def discard(self, segment_id) -> None:
        """Unstars a segment if present."""
        self._starred_segments.discard(segment_id)

    def __iter__(self) -> typing.Iterator[int]:
        """Iterates over the visible segments."""
        return iter(self._visible)

    def copy(self) -> VisibleSegments:
        """Returns a copy of the visible segment list."""
        new_starred_segments = StarredSegments()
        new_visible = self._visible.copy()
        new_starred_segments._data = new_visible
        new_starred_segments._visible = new_visible.copy()
        return VisibleSegments(new_starred_segments)

    def __repr__(self):
        return f"VisibleSegments({list(self)!r})"


@export
class SegmentationLayer(Layer, _AnnotationLayerOptions):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="segmentation", **kwargs)

    source = wrapped_property("source", LayerDataSources)
    starred_segments = wrapped_property("segments", StarredSegments)

    @property
    def visible_segments(self):
        return VisibleSegments(self.starred_segments)

    @visible_segments.setter
    def visible_segments(self, segments):
        self.starred_segments.visible = segments

    segments = visible_segments

    equivalences = wrapped_property("equivalences", uint64_equivalence_map)
    hide_segment_zero = hideSegmentZero = wrapped_property(
        "hideSegmentZero", optional(bool, True)
    )
    hover_highlight = hoverHighlight = wrapped_property(
        "hoverHighlight", optional(bool, True)
    )
    base_segment_coloring = baseSegmentColoring = wrapped_property(
        "baseSegmentColoring", optional(bool, False)
    )
    selected_alpha = selectedAlpha = wrapped_property(
        "selectedAlpha", optional(float, 0.5)
    )
    not_selected_alpha = notSelectedAlpha = wrapped_property(
        "notSelectedAlpha", optional(float, 0)
    )
    object_alpha = objectAlpha = wrapped_property("objectAlpha", optional(float, 1.0))
    saturation = wrapped_property("saturation", optional(float, 1.0))
    ignore_null_visible_set = ignoreNullVisibleSet = wrapped_property(
        "ignoreNullVisibleSet", optional(bool, True)
    )
    skeleton_rendering = skeletonRendering = wrapped_property(
        "skeletonRendering", SkeletonRenderingOptions
    )

    @property
    def skeleton_shader(self):
        return self.skeleton_rendering.shader

    @skeleton_shader.setter
    def skeleton_shader(self, shader):
        self.skeleton_rendering.shader = shader

    skeletonShader = skeleton_shader

    color_seed = colorSeed = wrapped_property("colorSeed", optional(int, 0))
    cross_section_render_scale = crossSectionRenderScale = wrapped_property(
        "crossSectionRenderScale", optional(float, 1)
    )
    mesh_render_scale = meshRenderScale = wrapped_property(
        "meshRenderScale", optional(float, 10)
    )
    mesh_silhouette_rendering = meshSilhouetteRendering = wrapped_property(
        "meshSilhouetteRendering", optional(float, 0)
    )
    segment_query = segmentQuery = wrapped_property("segmentQuery", optional(str))
    segment_colors = segmentColors = wrapped_property(
        "segmentColors", typed_map(key_type=np.uint64, value_type=str)
    )
    segment_default_color = segmentDefaultColor = wrapped_property(
        "segmentDefaultColor", optional(str)
    )

    @property
    def segment_html_color_dict(self):
        """Returns a dictionary whose keys are segments and values are the 6-digit hex
        strings representing the colors of those segments given the current
        color seed
        """
        d = {}
        for segment in self.segments:
            hex_string = segment_colors.hex_string_from_segment_id(
                color_seed=self.color_seed, segment_id=segment
            )
            d[segment] = hex_string
        return d

    linked_segmentation_group = linkedSegmentationGroup = wrapped_property(
        "linkedSegmentationGroup", optional(str)
    )
    linked_segmentation_color_group = linkedSegmentationColorGroup = wrapped_property(
        "linkedSegmentationColorGroup", optional(_linked_segmentation_color_group_value)
    )

    @staticmethod
    def interpolate(a, b, t):
        c = Layer.interpolate(a, b, t)
        for k in ["selected_alpha", "not_selected_alpha", "object_alpha"]:
            setattr(c, k, interpolate_linear(getattr(a, k), getattr(b, k), t))
        return c


@export
class SingleMeshLayer(Layer):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="mesh", **kwargs)

    source = wrapped_property("source", LayerDataSources)
    vertex_attribute_sources = vertexAttributeSources = wrapped_property(
        "vertexAttributeSources", optional(typed_list(str))
    )
    shader = wrapped_property("shader", str)
    vertex_attribute_names = vertexAttributeNames = wrapped_property(
        "vertexAttributeNames", optional(typed_list(optional(str)))
    )


def _factory_new(
    registry: collections.abc.Mapping[str, type],
    base_class: type,
    cls: type,
    allow_str: bool,
    obj: typing.Any,
    _readonly: bool,
    kwargs,
):
    if cls is base_class:
        if isinstance(obj, base_class):
            cls = type(obj)
        else:
            if allow_str and isinstance(obj, str):
                t = obj
                obj = {"type": obj}
            else:
                if not isinstance(obj, dict):
                    raise TypeError("Expected dict", obj)
                t = obj.get("type")  # type: ignore[assignment]
            cls = registry[t]  # type: ignore[index]
    return type.__call__(cls, obj, _readonly=_readonly, **kwargs)


class _AnnotationMetaclass(type):
    def __call__(self, obj: typing.Any = None, _readonly: bool = False, **kwargs):
        return _factory_new(
            registry=annotation_types,
            base_class=Annotation,
            cls=self,
            allow_str=False,
            obj=obj,
            _readonly=_readonly,
            kwargs=kwargs,
        )


class Annotation(JsonObjectWrapper, metaclass=_AnnotationMetaclass):
    __slots__ = ()

    id = wrapped_property("id", optional(str))  # pylint: disable=invalid-name
    type = wrapped_property("type", str)
    description = wrapped_property("description", optional(str))
    segments = wrapped_property("segments", optional(typed_list(typed_list(np.uint64))))
    props = wrapped_property("props", typed_list(number_or_string_or_array))

    def __new__(cls, obj=None, _readonly: bool = False, **kwargs):
        """Coerces the argument to an `Annotation`."""
        return object.__new__(cls)


@export
class PointAnnotation(Annotation):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="point", **kwargs)

    point = wrapped_property("point", array_wrapper(np.float32))


@export
class LineAnnotation(Annotation):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="line", **kwargs)

    point_a = pointA = wrapped_property("pointA", array_wrapper(np.float32))
    point_b = pointB = wrapped_property("pointB", array_wrapper(np.float32))


@export
class PolyLineAnnotation(Annotation):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="polyline", **kwargs)

    points = wrapped_property("points", typed_list(typed_list(number_or_string)))


@export
class AxisAlignedBoundingBoxAnnotation(Annotation):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="axis_aligned_bounding_box", **kwargs)

    point_a = pointA = wrapped_property("pointA", array_wrapper(np.float32))
    point_b = pointB = wrapped_property("pointB", array_wrapper(np.float32))


@export
class EllipsoidAnnotation(Annotation):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="ellipsoid", **kwargs)

    center = wrapped_property("center", array_wrapper(np.float32))
    radii = wrapped_property("radii", array_wrapper(np.float32))


annotation_types = {
    "point": PointAnnotation,
    "line": LineAnnotation,
    "axis_aligned_bounding_box": AxisAlignedBoundingBoxAnnotation,
    "ellipsoid": EllipsoidAnnotation,
    "polyline": PolyLineAnnotation,
}


@export
class AnnotationPropertySpec(JsonObjectWrapper):
    __slots__ = ()
    id = wrapped_property("id", str)
    type = wrapped_property("type", str)
    description = wrapped_property("description", optional(str))
    default = wrapped_property("default", optional(number_or_string))
    enum_values = wrapped_property(
        "enum_values", optional(typed_list(number_or_string))
    )
    enum_labels = wrapped_property("enum_labels", optional(typed_list(str)))


@export
class AnnotationLayer(Layer, _AnnotationLayerOptions):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, type="annotation", **kwargs)

    source = wrapped_property("source", LayerDataSources)
    annotations = wrapped_property("annotations", typed_list(Annotation))
    annotation_properties = annotationProperties = wrapped_property(
        "annotationProperties", typed_list(AnnotationPropertySpec)
    )
    annotation_relationships = annotationRelationships = wrapped_property(
        "annotationRelationships", typed_list(str)
    )
    linked_segmentation_layer = linkedSegmentationLayer = wrapped_property(
        "linkedSegmentationLayer", typed_map(str, str)
    )
    filter_by_segmentation = filterBySegmentation = wrapped_property(
        "filterBySegmentation", typed_list(str)
    )
    ignore_null_segment_filter = ignoreNullSegmentFilter = wrapped_property(
        "ignoreNullSegmentFilter", optional(bool, True)
    )
    shader = wrapped_property("shader", str)
    shader_controls = shaderControls = wrapped_property(
        "shaderControls", ShaderControls
    )

    @staticmethod
    def interpolate(a, b, t):
        del b
        del t
        return a


@export
class LocalAnnotationLayer(AnnotationLayer):
    __slots__ = ()

    def __init__(self, dimensions, *args, **kwargs):
        super().__init__(
            *args,
            source=LayerDataSource(
                url="local://annotations",
                transform=CoordinateSpaceTransform(outputDimensions=dimensions),
            ),
            **kwargs,
        )


layer_types = {
    "image": ImageLayer,
    "segmentation": SegmentationLayer,
    "pointAnnotation": PointAnnotationLayer,
    "annotation": AnnotationLayer,
    "mesh": SingleMeshLayer,
}


def make_layer(json_data, _readonly=False):
    if isinstance(json_data, Layer):
        return json_data

    if isinstance(json_data, local_volume.LocalVolume):
        json_data = dict(type=json_data.volume_type, source=json_data)

    if not isinstance(json_data, dict):
        raise TypeError

    type_name = json_data.get("type")
    layer_type = layer_types.get(type_name)
    if layer_type is not None:
        return layer_type(json_data, _readonly=_readonly)
    else:
        raise ValueError


@export
class ManagedLayer(JsonObjectWrapper):
    __slots__ = ("name", "layer")

    def __init__(self, name, layer=None, _readonly=False, **kwargs):
        if isinstance(name, ManagedLayer):
            if layer is not None or kwargs:
                raise ValueError
            layer = name.to_json()
            name = name.name

        object.__setattr__(self, "name", name)

        if isinstance(layer, Layer):
            json_data = {}
        elif isinstance(layer, local_volume.LocalVolume):
            json_data = {}
            layer = make_layer(layer, _readonly=_readonly)
        else:
            if layer is None:
                json_data = {}
            else:
                json_data = layer
            layer = make_layer(json_data, _readonly=_readonly)

        object.__setattr__(self, "layer", layer)
        super().__init__(json_data, _readonly=_readonly, **kwargs)

    _visible = wrapped_property("visible", optional(bool))
    archived = wrapped_property("archived", optional(bool, False))

    @property
    def visible(self):
        return not self.archived and self._visible is not False

    @visible.setter
    def visible(self, value):
        self._visible = value

    def __getattr__(self, key):
        return getattr(self.layer, key)

    def __setattr__(self, key, value):
        if self._readonly:
            raise AttributeError
        if key in ["name", "_visible", "visible", "archived", "layer"]:
            object.__setattr__(self, key, value)
        else:
            return setattr(self.layer, key, value)

    def __repr__(self):
        return f"ManagedLayer({encode_json_for_repr(self.name)},{encode_json_for_repr(self.to_json())})"

    def to_json(self):
        r = self.layer.to_json()
        r["name"] = self.name
        archived = self.archived
        if not archived:
            r.pop("archived", None)
        else:
            r["archived"] = True
        visible = self.visible
        if visible or archived:
            r.pop("visible", None)
        else:
            r["visible"] = False
        return r

    def __deepcopy__(self, memo):
        return ManagedLayer(self.name, copy.deepcopy(self.to_json(), memo))


@export
class Layers:
    __slots__ = ("_layers", "_readonly")
    supports_readonly = True

    def __init__(self, json_data: typing.Any, _readonly: bool = False) -> None:
        if json_data is None:
            json_data = {}
        self._layers: list[ManagedLayer] = []
        self._readonly: bool = _readonly
        if isinstance(json_data, collections.abc.Mapping):
            for k, v in json_data.items():
                self._layers.append(ManagedLayer(k, v, _readonly=_readonly))
        else:
            # layers property can also be an array in JSON now. each layer has a name property
            for layer in json_data:
                if isinstance(layer, ManagedLayer):
                    self._layers.append(
                        ManagedLayer(layer.name, layer, _readonly=_readonly)
                    )
                elif isinstance(layer, dict):
                    self._layers.append(
                        ManagedLayer(str(layer["name"]), layer, _readonly=_readonly)
                    )
                else:
                    raise TypeError

    def index(self, k: str) -> int:
        for i, u in enumerate(self._layers):
            if u.name == k:
                return i
        return -1

    def __contains__(self, k: str) -> int:
        return self.index(k) != -1

    @typing.overload
    def __getitem__(self, k: str | int) -> ManagedLayer: ...

    @typing.overload
    def __getitem__(self, k: slice) -> Layers: ...

    def __getitem__(self, k: str | int | slice) -> ManagedLayer | Layers:
        """Indexes into the list of layers by index, slice, or layer name."""
        match k:
            case str():
                return self._layers[self.index(k)]
            case slice():
                return Layers(self._layers[k])
            case _:
                return self._layers[k]

    @typing.overload
    def __setitem__(self, k: str, v: Layer | ManagedLayer) -> None: ...

    @typing.overload
    def __setitem__(self, k: int, v: ManagedLayer) -> None: ...

    @typing.overload
    def __setitem__(
        self, k: slice, v: collections.abc.Iterable[ManagedLayer]
    ) -> None: ...

    def __setitem__(
        self,
        k: str | int | slice,
        v: Layer | ManagedLayer | collections.abc.Iterable[ManagedLayer],
    ) -> None:
        if self._readonly:
            raise AttributeError
        if isinstance(k, str):
            i = self.index(k)
            if isinstance(v, Layer):
                v = ManagedLayer(k, v)
            elif not isinstance(v, ManagedLayer):
                raise TypeError
            if i == -1:
                self._layers.append(v)
            else:
                self._layers[i] = v
        else:
            if isinstance(k, slice):
                values = []
                for x in typing.cast(collections.abc.Iterable[ManagedLayer], v):
                    if not isinstance(v, ManagedLayer):
                        raise TypeError
                    values.append(x)
                self._layers[k] = values
            else:
                if not isinstance(v, ManagedLayer):
                    raise TypeError
                self._layers[k] = v

    def clear(self) -> None:
        """Clears the list of layers."""
        del self[:]

    def __delitem__(self, k: str | int | slice) -> None:
        """Deletes a layer by index, slice, or name."""
        if self._readonly:
            raise AttributeError
        if isinstance(k, str):
            k = self.index(k)
        del self._layers[k]

    def append(self, *args, **kwargs):
        """Appends a ManagedLayer to the list of layers."""
        if self._readonly:
            raise AttributeError
        if len(args) == 1 and not kwargs and isinstance(args[0], ManagedLayer):
            layer = args[0]
        else:
            layer = ManagedLayer(*args, **kwargs)
        self._layers.append(layer)

    def extend(self, elements):
        for element in elements:
            self.append(element)

    def __len__(self) -> int:
        """Returns the number of layers in the list."""
        return len(self._layers)

    def __iter__(self) -> collections.abc.Iterator[ManagedLayer]:
        return iter(self._layers)

    def to_json(self):
        r = []
        for x in self._layers:
            r.append(x.to_json())
        return r

    def __repr__(self) -> str:
        return repr(self._layers)

    @staticmethod
    def interpolate(a: Layers, b: Layers, t: float) -> Layers:
        c = copy.deepcopy(a)
        for layer in c:
            index = b.index(layer.name)
            if index == -1:
                continue
            other_layer = b[index]
            if type(other_layer.layer) is not type(layer.layer):  # noqa: E721
                continue
            layer.layer = type(layer.layer).interpolate(
                layer.layer, other_layer.layer, t
            )
        return c


def navigation_link_type(x):
    x = str(x)
    x = x.lower()
    if x not in ["linked", "unlinked", "relative"]:
        raise ValueError("Invalid navigation link type: %r" % x)
    return x


_set_type_annotation(
    navigation_link_type, typing.Literal["linked", "unlinked", "relative"]
)


@export
class LinkedType(typing.Generic[T], JsonObjectWrapper):
    """Value linked to another value in the viewer state.

    Type parameters:
      T: Value type.
    """

    __slots__ = ()
    link = wrapped_property("link", optional(navigation_link_type, "linked"))
    if _BUILDING_DOCS:
        # For some reason `T` doesn't get resolved properly by sphinx-immaterial.
        value: typing.Any
    else:
        value: T  # type: ignore[no-redef]

    _interpolate_function: typing.ClassVar[
        typing.Callable[[typing.Any, typing.Any, float], typing.Any]
    ]

    @classmethod
    def interpolate(cls, a, b, t):
        c = copy.deepcopy(a)
        c.link = a.link
        if a.link == b.link and a.link != "linked":
            c.value = cls._interpolate_function(a.value, b.value, t)
            return c
        return c


def make_linked_navigation_type(
    value_type: typing.Callable[[typing.Any], T], interpolate_function=None
) -> type[LinkedType[T]]:
    if interpolate_function is None:
        interpolate_function = value_type.interpolate  # type: ignore[attr-defined]

    class Linked(LinkedType):
        __slots__ = ()
        _value_type = value_type
        _interpolate_function = interpolate_function
        value = wrapped_property("value", optional(value_type))

    return Linked


if typing.TYPE_CHECKING or _BUILDING_DOCS:
    _LinkedPositionBase = LinkedType[np.typing.NDArray[np.float32]]
else:
    _LinkedPositionBase = make_linked_navigation_type(
        array_wrapper(np.float32), interpolate_linear_optional_vectors
    )


@export
class LinkedPosition(_LinkedPositionBase):
    __slots__ = ()


if typing.TYPE_CHECKING or _BUILDING_DOCS:
    _LinkedZoomFactorBase = LinkedType[float]
else:
    _LinkedZoomFactorBase = make_linked_navigation_type(float, interpolate_zoom)


@export
class LinkedZoomFactor(_LinkedZoomFactorBase):
    __slots__ = ()


if typing.TYPE_CHECKING or _BUILDING_DOCS:
    _LinkedDepthRangeBase = LinkedType[float]
else:
    _LinkedDepthRangeBase = make_linked_navigation_type(float, interpolate_zoom)


@export
class LinkedDepthRange(_LinkedDepthRangeBase):
    __slots__ = ()


if typing.TYPE_CHECKING or _BUILDING_DOCS:
    _LinkedOrientationStateBase = LinkedType[np.typing.NDArray[np.float32]]
else:
    _LinkedOrientationStateBase = make_linked_navigation_type(
        array_wrapper(np.float32, 4), quaternion_slerp
    )


@export
class LinkedOrientationState(_LinkedOrientationStateBase):
    __slots__ = ()


@export
class CrossSection(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True
    width = wrapped_property("width", optional(int, 1000))
    height = wrapped_property("height", optional(int, 1000))
    position = wrapped_property("position", LinkedPosition)
    orientation = wrapped_property("orientation", LinkedOrientationState)
    scale = wrapped_property("scale", LinkedZoomFactor)

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.width = interpolate_linear(a.width, b.width, t)
        c.height = interpolate_linear(a.height, b.height, t)
        c.position = LinkedPosition.interpolate(a.position, b.position, t)
        c.orientation = LinkedOrientationState.interpolate(
            a.orientation, b.orientation, t
        )
        c.scale = LinkedZoomFactor.interpolate(a.scale, b.scale, t)
        return c


if typing.TYPE_CHECKING or _BUILDING_DOCS:
    _CrossSectionMapBase = Map[str, CrossSection]
else:
    _CrossSectionMapBase = typed_map(str, CrossSection)


@export
class CrossSectionMap(_CrossSectionMapBase):
    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        for k in a:
            if k in b:
                c[k] = CrossSection.interpolate(a[k], b[k], t)
        return c


@export
class DataPanelLayout(JsonObjectWrapper):
    __slots__ = ()
    type = wrapped_property("type", str)
    cross_sections = crossSections = wrapped_property("crossSections", CrossSectionMap)
    orthographic_projection = orthographicProjection = wrapped_property(
        "orthographicProjection", optional(bool, False)
    )

    def __init__(self, json_data=None, _readonly=False, **kwargs):
        if isinstance(json_data, str):
            json_data = {"type": str(json_data)}
        super().__init__(json_data, _readonly=_readonly, **kwargs)

    def to_json(self):
        if len(self.cross_sections) == 0 and not self.orthographic_projection:
            return self.type
        return super().to_json()

    @staticmethod
    def interpolate(a, b, t):
        if a.type != b.type or len(a.cross_sections) == 0:
            return a
        c = copy.deepcopy(a)
        c.cross_sections = CrossSectionMap.interpolate(
            a.cross_sections, b.cross_sections, t
        )
        return c


def data_panel_layout_wrapper(default_value="xy"):
    def wrapper(x, _readonly=False):
        if x is None:
            x = default_value
        if isinstance(x, str):
            x = {"type": str(x)}
        return DataPanelLayout(x, _readonly=_readonly)

    wrapper.supports_readonly = True
    return wrapper


data_panel_layout_types = frozenset(
    ["xy", "yz", "xz", "xy-3d", "yz-3d", "xz-3d", "4panel", "4panel-alt", "3d"]
)


def layout_specification(x, _readonly=False):
    if x is None:
        x = "4panel"
    if isinstance(x, str):
        x = {"type": str(x)}
    if isinstance(x, StackLayout | LayerGroupViewer | DataPanelLayout):
        return type(x)(x.to_json(), _readonly=_readonly)
    if not isinstance(x, dict):
        raise ValueError
    layout_type = layout_types.get(x.get("type"))
    if layout_type is None:
        raise ValueError
    return layout_type(x, _readonly=_readonly)


_set_type_annotation(
    layout_specification,
    typing.Union["StackLayout", "LayerGroupViewer", "DataPanelLayout"],
)


layout_specification.supports_readonly = True  # type: ignore[attr-defined]


@export
class StackLayout(JsonObjectWrapper):
    __slots__ = ()
    type = wrapped_property("type", str)
    flex = wrapped_property("flex", optional(float, 1))
    children = wrapped_property("children", typed_list(layout_specification))

    def __getitem__(self, key):
        return self.children[key]

    def __len__(self):
        return len(self.children)

    def __setitem__(self, key, value):
        self.children[key] = value

    def __delitem__(self, key):
        del self.children[key]

    def __iter__(self):
        return iter(self.children)

    @staticmethod
    def interpolate(a, b, t):
        if a.type != b.type or len(a.children) != len(b.children):
            return a
        c = copy.deepcopy(a)
        c.children = [
            interpolate_layout(a_child, b_child, t)
            for a_child, b_child in zip(a.children, b.children)
        ]
        return c


@export
def row_layout(children):
    """Creates a row-oriented `StackLayout`.

    Group:
      viewer-state
    """
    return StackLayout(type="row", children=children)


@export
def column_layout(children):
    """Creates a column-oriented `StackLayout`.

    Group:
      viewer-state
    """
    return StackLayout(type="column", children=children)


def interpolate_layout(a, b, t):
    if type(a) is not type(b):
        return a
    return type(a).interpolate(a, b, t)


@export
class LayerGroupViewer(JsonObjectWrapper):
    __slots__ = ()
    type = wrapped_property("type", str)
    flex = wrapped_property("flex", optional(float, 1))
    layers = wrapped_property("layers", typed_list(str))
    layout = wrapped_property("layout", data_panel_layout_wrapper("xy"))
    position = wrapped_property("position", LinkedPosition)
    velocity = wrapped_property(
        "velocity", typed_map(key_type=str, value_type=DimensionPlaybackVelocity)
    )
    cross_section_orientation = crossSectionOrientation = wrapped_property(
        "crossSectionOrientation", LinkedOrientationState
    )
    cross_section_scale = crossSectionScale = wrapped_property(
        "crossSectionScale", LinkedZoomFactor
    )
    cross_section_depth = crossSectionDepth = wrapped_property(
        "crossSectionDepth", LinkedDepthRange
    )
    projection_orientation = projectionOrientation = wrapped_property(
        "projectionOrientation", LinkedOrientationState
    )
    projection_scale = projectionScale = wrapped_property(
        "projectionScale", LinkedZoomFactor
    )
    projection_depth = projectionDepth = wrapped_property(
        "projectionDepth", LinkedDepthRange
    )
    tool_bindings = toolBindings = wrapped_property(
        "toolBindings", typed_map(key_type=str, value_type=Tool)
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.type = "viewer"

    def __repr__(self):
        j = self.to_json()
        j.pop("type", None)
        return f"{type(self).__name__}({encode_json_for_repr(j)})"

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        for k in (
            "layout",
            "position",
            "cross_section_orientation",
            "cross_section_zoom",
            "perspective_orientation",
            "perspective_zoom",
        ):
            a_attr = getattr(a, k)
            b_attr = getattr(b, k)
            setattr(c, k, type(a_attr).interpolate(a_attr, b_attr, t))
        return c


layout_types = {
    "row": StackLayout,
    "column": StackLayout,
    "viewer": LayerGroupViewer,
}


def add_data_panel_layout_types():
    for k in data_panel_layout_types:
        layout_types[k] = DataPanelLayout


add_data_panel_layout_types()


@export
class SegmentIdMapEntry(typing.NamedTuple):
    key: int
    value: int | None = None
    label: str | None = None


@export
def layer_selected_value(x) -> None | int | numbers.Number | SegmentIdMapEntry:
    """Normalizes the selected value for a layer."""
    if isinstance(x, numbers.Number):
        return x
    if isinstance(x, str):
        return int(x)
    if isinstance(x, dict):
        value = x.get("value")
        if value is not None:
            value = int(value)
        return SegmentIdMapEntry(int(x["key"]), value, x.get("label"))
    return None


_set_type_annotation(layer_selected_value, None | numbers.Number | SegmentIdMapEntry)


@export
class LayerSelectionState(JsonObjectWrapper):
    """Represents the selection state for a single layer."""

    __slots__ = ()
    supports_validation = True
    local_position = wrapped_property(
        "localPosition", optional(array_wrapper(np.float32))
    )
    value = wrapped_property("value", optional(layer_selected_value))
    annotation_id = annotationId = wrapped_property("annotationId", optional(str))
    annotation_part = annotationPart = wrapped_property("annotationPart", optional(int))
    annotation_subsource = annotationSubsource = wrapped_property(
        "annotationSubsource", optional(str)
    )


if typing.TYPE_CHECKING or _BUILDING_DOCS:
    _LayerSelectedValuesBase = Map[str, LayerSelectionState]
else:
    _LayerSelectedValuesBase = typed_map(str, LayerSelectionState)


@export
class LayerSelectedValues(_LayerSelectedValuesBase):
    """Specifies the data values associated with the current mouse position."""


@export
class DataSelectionState(SidePanelLocation):
    position = wrapped_property("position", optional(array_wrapper(np.float32)))

    layers = wrapped_property("layers", LayerSelectedValues)


@export
class ViewerState(JsonObjectWrapper):
    """Complete Neuroglancer viewer state.

    This includes all state that is normally encoded into a Neuroglancer URL."""

    __slots__ = ()
    title = wrapped_property("title", optional(str))
    dimensions = wrapped_property("dimensions", CoordinateSpace)
    relative_display_scales = relativeDisplayScales = wrapped_property(
        "relativeDisplayScales", optional(typed_map(str, float))
    )
    display_dimensions = displayDimensions = wrapped_property(
        "displayDimensions", optional(typed_list(str))
    )
    position = voxel_coordinates = wrapped_property(
        "position", optional(array_wrapper(np.float32))
    )
    velocity = wrapped_property(
        "velocity", typed_map(key_type=str, value_type=DimensionPlaybackVelocity)
    )
    cross_section_orientation = crossSectionOrientation = wrapped_property(
        "crossSectionOrientation", optional(array_wrapper(np.float32, 4))
    )
    cross_section_scale = crossSectionScale = wrapped_property(
        "crossSectionScale", optional(float)
    )
    cross_section_depth = crossSectionDepth = wrapped_property(
        "crossSectionDepth", optional(float)
    )
    projection_scale = projectionScale = wrapped_property(
        "projectionScale", optional(float)
    )
    projection_depth = projectionDepth = wrapped_property(
        "projectionDepth", optional(float)
    )
    projection_orientation = projectionOrientation = perspectiveOrientation = (
        perspective_orientation
    ) = wrapped_property(
        "projectionOrientation", optional(array_wrapper(np.float32, 4))
    )
    show_slices = showSlices = wrapped_property("showSlices", optional(bool, True))
    hide_cross_section_background_3d = hideCrossSectionBackground3D = wrapped_property(
        "hideCrossSectionBackground3D", optional(bool, False)
    )
    show_axis_lines = showAxisLines = wrapped_property(
        "showAxisLines", optional(bool, True)
    )
    wire_frame = wireFrame = wrapped_property("wireFrame", optional(bool, False))
    enable_adaptive_downsampling = enableAdaptiveDownsampling = wrapped_property(
        "enableAdaptiveDownsampling", optional(bool, True)
    )
    show_scale_bar = showScaleBar = wrapped_property(
        "showScaleBar", optional(bool, True)
    )
    show_default_annotations = showDefaultAnnotations = wrapped_property(
        "showDefaultAnnotations", optional(bool, True)
    )
    gpu_memory_limit = gpuMemoryLimit = wrapped_property(
        "gpuMemoryLimit", optional(int)
    )
    system_memory_limit = systemMemoryLimit = wrapped_property(
        "systemMemoryLimit", optional(int)
    )
    concurrent_downloads = concurrentDownloads = wrapped_property(
        "concurrentDownloads", optional(int)
    )
    prefetch = wrapped_property("prefetch", optional(bool, True))
    layers = wrapped_property("layers", Layers)
    layout = wrapped_property("layout", layout_specification)
    cross_section_background_color = crossSectionBackgroundColor = wrapped_property(
        "crossSectionBackgroundColor", optional(str)
    )
    projection_background_color = projectionBackgroundColor = wrapped_property(
        "projectionBackgroundColor", optional(str)
    )
    selected_layer = selectedLayer = wrapped_property(
        "selectedLayer", SelectedLayerState
    )
    statistics = wrapped_property("statistics", StatisticsDisplayState)
    help_panel = helpPanel = wrapped_property("helpPanel", HelpPanelState)
    layer_list_panel = layerListPanel = wrapped_property(
        "layerListPanel", LayerListPanelState
    )
    partial_viewport = partialViewport = wrapped_property(
        "partialViewport",
        optional(
            array_wrapper(np.float64, 4), np.array([0, 0, 1, 1], dtype=np.float64)
        ),
    )
    tool_bindings = toolBindings = wrapped_property(
        "toolBindings", typed_map(key_type=str, value_type=Tool)
    )
    tool_palettes = toolPalettes = wrapped_property(
        "toolPalettes", typed_map(key_type=str, value_type=ToolPalette)
    )
    selection = wrapped_property("selection", DataSelectionState)

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.position = interpolate_linear_optional_vectors(a.position, b.position, t)
        c.projection_scale = interpolate_zoom(a.projection_scale, b.projection_scale, t)
        c.projection_orientation = quaternion_slerp(
            a.projection_orientation, b.projection_orientation, t
        )
        c.cross_section_scale = interpolate_zoom(
            a.cross_section_scale, b.cross_section_scale, t
        )
        c.cross_section_orientation = quaternion_slerp(
            a.cross_section_orientation, b.cross_section_orientation, t
        )
        c.layers = Layers.interpolate(a.layers, b.layers, t)
        c.layout = interpolate_layout(a.layout, b.layout, t)
        return c
