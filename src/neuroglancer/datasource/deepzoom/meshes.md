# Mesh representation of segmented object surfaces

If the `"mesh"` property is specified in the `info` JSON file for a `"segmentation"` volume, then a
triangular mesh representation of the surface of some or all segmented objects may be specified.
Each segmented object should correspond to a set of objects with the same non-zero integer label
value specified in the volume.

There are two supported mesh formats: a [multi-resolution mesh
format](#multi-resolution-mesh-format) in which each segmented object is represented at multiple
levels of detail using a octree decomposition, and a [legacy single-resolution
format](#legacy-single-resolution-mesh-format).

## Multi-resolution mesh format

The multi-resolution object surface meshes corresponding to a segmentation are represented as a
directory tree containing the following data:

- `info` file in JSON format specifying the
  [metadata](#multi-resolution-mesh-info-json-file-format).
- For each segment ID for which there is a mesh representation:
  - a ["manifest" file](#multi-resolution-mesh-manifest-file-format) that specifies the levels of
    detail and octree decomposition for the object;
  - a [mesh fragment data file](#multi-resolution-mesh-fragment-data-file-format) specifying an
    encoded mesh representation corresponding to each octree node.

The actual storage of the manifest and mesh fragment data depends on whether the unsharded or
[sharded](./sharded.md) format is used.

### Multi-resolution mesh info JSON file format

The `info` file is a JSON-format text file.  The root value must be a JSON object with the following
members:
- `"@type"`: Must be `"neuroglancer_multilod_draco"`.
- `"vertex_quantization_bits"`: Specifies the number of bits needed to represent each vertex
  position coordinate within a mesh fragment.  Must be `10` or `16`.
- `"transform"`: JSON array of 12 numbers specifying a 4x3 homogeneous coordinate transform from the
  "stored model" coordinate space to a "model" coordinate space.
- `"lod_scale_multiplier"`: Factor by which the `lod_scales` values in each `<segment-id>.index`
  file are multiplied.
- `"sharding"`: If specified, indicates that the mesh is stored using the [sharded
    format](./sharded.md).  Must be a [sharding specification](./sharded.md#sharding-specification).  If not
    specified, the unsharded storage representation is used.
- `"segment_properties"`: Optional.  If specified, it must be a string value specifying the name of
  the subdirectory containing a [segment properties](./segment_properties.md) representation.  Note
  that Neuroglancer only uses these segment properties if this mesh source is specified as a data
  source directly.  If it is specified indirectly via the `"mesh"` property in a [multi-scale
  volume](./volume.md), then you must instead specify the properties using use the
  `"segment_properties"` member in the volume's `info` file.

### Multi-resolution mesh manifest file format

For each segment ID for which there is a mesh representation, there is a binary "manifest" file in
the following format:

- `chunk_shape`: 3x float32le, specifies the `x`, `y`, and `z` extents of finest octree node in the
  "stored model" coordinate space.
- `grid_origin`: 3x float32le, specifies the `x`, `y`, and `z` origin of the octree decomposition in
  the "stored model" coordinate space.
- `num_lods`: uint32le, specifies the number of levels of detail.
- `lod_scales`: `num_lods` float32le, specifies the scale in "stored model" spatial units
  corresponding to each level of detail.  Each scale value is multiplied by the
  `lod_scale_multiplier` value from the `info` JSON file.
- `vertex_offsets`: `num_lods*3` float32le, as a C order `[num_lods, 3]` array specifying an
  offset (in the "stored model" coordinate space) to add to vertex positions for each level of
  detail.
- `num_fragments_per_lod`: `num_lods` uint32le, specifies the number of fragments (octree nodes) for
  each level of detail.
- For each `lod` in the range `[0, num_lods)`:
  - `fragment_positions`: `num_fragments_per_lod[lod]*3` uint32le, C order `[3,
    numFragments_per_lod[lod]]` array specifying the `x`, `y`, and `z` coordinates of the octree
    nodes for the given `lod`.  The node positions must be in `x`, `y`, `z` Z-curve order.  The node
    corresponds to the axis-aligned bounding box within the "stored model" coordinate space with an
    origin of: `grid_origin + [x, y, z] * chunk_shape * (2**lod)` and a shape of `chunk_shape *
    (2**lod)`.
  - `fragment_offsets`: `num_fragments_per_lod[lod]` uint32le, specifies the size in bytes of the
    encoded mesh fragment in the [mesh fragment data
    file](#multi-resolution-mesh-fragment-data-file-format) corresponding to each octree node in the
    `fragment_positions` array.  The starting offset of the encoded mesh data corresponding to a
    given octree node is equal to the sum of all prior `fragment_offsets` values.
    
#### Unsharded storage of multi-resolution mesh manifest
    
If the unsharded format is used, the manifest for each segment is stored as a separate file within
the same directory as the `info` file under the name `<segment-id>.index`, where `<segment-id>` is
the base-10 string representation of the segment ID.

#### Sharded storage of multi-resolution mesh manifest

If the [sharded format](./sharded.md#sharded-format) is used, the manifest for each segment is retrieved using
the segment ID as the key.  The shard files are stored in the same directory as the `info` file.

### Multi-resolution mesh fragment data file format

The mesh fragment data files consist of the concatenation of the encoded mesh data for all octree
nodes specified in the manifest file, in the same order the nodes are specified in the index file,
starting with `lod` 0.  Each mesh fragment is a [Draco](https://google.github.io/draco/)-encoded
triangular mesh with a 3-component integer vertex position attribute.  Each position component `j`
must be a value `x` in the range `[0, 2**vertex_quantization_bits)`, which corresponds to a "stored
model" coordinate of:

```
grid_origin[j] +
vertex_offsets[lod,j] +
chunk_shape[j] * (2**lod) * (fragmentPosition[j] +
                             x / ((2**vertex_quantization_bits)-1))
```

The built-in Draco attribute quantization is not supported.

Each mesh fragment for `lod > 0` must be partitioned by a `2x2x2` grid such that no triangle crosses
a grid boundary (but may be incident to a grid boundary).

#### Unsharded storage of multi-resolution mesh fragment data

If the unsharded format is used, the mesh mesh fragment data file is stored as a separate file
within the same directory as the `info` file under the name `<segment-id>`, where `<segment-id>` is
the base-10 string representation of the segment ID.  The HTTP server must support HTTP `Range`
requests for these files in order to allow individual fragment meshes to be retrieved.

#### Sharded storage of multi-resolution mesh fragment data

If the [sharded format](./sharded.md#sharded-format) is used, the mesh fragment data file is located immediately
before the manifest file in the same shard data file.  The starting offset within that shard data
file is not specified explicitly but may be computed from the starting offset of the manifest file
and the sum of the mesh fragment sizes specified in the manifest.

## Legacy single-resolution mesh format

In addition to the multi-resolution mesh format, an older single-resolution mesh format is also
supported.  This format is specified by either the absence of an `info` file in the mesh
subdirectory or an `info` file containing a JSON object with the following members:
- `"@type"`: Must be `"neuroglancer_legacy_mesh"`.

To specify a legacy single-resolution mesh dataset that lacks an `info` file as a Neuroglancer data
source, use the data source URL syntax `precomputed://FILE_URL#type=mesh`, where `FILE_URL` is the
URL to the directory containing the mesh data using any [supported file
protocol](../file_protocols.md).

The surface mesh representation for a given segmented object may be split into one or more separate
fragments (e.g. corresponding to subvolumes).

Within the mesh subdirectory, for each segmented object for which a surface representation is
available, there is a JSON-format metadata file named `<segment-id>:0`, where `<segment-id>` is
substituted with the base-10 string representation of the segment label value.  This metadata file
must contain an object with a `"fragments"` property specifying the filenames (relative to the mesh
subdirectory) containing the mesh data for each fragment.

This legacy mesh format does not support a [sharded storage representation](./sharded.md#sharded-format).

Each fragment file is specified in the following binary format:
- The file begins with a little-endian 32-bit unsigned integer `num_vertices` specifying the number
  of vertices.
- The `[x, y, z]` vertex positions (as nanometer offsets within the global coordinate frame) are
  stored as little-endian single precision/binary32 floating point values starting at an offset of
  `4` bytes from the start of the file (immediately after the `num_vertices` value) and ending at a
  byte offset of `4 + 4 * 3 * num_vertices`.  The x, y, and z components of the vertex positions are
  interleaved, i.e. `[x0, y0, z0, x1, y1, z1, ...]`.
- The number of triangles is inferred as the number of remaining bytes in the file after the vertex
  position data divided by 12 (the number of remaining bytes must be a multiple of 12).  The
  triangles are specified as an array of interleaved triplets `[a, b, c]` of vertex indices.  The
  vertex indices are encoded as little-endian 32-bit unsigned integers.
