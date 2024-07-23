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


import base64
import io
import numbers
import os
import traceback
import typing

import numpy as np

from . import viewer_state
from .json_wrappers import (
    JsonObjectWrapper,
    Map,
    _set_type_annotation,
    array_wrapper,
    optional,
    typed_list,
    typed_map,
    typed_set,
    wrapped_property,
)

_uint64_keys = frozenset(["t", "v"])
_map_entry_keys = frozenset(["key", "value"])


_BUILDING_DOCS = os.environ.get("NEUROGLANCER_BUILDING_DOCS") == "1"


__all__ = []


def export(obj):
    __all__.append(obj.__name__)
    return obj


@export
class SegmentIdMapEntry(typing.NamedTuple):
    key: int
    value: typing.Optional[int] = None
    label: typing.Optional[str] = None


@export
def layer_selected_value(x):
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


_set_type_annotation(
    layer_selected_value, typing.Union[None, numbers.Number, SegmentIdMapEntry]
)


@export
class LayerSelectionState(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True
    local_position = wrapped_property(
        "localPosition", optional(array_wrapper(np.float32))
    )
    value = wrapped_property("value", optional(layer_selected_value))


if typing.TYPE_CHECKING or _BUILDING_DOCS:
    _LayerSelectedValuesBase = Map[str, LayerSelectionState]
else:
    _LayerSelectedValuesBase = typed_map(str, LayerSelectionState)


@export
class LayerSelectedValues(_LayerSelectedValuesBase):
    """Specifies the data values associated with the current mouse position."""


@export
class ScreenshotReply(JsonObjectWrapper):
    __slots__ = ()
    id = wrapped_property("id", str)
    image = wrapped_property("image", base64.b64decode)
    width = wrapped_property("width", int)
    height = wrapped_property("height", int)
    image_type = imageType = wrapped_property("imageType", str)
    depth_data = depthData = wrapped_property("depthData", optional(base64.b64decode))

    @property
    def image_pixels(self):
        """Returns the screenshot image as a numpy array of pixel values."""
        import PIL

        return np.asarray(PIL.Image.open(io.BytesIO(self.image)))

    @property
    def depth_array(self):
        """Returns the depth data as a numpy float32 array."""
        depth_data = self.depth_data
        if depth_data is None:
            return None
        return np.frombuffer(depth_data, dtype="<f4").reshape((self.height, self.width))


@export
class AggregateChunkSourceStatistics(JsonObjectWrapper):
    __slots__ = ()
    visible_chunks_total = visibleChunksTotal = wrapped_property(
        "visibleChunksTotal", int
    )
    visible_chunks_downloading = visibleChunksDownloading = wrapped_property(
        "visibleChunksDownloading", int
    )
    visible_chunks_system_memory = visibleChunksSystemMemory = wrapped_property(
        "visibleChunksSystemMemory", int
    )
    visible_chunks_gpu_memory = visibleChunksGpuMemory = wrapped_property(
        "visibleChunksGpuMemory", int
    )
    visible_gpu_memory = visibleGpuMemory = wrapped_property("visibleGpuMemory", float)
    download_latency = downloadLatency = wrapped_property("downloadLatency", float)


@export
class ChunkSourceStatistics(JsonObjectWrapper):
    __slots__ = ()
    distinct_id = distinctId = wrapped_property("distinctId", str)


@export
class ScreenshotStatistics(JsonObjectWrapper):
    __slots__ = ()
    id = wrapped_property("id", str)

    chunk_sources = chunkSources = wrapped_property(
        "chunkSources", typed_list(ChunkSourceStatistics)
    )
    total = wrapped_property("total", AggregateChunkSourceStatistics)


@export
class ActionState(JsonObjectWrapper):
    __slots__ = ()
    viewer_state = viewerState = wrapped_property(
        "viewerState", viewer_state.ViewerState
    )
    selected_values = selectedValues = wrapped_property(
        "selectedValues", LayerSelectedValues
    )
    mouse_position = mouse_voxel_coordinates = mouseVoxelCoordinates = wrapped_property(
        "mousePosition", optional(array_wrapper(np.float32))
    )
    screenshot = wrapped_property("screenshot", optional(ScreenshotReply))
    screenshot_statistics = screenshotStatistics = wrapped_property(
        "screenshotStatistics", optional(ScreenshotStatistics)
    )


@export
class Actions:
    def __init__(self, set_config):
        self._action_handlers = dict()
        self._set_config = set_config

    def add(self, name, handler):
        self._action_handlers.setdefault(name, set()).add(handler)
        self._update_config()

    def clear(self):
        screenshot_handler = self._action_handlers.get("screenshot")
        self._action_handlers.clear()
        if screenshot_handler is not None:
            self._action_handlers["screenshot"] = screenshot_handler
        self._update_config()

    def remove(self, name, handler):
        handlers = self._action_handlers.get(name)
        if handlers is None:
            return
        handlers.remove(handler)
        if not handlers:
            del self._action_handlers[name]
        self._update_config()

    def _update_config(self):
        self._set_config(self._action_handlers.keys())

    def invoke(self, name, state):
        state = ActionState(state)
        handlers = self._action_handlers.get(name)
        if handlers is not None:
            for handler in handlers:
                try:
                    handler(state)
                except Exception:
                    traceback.print_exc()


EventActionMap = typed_map(str, str)


@export
class InputEventBindings(JsonObjectWrapper):
    __slots__ = ()
    viewer = wrapped_property("viewer", EventActionMap)
    slice_view = sliceView = wrapped_property("sliceView", EventActionMap)
    perspective_view = perspectiveView = wrapped_property(
        "perspectiveView", EventActionMap
    )
    data_view = dataView = wrapped_property("dataView", EventActionMap)


@export
class PrefetchState(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True
    priority = wrapped_property("priority", optional(int, 0))
    state = wrapped_property("state", viewer_state.ViewerState)


@export
class ScaleBarOptions(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True
    scale_factor = scaleFactor = wrapped_property("scaleFactor", optional(float, 1))
    text_height_in_pixels = textHeightInPixels = wrapped_property(
        "textHeightInPixels", optional(float, 15)
    )
    bar_height_in_pixels = barHeightInPixels = wrapped_property(
        "barHeightInPixels", optional(float, 8)
    )
    bar_top_margin_in_pixels = barTopMarginInPixels = wrapped_property(
        "barTopMarginInPixels", optional(float, 5)
    )
    font_name = fontName = wrapped_property("fontName", optional(str, "sans-serif"))
    padding_in_pixels = paddingInPixels = wrapped_property(
        "paddingInPixels", optional(float, 2)
    )
    max_width_in_pixels = maxWidthInPixels = wrapped_property(
        "maxWidthInPixels", optional(int, 100)
    )
    max_width_fraction = maxWidthFraction = wrapped_property(
        "maxWidthFraction", optional(float, 0.25)
    )
    left_pixel_offset = leftPixelOffset = wrapped_property(
        "leftPixelOffset", optional(int, 10)
    )
    bottom_pixel_offset = bottomPixelOffset = wrapped_property(
        "bottomPixelOffset", optional(int, 10)
    )


@export
class VolumeInfo(JsonObjectWrapper):
    __slots__ = ()

    dimensions = wrapped_property("dimensions", viewer_state.CoordinateSpace)
    order = wrapped_property("order", typed_list(int))
    data_type = dataType = wrapped_property("dataType", str)
    chunk_shape = chunkShape = wrapped_property("chunkShape", array_wrapper(np.int64))
    grid_origin = gridOrigin = wrapped_property("gridOrigin", array_wrapper(np.int64))
    lower_bound = lowerBound = wrapped_property("lowerBound", array_wrapper(np.int64))
    upper_bound = upperBound = wrapped_property("upperBound", array_wrapper(np.int64))

    @property
    def rank(self):
        return self.dimensions.rank


@export
class VolumeRequest(JsonObjectWrapper):
    __slots__ = ()
    id = wrapped_property("id", str)
    kind = wrapped_property("kind", str)
    layer = wrapped_property("layer", str)
    dimensions = wrapped_property("dimensions", optional(viewer_state.CoordinateSpace))
    volume_info = volumeInfo = wrapped_property("volumeInfo", optional(VolumeInfo))
    chunk_grid_position = chunkGridPosition = wrapped_property(
        "chunkGridPosition", optional(array_wrapper(np.int64))
    )


@export
class ConfigState(JsonObjectWrapper):
    __slots__ = ()
    credentials = wrapped_property("credentials", typed_map(str, dict))
    actions = wrapped_property("actions", typed_set(str))
    input_event_bindings = inputEventBindings = wrapped_property(
        "inputEventBindings", InputEventBindings
    )
    status_messages = statusMessages = wrapped_property(
        "statusMessages", typed_map(str, str)
    )
    source_generations = sourceGenerations = wrapped_property(
        "sourceGenerations", typed_map(str, int)
    )
    screenshot = wrapped_property("screenshot", optional(str))
    show_ui_controls = showUIControls = wrapped_property(
        "showUIControls", optional(bool, True)
    )
    show_location = showLocation = wrapped_property(
        "showLocation", optional(bool, True)
    )
    show_layer_panel = showLayerPanel = wrapped_property(
        "showLayerPanel", optional(bool, True)
    )
    show_help_button = showHelpButton = wrapped_property(
        "showHelpButton", optional(bool, True)
    )
    show_settings_button = showSettingsButton = wrapped_property(
        "showSettingsButton", optional(bool, True)
    )
    show_layer_side_panel_button = showLayerSidePanelButton = wrapped_property(
        "showLayerSidePanelButton", optional(bool, True)
    )
    show_layer_list_panel_button = showLayerListPanelButton = wrapped_property(
        "showLayerListPanelButton", optional(bool, True)
    )
    show_selection_panel_button = showSelectionPanelButton = wrapped_property(
        "showSelectionPanelButton", optional(bool, True)
    )
    show_panel_borders = showPanelBorders = wrapped_property(
        "showPanelBorders", optional(bool, True)
    )
    scale_bar_options = scaleBarOptions = wrapped_property(
        "scaleBarOptions", ScaleBarOptions
    )
    show_layer_hover_values = showLayerHoverValues = wrapped_property(
        "showLayerHoverValues", optional(bool, True)
    )
    viewer_size = viewerSize = wrapped_property(
        "viewerSize", optional(array_wrapper(np.int64, 2))
    )
    prefetch = wrapped_property("prefetch", typed_list(PrefetchState))
    volume_requests = volumeRequests = wrapped_property(
        "volumeRequests", typed_list(VolumeRequest)
    )
