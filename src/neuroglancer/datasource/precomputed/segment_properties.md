# Segment property representation

A collection of property values may be associated with uint64 segment IDs (usually corresponding to
a segmentation volume, meshes, and/or skeletons).

Currently only *inline* properties are supported, where the complete list of segment IDs and
associated property values is stored inline within the single `info` JSON file.

The properties are represented by a directory containing at least a single `info` JSON file.

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
    - `"type"`: Required.  Must be one of `"label"`, `"description"`, `"string"`, `"tags"`,
      `"number"`.  At most one property may have type `"label"` (which is displayed in the UI next
      to the segment ID), at most one property may have type `"description"`, and at most one
      property may have type `"tags"`.
    - `"description"`: Optional.  String description of the property to display in the UI.  Must not
      be present if `"type"` is equal to `"tags"`.
    - `"tags`": Must be present if `"type"` is equal to `"tags"`, otherwise must not be present.  An
      array of strings specifying the valid tag values.  The strings should *not* include an initial
      `"#"` character, and should not contain spaces.  Tags are matched case-insensitively.
    - `"tag_descriptions`": May be present if `"type"` is equal to `"tags"`, otherwise must not be
      present.  An array of strings, of the same length as the `"tags"` array, specifying a longer
      description corresponding to each tag value.
    - `"data_type"`: Must be present if `"type"` is equal to `"number"`.  One of `"uint8"`,
      `"int8"`, `"uint16"`, `"int16"`, `"uint32"`, `"int32"`, `"float32"`.
    - `"values"`: Required.  Array of length equal to the length of `ids` specifying the property
      value for each id.  If `"type"` is equal to `"label"`, `"description"`, or `"string"`, each
      element must be a string.  If `"type"` is equal to `"number"`, each element must be a number
      that will be converted to the specified `"data_type"`.  If `"type"` is equal to `"tags"`, each
      *element* must be an array of integers (in increasing order), where each number specifies an
      index into the `"tags"` array.
