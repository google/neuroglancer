# Annotation collection representation

Annotation collections are defined over an n-dimensional coordinate space and one of the
following four geometry types:

- Points (represented by a single position)
- Line segments (represented by the two endpoint positions)
- Axis-aligned bounding boxes (represented by two positions)
- Axis-aligned ellipsoids (represented by a center position and radii vector)

All annotations within a single annotation collection have the same geometry type.

Each annotation is defined by:
- A unique uint64 annotation id;
- Position/radii vectors required by the annotation type;
- For each *relationship* specified in the [info JSON file](#info-json-file-format), a list of associated uint64 ids (typically corresponding to segmented objects);
- Values for each *property* specified in the [info JSON file](#info-json-file-format).

An annotation collection is represented as a directory tree consisting of the following files:

- `info` file in JSON format specifying the [metadata](#info-json-file-format).
- A sub-directory containing the [annotations indexed by their unique uint64 annotation ids](#annotation-id-index).
- For each relationship, a sub-directory containing the [annotations indexed by associated object ids](#related-object-id-index).
- A collection of sub-directories containing a [multi-level spatial index of the annotations](#spatial-index).

## info JSON file format

The `info` file is a JSON-format text file.  The root value must be a JSON object with the following
members:
- `"@type"`: Must be `"neuroglancer_annotations_v1"`.
- `"dimensions"`: JSON object, where each key specifies a dimension name and the value is a
  two-element array `[scale, unit]`, where `scale` is a positive number specifying the physical
  scale, and `unit` is a string specifying the physical unit (must be a supported Neuroglancer unit,
  e.g. `"m"` or `"s"`).  An empty string may be specified as the `unit` to indicate a unitless
  quantity.  The number of members indicates the `rank`.  The order of the keys is significant, as
  it determines the order of the dimensions.
- `"lower_bound"`: Array of numbers of length `rank` specifying the lower bound (in the units
  specified by `dimensions`).  This is also the origin of the grid used for each spatial index
  level.
- `"upper_bound"`: Array of numbers of length `rank` specifying the exclusive upper bound (in the
  units specified by `dimensions`).  All annotation geometry should be contained within the bounding
  box defined by `lower_bound` and `upper_bound`.
- `"annotation_type"`: Indicates the annotation geometry type.  Must be one of `"POINT"`, `"LINE"`,
  `"AXIS_ALIGNED_BOUNDING_BOX"`, `"ELLIPSOID"`.
- `"properties"`: Array of JSON objects, each with the following members:
  - `"id"`: String value specifying unique identifier for the property.  Must match the regular expression `/^[a-z][a-zA-Z0-9_]*$/`.
  - `"type"`: String value specifying the property type.  Must be one of: `rgb` (represented as 3
    uint8 values), `rgba` (represented as 4 uint8 values), `uint8`, `int8`, `uint16`, `int16`,
    `uint32`, `int32`, or `float32`.
  - `"description"`: Optional.  String value specifying textual description of property shown in UI.
  - `"enum_values"`: Optional.  If `"type"` is a numeric type (not `"rgb"` or `"rgba"`), this
    property may specify an array of values (compatible with the specified data type).  These values
    correspond to the labels specified by `"enum_labels"`, which are shown in the UI.
  - `"enum_labels"`: Must be specified if, and only if, `"enum_values"` is specified.  Must be an
    array of strings of the same length as `"enum_values"` specifying the corresponding labels for
    each value.
- `"relationships"`: Array of JSON objects, each with the following members:
  - `"id"`: String value specifying unique identifier for the relationship (displayed in the UI).
  - `"key"`: String value specifying the sub-directory containing the corresponding [related object id index](#related-object-id-index).
    May also be a relative path `"/"`-separated path, optionally containing `".."` components, which
    is interpreted relative to the parent directory of the `"info"` file.
  - `"sharding"`: Optional.  If specified, must be a [sharding
    specification](./sharding.md#sharding-specification), and indicates that the [sharded uint64
    index format](#sharded-uint64-index) is used.  Otherwise, the [unsharded uint64 index
    format](#unsharded-uint64-index) is used.
- `"by_id"`: JSON object specifying the location and format of the [annotation id index](#annotation-id-index), with the following members:
  - `"key"`: String value specifying the sub-directory containing the index.  May also be a relative
    path `"/"`-separated path, optionally containing `".."` components, which is interpreted
    relative to the parent directory of the `"info"` file.
  - `"sharding"`: Optional.  If specified, must be a [sharding
    specification](./sharding.md#sharding-specification), and indicates that the [sharded uint64
    index format](#sharded-uint64-index) index format is used.  Otherwise, the [unsharded uint64
    index format](#unsharded-uint64-index) index format is used.
- `"spatial"`: Array of JSON objects specifying the spatial index levels from coarse to fine, each
  with the following members:
  - `"key"`: String value specifying the sub-directory containing the spatial index level.  May also be a relative
    path `"/"`-separated path, optionally containing `".."` components, which is interpreted
    relative to the parent directory of the `"info"` file.
  - `"sharding"`: Optional.  If specified, must be a [sharding
    specification](./sharding.md#sharding-specification), and indicates that the [sharded spatial
    index format](#sharded-spatial-index) index format is used.  Otherwise, the [unsharded spatial
    index](#unsharded-spatial-index) format is used.
  - `"grid_shape"`: Array of `rank` positive integers specifying the number of cells along each grid dimension for this spatial index level.
  - `"chunk_size"`: Array of `rank` positive floating-point numbers specifying the size (in the units specified by `dimensions`) of each grid cell.
  - `"limit"`: Integer specifying the maximum number of annotations per grid cell in this level of the spatial index.

## Annotation id index

The annotation id index supports efficient retrieval of individual annotations by their uint64 id,
and is used by Neuroglancer when selecting or hovering over an annotation.

The annotation id index maps each uint64 annotation id to the [encoded
representation](#single-annotation-encoding) of the single corresponding annotation.  Depending on
whether a `"sharding"` member is specified in the `"by_id"` member of the info JSON file, the index
is stored either in the [unsharded uint64 index format](#unsharded-uint64-index) or the [sharded
uint64 index format](#sharded-uint64-index).

Note that the geometry and property data is duplicated in all indices, but only the annotation id
index encodes the complete lists of related object ids.

### Single annotation encoding

Within the annotation id index, each annotation is encoded in the following binary format:

- The position/radii vectors required by the annotation type encoded as float32le values:
  - For `"POINT"` type, the position vector.
  - For `"LINE"` type, the first endpoint position followed by the second endpoint position.
  - For `"AXIS_ALIGNED_BOUNDING_BOX"` type, the first position followed by the second position.
  - For `"ELLIPSOID"` type, the center position followed by the radii vector.
- For each property of type `uint32`, `int32`, or `float32`: the value encoded as a little endian value.
- For each property of type `uint16` or `int16`: the value encoded as a little endian value.
- For each property of type `uint8`, `int8`, `rgb`, or `rgba`: the encoded value.
- Up to 3 padding bytes (with value of 0) to reach a byte offset that is a multiple of 4.
- For each relationship specified by the info JSON file:
  - The number of object ids as a uint32le value.
  - Each related object id, as a uint64le value.
  
### Unsharded uint64 index

The data corresponding to each uint64 annotation id or related object id is stored in a file named
`<id>` within the directory indicated by the `"key"` member, where `<id>` is the base-10 string
representation of the uint64 id.

### Sharded uint64 index

The uint64 annotation id or related object id is used directly as the key within the sharded
representation within the directory indicated by the `"key"` member.
  
## Related object id index

The related object id index supports efficient retrieval of the list of annotations associated via a
given relationship with a given object id, and is used by Neuroglancer when filtering by segment
ids.

The related object id index maps each uint64 object id to the [encoded
representation](#multiple-annotation-encoding) of the list of related annotations.  Depending on
whether a `"sharding"` member is specified in the corresponding entry of the `"relationships"`
member of the info JSON file, the index is stored either in the [unsharded uint64 index
format](#unsharded-uint64-index) or the [sharded uint64 index format](#sharded-uint64-index).

### Multiple annotation encoding

Both the related object id index and the spatial index encode lists of annotations in the following binary format:

The number of annotations, `count`, as a uint64le value.

Repeated for `i = 0` up to `count - 1`:
- The position/radii vectors, the property values, and padding bytes of the `i`th annotation are encoded exactly as
in the [single annotation encoding](#single-annotation-encoding).

Repeated for `i = 0` up to `count - 1`:
- The annotation id of the `i`th annotation encoded as a uint64le value.

For the related object id index, the order of the annotations does not matter.  For the spatial
index, the annotations should be ordered randomly.

## Spatial index

The spatial index supports efficient retrieval of the set of annotations that intersects a given
bounding box, with optional subsampling down to a desired maximum density.

The spatial index is used by Neuroglancer when not filtering by related segment ids.

Each spatial index level maps cell positions within the grid specified by the `chunk_size` and
`grid_shape` members of the corresponding entry of the `"spatial"` member of the info JSON file to a
spatially uniform subsample of annotations intersecting that grid cell.  A grid cell with
coordinates `cell` corresponds to a spatial interval in dimension `d` of `[lower_bound[d] +
cell[d] * chunk_size[d], lower_bound[d] + (cell[d] + 1) * chunk_size[d]]`.  The `"chunk_size"` for
spatial index level `i+1` should evenly divide the `"chunk_size"` for spatial index level `i`.  The
grid cells within level `i+1` that are contained within a single level `i` grid cell are considered
the child cells.  For each level, the elementwise product of the `grid_shape` and the `chunk_size`
should equal `upper_bound - lower_bound`.  Typically the `grid_shape` for level 0 should be a vector
of all 1 (with `chunk_size` equal to `upper_bound - lower_bound`), and each component of
`chunk_size` of each successively level should be either equal to, or half of, the corresponding
component of the prior level `chunk_size`, whichever results in a more spatially isotropic chunk.

The spatial index levels should be computed as follows:

- For each grid position `cell` at the coarsest level, compute the set `remaining_annotations(0, cell)` of
  annotations that intersect the cell.  Note that a single annotation may intersect multiple cells.
  
- Sequentially generate spatial index `level`, starting at `level=0` (the coarsest level):
  - Define `maxCount(level)` to be the maximum over all `cell` positions of the size of
    `remaining_annotations(level, cell)`.
  - For each `cell`:
    - Compute a subset `emitted(level, cell)` of `remaining_annotations(0, cell)` where each
      annotation is chosen uniformly at random with probability `min(1, limit / maxCount(level))`.
    - This spatial index level maps `cell` to the list of annotations in `emitted(level, cell)`.
      The annotations are encoded in the [multiple annotation
      encoding](#multiple-annotation-encoding) also used by the related object id index; the list
      should be ordered randomly (or perhaps pseudo-randomly based on the annotation id).
    - For each `child_cell` in level `level+1` contained within `cell`: Compute the set
      `remaining_annotations(level+1, child_cell)` of annotations within
      `remaining_annotations(level, cell) - emitted(level, cell)` that intersect `child_cell`.
  - Continue generating successively finer spatial index levels until no annotations remain.

### Unsharded spatial index

The encoded annotation list corresponding to a grid cell `cell` is stored within the directory
indicated by the `"key"` member in a file named `cell.join('_')` within the directory indicated by
`"key"`, i.e. the base-10 string representations of the grid cell coordinates separated by the `'_'`
character.  For example, cell `(1, 2, 3)` is stored in the file named `1_2_3`.

### Sharded spatial index

The [compressed morton code](./volume.md#compressed-morton-code) of the grid cell is used as the key
within the sharded representation stored in the directory indicated by the `"key"` member.
