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

from __future__ import absolute_import

import collections

import numpy as np
import six

from . import local_volume
from .equivalence_map import EquivalenceMap
from .json_utils import encode_json_for_repr
from .json_wrappers import (JsonObjectWrapper, array_wrapper, optional, text_type, typed_list,
                            typed_set, wrapped_property)

__all__ = []

def export(obj):
    __all__.append(obj.__name__)
    return obj

@export
class SpatialPosition(JsonObjectWrapper):
    __slots__ = ()
    voxel_size = voxelSize = wrapped_property('voxelSize', optional(array_wrapper(np.float32, 3)))
    spatial_coordinates = spatialCoordinates = wrapped_property(
        'spatialCoordinates', optional(array_wrapper(np.float32, 3)))
    voxel_coordinates = voxelCoordinates = wrapped_property('voxelCoordinates',
                                                            optional(array_wrapper(np.float32, 3)))


@export
class Pose(JsonObjectWrapper):
    __slots__ = ()
    position = wrapped_property('position', SpatialPosition)
    orientation = wrapped_property('orientation', optional(array_wrapper(np.float32, 4)))


@export
class NavigationState(JsonObjectWrapper):
    __slots__ = ()
    pose = wrapped_property('pose', Pose)
    zoom_factor = zoomFactor = wrapped_property('zoomFactor', optional(float))

    @property
    def position(self):
        return self.pose.position

    @position.setter
    def position(self, v):
        self.pose.position = v

    @property
    def voxel_size(self):
        return self.pose.position.voxel_size

    @voxel_size.setter
    def voxel_size(self, v):
        self.pose.position.voxel_size = v


@export
class Layer(JsonObjectWrapper):
    __slots__ = ()
    type = wrapped_property('type', optional(text_type))


@export
class PointAnnotationLayer(Layer):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(PointAnnotationLayer, self).__init__(*args, type='pointAnnotation', **kwargs)

    points = wrapped_property('points', typed_list(array_wrapper(np.float32, 3)))


def volume_source(x):
    if isinstance(x, local_volume.LocalVolume):
        return x
    if not isinstance(x, basestring):
        raise TypeError
    return text_type(x)


@export
class ImageLayer(Layer):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(ImageLayer, self).__init__(*args, type='image', **kwargs)

    source = wrapped_property('source', volume_source)
    shader = wrapped_property('shader', text_type)
    opacity = wrapped_property('opacity', optional(float, 0.5))


def uint64_equivalence_map(obj, _readonly=False):
    if isinstance(obj, EquivalenceMap):
        return obj
    if obj is not None:
        obj = [[int(v) for v in group] for group in obj]
    return EquivalenceMap(obj, _readonly=_readonly)


@export
class SegmentationLayer(Layer):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(SegmentationLayer, self).__init__(*args, type='segmentation', **kwargs)

    source = wrapped_property('source', optional(volume_source))
    mesh = wrapped_property('mesh', optional(text_type))
    skeleton = wrapped_property('skeleton', optional(text_type))
    segments = wrapped_property('segments', typed_set(np.uint64))
    equivalences = wrapped_property('equivalences', uint64_equivalence_map)
    hide_segment_zero = hideSegmentZero = wrapped_property('hideSegmentZero', optional(bool, True))
    selected_alpha = selectedAlpha = wrapped_property('selectedAlpha', optional(float, 0.5))
    not_selected_alpha = notSelectedAlpha = wrapped_property('notSelectedAlpha', optional(float, 0))
    object_alpha = objectAlpha = wrapped_property('objectAlpha', optional(float, 1.0))


layer_types = {
    'image': ImageLayer,
    'segmentation': SegmentationLayer,
    'pointAnnotation': PointAnnotationLayer,
}


def make_layer(json_data, _readonly=False):
    if isinstance(json_data, Layer):
        return json_data

    if isinstance(json_data, local_volume.LocalVolume):
        json_data = dict(type=json_data.volume_type,
                         source=json_data)

    if not isinstance(json_data, dict):
        raise TypeError

    type_name = json_data.get('type')
    layer_type = layer_types.get(type_name)
    if layer_type is not None:
        return layer_type(json_data, _readonly=_readonly)
    else:
        raise ValueError


@export
class ManagedLayer(JsonObjectWrapper):
    __slots__ = ('name', 'layer')

    def __init__(self, name, layer=None, _readonly=False, **kwargs):
        if isinstance(name, ManagedLayer):
            if layer is not None or kwargs:
                raise ValueError
            layer = name.to_json()
            name = name.name

        object.__setattr__(self, 'name', name)

        if isinstance(layer, Layer):
            json_data = collections.OrderedDict()
        elif isinstance(layer, local_volume.LocalVolume):
            json_data = collections.OrderedDict()
            layer = make_layer(layer, _readonly=_readonly)
        else:
            if layer is None:
                json_data = collections.OrderedDict()
            else:
                json_data = layer
            layer = make_layer(json_data, _readonly=_readonly)

        object.__setattr__(self, 'layer', layer)
        super(ManagedLayer, self).__init__(json_data, _readonly=_readonly, **kwargs)

    visible = wrapped_property('visible', optional(bool))

    def __getattr__(self, key):
        return getattr(self.layer, key)

    def __setattr__(self, key, value):
        if self._readonly:
            raise AttributeError
        if key in ['name', 'visible', 'layer']:
            object.__setattr__(self, key, value)
        else:
            return setattr(self.layer, key, value)

    def __repr__(self):
        return u'ManagedLayer(%s,%s)' % (encode_json_for_repr(self.name),
                                         encode_json_for_repr(self.to_json()))

    def to_json(self):
        r = self.layer.to_json()
        visible = self.visible
        if visible is not None:
            r['visible'] = visible
        return r


@export
class Layers(object):
    __slots__ = ('_layers', '_readonly')
    supports_readonly = True

    def __init__(self, json_data, _readonly=False):
        if json_data is None:
            json_data = collections.OrderedDict()
        self._layers = []
        self._readonly = _readonly
        for k, v in six.iteritems(json_data):
            self._layers.append(ManagedLayer(k, v, _readonly=_readonly))

    def index(self, k):
        for i, u in enumerate(self._layers):
            if u.name == k:
                return i
        return -1

    def __getitem__(self, k):
        """Indexes into the list of layers by index, slice, or layer name."""
        if isinstance(k, basestring):
            return self._layers[self.index(k)]
        return self._layers[k]

    def __setitem__(self, k, v):
        if self._readonly:
            raise AttributeError
        if isinstance(k, basestring):
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
                for x in v:
                    if not isinstance(v, ManagedLayer):
                        raise TypeError
                    values.append(x)
                self._layers[k] = values
            else:
                if not isinstance(v, ManagedLayer):
                    raise TypeError
                self._layers[k] = v

    def clear(self):
        """Clears the list of layers."""
        del self[:]

    def __delitem__(self, k):
        """Deletes a layer by index, slice, or name."""
        if self._readonly:
            raise AttributeError
        if isinstance(k, basestring):
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

    def __len__(self):
        """Returns the number of layers in the list."""
        return len(self._layers)

    def __iter__(self):
        return iter(self._layers)

    def to_json(self):
        r = collections.OrderedDict()
        for x in self._layers:
            r[x.name] = x.to_json()
        return r

    def __repr__(self):
        return repr(self._layers)


def layout_specification(x, _readonly=False):
    if isinstance(x, basestring):
        return six.text_type(x)
    if isinstance(x, (StackLayout, LayerGroupViewer)):
        return type(x)(x.to_json(), _readonly=_readonly)
    if not isinstance(x, dict):
        raise ValueError
    layout_type = layout_types.get(x.get('type'))
    if layout_type is None:
        raise ValueError
    return layout_type(x, _readonly=_readonly)


layout_specification.supports_readonly = True


@export
class StackLayout(JsonObjectWrapper):
    __slots__ = ()
    type = wrapped_property('type', text_type)
    children = wrapped_property('children', typed_list(layout_specification))

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


@export
def row_layout(children):
    return StackLayout(type='row', children=children)


@export
def column_layout(children):
    return StackLayout(type='column', children=children)


def navigation_link_type(x):
    x = six.text_type(x)
    x = x.lower()
    if x not in [u'linked', u'unlinked', u'relative']:
        raise ValueError('Invalid navigation link type: %r' % x)
    return x


def make_linked_navigation_type(value_type):
    class LinkedType(JsonObjectWrapper):
        __slots__ = ()
        link = wrapped_property('link', optional(navigation_link_type, u'linked'))
        value = wrapped_property('value', optional(value_type))

    return LinkedType


@export
class LinkedSpatialPosition(make_linked_navigation_type(SpatialPosition)):
    __slots__ = ()


@export
class LinkedZoomFactor(make_linked_navigation_type(float)):
    __slots__ = ()


@export
class LinkedOrientationState(make_linked_navigation_type(array_wrapper(np.float32, 4))):
    __slots__ = ()


@export
class LayerGroupViewer(JsonObjectWrapper):
    __slots__ = ()
    type = wrapped_property('type', text_type)
    layers = wrapped_property('layers', typed_list(text_type))
    layout = wrapped_property('layout', text_type)
    position = wrapped_property('position', LinkedSpatialPosition)
    cross_section_orientation = crossSectionOrientation = wrapped_property('crossSectionOrientation', LinkedOrientationState)
    cross_section_zoom = crossSectionZoom = wrapped_property('crossSectionZoom', LinkedZoomFactor)
    perspective_orientation = perspectiveOrientation = wrapped_property('perspectiveOrientation', LinkedOrientationState)
    perspective_zoom = perspectiveZoom = wrapped_property('perspectiveZoom', LinkedZoomFactor)

    def __init__(self, *args, **kwargs):
        super(LayerGroupViewer, self).__init__(*args, **kwargs)
        self.type = 'viewer'

    def __repr__(self):
        j = self.to_json()
        j.pop('type', None)
        return u'%s(%s)' % (type(self).__name__, encode_json_for_repr(j))



layout_types = {
    'row': StackLayout,
    'column': StackLayout,
    'viewer': LayerGroupViewer,
}



@export
class ViewerState(JsonObjectWrapper):
    __slots__ = ()
    navigation = wrapped_property('navigation', NavigationState)
    perspective_zoom = perspectiveZoom = wrapped_property('perspectiveZoom', optional(float))
    perspective_orientation = perspectiveOrientation = wrapped_property(
        'perspectiveOrientation', optional(array_wrapper(np.float32, 4)))
    show_slices = showSlices = wrapped_property('showSlices', optional(bool, True))
    layers = wrapped_property('layers', Layers)
    layout = wrapped_property('layout', optional(layout_specification, u'4panel'))

    @property
    def position(self):
        return self.navigation.position

    @position.setter
    def position(self, v):
        self.navigation.position = v

    @property
    def voxel_coordinates(self):
        return self.position.voxel_coordinates

    @voxel_coordinates.setter
    def voxel_coordinates(self, v):
        self.position.voxel_coordinates = v

    @property
    def voxel_size(self):
        return self.navigation.voxel_size

    @voxel_size.setter
    def voxel_size(self, v):
        self.navigation.voxel_size = v
