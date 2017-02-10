This directory implements a data source based on a representation of volumes and (and optional
associated object surface meshes) as static collections of files served directly over HTTP; it
therefore can be used without any special serving infrastructure.  In particular, it can be used
with data hosted by a cloud storage provider like Google Cloud Storage or Amazon S3.  Note that it
is necessary, however, to either host the Neuroglancer client from the same server or enable CORS
access to the data.

Each (optionally multi-scale) volume is represented as a directory tree (served over HTTP) with the following contents:
- `info` file in JSON format specifying the metadata.
- One subdirectory with the same name as each scale `"key"` value specified in the `info` file.
  Each subdirectory contains a chunked representation of the data for a single resolution.
- One subdirectory with a name equal to the `"mesh"` key value in the `json` file (only if a
  `"mesh"` key is specified, and only for segmentation volumes).  This subdirectory contains
  metadata and triangular mesh representations of the surfaces of objects in the volume.
  
Within neuroglancer, a precomputed data source is specified using a URL of the form:
`precomputed://https://host/path/to/root/directory`.  If the data is being served from Google Cloud
Storage (GCS), `precomputed://gs://bucket/path/to/root/directory` may be used as an alias for
`precomputed://https://storage.googleapis.com/bucket/path/to/root/directory`.
  
# `info` JSON file specification

The root value must be an object with the following keys:
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
    volume at this scale.
  - `"size"`: 3-element array `[x, y, z]` of integers specifying the x, y, and z dimensions of the
    volume in voxels.
  - `"resolution"`: 3-element array `[x, y, z]` of numeric values specifying the x, y, and z
    dimensions of a voxel in nanometers.  The x, y, and z `"resolution"` values must not decrease as
    the index into the `"scales"` array increases.
  - `"voxel_offset"`: 3-element array `[x, y, z]` of integer values specifying a translation in
    voxels of the origin of the data relative to the global coordinate frame.  Typically this is
    `[0, 0, 0]`.
  - `"chunk_sizes"`: Array of 3-element `[x, y, z]` arrays of integers specifying the x, y, and z
    dimensions in voxels of each supported chunk size.  Typically just a single chunk size will be
    specified as `[[x, y, z]]`.
  - `"encoding"`: A string value equal (case-insensitively) to the name of one of the supported
    `VolumeChunkEncoding` values specified in [base.ts](base.ts).  May be one of `"raw"`, `"jpeg"`,
    or `"compressed_segmentation"`.  These encodings are described below.
  - `"compressed_segmentation_block_size"`: This property must be specified if, and only if,
    `"encoding"` is `"compressed_segmentation"`.  If specified, it must be a 3-element `[x, y, z]`
    array of integers specifying the x, y, and z block size for the compressed segmentation
    encoding.
- `"mesh"`: May be optionally specified if `"volume_type"` is `"segmentation"`.  If specified, it
  must be a string value specifying the name of the subdirectory containing the mesh data.
  
# Chunked representation of volume data

For each scale and chunk size `chunk_size`, the volume (of voxel dimensions `size = [sx, sy, sz]`)
is divided into a grid of `grid_size = ceil(size / chunk_size)` chunks.  For each grid cell with
grid coordinates `g`, where `0 <= g < grid_size`, there is a file named
`"<xBegin>-<xEnd>_<yBegin>-<yEnd>_<zBegin>-<zEnd>"`, where:
- `<xBegin>`, `<yBegin>`, and `<zBegin>` are substituted with the base-10 string representations of
  the `x`, `y`, and `z` components of `begin_offset = voxel_offset + g * chunk_size`, respectively; and
- `<xEnd>`, `<yEnd>`, and `<zEnd>` are substituted with the base-10 string representations of the
  `x`, `y`, and `z` components of `end_offset = voxel_offset + min((g + 1) * chunk_size, size)`,
  respectively.

This file contains the encoded data for the subvolume `[begin_offset, end_offset)`.  The size of
each subvolume is at most `chunk_size` but may be truncated to fit within the dimensions of the
volume.  Each subvolume is conceptually a 4-dimensional `[x, y, z, channel]` array.

## Chunk encoding

The encoding of the subvolume data in each chunk file depends on the value of the `"encoding"`
property specified for the particular scale in the `info` JSON file.

### `"raw"` encoding

The subvolume data for the chunk is stored directly in little-endian binary format in `[x, y, z,
channel]` Fortran order (i.e. consecutive `x` values are contiguous) without any header.  For
example, if the chunk has dimensions `[32, 32, 32, 1]` and has `"data_type": "uint32"`, then the
chunk file should have a length of 131072 bytes.

### `"jpeg"` encoding

The subvolume data for the chunk is encoded as a 1- or 3-channel JPEG image.  To use this encoding,
the `"data_type"` must be `"uint8"` and `"num_channels"` must be 1 or 3.  Because of the lossiness
of JPEG compression, this encoding should not be used for `"segmentation"` volumes or `"image"`
volumes where it is important to retain the precise values.  The width and height of the JPEG image
may be arbitrary, provided that the total number of pixels is equal to the product of the x, y, and
z dimensions of the subvolume, and that the 1-D array obtained by concatenating the horizontal rows
of the image corresponds to the flattened `[x, y, z]` Fortran-order representation of the subvolume.

### `"compressed_segmentation"` encoding

The subvolume data for the chunk is encoded using the multi-channel
format [compressed segmentation format](/src/neuroglancer/sliceview/compressed_segmentation).  The
`"data_type"` must be either `"uint32"` or `"uint64"`.  The compression block size is specified by
the `"compressed_segmentation_block_size"` property in the `info` JSON file.

# Mesh representation of segmented object surfaces

If the `"mesh"` property is specified in the `info` JSON file for a `"segmentation"` volume, then a
triangular mesh representation of the surface of some or all segmented objects may be specified.
Each segmented object should correspond to a set of objects with the same non-zero integer label
value specified in the volume.  The surface mesh representation for a given segmented object may be
split into one or more separate fragments (e.g. corresponding to subvolumes).

Within the subdirectory specified by the `"mesh"` property, for each segmented object for which a
surface representation is available, there is a JSON-format metadata file named `<segment-id>:0`,
where `<segment-id>` is substituted with the base-10 string representation of the segment label
value.  This metadata file must contain an object with a `"fragments"` property specifying the
filenames (relative to the mesh subdirectory) containing the mesh data for each fragment.

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

