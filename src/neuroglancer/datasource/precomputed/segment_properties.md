# Segment property representation

A collection of property values may be associated with uint64 segment IDs (usually corresponding to
a segmentation volume, meshes, and/or skeletons).  Two forms of property mappings are supported:

1. *inline* properties, where the complete list of segment IDs and associated property values is
   stored inline within the single `info` JSON file;
2. *indexed* properties, where properties are stored in a separate file or files that support random
   access by segment ID.

The properties are represented by a directory containing at least a single `info` JSON file, and
additional files if there are any indexed properties.

## info JSON file format

The `info` file is JSON-formt text file.  The root value must be a JSON object with the following
members:

- `"@type"`: Must be `"neuroglancer_segment_properties"`.
- `'inline"`: Optional.  Specifies the inline properties and their values.  Object with the
  following members:
  - `"ids"`: Array of strings specifying the base-10 representation of the segment IDs for which
    inline property values are specified.
  - `"properties"`: Specifies the supported inline property types.  Array of objects, each with the following members:
    - `"id"`: Required.  String identifier to display in the UI.  (Not displayed if the `"type"` is
      `"label"` or `"description"`.)
    - `"description"`: Optional.  String description to display in the UI.
    - `"type"`: Required.  Must be one of `"label"`, `"description"`, `"string"`.  At most one
      property may have type `"label"` (which is displayed in the UI next to the segment ID), and at
      most one property may have type `"description"`.
    - `"values"`: Required.  Array of strings of length equal to the length of `ids` specifying the
      property value for each id.
- `"indexed"`: Optional.  Specifies the indexed property types.
  - `"sharding"`: Optional.  Optional.  If specified, must be a [sharding
    specification](./sharding.md#sharding-specification), and indicates that the [sharded uint64
    index format](./annotations.md#sharded-uint64-index) is used.  Otherwise, the [unsharded uint64 index
    format](./annotations.md#unsharded-uint64-index) is used.
  - `"properties"`: Specifies the supported indexed property types.  Array of objects, each with the following members:
    - `"id"`: Required.  String identifier to display in the UI.
    - `"description"`: Optional.  String description to display in the UI.
    - `"type"`: Required.  Must be `"string"`.

## Indexed property format

The indexed properties for a given segment ID are represented by a JSON object, where the member
names correspond to the `"id"` values in the `"properties"` array of the `"indexed"` object in the
`info` JSON file.

The JSON object for seach segment ID is serialized as a string and stored in either the [sharded
    uint64 index format](./annotations.md#sharded-uint64-index) or [unsharded uint64 index
    format](./annotations.md#unsharded-uint64-index).
