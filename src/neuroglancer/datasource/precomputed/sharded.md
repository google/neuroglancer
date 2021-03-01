# Sharded format

The unsharded [multiscale volume](./volume.md#unsharded-chunk-storage),
[mesh](./meshes.md#unsharded-storage-of-multi-resolution-mesh-manifest) and [skeleton
formats](./skeletons.md#unsharded-storage-of-encoded-skeleton-data) store each volumetric chunk or per-object
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
  code](./volume.md#compressed-morton-code).
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
