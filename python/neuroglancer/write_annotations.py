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

from collections import defaultdict
import json
import numbers
import os
import pathlib
import struct
from collections.abc import Sequence
from typing import Literal, NamedTuple, Optional, Union, cast
import tensorstore as ts
import numpy as np
import math 

from . import coordinate_space, viewer_state

class NumpyEncoder(json.JSONEncoder):
  def default(self, obj):
    if isinstance(obj, np.ndarray):
      return obj.tolist()
    if isinstance(obj, np.integer):
      return int(obj)
    if isinstance(obj, np.floating):
      return float(obj)
    return json.JSONEncoder.default(self, obj)
  

class Annotation(NamedTuple):
    id: int
    encoded: bytes
    relationships: Sequence[Sequence[int]]


_PROPERTY_DTYPES: dict[
    str, tuple[Union[tuple[str], tuple[str, tuple[int, ...]]], int]
] = {
    "uint8": (("|u1",), 1),
    "uint16": (("<u2",), 2),
    "uint32": (("<u4",), 3),
    "int8": (("|i1",), 1),
    "int16": (("<i2",), 2),
    "int32": (("<i4",), 4),
    "float32": (("<f4",), 4),
    "rgb": (("|u1", (3,)), 1),
    "rgba": (("|u1", (4,)), 1),
}

AnnotationType = Literal["point", "line", "axis_aligned_bounding_box", "ellipsoid"]
ShardHashType = Literal["murmurhash3_x86_128", "identity_hash"]

MINISHARD_TARGET_COUNT = 1000
SHARD_TARGET_SIZE = 50000000


def choose_output_spec(total_count, total_bytes,
                       hashtype: ShardHashType = "murmurhash3_x86_128",
                       gzip_compress=True): 
    if total_count ==1:
        return None
    
    options = {
        '@type': 'neuroglancer_uint64_sharded_v1',
        'hash': hashtype,
    }

    total_minishard_bits = 0
    while (total_count >> total_minishard_bits) > MINISHARD_TARGET_COUNT:
        total_minishard_bits += 1

    shard_bits = 0
    while (total_bytes >> shard_bits) > SHARD_TARGET_SIZE:
        shard_bits += 1

    preshift_bits = 0
    while MINISHARD_TARGET_COUNT >> preshift_bits:
        preshift_bits += 1

    options['preshift_bits'] = preshift_bits
    options['shard_bits'] = shard_bits
    options['minishard_bits'] = total_minishard_bits - min(total_minishard_bits, shard_bits)
    if gzip_compress:
        options['data_encoding'] = 'gzip'
        options['minishard_index_encoding'] = 'gzip'
    else:
        options['data_encoding'] = 'raw'
        options['minishard_index_encoding'] = 'raw'

    return options


def compressed_morton_code(gridpt, grid_size):
    # from cloudvolume
    if hasattr(gridpt, "__len__") and len(gridpt) == 0: # generators don't have len
        return np.zeros((0,), dtype=np.uint32)

    gridpt = np.asarray(gridpt, dtype=np.uint32)
    single_input = False
    if gridpt.ndim == 1:
        gridpt = np.atleast_2d(gridpt)
        single_input = True

    code = np.zeros((gridpt.shape[0],), dtype=np.uint64)
    num_bits = [ math.ceil(math.log2(size)) for size in grid_size ]
    j = np.uint64(0)
    one = np.uint64(1)

    if sum(num_bits) > 64:
        raise ValueError(f"Unable to represent grids that require more than 64 bits. Grid size {grid_size} requires {num_bits} bits.")

    max_coords = np.max(gridpt, axis=0)
    if np.any(max_coords >= grid_size):
        raise ValueError(f"Unable to represent grid points larger than the grid. Grid size: {grid_size} Grid points: {gridpt}")

    for i in range(max(num_bits)):
        for dim in range(3):
            if 2 ** i < grid_size[dim]:
                bit = (((np.uint64(gridpt[:, dim]) >> np.uint64(i)) & one) << j)
                code |= bit
                j += one
    print(gridpt, grid_size, code)
    if single_input:
        return code[0]
    return code

# def compressed_morton_code(position, shape):
#     output_bit = 0
#     rank = len(position)
#     output_num = 0
#     for bit in range(32):
#         for dim in range(rank-1, -1, -1):
#             if (shape[dim] - 1) >> bit:
#                 output_num |= ((position[dim] >> bit) & 1) << output_bit
#                 output_bit += 1
#                 if output_bit == 64:
#                     # In Python, we don't have the 32-bit limitation, so we don't need to split into high and low.
#                     # But you can add code here to handle or signal overflow if needed.
#                     pass
#     return output_num

def _get_dtype_for_geometry(annotation_type: AnnotationType, rank: int):
    geometry_size = rank if annotation_type == "point" else 2 * rank
    return [("geometry", "<f4", geometry_size)]


def _get_dtype_for_properties(
    properties: Sequence[viewer_state.AnnotationPropertySpec],
):
    dtype = []
    offset = 0
    for i, p in enumerate(properties):
        dtype_entry, alignment = _PROPERTY_DTYPES[p.type]
        if offset % alignment:
            padded_offset = (offset + alignment - 1) // alignment * alignment
            padding = padded_offset - offset
            dtype.append((f"padding{offset}", "|u1", (padding,)))
            offset += padding
        dtype.append((f"property{i}", *dtype_entry))  # type: ignore[arg-type]
        size = np.dtype(dtype[-1:]).itemsize
        offset += size
    alignment = 4
    if offset % alignment:
        padded_offset = (offset + alignment - 1) // alignment * alignment
        padding = padded_offset - offset
        dtype.append((f"padding{offset}", "|u1", (padding,)))
        offset += padding
    return dtype


class AnnotationWriter:
    annotations: list[Annotation]
    related_annotations: list[dict[int, list[Annotation]]]

    def __init__(
        self,
        coordinate_space: coordinate_space.CoordinateSpace,
        annotation_type: AnnotationType,
        lower_bound: Sequence = (0, 0, 0),
        relationships: Sequence[str] = (),
        properties: Sequence[viewer_state.AnnotationPropertySpec] = (),
        chunk_size: Sequence[int] = [256, 256, 256]
    ):
        """Initializes an `AnnotationWriter`.

        Args:
            coordinate_space: The coordinate space in which the annotations are
                defined. is a `CoordinateSpace` object.
            annotation_type: The type of annotation.  Must be one of "point",
                "line", "axis_aligned_bounding_box", or "ellipsoid".
            lower_bound: The lower bound of the bounding box of the annotations.
            relationships: The names of relationships between annotations.  Each
                relationship is a string that is used as a key in the `relationships`
                field of each annotation.  For example, if `relationships` is
                `["parent", "child"]`, then each annotation may have a `parent` and
                `child` relationship, and the `relationships` field of each annotation
                is a dictionary with keys `"parent"` and `"child"`.
            properties: The properties of each annotation.  Each property is a
                `AnnotationPropertySpec` object.
            chunk_size: The size of each chunk in the spatial index.  Must have the
                same length as `coordinate_space.rank`.
            write_id_sharded: If True, the annotations will be sharded by id.
            id_sharding_spec: The sharding specification for the id sharding.  If
                not specified spec will be automatically configured
        """
        self.chunk_size = np.array(chunk_size)
        self.coordinate_space = coordinate_space
        self.relationships = list(relationships)
        self.annotation_type = annotation_type
        self.properties = list(properties)
        self.annotations_by_chunk = defaultdict(list)
        self.properties.sort(key=lambda p: -_PROPERTY_DTYPES[p.type][1])
        self.annotations = []
        self.rank = coordinate_space.rank
        self.dtype = _get_dtype_for_geometry(
            annotation_type, coordinate_space.rank
        ) + _get_dtype_for_properties(self.properties)
        self.lower_bound = np.array(lower_bound, dtype=np.float32)
        assert(len(self.lower_bound) == self.rank)
        self.upper_bound = np.full(
            shape=(self.rank,), fill_value=float("-inf"), dtype=np.float32
        )
        self.related_annotations = [{} for _ in self.relationships]
        

    def get_chunk_index(self, coords):
        return tuple(((coords-self.lower_bound) // self.chunk_size).astype(np.int32))

    def add_point(self, point: Sequence[float], id: Optional[int] = None, **kwargs):
        if self.annotation_type != "point":
            raise ValueError(
                f"Expected annotation type point, but received: {self.annotation_type}"
            )
        if len(point) != self.coordinate_space.rank:
            raise ValueError(
                f"Expected point to have length {self.coordinate_space.rank}, but received: {len(point)}"
            )

        #self.lower_bound = np.minimum(self.lower_bound, point)
        self.upper_bound = np.maximum(self.upper_bound, point)
        self._add_obj(point, id, **kwargs)

    def add_axis_aligned_bounding_box(
        self,
        point_a: Sequence[float],
        point_b: Sequence[float],
        id: Optional[int] = None,
        **kwargs,
    ):
        if self.annotation_type != "axis_aligned_bounding_box":
            raise ValueError(
                f"Expected annotation type axis_aligned_bounding_box, but received: {self.annotation_type}"
            )
        self._add_two_point_obj(point_a, point_b, id, **kwargs)

    def add_line(
        self,
        point_a: Sequence[float],
        point_b: Sequence[float],
        id: Optional[int] = None,
        **kwargs,
    ):
        if self.annotation_type != "line":
            raise ValueError(
                f"Expected annotation type line, but received: {self.annotation_type}"
            )
        self._add_two_point_obj(point_a, point_b, id, **kwargs)

    def _add_two_point_obj(
        self,
        point_a: Sequence[float],
        point_b: Sequence[float],
        id: Optional[int] = None,
        **kwargs,
    ):
        if len(point_a) != self.coordinate_space.rank:
            raise ValueError(
                f"Expected coordinates to have length {self.coordinate_space.rank}, but received: {len(point_a)}"
            )

        if len(point_b) != self.coordinate_space.rank:
            raise ValueError(
                f"Expected coordinates to have length {self.coordinate_space.rank}, but received: {len(point_b)}"
            )

        #self.lower_bound = np.minimum(self.lower_bound, point_a)
        self.upper_bound = np.maximum(self.upper_bound, point_b)
        coords = np.concatenate((point_a, point_b))
        self._add_obj(cast(Sequence[float], coords), id, **kwargs)

    def _add_obj(self, coords: Sequence[float], id: Optional[int], **kwargs):
        encoded = np.zeros(shape=(), dtype=self.dtype)
        encoded[()]["geometry"] = coords

        for i, p in enumerate(self.properties):
            if p.id in kwargs:
                encoded[()][f"property{i}"] = kwargs.pop(p.id)

        related_ids = []
        for relationship in self.relationships:
            ids = kwargs.pop(relationship, None)
            if ids is None:
                ids = []
            if isinstance(ids, numbers.Integral):
                ids = [ids]
            related_ids.append(ids)

        if kwargs:
            raise ValueError(f"Unexpected keyword arguments {kwargs}")

        if id is None:
            id = len(self.annotations)

        annotation = Annotation(
            id=id, encoded=encoded.tobytes(), relationships=related_ids
        )

        chunk_index = self.get_chunk_index(np.array(coords[:self.rank]))
        self.annotations_by_chunk[chunk_index].append(annotation)
        self.annotations.append(annotation)
        for i, segment_ids in enumerate(related_ids):
            for segment_id in segment_ids:
                rel_index = self.related_annotations[i]
                rel_index_list = rel_index.setdefault(segment_id, [])
                rel_index_list.append(annotation)
         
    def _serialize_annotations_sharded(self, path, annotations, shard_spec):
        spec = {
                'driver': 'neuroglancer_uint64_sharded',
                'metadata': shard_spec,
                "base": f"file://{path}"
            }
        dataset = ts.KvStore.open(spec).result()
        txn = ts.Transaction()
        for ann in annotations:
            # convert the ann.id to a binary representation of a uint64
            key = ann.id.to_bytes(8, 'little')
            dataset.with_transaction(txn)[key]=ann.encoded
        txn.commit_async().result()
    
    def _serialize_annotations(self, f, annotations: list[Annotation]):
        f.write(self._encode_multiple_annotations(annotations))
       
    def _serialize_annotation(self, f, annotation: Annotation):
        f.write(annotation.encoded)
        for related_ids in annotation.relationships:
            f.write(struct.pack("<I", len(related_ids)))
            for related_id in related_ids:
                f.write(struct.pack("<Q", related_id))

    def _encode_multiple_annotations(self, annotations: list[Annotation]):
        """
        This function creates a binary string from a list of annotations.

        Parameters:
            annotations (list): List of annotation objects. Each object should have 'encoded' and 'id' attributes.

        Returns:
            bytes: Binary string of all components together.
        """
        binary_components = []
        binary_components.append(struct.pack("<Q", len(annotations)))
        for annotation in annotations:
            binary_components.append(annotation.encoded)
        for annotation in annotations:
            binary_components.append(struct.pack("<Q", annotation.id))
        return b"".join(binary_components)
    
    def _serialize_annotations_by_related_id(self, path, related_id_dict, shard_spec):
        spec = {
                'driver': 'neuroglancer_uint64_sharded',
                'metadata': shard_spec,
                "base": f"file://{path}"
            }
        dataset = ts.KvStore.open(spec).result()
        txn = ts.Transaction()
        for related_id, annotations in related_id_dict.items():
            # convert the ann.id to a binary representation of a uint64
            key = related_id.to_bytes(8, 'little')
            value = self._encode_multiple_annotations(annotations)
            dataset.with_transaction(txn)[key]=value
        txn.commit_async().result()

    def _serialize_annotation_chunk_sharded(self, path, annotations_by_chunk, shard_spec, max_sizes):
        spec = {
                'driver': 'neuroglancer_uint64_sharded',
                'metadata': shard_spec,
                "base": f"file://{path}"
            }
        dataset = ts.KvStore.open(spec).result()
        txn = ts.Transaction()
        for chunk_index, annotations in annotations_by_chunk.items():
            # calculate the compressed morton code for the chunk index
            key = compressed_morton_code(chunk_index, max_sizes)
            print(key, type(key))
            key = key.astype('<u8').tobytes()
            print(key, type(key))
            value = self._encode_multiple_annotations(annotations)
            dataset.with_transaction(txn)[key] = value

        txn.commit_async().result()

    def write(self, path: Union[str, pathlib.Path]):
        metadata = {
            "@type": "neuroglancer_annotations_v1",
            "dimensions": self.coordinate_space.to_json(),
            "lower_bound": [float(x) for x in self.lower_bound],
            "upper_bound": [float(x) for x in self.upper_bound],
            "annotation_type": self.annotation_type,
            "properties": [p.to_json() for p in self.properties],
            "relationships": [],
            "by_id": {
                "key": "by_id"
            }
        }
        total_ann_bytes = sum(len(a.encoded) for a in self.annotations)
        sharding_spec = choose_output_spec(len(self.annotations),
                                           total_ann_bytes)

        # calculate the number of chunks in each dimension
        num_chunks = np.ceil((self.upper_bound - self.lower_bound) / self.chunk_size).astype(int)

        # find the maximum number of annotations in any chunk
        max_annotations = max(len(annotations) for annotations in self.annotations_by_chunk.values())

        # make directories
        os.makedirs(path, exist_ok=True)
        for relationship in self.relationships:
            os.makedirs(os.path.join(path, f"rel_{relationship}"), exist_ok=True)
        os.makedirs(os.path.join(path, "by_id"), exist_ok=True)
        os.makedirs(os.path.join(path, "spatial0"), exist_ok=True)

        total_chunks = len(self.annotations_by_chunk)
        spatial_sharding_spec = choose_output_spec(total_chunks,
                                                   total_ann_bytes + 8*len(self.annotations)+8*total_chunks)
        # initialize metadata for spatial index
        metadata['spatial'] = [
            {
                "key": "spatial0",
                "grid_shape": num_chunks.tolist(),
                "chunk_size": [int(x) for x in self.chunk_size],
                "limit": max_annotations
            }
        ]
        # write annotations by spatial chunk
        if spatial_sharding_spec is not None:
            self._serialize_annotation_chunk_sharded(os.path.join(path, "spatial0"),
                                                    self.annotations_by_chunk,
                                                    spatial_sharding_spec,
                                                    num_chunks.tolist())
            metadata['spatial'][0]['sharding'] = spatial_sharding_spec
        else:
            for chunk_index, annotations in self.annotations_by_chunk.items():
                chunk_name = "_".join([str(c) for c in chunk_index])
                filepath = os.path.join(path, "spatial0", chunk_name)
                with open(filepath, 'wb') as f:
                    self._serialize_annotations(f, annotations)

        # write annotations by id
        if sharding_spec is not None:
            self._serialize_annotations_sharded(os.path.join(path, "by_id"), self.annotations, sharding_spec)
            metadata["by_id"]["sharding"] = sharding_spec
        else:
            for annotation in self.annotations:
                with open(os.path.join(path, "by_id", str(annotation.id)), "wb") as f:
                    self._serialize_annotation(f, annotation)

        # write relationships
        for i, relationship in enumerate(self.relationships):
            rel_index = self.related_annotations[i]
            relationship_sharding_spec = choose_output_spec(len(rel_index),
                                                            total_ann_bytes + 8*len(self.annotations)+8*total_chunks)
            rel_md = {"id": relationship,
                      "key": f"rel_{relationship}"}
            if relationship_sharding_spec is not None:
                rel_md["sharding"] = relationship_sharding_spec
                self._serialize_annotations_by_related_id(os.path.join(path, f"rel_{relationship}"), rel_index, relationship_sharding_spec)
            else:
                for segment_id, annotations in rel_index.items():
                    filepath = os.path.join(path, f"rel_{relationship}", str(segment_id))
                    with open(filepath, "wb") as f:
                        self._serialize_annotations(f, annotations)
            
            metadata["relationships"].append(rel_md)
        
        # write metadata info file
        with open(os.path.join(path, "info"), "w") as f:
            f.write(json.dumps(metadata, cls=NumpyEncoder))