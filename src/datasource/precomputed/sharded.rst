.. _precomputed-sharded-format:

Neuroglancer Precomputed Sharded Format
=======================================

The precomputed sharded format is logically a key-value store that maps 8-byte (uint64)
keys to arbitrary byte sequence values.

It packs any number of key/value pairs (called *chunks*) into a fixed number of
larger *shard* files. Compared to storing each key in a separate file, it can
reduce space overhead and storage and improve write efficiency on storage
systems with high per-file overhead, as is common in many distributed storage
systems including cloud object stores. There are several downsides to the
sharded format, however:

- It requires greater complexity in the generation pipeline.
- It is not possible to re-write the data for individual chunks; the entire
  shard must be re-written.
- There is somewhat higher read latency due to the need to retrieve additional
  index information before retrieving the actual chunk data, although this
  latency is partially mitigated by client-side caching of the index data in
  Neuroglancer.

The sharded format uses a two-level index hierarchy:

- There are a fixed number of shards, and a fixed number of minishards within
  each shard.
- Each chunk, identified by a uint64 identifier, is mapped via a hash function
  to a particular shard and minishard. In the case of meshes and skeletons, the
  chunk identifier is simply the segment
  ID. In the case of volumetric and annotation data, the chunk identifier is the
  :ref:`compressed Morton code<precomputed-compressed-morton-code>`.
- A fixed size :ref:`shard index<precomputed-sharded-format-shard-index>` stored
  at the start of each shard file specifies for each minishard the start and end
  offsets within the shard file of the corresponding *minishard index*.
- The variable-size :ref:`shard
  index<precomputed-sharded-format-minishard-index>` specifies the list of chunk
  ids present in the minishard and the corresponding start and end offsets of
  the data within the shard file.

.. note::

   The sharded format requires that the underlying key-value store supports
   :ref:`byte range reads<kvstore-byte-range-reads>`.

The sharded format consists of the :json:schema:`sharding metadata
parameters<PrecomputedSharding>`, which are embedded in the parent format
:file:`info` metadata file, and a directory containing the :ref:`shard data
files<precomputed-sharded-shard-data-files>`.

Sharding metadata
-----------------

.. json:schema:: PrecomputedSharding

.. _precomputed-sharded-shard-data-files:

Shard data files
----------------

For each shard number in the range ``[0, 2**shard_bits)``, there is a
:file:`{<shard>}.shard` file, where :file:`{<shard>}` is the lowercase base-16
shard number zero padded to ``ceil(shard_bits/4)`` digits.

.. note::

   There was an earlier (obselete) version of the sharded format, which also
   used the same :json:`"neuroglancer_uint64_sharded_v1"` identifier. The
   earlier format differed only in that there was a separate
   :file:`{<shard>}.index` file (containing the *shard index*) and a
   :file:`{<shard>}.data` file (containing the remaining data) in place of the
   single :file:`{<shard>}.shard` file of the current format; the
   :file:`{<shard>}.shard` file is equivalent to the concatenation of the
   :file:`{<shard>}.index` and :file:`{<shard>}.data` files of the earlier
   version.

.. _precomputed-sharded-format-shard-index:

Shard index format
------------------

The first ``2**minishard_bits * 16`` bytes of each shard file is the *shard
index* consisting of ``2**minishard_bits`` 16-byte entries of the form:

- ``start_offset``: uint64le, specifies the inclusive start byte offset of the
  :ref:`minishard index<precomputed-sharded-format-minishard-index>` in the
  shard file.
- ``end_offset``: uint64le, specifies the exclusive end byte offset of the
  :ref:`minishard index<precomputed-sharded-format-minishard-index>` in the
  shard file.

Both the ``start_offset`` and ``end_offset`` are relative to the end of the
*shard index*, i.e. ``shard_index_end = 2**minishard_bits * 16`` bytes.

That is, the encoded :ref:`minishard
index<precomputed-sharded-format-minishard-index>` for a given minishard is
stored in the byte range ``[shard_index_end + start_offset, shard_index_end +
end_offset)`` of the shard file. A zero-length byte range indicates that there
are no chunk IDs in the minishard.

.. _precomputed-sharded-format-minishard-index:

Minishard index format
----------------------

The *minishard index* stored in the shard file is encoded according to the
:json:schema:`~PrecomputedSharding.minishard_index_encoding` metadata value.

The decoded *minishard index* is a binary string of ``24*n`` bytes, specifying a
contiguous C-order ``array`` of ``[3, n]`` uint64le values.

- Values ``array[0, 0], ..., array[0, n-1]`` specify the chunk IDs in the
  minishard, and are delta encoded, such that ``array[0, 0]`` is equal to the ID
  of the first chunk, and the ID of chunk ``i`` is equal to the sum of
  ``array[0, 0], ..., array[0, i]``.

- The size of the data for chunk ``i`` is stored as ``array[2, i]``. Values
  ``array[1, 0], ..., array[1, n-1]`` specify the starting offsets in the shard
  file of the data corresponding to each chunk, and are also delta encoded
  relative to the *end* of the prior chunk, such that the starting offset of the
  first chunk is equal to ``shard_index_end + array[1, 0]``, and the starting
  offset of chunk ``i`` is the sum of ``shard_index_end + array[1, 0], ...,
  array[1, i]`` and ``array[2, 0], ..., array[2, i-1]``.

The start and size values in the minishard index specify the location in the
shard file of the chunk data, which is encoded according to the
:json:schema:`~PrecomputedSharding.data_encoding` metadata value.
