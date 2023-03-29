Each (optionally multi-scale) volume is represented as a directory tree (served over HTTP) with the following contents:
- `info` file in JSON format specifying the [metadata](#info-json-file-specification).
- One subdirectory with the same name as each scale `"key"` value specified in the `info` file.
  Each subdirectory contains a chunked representation of the data for a single resolution.
- One subdirectory with a name equal to the `"mesh"` key value in the `json` file (only if a
  `"mesh"` key is specified, and only for segmentation volumes).  This subdirectory contains
  [metadata and triangular mesh representations](./meshes.md)
  of the surfaces of objects in the volume.
- One subdirectory with a name equal to the `"skeletons"` key value in the `json` file (only if a
  `"skeletons"` key is specified, and only for segmentation volumes).  This subdirectory contains
  [skeleton representations](./skeletons.md) of objects in the volume.

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
    format](#sharded-chunk-storage).  Must be a [sharding specification](./sharded.md#sharding-specification).
    If the sharded format is used, the `"chunk_sizes"` member must specify only a single chunk size.
    If unspecified, the [unsharded format](#unsharded-chunk-storage) is used.
- `"mesh"`: May be optionally specified if `"volume_type"` is `"segmentation"`.  If specified, it
  must be a string value specifying the name of the subdirectory containing the [mesh
  data](./meshes.md).
- `"skeletons"`: May be optionally specified if `"volume_type"` is `"segmentation"`.  If specified,
  it must be a string value specifying the name of the subdirectory containing the [skeleton data](./skeletons.md).
- `"segment_properties"`: May be optionally spsecified if `"volume_type"` is `"segmentation"`.  If
  specified, it must be a string value specifying the name of the subdirectory containing a
  [segment properties](./segment_properties.md) representation.

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
  
If the [sharded format](./sharded.md) is used, the sharded representation of the chunk data is
stored within the directory specified by the `"key"` property.  Each chunk is identified by a uint64
chunk identifier, equal to the "compressed Morton code" of the grid cell coordinates, which is used
as a key to retrieve the encoded chunk data from sharded representation.

### Compressed morton code

The "compressed Morton code" is a variant of the normal [Morton
code](https://en.wikipedia.org/wiki/Z-order_curve) where bits that would be equal to 0 for all grid
cells are skipped.  

Note that for a normal 3D morton code in a uint64, we could only allow 21 bits for each of
the three dimensions.

In the following, we list each potentially used bit with a hexadecimal letter,
so a 21-bit X coordinate would look like this:  
`x = ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---4 3210 fedc ba98 7654 3210`   
after spacing out by 2 to allow interleaved Y and Z bits, it becomes  
`x = ---4 --3- -2-- 1--0 --f- -e-- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0`

For standard morton code, we'd shift Y << 1 and Z << 2 then OR the three resulting uint64.
But most datasets aren't symmetrical in size across dimensions.

Using compressed 3D morton code lets us use bits asymmetrically and conserve bits where some
dimensions are smaller and those bits would always be zero.  Compressed morton code
drops the bits that would be zero across all entries because that dimension is limited in
size.  Say the X has max size 42,943 which requires only 16 bits (~64K) and would only use
up to the "f" bit in the above diagram.  The bits corresponding to the most-significant
`4`, `3`, `2`, `1`, and `0` bits would always be zero and therefore can be removed.

This allows us to fit more data into the single uint64, as the following example shows
with Z having a 24 bit range.

Start with a X coordinate that for this example has a max of 16 bits  
`x = ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- fedc ba98 7654 3210`  
after spacing, note MSB `f` only has room for the Z bit since Y has dropped out  
`x = ---- ---- ---- ---- ---f -e-- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0`

Start with a Y coordinate that for this example has a max of 14 bits  
`y = ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- --dc ba98 7654 3210`  
after spacing with constant 2 bits since Y has smallest range  
`y = ---- ---- ---- ---- ---- ---- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0`  
after shifting by 1 for future interleaving to get morton code  
`y = ---- ---- ---- ---- ---- ---d --c- -b-- a--9 --8- -7-- 6--5 --4- -3-- 2--1 --0-`

Start with a Z coordinate that for this example has a max of 24 bits  
`z = ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- 7654 3210 fedc ba98 7654 3210`  
after spacing out Z with 24 bits max; note compression of MSB due to X and Y dropout  
`z = ---- ---- ---- 7654 3210 f-e- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0`  
after shifting by 2 for future interleaving  
`z = ---- ---- --76 5432 10f- e-d- -c-- b--a --9- -8-- 7--6 --5- -4-- 3--2 --1- -0--`

Now if you OR the final X, Y, and Z you see no collisions.
```
x = ---- ---- ---- ---- ---f -e-- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0
y = ---- ---- ---- ---- ---- ---d --c- -b-- a--9 --8- -7-- 6--5 --4- -3-- 2--1 --0-
z = ---- ---- --76 5432 10f- e-d- -c-- b--a --9- -8-- 7--6 --5- -4-- 3--2 --1- -0--
```

While the above may be the simplest way to understand compressed morton codes,
the algorithm can be implemented more simply by iteratively going bit by bit
from LSB to MSB and keeping track of the interleaved output bit.

Specifically, given the coordinates `g` for a grid cell, where `0 <= g <
grid_size`, the compressed Morton code is computed as follows:
1. Set `j := 0`.
2. For `i` from `0` to `n-1`, where `n` is the number of bits needed to encode the grid cell
   coordinates:
   - For `dim` in `0, 1, 2` (corresponding to `x`, `y`, `z`):
     - If `2**i < grid_size[dim]`:
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
