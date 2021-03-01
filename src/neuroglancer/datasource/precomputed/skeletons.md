# Skeleton representation of segmented objects

A skeleton representation of some or all segmented objects may be specified as a directory tree
consisting of the following files:

- `info` file in JSON format specifying the [metadata](#skeleton-info-json-file-format).
- For each segment ID for which there is a skeleton representation, a segment data file specifying
  the [encoded skeleton](#encoded-skeleton-file-format) for a single segment.

The actual storage of the manifest and mesh fragment data depends on whether the unsharded or
[sharded](./sharded.md) format is used.

## Skeleton info JSON file format

The `info` file is a JSON-format text file.  The root value must be a JSON object with the following
members:
- `"@type"`: Must be `"neuroglancer_skeletons"`.
- `"transform"`: JSON array of 12 numbers specifying a 4x3 homogeneous coordinate transform from the
  "stored model" coordinate space to a "model" coordinate space.  The "stored model" coordinate
  space is arbitrary.  The "model" coordinate space should be in nanometers.  If using a `"radius"`
  attribute, the scaling applied by `"transform"` should be uniform.
- `"vertex_attributes"`: JSON array specifying additional per-vertex attributes, where each array
  element is a JSON object with the following members:
  - `"id"`: Attribute identifier, must be a unique, non-empty JSON string.
  - `"data_type"`: JSON string specifying the data type, must be one of `"float32"`, `"int8"`,
    `"uint8"`, `"int16"`, `"uint16"`, `"int32"`, `"uint32"`.
  - `"num_components"`: JSON number specifying the number of components per vertex.
- `"sharding"`: If specified, indicates that the mesh is stored using the [sharded
    format](./sharded.md).  Must be a [sharding specification](./sharded.md#sharding-specification).  If not
    specified, the unsharded storage representation is used.
- `"segment_properties"`: Optional.  If specified, it must be a string value specifying the name of
  the subdirectory containing a [segment properties](./segment_properties.md) representation.  Note
  that Neuroglancer only uses these segment properties if this skeleton source is specified as a
  data source directly.  If it is specified indirectly via the `"skeletons"` property in a
  [multi-scale volume](./volume.md), then you must instead specify the properties using use the
  `"segment_properties"` member in the volume's `info` file.

The special vertex attribute id of `"radius"` may be used to indicate the radius in "stored model"
units; it should have a `"data_type"` of `"float32"` and `"num_components"` of 1.

## Encoded skeleton file format

The skeleton representation for a single segment ID is a binary file with the following format:

- `num_vertices`: uint32le, specifies the number of vertices.
- `num_edges`: uint32le, specifies the number of edges.
- `vertex_positions`: `3*num_vertices` float32le, as a C-order `[num_vertices, 3]` array specifying
  the `x`, `y`, and `z` vertex positions in "stored model" coordinates.
- `edges`: `2*num_edges` uint32le, as a C-order `[num_edges, 2]` array specifying the source and
  target vertex index in the range `[0, num_vertices)`.
- For each additional attribute in `vertex_attributes`:
  - `attribute_data`: `num_vertices * num_components` elements of the specified `data_type` in
    little-endian format.

### Unsharded storage of encoded skeleton data

If the unsharded format is used, the encoded skeleton data is stored as a separate file within the
same directory as the `info` file under the name `<segment-id>`, where `<segment-id>` is the base-10
segment ID.

### Sharded storage of encoded skeleton data

If the [sharded format](./sharded.md) is used, the encoded skeleton data is retrieved using the
segment ID as the key.  The shard files are stored in the same directory as the `info` file.
