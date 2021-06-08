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

from __future__ import absolute_import

import base64
import collections
import io
import numbers
import traceback

import numpy as np
import six

from . import viewer_state
from .json_wrappers import (JsonObjectWrapper, array_wrapper, optional, text_type, typed_list,
                            typed_set, typed_string_map, wrapped_property)

_uint64_keys = frozenset(['t', 'v'])
_map_entry_keys = frozenset(['key', 'value'])


class SegmentIdMapEntry(collections.namedtuple('SegmentIdMapEntry', ['key', 'value', 'label'])):
    def __new__(cls, key, value=None, label=None):
        return super(SegmentIdMapEntry, cls).__new__(cls, key, value, label)


def layer_selected_value(x):
    if isinstance(x, numbers.Number):
        return x
    if isinstance(x, six.string_types):
        return int(x)
    if isinstance(x, dict):
        value = x.get('value')
        if value is not None:
            value = int(value)
        return SegmentIdMapEntry(int(x['key']), value, x.get('label'))
    return None


class LayerSelectionState(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True
    local_position = wrapped_property('localPosition', optional(array_wrapper(np.float32)))
    value = wrapped_property('value', optional(layer_selected_value))


LayerSelectedValues = typed_string_map(LayerSelectionState)


class ScreenshotReply(JsonObjectWrapper):
    __slots__ = ()
    id = wrapped_property('id', text_type)
    image = wrapped_property('image', base64.b64decode)
    width = wrapped_property('width', int)
    height = wrapped_property('height', int)
    image_type = imageType = wrapped_property('imageType', text_type)
    depth_data = depthData = wrapped_property('depthData', optional(base64.b64decode))

    @property
    def image_pixels(self):
        """Returns the screenshot image as a numpy array of pixel values."""
        import PIL
        return np.asarray(PIL.Image.open(io.BytesIO(self.image)))

    @property
    def depth_array(self):
        """Returns the depth data as a numpy float32 array."""
        depth_data = self.depth_data
        if depth_data is None: return None
        return np.frombuffer(depth_data, dtype='<f4').reshape((self.height, self.width))


class AggregateChunkSourceStatistics(JsonObjectWrapper):
    __slots__ = ()
    visible_chunks_total = visibleChunksTotal = wrapped_property('visibleChunksTotal', int)
    visible_chunks_downloading = visibleChunksDownloading = wrapped_property(
        'visibleChunksDownloading', int)
    visible_chunks_system_memory = visibleChunksSystemMemory = wrapped_property(
        'visibleChunksSystemMemory', int)
    visible_chunks_gpu_memory = visibleChunksGpuMemory = wrapped_property(
        'visibleChunksGpuMemory', int)
    visible_gpu_memory = visibleGpuMemory = wrapped_property('visibleGpuMemory', float)
    download_latency = downloadLatency = wrapped_property('downloadLatency', float)


class ChunkSourceStatistics(JsonObjectWrapper):
    __slots__ = ()
    distinct_id = distinctId = wrapped_property('distinctId', text_type)


class ScreenshotStatistics(JsonObjectWrapper):
    __slots__ = ()
    id = wrapped_property('id', text_type)

    chunk_sources = chunkSources = wrapped_property('chunkSources',
                                                    typed_list(ChunkSourceStatistics))
    total = wrapped_property('total', AggregateChunkSourceStatistics)


class ActionState(JsonObjectWrapper):
    __slots__ = ()
    viewer_state = viewerState = wrapped_property('viewerState', viewer_state.ViewerState)
    selected_values = selectedValues = wrapped_property('selectedValues', LayerSelectedValues)
    mouse_position = mouse_voxel_coordinates = mouseVoxelCoordinates = wrapped_property(
        'mousePosition', optional(array_wrapper(np.float32)))
    screenshot = wrapped_property('screenshot', optional(ScreenshotReply))
    screenshot_statistics = screenshotStatistics = wrapped_property('screenshotStatistics',
                                                                    optional(ScreenshotStatistics))


class Actions(object):
    def __init__(self, set_config):
        self._action_handlers = dict()
        self._set_config = set_config

    def add(self, name, handler):
        self._action_handlers.setdefault(name, set()).add(handler)
        self._update_config()

    def clear(self):
        screenshot_handler = self._action_handlers.get('screenshot')
        self._action_handlers.clear()
        if screenshot_handler is not None:
            self._action_handlers['screenshot'] = screenshot_handler
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
        self._set_config(six.viewkeys(self._action_handlers))

    def invoke(self, name, state):
        state = ActionState(state)
        handlers = self._action_handlers.get(name)
        if handlers is not None:
            for handler in handlers:
                try:
                    handler(state)
                except:
                    traceback.print_exc()


EventActionMap = typed_string_map(text_type)


class InputEventBindings(JsonObjectWrapper):
    __slots__ = ()
    viewer = wrapped_property('viewer', EventActionMap)
    slice_view = sliceView = wrapped_property('sliceView', EventActionMap)
    perspective_view = perspectiveView = wrapped_property('perspectiveView', EventActionMap)
    data_view = dataView = wrapped_property('dataView', EventActionMap)


class PrefetchState(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True
    priority = wrapped_property('priority', optional(int, 0))
    state = wrapped_property('state', viewer_state.ViewerState)


class ScaleBarOptions(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True
    scale_factor = scaleFactor = wrapped_property('scaleFactor', optional(float, 1))
    text_height_in_pixels = textHeightInPixels = wrapped_property('textHeightInPixels',
                                                                  optional(float, 15))
    bar_height_in_pixels = barHeightInPixels = wrapped_property('barHeightInPixels',
                                                                optional(float, 8))
    bar_top_margin_in_pixels = barTopMarginInPixels = wrapped_property(
        'barTopMarginInPixels', optional(float, 5))
    font_name = fontName = wrapped_property('fontName', optional(text_type, 'sans-serif'))
    padding_in_pixels = paddingInPixels = wrapped_property('paddingInPixels', optional(float, 2))
    max_width_in_pixels = maxWidthInPixels = wrapped_property('maxWidthInPixels',
                                                              optional(int, 100))
    max_width_fraction = maxWidthFraction = wrapped_property('maxWidthFraction',
                                                             optional(float, 0.25))
    left_pixel_offset = leftPixelOffset = wrapped_property('leftPixelOffset', optional(int, 10))
    bottom_pixel_offset = bottomPixelOffset = wrapped_property('bottomPixelOffset',
                                                               optional(int, 10))


class ConfigState(JsonObjectWrapper):
    __slots__ = ()
    credentials = wrapped_property('credentials', typed_string_map(dict))
    actions = wrapped_property('actions', typed_set(text_type))
    input_event_bindings = inputEventBindings = wrapped_property('inputEventBindings',
                                                                 InputEventBindings)
    status_messages = statusMessages = wrapped_property('statusMessages',
                                                        typed_string_map(text_type))
    source_generations = sourceGenerations = wrapped_property('sourceGenerations',
                                                              typed_string_map(int))
    screenshot = wrapped_property('screenshot', optional(text_type))
    show_ui_controls = showUIControls = wrapped_property('showUIControls', optional(bool, True))
    show_location = showLocation = wrapped_property('showLocation', optional(bool, True))
    show_layer_panel = showLayerPanel = wrapped_property('showLayerPanel', optional(bool, True))
    show_help_button = showHelpButton = wrapped_property('showHelpButton', optional(bool, True))
    show_settings_button = showSettingsButton = wrapped_property('showSettingsButton', optional(bool, True))
    show_layer_side_panel_button = showLayerSidePanelButton = wrapped_property('showLayerSidePanelButton', optional(bool, True))
    show_layer_list_panel_button = showLayerListPanelButton = wrapped_property('showLayerListPanelButton', optional(bool, True))
    show_selection_panel_button = showSelectionPanelButton = wrapped_property('showSelectionPanelButton', optional(bool, True))
    show_panel_borders = showPanelBorders = wrapped_property('showPanelBorders',
                                                             optional(bool, True))
    scale_bar_options = scaleBarOptions = wrapped_property('scaleBarOptions', ScaleBarOptions)
    show_layer_hover_values = showLayerHoverValues = wrapped_property('showLayerHoverValues',
                                                                      optional(bool, True))
    viewer_size = viewerSize = wrapped_property('viewerSize', optional(array_wrapper(np.int64, 2)))
    prefetch = wrapped_property('prefetch', typed_list(PrefetchState))


class PrivateState(JsonObjectWrapper):
    __slots__ = ()
    credentials = wrapped_property('credentials', typed_string_map(optional(int)))
