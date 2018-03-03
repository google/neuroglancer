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
import copy
import math

import numpy as np
import six

from . import local_volume
from .equivalence_map import EquivalenceMap
from .json_utils import encode_json_for_repr
from .json_wrappers import (JsonObjectWrapper, array_wrapper, optional, text_type, typed_list,
                            typed_set, typed_string_map, wrapped_property)

__all__ = []


def export(obj):
    __all__.append(obj.__name__)
    return obj


def interpolate_linear(a, b, t):
    return a * (1 - t) + b * t


@export
class SpatialPosition(JsonObjectWrapper):
    __slots__ = ()
    voxel_size = voxelSize = wrapped_property('voxelSize', optional(array_wrapper(np.float32, 3)))
    spatial_coordinates = spatialCoordinates = wrapped_property(
        'spatialCoordinates', optional(array_wrapper(np.float32, 3)))
    voxel_coordinates = voxelCoordinates = wrapped_property('voxelCoordinates',
                                                            optional(array_wrapper(np.float32, 3)))

    @staticmethod
    def interpolate(a, b, t):
        if a.voxel_size is None or a.voxel_coordinates is None or b.voxel_coordinates is None:
            return a
        c = copy.deepcopy(a)
        c.voxel_coordinates = interpolate_linear(a.voxel_coordinates, b.voxel_coordinates, t)
        return c


def unit_quaternion():
    return np.array([0, 0, 0, 1], np.float32)


def quaternion_slerp(a, b, t):
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


@export
class Pose(JsonObjectWrapper):
    __slots__ = ()
    position = wrapped_property('position', SpatialPosition)
    orientation = wrapped_property('orientation',
                                   optional(array_wrapper(np.float32, 4)))

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.position = SpatialPosition.interpolate(a.position, b.position, t)
        c.orientation = quaternion_slerp(a.orientation, b.orientation, t)
        return c

def interpolate_zoom(a, b, t):
    if a is None or b is None:
        return a
    scale_change = math.log(b / a)
    return a * math.exp(scale_change * t)


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

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.pose = Pose.interpolate(a.pose, b.pose, t)
        c.zoom_factor = interpolate_zoom(a.zoom_factor, b.zoom_factor, t)
        return c


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
    if not isinstance(x, six.string_types):
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

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.opacity = interpolate_linear(a.opacity, b.opacity, t)
        return c


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
    skeletons = wrapped_property('skeletons', optional(text_type))
    segments = wrapped_property('segments', typed_set(np.uint64))
    equivalences = wrapped_property('equivalences', uint64_equivalence_map)
    hide_segment_zero = hideSegmentZero = wrapped_property('hideSegmentZero', optional(bool, True))
    selected_alpha = selectedAlpha = wrapped_property('selectedAlpha', optional(float, 0.5))
    not_selected_alpha = notSelectedAlpha = wrapped_property('notSelectedAlpha', optional(float, 0))
    object_alpha = objectAlpha = wrapped_property('objectAlpha', optional(float, 1.0))
    skeleton_shader = skeletonShader = wrapped_property('skeletonShader', text_type)

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        for k in ['selected_alpha', 'not_selected_alpha', 'object_alpha']:
            setattr(c, k, interpolate_linear(getattr(a, k), getattr(b, k), t))
        return c


class AnnotationBase(JsonObjectWrapper):
    __slots__ = ()

    id = wrapped_property('id', optional(text_type))  # pylint: disable=invalid-name
    type = wrapped_property('type', text_type)
    description = wrapped_property('description', optional(text_type))


@export
class PointAnnotation(AnnotationBase):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(PointAnnotation, self).__init__(*args, type='point', **kwargs)

    point = wrapped_property('point', array_wrapper(np.float32, 3))


@export
class LineAnnotation(AnnotationBase):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(LineAnnotation, self).__init__(*args, type='line', **kwargs)

    point_a = pointA = wrapped_property('pointA', array_wrapper(np.float32, 3))
    point_b = pointB = wrapped_property('pointB', array_wrapper(np.float32, 3))


@export
class AxisAlignedBoundingBoxAnnotation(AnnotationBase):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(AxisAlignedBoundingBoxAnnotation, self).__init__(
            *args, type='axis_aligned_bounding_box', **kwargs)

    point_a = pointA = wrapped_property('pointA', array_wrapper(np.float32, 3))
    point_b = pointB = wrapped_property('pointB', array_wrapper(np.float32, 3))


@export
class EllipsoidAnnotation(AnnotationBase):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(EllipsoidAnnotation, self).__init__(*args, type='ellipsoid', **kwargs)

    center = wrapped_property('center', array_wrapper(np.float32, 3))
    radii = wrapped_property('radii', array_wrapper(np.float32, 3))


annotation_types = {
    'point': PointAnnotation,
    'line': LineAnnotation,
    'axis_aligned_bounding_box': AxisAlignedBoundingBoxAnnotation,
    'ellipsoid': EllipsoidAnnotation,
}


def annotation(obj, _readonly=False):
    if isinstance(obj, AnnotationBase):
        obj = obj.to_json()
    elif not isinstance(obj, dict):
        raise TypeError
    t = obj.get('type')
    return annotation_types[t](obj, _readonly=_readonly)


annotation.supports_readonly = True


@export
class AnnotationLayer(Layer):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(AnnotationLayer, self).__init__(*args, type='annotation', **kwargs)

    source = wrapped_property('source', optional(volume_source))
    annotation_color = annotationColor = wrapped_property('annotationColor', optional(text_type))
    voxel_size = voxelSize = wrapped_property('voxelSize', optional(array_wrapper(np.float32, 3)))
    annotations = wrapped_property('annotations', optional(typed_list(annotation)))

    @staticmethod
    def interpolate(a, b, t):
        del b
        del t
        return a


layer_types = {
    'image': ImageLayer,
    'segmentation': SegmentationLayer,
    'pointAnnotation': PointAnnotationLayer,
    'annotation': AnnotationLayer,
}


def make_layer(json_data, _readonly=False):
    if isinstance(json_data, Layer):
        return json_data

    if isinstance(json_data, local_volume.LocalVolume):
        json_data = dict(type=json_data.volume_type, source=json_data)

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

    def __deepcopy__(self, memo):
        return ManagedLayer(self.name, copy.deepcopy(self.to_json(), memo))


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
        if isinstance(k, six.string_types):
            return self._layers[self.index(k)]
        return self._layers[k]

    def __setitem__(self, k, v):
        if self._readonly:
            raise AttributeError
        if isinstance(k, six.string_types):
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
        if isinstance(k, six.string_types):
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

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        for layer in c:
            index = b.index(layer.name)
            if index == -1:
                continue
            other_layer = b[index]
            if type(other_layer.layer) is not type(layer.layer):  # pylint: disable=unidiomatic-typecheck
                continue
            layer.layer = type(layer.layer).interpolate(layer.layer, other_layer.layer, t)
        return c



def navigation_link_type(x):
    x = six.text_type(x)
    x = x.lower()
    if x not in [u'linked', u'unlinked', u'relative']:
        raise ValueError('Invalid navigation link type: %r' % x)
    return x


def make_linked_navigation_type(value_type, interpolate_function=None):
    if interpolate_function is None:
        interpolate_function = value_type.interpolate

    class LinkedType(JsonObjectWrapper):
        __slots__ = ()
        link = wrapped_property('link', optional(navigation_link_type, u'linked'))
        value = wrapped_property('value', optional(value_type))

        @staticmethod
        def interpolate(a, b, t):
            c = copy.deepcopy(a)
            c.link = a.link
            if a.link == b.link and a.link != 'linked':
                c.value = interpolate_function(a, b, t)
                return c
            return c

    return LinkedType


@export
class LinkedSpatialPosition(make_linked_navigation_type(SpatialPosition)):
    __slots__ = ()


@export
class LinkedZoomFactor(make_linked_navigation_type(float, interpolate_zoom)):
    __slots__ = ()


@export
class LinkedOrientationState(make_linked_navigation_type(array_wrapper(np.float32, 4), quaternion_slerp)):
    __slots__ = ()



@export
class CrossSection(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True
    width = wrapped_property('width', optional(int, 1000))
    height = wrapped_property('height', optional(int, 1000))
    position = wrapped_property('position', LinkedSpatialPosition)
    orientation = wrapped_property('orientation', LinkedOrientationState)
    zoom = wrapped_property('zoom', LinkedZoomFactor)

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.width = interpolate_linear(a.width, b.width, t)
        c.height = interpolate_linear(a.height, b.height, t)
        c.position = LinkedSpatialPosition.interpolate(a.position, b.position, t)
        c.orientation = LinkedOrientationState.interpolate(a.orientation, b.orientation, t)
        c.zoom = LinkedZoomFactor.interpolate(a.zoom, b.zoom, t)
        return c


@export
class CrossSectionMap(typed_string_map(CrossSection)):
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
    type = wrapped_property('type', text_type)
    cross_sections = crossSections = wrapped_property('crossSections',
                                                      CrossSectionMap)

    def __init__(self, json_data=None, _readonly=False, **kwargs):
        if isinstance(json_data, six.string_types):
            json_data = {'type': six.text_type(json_data)}
        super(DataPanelLayout, self).__init__(json_data, _readonly=_readonly, **kwargs)

    def to_json(self):
        if len(self.cross_sections) == 0:
            return self.type
        return super(DataPanelLayout, self).to_json()

    @staticmethod
    def interpolate(a, b, t):
        if a.type != b.type or len(a.cross_sections) == 0:
            return a
        c = copy.deepcopy(a)
        c.cross_sections = CrossSectionMap.interpolate(a.cross_sections, b.cross_sections, t)
        return c


def data_panel_layout_wrapper(default_value='xy'):
    def wrapper(x, _readonly=False):
        if x is None:
            x = default_value
        if isinstance(x, six.string_types):
            x = {'type': six.text_type(x)}
        return DataPanelLayout(x, _readonly=_readonly)

    wrapper.supports_readonly = True
    return wrapper


data_panel_layout_types = frozenset(['xy', 'yz', 'yz', 'xy-3d', 'yz-3d', 'yz-3d', '4panel', '3d'])


def layout_specification(x, _readonly=False):
    if x is None:
        x = '4panel'
    if isinstance(x, six.string_types):
        x = {'type': six.text_type(x)}
    if isinstance(x, (StackLayout, LayerGroupViewer, DataPanelLayout)):
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
    return StackLayout(type='row', children=children)


@export
def column_layout(children):
    return StackLayout(type='column', children=children)


def interpolate_layout(a, b, t):
    if type(a) is not type(b):
        return a
    return type(a).interpolate(a, b, t)


@export
class LayerGroupViewer(JsonObjectWrapper):
    __slots__ = ()
    type = wrapped_property('type', text_type)
    layers = wrapped_property('layers', typed_list(text_type))
    layout = wrapped_property('layout', data_panel_layout_wrapper('xy'))
    position = wrapped_property('position', LinkedSpatialPosition)
    cross_section_orientation = crossSectionOrientation = wrapped_property(
        'crossSectionOrientation', LinkedOrientationState)
    cross_section_zoom = crossSectionZoom = wrapped_property('crossSectionZoom', LinkedZoomFactor)
    perspective_orientation = perspectiveOrientation = wrapped_property(
        'perspectiveOrientation', LinkedOrientationState)
    perspective_zoom = perspectiveZoom = wrapped_property('perspectiveZoom', LinkedZoomFactor)

    def __init__(self, *args, **kwargs):
        super(LayerGroupViewer, self).__init__(*args, **kwargs)
        self.type = 'viewer'

    def __repr__(self):
        j = self.to_json()
        j.pop('type', None)
        return u'%s(%s)' % (type(self).__name__, encode_json_for_repr(j))

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        for k in ('layout', 'position', 'cross_section_orientation', 'cross_section_zoom',
                  'perspective_orientation', 'perspective_zoom'):
            a_attr = getattr(a, k)
            b_attr = getattr(b, k)
            setattr(c, k, type(a_attr).interpolate(a_attr, b_attr, t))
        return c


layout_types = {
    'row': StackLayout,
    'column': StackLayout,
    'viewer': LayerGroupViewer,
}

def add_data_panel_layout_types():
    for k in data_panel_layout_types:
        layout_types[k] = DataPanelLayout
add_data_panel_layout_types()


@export
class ViewerState(JsonObjectWrapper):
    __slots__ = ()
    navigation = wrapped_property('navigation', NavigationState)
    perspective_zoom = perspectiveZoom = wrapped_property('perspectiveZoom', optional(float))
    perspective_orientation = perspectiveOrientation = wrapped_property(
        'perspectiveOrientation', optional(array_wrapper(np.float32, 4)))
    show_slices = showSlices = wrapped_property('showSlices', optional(bool, True))
    show_axis_lines = showAxisLines = wrapped_property('showAxisLines', optional(bool, True))
    show_scale_bar = showScaleBar = wrapped_property('showScaleBar', optional(bool, True))
    show_default_annotations = showDefaultAnnotations = wrapped_property('showDefaultAnnotations', optional(bool, True))
    gpu_memory_limit = gpuMemoryLimit = wrapped_property('gpuMemoryLimit', optional(int))
    system_memory_limit = systemMemoryLimit = wrapped_property('systemMemoryLimit', optional(int))
    concurrent_downloads = concurrentDownloads = wrapped_property('concurrentDownloads', optional(int))
    layers = wrapped_property('layers', Layers)
    layout = wrapped_property('layout', layout_specification)
    cross_section_background_color = crossSectionBackgroundColor = wrapped_property('crossSectionBackgroundColor', optional(text_type))

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

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.navigation = NavigationState.interpolate(a.navigation, b.navigation, t)
        c.perspective_zoom = interpolate_zoom(a.perspective_zoom, b.perspective_zoom, t)
        c.perspective_orientation = quaternion_slerp(a.perspective_orientation,
                                                     b.perspective_orientation, t)
        c.layers = Layers.interpolate(a.layers, b.layers, t)
        c.layout = interpolate_layout(a.layout, b.layout, t)
        return c
