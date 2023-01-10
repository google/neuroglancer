# coding=utf-8
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
import numbers
import re

try:
    import collections.abc as collections_abc
except ImportError:
    import collections as collections_abc

import numpy as np
import six

from . import local_volume
from . import skeleton
from . import segment_colors
from .coordinate_space import DimensionScale, CoordinateSpace, CoordinateArray
from .equivalence_map import EquivalenceMap
from .json_utils import encode_json_for_repr
from .json_wrappers import (JsonObjectWrapper, array_wrapper, optional, text_type, typed_list,
                            typed_map, typed_set, typed_string_map, wrapped_property,
                            number_or_string)

__all__ = ['CoordinateSpace', 'DimensionScale', 'CoordinateArray']


def export(obj):
    __all__.append(obj.__name__)
    return obj


def interpolate_linear(a, b, t):
    return a * (1 - t) + b * t


def interpolate_linear_optional_vectors(a, b, t):
    if a is not None and b is not None and len(a) == len(b):
        return a * (1 - t) + b * t
    return a


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


def interpolate_zoom(a, b, t):
    if a is None or b is None:
        return a
    scale_change = math.log(b / a)
    return a * math.exp(scale_change * t)


@export
class Tool(JsonObjectWrapper):
    __slots__ = ()

    type = wrapped_property('type', text_type)

    TOOL_TYPE = None

    def __init__(self, *args, **kwargs):
        tool_type = self.TOOL_TYPE
        if tool_type is not None:
            kwargs.update(type=tool_type)
        super().__init__(*args, **kwargs)


tool_types = {}


def export_tool(tool_class):
    export(tool_class)
    tool_types[tool_class.TOOL_TYPE] = tool_class
    return tool_class


@export_tool
class PlacePointTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'annotatePoint'


@export_tool
class PlaceLineTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'annotateLine'


@export_tool
class PlaceBoundingBoxTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'annotateBoundingBox'


@export_tool
class PlaceEllipsoidTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'annotateSphere'


@export_tool
class BlendTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'blend'


@export_tool
class OpacityTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'opacity'


@export_tool
class CrossSectionRenderScaleTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'crossSectionRenderScale'


@export_tool
class SelectedAlphaTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'selectedAlpha'


@export_tool
class NotSelectedAlphaTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'notSelectedAlpha'


@export_tool
class ObjectAlphaTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'objectAlpha'


@export_tool
class HideSegmentZeroTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'hideSegmentZero'


@export_tool
class HoverHighlightTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'hoverHighlight'


@export_tool
class BaseSegmentColoringTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'baseSegmentColoring'


@export_tool
class IgnoreNullVisibleSetTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'ignoreNullVisibleSet'


@export_tool
class ColorSeedTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'colorSeed'


@export_tool
class SegmentDefaultColorTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'segmentDefaultColor'


@export_tool
class MeshRenderScaleTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'meshRenderScale'


@export_tool
class MeshSilhouetteRenderingTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'meshSilhouetteRendering'


@export_tool
class SaturationTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'saturation'


@export_tool
class SkeletonRenderingMode2dTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'skeletonRendering.mode2d'


@export_tool
class SkeletonRenderingMode3dTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'skeletonRendering.mode3d'


@export_tool
class SkeletonRenderingLineWidth2dTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'skeletonRendering.lineWidth2d'


@export_tool
class SkeletonRenderingLineWidth3dTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'skeletonRendering.lineWidth3d'


@export_tool
class ShaderControlTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'shaderControl'
    control = wrapped_property('control', text_type)


@export_tool
class MergeSegmentsTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'mergeSegments'


@export_tool
class SplitSegmentsTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'splitSegments'


@export_tool
class SelectSegmentsTool(Tool):
    __slots__ = ()
    TOOL_TYPE = 'selectSegments'


@export
def tool(json_data, _readonly=False):
    if isinstance(json_data, Tool):
        return json_data
    if isinstance(json_data, str):
        json_data = {'type': json_data}
    if not isinstance(json_data, dict):
        raise TypeError

    type_name = json_data.get('type')
    tool_type = tool_types.get(type_name)
    if tool_type is None: raise ValueError
    return tool_type(json_data, _readonly=_readonly)


tool.supports_readonly = True


@export
class SidePanelLocation(JsonObjectWrapper):
    side = wrapped_property('side', optional(str))
    visible = wrapped_property('visible', optional(bool))
    size = wrapped_property('size', optional(int))
    flex = wrapped_property('flex', optional(float, 1))
    row = wrapped_property('row', optional(int))
    col = wrapped_property('col', optional(int))


@export
class SelectedLayerState(SidePanelLocation):
    layer = wrapped_property('layer', optional(text_type))


@export
class StatisticsDisplayState(SidePanelLocation):
    pass


@export
class LayerSidePanelState(SidePanelLocation):
    tab = wrapped_property('tab', optional(str))
    tabs = wrapped_property('tabs', typed_set(str))


@export
class LayerListPanelState(SidePanelLocation):
    pass


@export
class HelpPanelState(SidePanelLocation):
    pass


@export
class Layer(JsonObjectWrapper):
    __slots__ = ()
    type = wrapped_property('type', optional(text_type))
    layer_dimensions = layerDimensions = wrapped_property('localDimensions', CoordinateSpace)
    layer_position = layerPosition = wrapped_property('localPosition',
                                                      optional(array_wrapper(np.float32)))
    tab = wrapped_property('tab', optional(str))
    panels = wrapped_property('panels', typed_list(LayerSidePanelState))
    pick = wrapped_property('pick', optional(bool))
    tool_bindings = wrapped_property('toolBindings', typed_map(key_type=text_type, value_type=tool))
    tool = wrapped_property('tool', optional(tool))

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.layer_position = interpolate_linear_optional_vectors(a.layer_position, b.layer_position,
                                                               t)
        return c


@export
class PointAnnotationLayer(Layer):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(PointAnnotationLayer, self).__init__(*args, type='pointAnnotation', **kwargs)

    points = wrapped_property('points', typed_list(array_wrapper(np.float32, 3)))


@export
class CoordinateSpaceTransform(JsonObjectWrapper):
    __slots__ = ()

    output_dimensions = outputDimensions = wrapped_property('outputDimensions', CoordinateSpace)
    input_dimensions = inputDimensions = wrapped_property('inputDimensions',
                                                          optional(CoordinateSpace))
    source_rank = sourceRank = wrapped_property('sourceRank', optional(int))
    matrix = wrapped_property('matrix', optional(array_wrapper(np.float64)))


def data_source_url(x):
    if isinstance(x, (local_volume.LocalVolume, skeleton.SkeletonSource)):
        return x
    if not isinstance(x, six.string_types):
        raise TypeError
    return text_type(x)


@export
class LayerDataSubsource(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True

    def __init__(self, json_data=None, *args, **kwargs):
        if isinstance(json_data, bool):
            json_data = {'enabled': json_data}
        super(LayerDataSubsource, self).__init__(json_data, *args, **kwargs)

    enabled = wrapped_property('enabled', optional(bool))


@export
class LayerDataSource(JsonObjectWrapper):
    __slots__ = ()

    def __init__(self, json_data=None, *args, **kwargs):
        if (isinstance(json_data, six.string_types)
                or isinstance(json_data, (local_volume.LocalVolume, skeleton.SkeletonSource))):
            json_data = {'url': json_data}
        super(LayerDataSource, self).__init__(json_data, *args, **kwargs)

    url = wrapped_property('url', data_source_url)
    transform = wrapped_property('transform', optional(CoordinateSpaceTransform))
    subsources = wrapped_property('subsources', typed_string_map(LayerDataSubsource))
    enable_default_subsources = enableDefaultSubsources = wrapped_property(
        'enableDefaultSubsources', optional(bool, True))


@export
class LayerDataSources(typed_list(LayerDataSource, validator=LayerDataSource)):
    __slots__ = ()

    def __init__(self, json_data=None, **kwargs):
        if isinstance(json_data, (LayerDataSource, six.string_types, local_volume.LocalVolume,
                                  skeleton.SkeletonSource, dict)):
            json_data = [json_data]
        elif isinstance(json_data, LayerDataSources):
            json_data = json_data.to_json()
        super(LayerDataSources, self).__init__(json_data, **kwargs)


class _AnnotationLayerOptions(object):
    __slots__ = ()
    annotation_color = annotationColor = wrapped_property('annotationColor', optional(text_type))


@export
class InvlerpParameters(JsonObjectWrapper):
    range = wrapped_property('range', optional(array_wrapper(numbers.Number, 2)))
    window = wrapped_property('window', optional(array_wrapper(numbers.Number, 2)))
    channel = wrapped_property('channel', optional(typed_list(int)))


_UINT64_STR_PATTERN = re.compile('[0-9]+')


def _shader_control_parameters(v, _readonly=False):
    if isinstance(v, str):
        # Check if it can be converted to a number
        if _UINT64_STR_PATTERN.fullmatch(v):
            return int(v)
        return v
    if isinstance(v, numbers.Number):
        return v
    if isinstance(v, dict):
        return InvlerpParameters(v, _readonly=_readonly)
    if isinstance(v, InvlerpParameters):
        return v
    raise TypeError('Unexpected shader control parameters type: %s' % (type(v), ))


_shader_control_parameters.supports_readonly = True

ShaderControls = typed_string_map(_shader_control_parameters)


@export
class ImageLayer(Layer, _AnnotationLayerOptions):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(ImageLayer, self).__init__(*args, type='image', **kwargs)

    source = wrapped_property('source', LayerDataSources)
    shader = wrapped_property('shader', text_type)
    shader_controls = shaderControls = wrapped_property('shaderControls', ShaderControls)
    opacity = wrapped_property('opacity', optional(float, 0.5))
    blend = wrapped_property('blend', optional(str))
    cross_section_render_scale = crossSectionRenderScale = wrapped_property(
        'crossSectionRenderScale', optional(float, 1))

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
    raise ValueError('Expected str or False, but received: %r' % (x, ))


@export
class SkeletonRenderingOptions(JsonObjectWrapper):
    __slots__ = ()

    shader = wrapped_property('shader', optional(text_type))
    shader_controls = shaderControls = wrapped_property('shaderControls', ShaderControls)
    mode2d = wrapped_property('mode2d', optional(text_type))
    line_width2d = lineWidth2d = wrapped_property('lineWidth2d', optional(float, 2))
    mode3d = wrapped_property('mode3d', optional(text_type))
    line_width3d = lineWidth3d = wrapped_property('lineWidth3d', optional(float, 1))


@export
class SegmentationLayer(Layer, _AnnotationLayerOptions):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(SegmentationLayer, self).__init__(*args, type='segmentation', **kwargs)

    source = wrapped_property('source', LayerDataSources)
    segments = wrapped_property('segments', typed_set(np.uint64))
    equivalences = wrapped_property('equivalences', uint64_equivalence_map)
    hide_segment_zero = hideSegmentZero = wrapped_property('hideSegmentZero', optional(bool, True))
    hover_highlight = hoverHighlight = wrapped_property('hoverHighlight', optional(bool, True))
    base_segment_coloring = baseSegmentColoring = wrapped_property('baseSegmentColoring', optional(bool, False))
    selected_alpha = selectedAlpha = wrapped_property('selectedAlpha', optional(float, 0.5))
    not_selected_alpha = notSelectedAlpha = wrapped_property('notSelectedAlpha', optional(float, 0))
    object_alpha = objectAlpha = wrapped_property('objectAlpha', optional(float, 1.0))
    saturation = wrapped_property('saturation', optional(float, 1.0))
    ignore_null_visible_set = ignoreNullVisibleSet = wrapped_property('ignoreNullVisibleSet',
                                                                      optional(bool, True))
    skeleton_rendering = skeletonRendering = wrapped_property('skeletonRendering',
                                                              SkeletonRenderingOptions)

    @property
    def skeleton_shader(self):
        return self.skeleton_rendering.shader

    @skeleton_shader.setter
    def skeleton_shader(self, shader):
        self.skeleton_rendering.shader = shader

    skeletonShader = skeleton_shader

    color_seed = colorSeed = wrapped_property('colorSeed', optional(int, 0))
    cross_section_render_scale = crossSectionRenderScale = wrapped_property(
        'crossSectionRenderScale', optional(float, 1))
    mesh_render_scale = meshRenderScale = wrapped_property('meshRenderScale', optional(float, 10))
    mesh_silhouette_rendering = meshSilhouetteRendering = wrapped_property(
        'meshSilhouetteRendering', optional(float, 0))
    segment_query = segmentQuery = wrapped_property('segmentQuery', optional(text_type))
    segment_colors = segmentColors = wrapped_property(
        'segmentColors', typed_map(key_type=np.uint64, value_type=text_type))
    segment_default_color = segmentDefaultColor = wrapped_property('segmentDefaultColor',
                                                                   optional(text_type))

    @property
    def segment_html_color_dict(self):
        """Returns a dictionary whose keys are segments and values are the 6-digit hex
        strings representing the colors of those segments given the current
        color seed
        """
        d = {}
        for segment in self.segments:
            hex_string = segment_colors.hex_string_from_segment_id(color_seed=self.color_seed,
                                                                   segment_id=segment)
            d[segment] = hex_string
        return d

    linked_segmentation_group = linkedSegmentationGroup = wrapped_property(
        'linkedSegmentationGroup', optional(text_type))
    linked_segmentation_color_group = linkedSegmentationColorGroup = wrapped_property(
        'linkedSegmentationColorGroup', optional(_linked_segmentation_color_group_value))

    @staticmethod
    def interpolate(a, b, t):
        c = Layer.interpolate(a, b, t)
        for k in ['selected_alpha', 'not_selected_alpha', 'object_alpha']:
            setattr(c, k, interpolate_linear(getattr(a, k), getattr(b, k), t))
        return c


@export
class SingleMeshLayer(Layer):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(SingleMeshLayer, self).__init__(*args, type='mesh', **kwargs)

    source = wrapped_property('source', LayerDataSources)
    vertex_attribute_sources = vertexAttributeSources = wrapped_property(
        'vertexAttributeSources', optional(typed_list(text_type)))
    shader = wrapped_property('shader', text_type)
    vertex_attribute_names = vertexAttributeNames = wrapped_property(
        'vertexAttributeNames', optional(typed_list(optional(text_type))))


class AnnotationBase(JsonObjectWrapper):
    __slots__ = ()

    id = wrapped_property('id', optional(text_type))  # pylint: disable=invalid-name
    type = wrapped_property('type', text_type)
    description = wrapped_property('description', optional(text_type))
    segments = wrapped_property('segments', optional(typed_list(typed_list(np.uint64))))
    props = wrapped_property('props', optional(typed_list(number_or_string)))


@export
class PointAnnotation(AnnotationBase):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(PointAnnotation, self).__init__(*args, type='point', **kwargs)

    point = wrapped_property('point', array_wrapper(np.float32))


@export
class LineAnnotation(AnnotationBase):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(LineAnnotation, self).__init__(*args, type='line', **kwargs)

    point_a = pointA = wrapped_property('pointA', array_wrapper(np.float32))
    point_b = pointB = wrapped_property('pointB', array_wrapper(np.float32))


@export
class AxisAlignedBoundingBoxAnnotation(AnnotationBase):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(AxisAlignedBoundingBoxAnnotation, self).__init__(*args,
                                                               type='axis_aligned_bounding_box',
                                                               **kwargs)

    point_a = pointA = wrapped_property('pointA', array_wrapper(np.float32))
    point_b = pointB = wrapped_property('pointB', array_wrapper(np.float32))


@export
class EllipsoidAnnotation(AnnotationBase):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(EllipsoidAnnotation, self).__init__(*args, type='ellipsoid', **kwargs)

    center = wrapped_property('center', array_wrapper(np.float32))
    radii = wrapped_property('radii', array_wrapper(np.float32))


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
class AnnotationPropertySpec(JsonObjectWrapper):
    __slots__ = ()
    id = wrapped_property('id', text_type)
    type = wrapped_property('type', text_type)
    description = wrapped_property('description', optional(text_type))
    default = wrapped_property('default', optional(number_or_string))
    enum_values = wrapped_property('enum_values', optional(typed_list(number_or_string)))
    enum_labels = wrapped_property('enum_labels', optional(typed_list(text_type)))


@export
class AnnotationLayer(Layer, _AnnotationLayerOptions):
    __slots__ = ()

    def __init__(self, *args, **kwargs):
        super(AnnotationLayer, self).__init__(*args, type='annotation', **kwargs)

    source = wrapped_property('source', LayerDataSources)
    annotations = wrapped_property('annotations', typed_list(annotation))
    annotation_properties = annotationProperties = wrapped_property(
        'annotationProperties', typed_list(AnnotationPropertySpec))
    annotation_relationships = annotationRelationships = wrapped_property(
        'annotationRelationships', typed_list(text_type))
    linked_segmentation_layer = linkedSegmentationLayer = wrapped_property(
        'linkedSegmentationLayer', typed_string_map(text_type))
    filter_by_segmentation = filterBySegmentation = wrapped_property('filterBySegmentation',
                                                                     typed_list(text_type))
    ignore_null_segment_filter = ignoreNullSegmentFilter = wrapped_property(
        'ignoreNullSegmentFilter', optional(bool, True))
    shader = wrapped_property('shader', text_type)
    shader_controls = shaderControls = wrapped_property('shaderControls', ShaderControls)

    @staticmethod
    def interpolate(a, b, t):
        del b
        del t
        return a


@export
class LocalAnnotationLayer(AnnotationLayer):
    __slots__ = ()

    def __init__(self, dimensions, *args, **kwargs):
        super(LocalAnnotationLayer, self).__init__(
            *args,
            source=LayerDataSource(url='local://annotations',
                                   transform=CoordinateSpaceTransform(outputDimensions=dimensions)),
            **kwargs)


layer_types = {
    'image': ImageLayer,
    'segmentation': SegmentationLayer,
    'pointAnnotation': PointAnnotationLayer,
    'annotation': AnnotationLayer,
    'mesh': SingleMeshLayer,
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

    _visible = wrapped_property('visible', optional(bool))
    archived = wrapped_property('archived', optional(bool, False))

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
        if key in ['name', '_visible', 'visible', 'archived', 'layer']:
            object.__setattr__(self, key, value)
        else:
            return setattr(self.layer, key, value)

    def __repr__(self):
        return u'ManagedLayer(%s,%s)' % (encode_json_for_repr(
            self.name), encode_json_for_repr(self.to_json()))

    def to_json(self):
        r = self.layer.to_json()
        r['name'] = self.name
        archived = self.archived
        if not archived:
            r.pop('archived', None)
        else:
            r['archived'] = True
        visible = self.visible
        if visible or archived:
            r.pop('visible', None)
        else:
            r['visible'] = False
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
        if isinstance(json_data, collections_abc.Mapping):
            for k, v in six.iteritems(json_data):
                self._layers.append(ManagedLayer(k, v, _readonly=_readonly))
        else:
            # layers property can also be an array in JSON now. each layer has a name property
            for layer in json_data:
                if isinstance(layer, ManagedLayer):
                    self._layers.append(ManagedLayer(layer.name, layer, _readonly=_readonly))
                elif isinstance(layer, dict):
                    self._layers.append(
                        ManagedLayer(text_type(layer['name']), layer, _readonly=_readonly))
                else:
                    raise TypeError

    def index(self, k):
        for i, u in enumerate(self._layers):
            if u.name == k:
                return i
        return -1

    def __contains__(self, k):
        return self.index(k) != -1

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
        r = []
        for x in self._layers:
            r.append(x.to_json())
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
class LinkedPosition(
        make_linked_navigation_type(array_wrapper(np.float32),
                                    interpolate_linear_optional_vectors)):
    __slots__ = ()


@export
class LinkedZoomFactor(make_linked_navigation_type(float, interpolate_zoom)):
    __slots__ = ()


@export
class LinkedDepthRange(make_linked_navigation_type(float, interpolate_zoom)):
    __slots__ = ()


@export
class LinkedOrientationState(
        make_linked_navigation_type(array_wrapper(np.float32, 4), quaternion_slerp)):
    __slots__ = ()


@export
class CrossSection(JsonObjectWrapper):
    __slots__ = ()
    supports_validation = True
    width = wrapped_property('width', optional(int, 1000))
    height = wrapped_property('height', optional(int, 1000))
    position = wrapped_property('position', LinkedPosition)
    orientation = wrapped_property('orientation', LinkedOrientationState)
    scale = wrapped_property('scale', LinkedZoomFactor)

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.width = interpolate_linear(a.width, b.width, t)
        c.height = interpolate_linear(a.height, b.height, t)
        c.position = LinkedPosition.interpolate(a.position, b.position, t)
        c.orientation = LinkedOrientationState.interpolate(a.orientation, b.orientation, t)
        c.scale = LinkedZoomFactor.interpolate(a.scale, b.scale, t)
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
    cross_sections = crossSections = wrapped_property('crossSections', CrossSectionMap)
    orthographic_projection = orthographicProjection = wrapped_property(
        'orthographicProjection', optional(bool, False))

    def __init__(self, json_data=None, _readonly=False, **kwargs):
        if isinstance(json_data, six.string_types):
            json_data = {'type': six.text_type(json_data)}
        super(DataPanelLayout, self).__init__(json_data, _readonly=_readonly, **kwargs)

    def to_json(self):
        if len(self.cross_sections) == 0 and not self.orthographic_projection:
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


data_panel_layout_types = frozenset(['xy', 'yz', 'xz', 'xy-3d', 'yz-3d', 'xz-3d', '4panel', '3d'])


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
    flex = wrapped_property('flex', optional(float, 1))
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
    flex = wrapped_property('flex', optional(float, 1))
    layers = wrapped_property('layers', typed_list(text_type))
    layout = wrapped_property('layout', data_panel_layout_wrapper('xy'))
    position = wrapped_property('position', LinkedPosition)
    cross_section_orientation = crossSectionOrientation = wrapped_property(
        'crossSectionOrientation', LinkedOrientationState)
    cross_section_scale = crossSectionScale = wrapped_property('crossSectionScale', LinkedZoomFactor)
    cross_section_depth = crossSectionDepth = wrapped_property('crossSectionDepth',
                                                               LinkedDepthRange)
    projection_orientation = projectionOrientation = wrapped_property('projectionOrientation',
                                                                      LinkedOrientationState)
    projection_scale = projectionScale = wrapped_property('projectionScale', LinkedZoomFactor)
    projection_depth = projectionDepth = wrapped_property('projectionDepth', LinkedDepthRange)

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
    title = wrapped_property('title', optional(text_type))
    dimensions = wrapped_property('dimensions', CoordinateSpace)
    relative_display_scales = relativeDisplayScales = wrapped_property(
        'relativeDisplayScales', optional(typed_string_map(float)))
    display_dimensions = displayDimensions = wrapped_property('displayDimensions',
                                                              optional(typed_list(text_type)))
    position = voxel_coordinates = wrapped_property('position', optional(array_wrapper(np.float32)))
    cross_section_orientation = crossSectionOrientation = wrapped_property(
        'crossSectionOrientation', optional(array_wrapper(np.float32, 4)))
    cross_section_scale = crossSectionScale = wrapped_property('crossSectionScale', optional(float))
    cross_section_depth = crossSectionDepth = wrapped_property('crossSectionDepth', optional(float))
    projection_scale = projectionScale = wrapped_property('projectionScale', optional(float))
    projection_depth = projectionDepth = wrapped_property('projectionDepth', optional(float))
    projection_orientation = projectionOrientation = perspectiveOrientation = perspective_orientation = wrapped_property(
        'projectionOrientation', optional(array_wrapper(np.float32, 4)))
    show_slices = showSlices = wrapped_property('showSlices', optional(bool, True))
    show_axis_lines = showAxisLines = wrapped_property('showAxisLines', optional(bool, True))
    show_scale_bar = showScaleBar = wrapped_property('showScaleBar', optional(bool, True))
    show_default_annotations = showDefaultAnnotations = wrapped_property(
        'showDefaultAnnotations', optional(bool, True))
    gpu_memory_limit = gpuMemoryLimit = wrapped_property('gpuMemoryLimit', optional(int))
    system_memory_limit = systemMemoryLimit = wrapped_property('systemMemoryLimit', optional(int))
    concurrent_downloads = concurrentDownloads = wrapped_property('concurrentDownloads',
                                                                  optional(int))
    prefetch = wrapped_property('prefetch', optional(bool, True))
    layers = wrapped_property('layers', Layers)
    layout = wrapped_property('layout', layout_specification)
    cross_section_background_color = crossSectionBackgroundColor = wrapped_property(
        'crossSectionBackgroundColor', optional(text_type))
    projection_background_color = projectionBackgroundColor = wrapped_property(
        'projectionBackgroundColor', optional(text_type))
    selected_layer = selectedLayer = wrapped_property('selectedLayer', SelectedLayerState)
    statistics = wrapped_property('statistics', StatisticsDisplayState)
    help_panel = helpPanel = wrapped_property('helpPanel', HelpPanelState)
    layer_list_panel = layerListPanel = wrapped_property('layerListPanel', LayerListPanelState)
    partial_viewport = partialViewport = wrapped_property(
        'partialViewport',
        optional(array_wrapper(np.float64, 4), np.array([0, 0, 1, 1], dtype=np.float64)))

    @staticmethod
    def interpolate(a, b, t):
        c = copy.deepcopy(a)
        c.position = interpolate_linear_optional_vectors(a.position, b.position, t)
        c.projection_scale = interpolate_zoom(a.projection_scale, b.projection_scale, t)
        c.projection_orientation = quaternion_slerp(a.projection_orientation,
                                                    b.projection_orientation, t)
        c.cross_section_scale = interpolate_zoom(a.cross_section_scale, b.cross_section_scale, t)
        c.cross_section_orientation = quaternion_slerp(a.cross_section_orientation,
                                                       b.cross_section_orientation, t)
        c.layers = Layers.interpolate(a.layers, b.layers, t)
        c.layout = interpolate_layout(a.layout, b.layout, t)
        return c
