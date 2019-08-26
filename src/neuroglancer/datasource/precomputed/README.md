This directory implements a data source based on a representation of volumes and (and optional
associated object surface meshes and/or skeleton representations) as static collections of files
served directly over HTTP; it therefore can be used without any special serving infrastructure.  In
particular, it can be used with data hosted by a cloud storage provider like Google Cloud Storage or
Amazon S3.  Note that it is necessary, however, to either host the Neuroglancer client from the same
server or enable CORS access to the data.

Each (optionally multi-scale) volume is represented as a directory tree (served over HTTP) with the following contents:
- `info` file in JSON format specifying the [metadata](#info-json-file-specification).
- One subdirectory with the same name as each scale `"key"` value specified in the `info` file.
  Each subdirectory contains a chunked representation of the data for a single resolution.
- One subdirectory with a name equal to the `"mesh"` key value in the `json` file (only if a
  `"mesh"` key is specified, and only for segmentation volumes).  This subdirectory contains
  [metadata and triangular mesh representations](#mesh-representation-of-segmented-object-surfaces)
  of the surfaces of objects in the volume.
- One subdirectory with a name equal to the `"skeletons"` key value in the `json` file (only if a
  `"skeletons"` key is specified, and only for segmentation volumes).  This subdirectory contains
  [skeleton representations](#skeleton-representation-of-segmented-objects) of objects in the volume.
  
Within neuroglancer, a precomputed data source is specified using a URL of the form:
`precomputed://https://host/path/to/root/directory`.  If the data is being served from Google Cloud
Storage (GCS), `precomputed://gs://bucket/path/to/root/directory` may be used as an alias for
`precomputed://https://storage.googleapis.com/bucket/path/to/root/directory`.

# info JSON file specification

The root value must be a JSON object with the following members:
- `"@type"`: If specified, must be `"neuroglancer_multiscale_volume"`.  This optional property
  permits automatically detecting paths to volumes, meshes, and skeletons.
- `"type"`: One of `"image"` or `"segmentation"`, specifying the type of the volume.
- `"data_type"`: A string value equal (case-insensitively) to the name of one of the supported
  `DataType` values specified in [data_type.ts](/src/neuroglancer/util/data_type.ts).  May be one of
  `"uint8"`, `"uint16"`, `"uint32"`, `"uint64"`, or `"float32"`.  `"float32"` should only be specified
  for `"image"` volumes.
- `"num_channels"`: An integer value specifying the number of channels in the volume.  Must be `1`
  for `"segmentation"` volumes.
- `"scales"`: Array specifying information about the supported resolutions (downsampling scales) of
  the volume.  Each element of the array is an object with the following keys:
  - `"key"`: String value specifying the subdirectory containing the chunked representation of the
    volume at this scale.  May also be a relative path `"/"`-separated path, optionally containing
    `".."` components, which is interpreted relative to the parent directory of the `"info"` file.
  - `"size"`: 3-element array `[x, y, z]` of integers specifying the x, y, and z dimensions of the
    volume in voxels.
  - `"resolution"`: 3-element array `[x, y, z]` of numeric values specifying the x, y, and z
    dimensions of a voxel in nanometers.  The x, y, and z `"resolution"` values must not decrease as
    the index into the `"scales"` array increases.
  - `"voxel_offset"`: Optional.  If specified, must be a 3-element array `[x, y, z]` of integer
    values specifying a translation in voxels of the origin of the data relative to the global
    coordinate frame.  If not specified, defaults to `[0, 0, 0]`.
  - `"chunk_sizes"`: Array of 3-element `[x, y, z]` arrays of integers specifying the x, y, and z
    dimensions in voxels of each supported chunk size.  Typically just a single chunk size will be
    specified as `[[x, y, z]]`.
  - `"encoding"`: Specifies the [encoding of the chunk data](#chunk-encoding).  Must be a string
    value equal (case-insensitively) to the name of one of the supported `VolumeChunkEncoding`
    values specified in [base.ts](base.ts).  May be one of [`"raw"`](#raw-chunk-encoding),
    [`"jpeg"`](#jpeg-chunk-encoding), or
    [`"compressed_segmentation"`](#compressed_segmentation-chunk-encoding).
  - `"compressed_segmentation_block_size"`: This property must be specified if, and only if,
    `"encoding"` is `"compressed_segmentation"`.  If specified, it must be a 3-element `[x, y, z]`
    array of integers specifying the x, y, and z block size for the compressed segmentation
    encoding.
  - `"sharding"`: If specified, indicates that volumetric chunk data is stored using the [sharded
    format](#sharded-chunk-storage).  Must be a [sharding specification](#sharding-specification).
    If the sharded format is used, the `"chunk_sizes"` member must specify only a single chunk size.
    If unspecified, the [unsharded format](#unsharded-chunk-storage) is used.
- `"mesh"`: May be optionally specified if `"volume_type"` is `"segmentation"`.  If specified, it
  must be a string value specifying the name of the subdirectory containing the [mesh
  data](#mesh-representation-of-segmented-object-surfaces).
- `"skeletons"`: May be optionally specified if `"volume_type"` is `"segmentation"`.  If specified,
  it must be a string value specifying the name of the subdirectory containing the skeleton data.

# Chunked representation of volume data

For each scale and chunk size `chunk_size`, the volume (of voxel dimensions `size = [sx, sy, sz]`)
is divided into a grid of `grid_size = ceil(size / chunk_size)` chunks.

The grid cell with grid coordinates `g`, where `0 <= g < grid_size`, contains the [encoded
data](#chunk-encoding) for the voxel-space subvolume `[begin_offset, end_offset)`, where
`begin_offset = voxel_offset + g * chunk_size` and `end_offset = voxel_offset + min((g + 1) *
chunk_size, size)`.  Thus, the size of each subvolume is at most `chunk_size` but may be truncated
to fit within the dimensions of the volume.  Each subvolume is conceptually a 4-dimensional `[x, y,
z, channel]` array.

## Unsharded chunk storage

If the unsharded format is used, each chunk is stored as a separate file within the path specified
by the `"key"` property with the name `"<xBegin>-<xEnd>_<yBegin>-<yEnd>_<zBegin>-<zEnd>"`, where:
- `<xBegin>`, `<yBegin>`, and `<zBegin>` are substituted with the base-10 string representations of
  the `x`, `y`, and `z` components of `begin_offset`, respectively; and
- `<xEnd>`, `<yEnd>`, and `<zEnd>` are substituted with the base-10 string representations of the
  `x`, `y`, and `z` components of `end_offset`, respectively.
  
## Sharded chunk storage
  
If the [sharded format](#sharded-format) is used, the sharded representation of the chunk data is
stored within the directory specified by the `"key"` property.  Each chunk is identified by a uint64
chunk identifier, equal to the "compressed Morton code" of the grid cell coordinates, which is used
as a key to retrieve the encoded chunk data from sharded representation.

### Compresed morton code

The "compressed Morton code" is a variant of the normal [Morton
code](https://en.wikipedia.org/wiki/Z-order_curve) where bits that would be equal to 0 for all grid
cells are skipped.  Specifically, given the coordinates `g` for a grid cell, where `0 <= g <
grid_size`, the compressed Morton code is computed as follows:
1. Set `j := 0`.
2. For `i` from `0` to `n-1`, where `n` is the number of bits needed to encode the grid cell
   coordinates:
   - For `dim` in `0, 1, 2` (corresponding to `x`, `y`, `z`):
     - If `2**i <= grid_size[dim]`:
       - Set output bit `j` of the compressed Morton code to bit `i` of `g[dim]`.
       - Set `j := j + 1`.
       
## Chunk encoding

The encoding of the subvolume data in each chunk file depends on the value of the `"encoding"`
property specified for the particular scale in the `info` JSON file.

### raw chunk encoding

The subvolume data for the chunk is stored directly in little-endian binary format in `[x, y, z,
channel]` Fortran order (i.e. consecutive `x` values are contiguous) without any header.  For
example, if the chunk has dimensions `[32, 32, 32, 1]` and has `"data_type": "uint32"`, then the
chunk file should have a length of 131072 bytes.

### jpeg chunk encoding

The subvolume data for the chunk is encoded as a 1- or 3-channel JPEG image.  To use this encoding,
the `"data_type"` must be `"uint8"` and `"num_channels"` must be 1 or 3.  Because of the lossiness
of JPEG compression, this encoding should not be used for `"segmentation"` volumes or `"image"`
volumes where it is important to retain the precise values.  The width and height of the JPEG image
may be arbitrary, provided that the total number of pixels is equal to the product of the x, y, and
z dimensions of the subvolume, and that the 1-D array obtained by concatenating the horizontal rows
of the image corresponds to the flattened `[x, y, z]` Fortran-order representation of the subvolume.

### compressed_segmentation chunk encoding

The subvolume data for the chunk is encoded using the multi-channel
format [compressed segmentation format](/src/neuroglancer/sliceview/compressed_segmentation).  The
`"data_type"` must be either `"uint32"` or `"uint64"`.  The compression block size is specified by
the `"compressed_segmentation_block_size"` property in the `info` JSON file.

# Mesh representation of segmented object surfaces

If the `"mesh"` property is specified in the `info` JSON file for a `"segmentation"` volume, then a
triangular mesh representation of the surface of some or all segmented objects may be specified.
Each segmented object should correspond to a set of objects with the same non-zero integer label
value specified in the volume.

There are two support mesh formats: a [multi-resolution mesh format](#multi-resolution-mesh-format)
in which each segmented object is represented at multiple levels of detail using a octree
decomposition, and a [legacy single-resolution format](#legacy-single-resolution-mesh-format).

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
[sharded](#sharded-format) format is used.

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
    format](#sharded-format).  Must be a [sharding specification](#sharding-specification).  If not
    specified, the unsharded storage representation is used.

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
- `vertex_offsets`: `num_lods*3` float32le, as a C order `[vertex_offsets, 3]` array specifying an
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
  - `fragment_offfsets`: ``num_fragments_per_lod[lod]` uint32le, specifies the size in bytes of the
    encoded mesh fragment in the [mesh fragment data
    file](#multi-resolution-mesh-fragment-data-file-format) corresponding to each octree node in the
    `fragment_positions` array.  The starting offset of the encoded mesh data corresponding to a
    given octree node is equal to the sum of all prior `fragment_positions` values.
    
#### Unsharded storage of multi-resolution mesh manifest
    
If the unsharded format is used, the manifest for each segment is stored as a separate file within
the same directory as the `info` file under the name `<segment-id>.index`, where `<segment-id>` is
the base-10 string representation of the segment ID.

#### Sharded storage of multi-resolution mesh manifest

If the [sharded format](#sharded-format) is used, the manifest for each segment is retrieved using
the segment ID as the key.  The shard files are stored in the same directory as the `info` file.

### Multi-resolution mesh fragment data file format

The mesh fragment data files consist of the concatenation of the encoded mesh data for all octree
nodes specified in the manifest file, in the same order the nodes are specified in the index file,
starting with `lod` 0.  Each mesh fragment is a [Draco](https://google.github.io/draco/)-encoded
triangular mesh with a 3-component integer vertex position attribute.  Each position component `j`
must be in the range `[0, 2**vertex_quantization_bits)`, where a value of `x` corresponds to
`grid_origin[i] + (fragmentPosition[i] + x / (2**vertex_quantization_bits-1) * (2**lod)`.  The
built-in Draco attribute quantization is not supported.

Each mesh fragment for `lod > 0` must be partitioned by a `2x2x2` grid such that no triangle crosses
a grid boundary (but may be incident to a grid boundary).

#### Unsharded storage of multi-resolution mesh fragment data

If the unsharded format is used, the mesh mesh fragment data file is stored as a separate file
within the same directory as the `info` file under the name `<segment-id>`, where `<segment-id>` is
the base-10 string representation of the segment ID.  The HTTP server must support HTTP `Range`
requests for these files in order to allow individual fragment meshes to be retrieved.

#### Sharded storage of multi-resolution mesh fragment data

If the [sharded format](#sharded-format) is used, the mesh fragment data file is located immediately
before the manifest file in the same shard data file.  The starting offset within that shard data
file is not specified explicitly but may be computed from the starting offset of the manifest file
and the sum of the mesh fragment sizes specified in the manifest.

## Legacy single-resolution mesh format

In addition to the multi-resolution mesh format, an older single-resolution mesh format is also
supported.

The surface mesh representation for a given segmented object may be split into one or more separate
fragments (e.g. corresponding to subvolumes).

Within the mesh subdirectory, for each segmented object for which a surface representation is
available, there is a JSON-format metadata file named `<segment-id>:0`, where `<segment-id>` is
substituted with the base-10 string representation of the segment label value.  This metadata file
must contain an object with a `"fragments"` property specifying the filenames (relative to the mesh
subdirectory) containing the mesh data for each fragment.

This legacy mesh format does not support a [sharded storage representation](#sharded-format).

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

# Skeleton representation of segmented objects

A skeleton representation of some or all segmented objects may be specified as a directory tree
consisting of the following files:

- `info` file in JSON format specifying the [metadata](#skeleton-info-json-file-format).
- For each segment ID for which there is a skeleton representation, a segment data file specifying
  the [encoded skeleton](#encoded-skeleton-file-format) for a single segment.

The actual storage of the manifest and mesh fragment data depends on whether the unsharded or
[sharded](#sharded-format) format is used.

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
    format](#sharded-format).  Must be a [sharding specification](#sharding-specification).  If not
    specified, the unsharded storage representation is used.

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

If the [sharded format](#sharded-format) is used, the encoded skeleton data is retrieved using the
segment ID as the key.  The shard files are stored in the same directory as the `info` file.

# Sharded format

The unsharded [multiscale volume](#unsharded-chunk-storage),
[mesh](#unsharded-storage-of-multi-resolution-mesh-manifest) and [skeleton
formats](#unsharded-storage-of-encoded-skeleton-data) store each volumetric chunk or per-object
mesh/skeleton in a separate file; in general a single file corresponds to a single unit of data that
Neuroglancer may retrieve.  Separate files are simple to read and write; however, if there are a
large number of chunks, the resulting large number of small files can be highly inefficient with
storage systems that have a high per-file overhead, as is common in many distributed storage
systems.  The "sharded" format avoids that problem by combining all "chunks" into a fixed number of
larger "shard" files.  There are several downsides to the sharded format, however:
- It requires greater complexity in the generation pipeline.
- It is not possible to re-write the data for individual chunks; the entire shard must be
  re-written.
- There is somewhat higher read latency due to the need to retrieve additional index information
  before retrieving the actual chunk data, although this latency is partially mitigated by
  client-side caching of the index data in Neuroglancer.

The sharded format uses a two-level index hierarchy:
- There are a fixed number of shards, and a fixed number of minishards within each shard.
- Each chunk, identified by a uint64 identifier, is mapped via a hash function to a particular shard
  and minishard.  In the case of meshes and skeletons, the chunk identifier is simply the segment
  ID.  In the case of volumetric data, the chunk identifier is the [compressed Morton
  code](#compressed-morton-code).
- A fixed size "shard index" stored at the start of each shard file specifies for each minishard the
  start and end offsets within the shard file of the corresponding "minishard index".
- The variable-size "minishard index" specifies the list of chunk ids present in the minishard and
  the corresponding start and end offsets of the data within the shard file.

The sharded format requires that the HTTP server support HTTP `Range` requests.

## Sharding specification

The sharding format is specified by a *sharding specification* in the form of a `"sharding"` JSON
member whose value is a JSON object with the following members:
- `"@type"`: Must be `"neuroglancer_uint64_sharded_v1"`.
- `"preshift_bits"`: Specifies the number of low-order bits of the chunk ID that do not contribute
  to the hashed chunk ID.  The hashed chunk ID is computed as `hash(chunk_id >>
  preshift_bits)`.
- `"hash"`: Specifies the hash function used to map chunk IDs to shards.  Must be one of:
  - `"identity"`: The identity function.
  - `"murmurhash3_x86_128"`: The MurmurHash3_x86_128 hash function applied to the shifted chunk ID
    in little endian encoding.  The low 8 bytes of the resultant hash code are treated as a little
    endian 64-bit number.
- `"minishard_bits"`: Specifies the number of bits of the hashed chunk ID that determine the
  minishard number.  The number of minishards within each shard is equal to `2**minishard_bits`.
  The minishard number is equal to bits `[0, minishard_bits)` of the hashed chunk id.
- `"shard_bits"`: Specifies the number of bits of the hashed chunk ID that determine the shard
  number.  The number of shards is equal to `2**shard_bits`.  The shard number is equal to bits
  `[minishard_bits, minishard_bits+shard_bits)` of the hashed chunk ID.
- `"minishard_index_encoding"`: Specifies the encoding of the "minishard index".  If specified, must
  be `"raw"` (to indicate no compression) or `"gzip"` (to indicate gzip compression).  If not
  specified, equivalent to `"raw"`.
- `"data_encoding"`: Specifies the encoding of the actual chunk data, in the same way as
  `"minishard_index_encoding"`.  In the case of multiscale meshes, this encoding applies to the
  manifests but not to the mesh fragment data.

For each shard number in the range `[0, 2**shard_bits)`, there is a `<shard>.shard` file, where
`<shard>` is the lowercase base-16 shard number zero padded to `ceil(shard_bits/4)` digits.

Note that there was an earlier (obselete) version of the sharded format, which also used the same
`"neuroglancer_uint64_sharded_v1"` identifier.  The earlier format differed only in that there was a
separate `<shard>.index` file (containing the "shard index") and a `<shard>.data` file (containing
the remaining data) in place of the single `<shard>.shard` file of the current format; the
`<shard>.shard` file is equivalent to the concatenation of the `<shard>.index` and `<shard>.data`
files of the earlier version.

## Shard index format

The first `2**minishard_bits * 16` bytes of each shard file is the "shard index" consisting of
`2**minishard_bits` entries of the form:
- `start_offset`: uint64le, specifies the inclusive start byte offset of the "minishard index" in
  the shard file.
- `end_offset`: uint64le, specifies the exclusive end byte offset of the "minishard index" in the
  shard file.
  
Both the `start_offset` and `end_offset` are relative to the end of the "shard index",
i.e. `shard_index_end = 2**minishard_bits * 16` bytes.

That is, the encoded "minishard index" for a given minishard is stored in the byte range
`[shard_index_end + start_offset, shard_index_end + end_offset)` of the shard file.  A zero-length
byte range indicates that there are no chunk IDs in the minishard.

## Minishard index format

The "minishard index" stored in the shard file is encoded according to the
`minishard_index_encoding` metadata value.  The decoded "minishard index" is a binary string of
`24*n` bytes, specifying a contiguous C-order `array` of `[3, n]` uint64le values.  Values `array[0,
0], ..., array[0, n-1]` specify the chunk IDs in the minishard, and are delta encoded, such that
`array[0, 0]` is equal to the ID of the first chunk, and the ID of chunk `i` is equal to the sum of
`array[0, 0], ..., array[0, i]`.  The size of the data for chunk `i` is stored as `array[2, i]`.
Values `array[1, 0], ..., array[1, n-1]` specify the starting offsets in the shard file of the data
corresponding to each chunk, and are also delta encoded relative to the *end* of the prior chunk,
such that the starting offset of the first chunk is equal to `shard_index_end + array[1, 0]`, and
the starting offset of chunk `i` is the sum of `shard_index_end + array[1, 0], ..., array[1, i]` and
`array[2, 0], ..., array[2, i-1]`.

The start and size values in the minishard index specify the location in the shard file of the chunk
data, which is encoded according to the `data_encoding` metadata value.
  
# HTTP Content-Encoding

The normal HTTP `Content-Encoding` mechanism may be used by the HTTP server to transmit data in
compressed form; this is particularly useful for the JSON metadata files, unsharded `"raw"` or
`"compressed_segmentation"` chunk data, unsharded skeleton data, and unsharded mesh manifests, which
are likely to benefit from compression and do not support other forms of compression.  Some HTTP
servers can perform this compression on the fly, while others, like Google Cloud Storage, require
that the data be compressed ahead of time.  Note that with Google Cloud Storage (and any other
system that requires ahead-of-time compression), the use of `Content-Encoding` is not compatible
with HTTP `Range` requests that are needed for the sharded index and data files and unsharded
multi-scale mesh fragment data files; therefore, ahead-of-time compression should not be used on
such files.

# Example `info` files

```json
{"data_type": "uint8",
 "num_channels": 1,
 "scales": [{"chunk_sizes": [[64, 64, 64]],
   "encoding": "jpeg",
   "key": "8_8_8",
   "resolution": [8, 8, 8],
   "size": [6446, 6643, 8090],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "encoding": "jpeg",
   "key": "16_16_16",
   "resolution": [16, 16, 16],
   "size": [3223, 3321, 4045],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "encoding": "jpeg",
   "key": "32_32_32",
   "resolution": [32, 32, 32],
   "size": [1611, 1660, 2022],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "encoding": "jpeg",
   "key": "64_64_64",
   "resolution": [64, 64, 64],
   "size": [805, 830, 1011],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "encoding": "jpeg",
   "key": "128_128_128",
   "resolution": [128, 128, 128],
   "size": [402, 415, 505],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "encoding": "jpeg",
   "key": "256_256_256",
   "resolution": [256, 256, 256],
   "size": [201, 207, 252],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "encoding": "jpeg",
   "key": "512_512_512",
   "resolution": [512, 512, 512],
   "size": [100, 103, 126],
   "voxel_offset": [0, 0, 0]}],
 "type": "image"}
```

```json
{"data_type": "uint64",
 "mesh": "mesh",
 "num_channels": 1,
 "scales": [{"chunk_sizes": [[64, 64, 64]],
   "compressed_segmentation_block_size": [8, 8, 8],
   "encoding": "compressed_segmentation",
   "key": "8_8_8",
   "resolution": [8, 8, 8],
   "size": [6446, 6643, 8090],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "compressed_segmentation_block_size": [8, 8, 8],
   "encoding": "compressed_segmentation",
   "key": "16_16_16",
   "resolution": [16, 16, 16],
   "size": [3223, 3321, 4045],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "compressed_segmentation_block_size": [8, 8, 8],
   "encoding": "compressed_segmentation",
   "key": "32_32_32",
   "resolution": [32, 32, 32],
   "size": [1611, 1660, 2022],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "compressed_segmentation_block_size": [8, 8, 8],
   "encoding": "compressed_segmentation",
   "key": "64_64_64",
   "resolution": [64, 64, 64],
   "size": [805, 830, 1011],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "compressed_segmentation_block_size": [8, 8, 8],
   "encoding": "compressed_segmentation",
   "key": "128_128_128",
   "resolution": [128, 128, 128],
   "size": [402, 415, 505],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "compressed_segmentation_block_size": [8, 8, 8],
   "encoding": "compressed_segmentation",
   "key": "256_256_256",
   "resolution": [256, 256, 256],
   "size": [201, 207, 252],
   "voxel_offset": [0, 0, 0]},
  {"chunk_sizes": [[64, 64, 64]],
   "compressed_segmentation_block_size": [8, 8, 8],
   "encoding": "compressed_segmentation",
   "key": "512_512_512",
   "resolution": [512, 512, 512],
   "size": [100, 103, 126],
   "voxel_offset": [0, 0, 0]}],
 "type": "segmentation"}
```
