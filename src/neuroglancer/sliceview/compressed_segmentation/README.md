Compressed Segmentation Format
==

For displaying arbitrary cross-sectional views, volume segmentations are conveniently represented as 3-D arrays of uint32 or uint64 values that assign a segment ID to each voxel position within the volume.

Using a typical chunk size of 64x64x64 voxels, a single chunk of uint64 values take 2 MiB of memory, and the chunks required to cover a standard 1920x1080 pixel screen require about 1 GiB of memory; this makes it impractical to cache in CPU and GPU memory a sufficient portion of even a single segmentation, yet alone multiple segmentations as is sometimes desired.

Because these volumes representing segmentations invariably have a high degree of spatial continuity, in that there are typically only a small number of distinct segment IDs within a small local region, even basic compression methods like GZIP can easily achieve compression ratios of 50:1.  While any compression method can be used to reduce the amount of data transferred over the network, methods like GZIP that do not support random access cannot be used to reduce GPU memory usage.

This directory contains the implementation of a compression format for uint32 and uint64 volumes that supports random access and can be efficiently decoded by a GLSL fragment shader as it is displayed.  The format is based on a user-specified 3-D block size, and it achieves good compression if the number of distinct uint32 or uint64 values within each block is small.

Format specification:
--

A 3-D volume is divided into a grid of fixed-size (e.g. 8x8x8) blocks.  Each block is encoded using a lookup table of the distinct values present, and the value at each position within the block is encoded with 0, 1, 2, 4, 8, 16 or 32 bits depending on the number of distinct values.  The number of bits used to encode each value is fixed within each block but varies between blocks.

If the block size does not evenly divide the size of the volume, for the purpose of encoding the volume is assumed to be padded at its upper bound to be a multiple of the block size; any value that occurs within the partial block may be used as a padding value.

The compressed data consists of `gx * gy * gz` 64-bit block headers at the start, assuming the grid of blocks has dimensions `(gx, gy, gz)`, followed by the encoded block data.  The 64-bit block header for the block at grid position `(x, y, z)` starts at byte offset `8 * (x + gx * (y + gy * z))` from the start of the compressed data.

Each 64-bit block header has the format:
- lookupTableOffset (24-bit little endian unsigned integer): specifies the start of the lookup table to be used for the block in 32-bit units from the start of the compressed data.
- encodedBits (8 bits): specifies the number of bits used to encode values within the block.  Must be 0, 1, 2, 4, 8, 16, or 32.
- encodedValuesOffset (32-bit little endian unsigned integer): specifies the start of the encoded values for the block in 32-bit units from the start of the compressed data.

The lookup table of values for each block is encoded simply as a sequence of little-endian uint32 or uint64 values (depending on the type of the volume).

The encoded values for each block are packed into a sequence of little-endian 32-bit unsigned integers.  The encoded value for a position `(x, y, z)` within a block of dimensions `(bx, by, bz)` is at `bitOffset = encodedBits * (x + bx * (y + by * z))`, which starts at bit position `bitOffset % 32` in the 32-bit unsigned integer at byte offset `4 * (encodedValuesOffset + floor(bitOffset / 32))`.

The 3-D size of the volume and the 3-D block size is not encoded, but is needed for decoding.

While the encoded values and lookup tables for each block may be ordered arbitrarily within the compressed data, a typical order is as follows:
- block headers
- encoded values for block `(0, 0, 0)`
- lookup table for block `(0, 0, 0)`
- encoded values for block `(1, 0, 0)`
- lookup table for block `(1, 0, 0)`
- etc.

It is permitted for multiple blocks to share the same lookup table, i.e. to use the same lookup table offset in multiple block headers.
