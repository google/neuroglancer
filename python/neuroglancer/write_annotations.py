"""Writes annotations in the Precomputed annotation format.

This provides a simple way to write annotations in the precomputed format, but
has a number of limitations that makes it suitable only for a relatively small
amount of annotation data:

- All annotations are buffered in memory.

- Only a trivial spatial index consisting of a single grid cell at a single
  level is generated.  Consequently, Neuroglancer will be forced to download all
  annotations at once.

- All indices are written in the unsharded format.  Consequently, there is at
  least one file written per annotation.
"""

from . import coordinate_space
from typing import List, Sequence, NamedTuple, Optional
from typing_extensions import Literal
from . import viewer_state
import numbers
import io
import json
import os
import numpy as np
import struct


class Annotation(NamedTuple):
    id: int
    encoded: bytes
    relationships: Sequence[Sequence[int]]


_PROPERTY_DTYPES = {
    'uint8': (('|u1', ), 1),
    'uint16': (('<u2', ), 2),
    'uint32': (('<u4', ), 3),
    'int8': (('|i1', ), 1),
    'int16': (('<i2', ), 2),
    'int32': (('<i4', ), 4),
    'float32': (('<f4', ), 4),
    'rgb': (('|u1', (3, )), 1),
    'rgba': (('|u1', (4, )), 1),
}

AnnotationType = Literal['point', 'line', 'axis_aligned_bounding_box', 'ellipsoid']


def _get_dtype_for_geometry(annotation_type: AnnotationType, rank: int):
    geometry_size = rank if annotation_type == 'point' else 2 * rank
    return [('geometry', '<f4', geometry_size)]


def _get_dtype_for_properties(properties: Sequence[viewer_state.AnnotationPropertySpec]):
    dtype = []
    offset = 0
    for i, p in enumerate(properties):
        dtype_entry, alignment = _PROPERTY_DTYPES[p.type]
        if offset % alignment:
            padded_offset = (offset + alignment - 1) // alignment * alignment
            padding = padded_offset - offset
            dtype.append((f'padding{offset}', '|u1', (padding, )))
            offset += padding
        dtype.append((f'property{i}', *dtype_entry))
        size = np.dtype(dtype[-1:]).itemsize
        offset += size
    alignment = 4
    if offset % alignment:
        padded_offset = (offset + alignment - 1) // alignment * alignment
        padding = padded_offset - offset
        dtype.append((f'padding{offset}', '|u1', (padding, )))
        offset += padding
    return dtype


class AnnotationWriter:
    def __init__(
            self,
            coordinate_space: coordinate_space.CoordinateSpace,
            annotation_type: AnnotationType,
            relationships: Sequence[str] = (),
            properties: Sequence[viewer_state.AnnotationPropertySpec] = (),
    ):
        self.coordinate_space = coordinate_space
        self.relationships = list(relationships)
        self.annotation_type = annotation_type
        self.properties = list(properties)
        self.properties.sort(key=lambda p: -_PROPERTY_DTYPES[p.type][1])
        self.annotations = []
        self.rank = coordinate_space.rank
        self.dtype = (_get_dtype_for_geometry(annotation_type, coordinate_space.rank) +
                      _get_dtype_for_properties(self.properties))
        self.lower_bound = np.full(shape=(self.rank, ), fill_value=float('inf'), dtype=np.float32)
        self.upper_bound = np.full(shape=(self.rank, ), fill_value=float('-inf'), dtype=np.float32)
        self.related_annotations = [{} for _ in self.relationships]

    def add_point(self, point: Sequence[int], id: Optional[int] = None, **kwargs):
        if self.annotation_type != 'point':
            raise ValueError(
                f'Expected annotation type point, but received: {self.annotation_type}'
            )
        if len(point) != self.coordinate_space.rank:
            raise ValueError(
                f'Expected point to have length {self.coordinate_space.rank}, but received: {len(point)}'
            )

        self.lower_bound = np.minimum(self.lower_bound, point)
        self.upper_bound = np.maximum(self.upper_bound, point)
        self._add_obj(point, id, **kwargs)
        
    def add_axis_aligned_bounding_box(self, point_a: Sequence[int], point_b: Sequence[int], id: Optional[int] = None, **kwargs):
        if self.annotation_type != 'axis_aligned_bounding_box':
            raise ValueError(
                f'Expected annotation type axis_aligned_bounding_box, but received: {self.annotation_type}'
            )
        self._add_two_point_obj(point_a, point_b, id, **kwargs)
    
    def add_line(self, point_a: Sequence[int], point_b: Sequence[int], id: Optional[int] = None, **kwargs):
        if self.annotation_type != 'line':
            raise ValueError(
                f'Expected annotation type line, but received: {self.annotation_type}'
            )
        self._add_two_point_obj(point_a, point_b, id, **kwargs)

    def _add_two_point_obj(self, point_a: Sequence[int], point_b: Sequence[int], id: Optional[int] = None, **kwargs):
        if len(point_a) != self.coordinate_space.rank:
            raise ValueError(
                f'Expected coordinates to have length {self.coordinate_space.rank}, but received: {len(point_a)}'
            )
            
        if len(point_b) != self.coordinate_space.rank:
            raise ValueError(
                f'Expected coordinates to have length {self.coordinate_space.rank}, but received: {len(point_b)}'
            )
            
        self.lower_bound = np.minimum(self.lower_bound, point_a)
        self.upper_bound = np.maximum(self.upper_bound, point_b)
        coords = np.concatenate((point_a, point_b))
        self._add_obj(coords, id, **kwargs)

    def _add_obj(self, coords: Sequence[int], id: Optional[int], **kwargs):
        encoded = np.zeros(shape=(), dtype=self.dtype)
        encoded[()]['geometry'] = coords

        for i, p in enumerate(self.properties):
            if p.id in kwargs:
                encoded[()][f'property{i}'] = kwargs.pop(p.id)

        related_ids = []
        for relationship in self.relationships:
            ids = kwargs.pop(relationship, None)
            if ids is None:
                ids = []
            if isinstance(ids, numbers.Integral):
                ids = [ids]
            related_ids.append(ids)

        if kwargs:
            raise ValueError(f'Unexpected keyword arguments {kwargs}')

        if id is None:
            id = len(self.annotations)

        annotation = Annotation(id=id, encoded=encoded.tobytes(), relationships=related_ids)

        self.annotations.append(annotation)

        for i, segment_ids in enumerate(related_ids):
            for segment_id in segment_ids:
                rel_index = self.related_annotations[i]
                rel_index.setdefault(segment_id, [])
                rel_index.append(annotation)

    def _serialize_annotations(self, f, annotations: List[Annotation]):
        f.write(struct.pack('<Q', len(annotations)))
        for annotation in annotations:
            f.write(annotation.encoded)
        for annotation in annotations:
            f.write(struct.pack('<Q', annotation.id))

    def _serialize_annotation(self, f, annotation: Annotation):
        f.write(annotation.encoded)
        for related_ids in annotation.relationships:
            f.write(struct.pack('<I', len(related_ids)))
            for related_id in related_ids:
                f.write(struct.pack('<Q', related_id))

    def write(self, path: str):

        metadata = {
            '@type':
            'neuroglancer_annotations_v1',
            'dimensions':
            self.coordinate_space.to_json(),
            'lower_bound': [float(x) for x in self.lower_bound],
            'upper_bound': [float(x) for x in self.upper_bound],
            'annotation_type':
            self.annotation_type,
            'properties': [p.to_json() for p in self.properties],
            'relationships': [{
                'id': relationship,
                'key': f'rel_{relationship}'
            } for relationship in self.relationships],
            'by_id': {
                'key': 'by_id',
            },
            'spatial': [
                {
                    'key': 'spatial0',
                    'grid_shape': [1] * self.rank,
                    'chunk_size': [max(1, float(x)) for x in self.upper_bound - self.lower_bound],
                    'limit': len(self.annotations),
                },
            ],
        }

        os.makedirs(path, exist_ok=True)
        for relationship in self.relationships:
            os.makedirs(os.path.join(path, f'rel_{relationship}'), exist_ok=True)
        os.makedirs(os.path.join(path, 'by_id'), exist_ok=True)
        os.makedirs(os.path.join(path, 'spatial0'), exist_ok=True)

        with open(os.path.join(path, 'info'), 'w') as f:
            f.write(json.dumps(metadata))

        with open(os.path.join(path, 'spatial0', '_'.join('0' for _ in range(self.rank))),
                  'wb') as f:
            self._serialize_annotations(f, self.annotations)

        for annotation in self.annotations:
            with open(os.path.join(path, 'by_id', str(annotation.id)), 'wb') as f:
                self._serialize_annotation(f, annotation)

        for i, relationship in enumerate(self.relationships):
            rel_index = self.related_annotations[i]
            for segment_id, annotations in rel_index.items():
                with open(os.path.join(path, f'rel_{relationship}', str(segment_id)), 'wb') as f:
                    self._serialize_annotations(f, annotations)
