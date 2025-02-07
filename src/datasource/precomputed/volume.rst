.. _precomputed-volume-format:

Neuroglancer Precomputed Volume Format
======================================

The precomputed volume format stores 4-d XYZC single- or multi-resolution
arrays. The XYZ dimensions are chunked and optionally stored at multiple
resolutions, while the C (channel) dimension is neither chunked nor
multi-resolution.

The volume format consists of a directory tree containing an :file:`info`
metadata file in JSON format, and the associated chunk data in the relative
paths specified in the metadata.

.. _precomputed-volume-metadata:

:file:`info` metadata format
----------------------------

.. json:schema:: PrecomputedVolume

Chunked representation of volume data
-------------------------------------

For each :json:schema:`scale<PrecomputedVolume.scales>` and chunk size
``chunk_size`` specified in
:json:schema:`~PrecomputedVolume.scales.chunk_sizes`, the volume (of voxel
dimensions ``size = [sx, sy, sz]``) is divided into a grid of ``grid_size =
ceil(size / chunk_size)`` chunks.

The grid cell with grid coordinates ``g``, where ``0 <= g < grid_size``,
contains the :ref:`encoded data<precomputed-volume-chunk-encoding>` for the
voxel-space subvolume ``[begin_offset, end_offset)``, where ``begin_offset =
voxel_offset + g * chunk_size`` and ``end_offset = voxel_offset + min((g + 1) *
chunk_size, size)``. Thus, the size of each subvolume is at most ``chunk_size``
but may be truncated to fit within the dimensions of the volume. Each subvolume
is conceptually a 4-dimensional ``[x, y, z, channel]`` array.

.. _precomputed-volume-unsharded-format:

Unsharded chunk storage
~~~~~~~~~~~~~~~~~~~~~~~

If :json:schema:`~PrecomputedVolume.scales.sharding` parameters are not
specified for a scale, each chunk is stored as a separate file within the path
specified by the :json:schema:`~PrecomputedVolume.scales.key` property with the
name :file:`{xBegin}-{xEnd}_{yBegin}-{yEnd}_{zBegin}-{zEnd}`, where:

- :file:`{xBegin}`, :file:`{yBegin}`, and :file:`{zBegin}` are substituted with
  the base-10 string representations of the ``x``, ``y``, and ``z`` components
  of ``begin_offset``, respectively; and
- :file:`{xEnd}`, :file:`{yEnd}`, and :file:`{zEnd}` are substituted with the
  base-10 string representations of the ``x``, ``y``, and ``z`` components of
  ``end_offset``, respectively.

.. _precomputed-volume-sharded-format:

Sharded chunk storage
~~~~~~~~~~~~~~~~~~~~~

If :json:schema:`~PrecomputedVolume.scales.sharding` parameters *are* specified
for a scale, the :ref:`sharded<precomputed-sharded-format>` representation of
the chunk data is stored within the directory specified by the
:json:schema:`~PrecomputedVolume.scales.key` property. Each chunk is identified
by a uint64 chunk identifier, equal to the :ref:`compressed format
code<precomputed-compressed-morton-code>` of the grid cell coordinates, which is
used as a key to retrieve the encoded chunk data from sharded representation.

.. _precomputed-compressed-morton-code:

Compressed morton code
^^^^^^^^^^^^^^^^^^^^^^

The *compressed Morton code* is a variant of the normal `Morton code
<https://en.wikipedia.org/wiki/Z-order_curve>`__ where bits that would be equal
to 0 for all grid cells are skipped.

.. note::

   Storing a normal 3-D Morton code in a uint64 value would only allow 21 bits
   for each of the three dimensions.

In the following, we list each potentially used bit with a hexadecimal letter,
so a 21-bit X coordinate would look like this::

  x = ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---4 3210 fedc ba98 7654 3210

after spacing out by 2 to allow interleaved Y and Z bits, it becomes::

  x = ---4 --3- -2-- 1--0 --f- -e-- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0``

For standard morton code, we'd shift ``Y << 1`` and ``Z << 2`` then OR the three
resulting uint64. But most datasets aren't symmetrical in size across
dimensions.

Using compressed 3-D Morton code lets us use bits asymmetrically and conserve
bits where some dimensions are smaller and those bits would always be zero.
Compressed morton code drops the bits that would be zero across all entries
because that dimension is limited in size. Say the X has max size 42,943 which
requires only 16 bits (~64K) and would only use up to the "f" bit in the above
diagram. The bits corresponding to the most-significant ``4``, ``3``, ``2``,
``1``, and ``0`` bits would always be zero and therefore can be removed.

This allows us to fit more data into the single uint64, as the following example
shows with Z having a 24 bit range.

Start with a X coordinate that for this example has a max of 16 bits::

  x = ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- fedc ba98 7654 3210

after spacing, note MSB ``f`` only has room for the Z bit since Y has dropped out::

  x = ---- ---- ---- ---- ---f -e-- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0

Start with a Y coordinate that for this example has a max of 14 bits::

  y = ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- --dc ba98 7654 3210

after spacing with constant 2 bits since Y has smallest range::

  y = ---- ---- ---- ---- ---- ---- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0

after shifting by 1 for future interleaving to get morton code::

  y = ---- ---- ---- ---- ---- ---d --c- -b-- a--9 --8- -7-- 6--5 --4- -3-- 2--1 --0-

Start with a Z coordinate that for this example has a max of 24 bits::
  z = ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- 7654 3210 fedc ba98 7654 3210

after spacing out Z with 24 bits max; note compression of MSB due to X and Y dropout::

  z = ---- ---- ---- 7654 3210 f-e- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0

after shifting by 2 for future interleaving::

  z = ---- ---- --76 5432 10f- e-d- -c-- b--a --9- -8-- 7--6 --5- -4-- 3--2 --1- -0--

Now if you OR the final X, Y, and Z you see no collisions::

  x = ---- ---- ---- ---- ---f -e-- d--c --b- -a-- 9--8 --7- -6-- 5--4 --3- -2-- 1--0
  y = ---- ---- ---- ---- ---- ---d --c- -b-- a--9 --8- -7-- 6--5 --4- -3-- 2--1 --0-
  z = ---- ---- --76 5432 10f- e-d- -c-- b--a --9- -8-- 7--6 --5- -4-- 3--2 --1- -0--

While the above may be the simplest way to understand compressed Morton codes,
the algorithm can be implemented more simply by iteratively going bit by bit
from LSB to MSB and keeping track of the interleaved output bit.

Specifically, given the coordinates ``g`` for a grid cell, where ``0 <= g <
grid_size``, the compressed Morton code is computed as follows:

1. Set ``j := 0``.

2. For ``i`` from ``0`` to ``n-1``, where ``n`` is the number of bits needed to
   encode the grid cell coordinates:

   - For ``dim`` in ``0, 1, 2`` (corresponding to ``x``, ``y``, ``z``):

     - If ``2**i < grid_size[dim]``:

       - Set output bit ``j`` of the compressed Morton code to bit ``i`` of ``g[dim]``.
       - Set ``j := j + 1``.

.. _precomputed-volume-chunk-encoding:

Chunk encoding
--------------

The  of the subvolume data in each chunk depends on the specified
:json:schema:`~PrecomputedVolume.scales.encoding`.

.. _precomputed-volume-encoding-raw:

raw
~~~

Each chunk is stored directly in little-endian binary format in ``[x, y, z,
channel]`` Fortran order (i.e. consecutive ``x`` values are contiguous) without
any header. For example, if the chunk has dimensions ``[32, 32, 32, 1]`` and has
a :json:schema:`~PrecomputedVolume.data_type` of :json:`"uint32"`, then the
encoded chunk should have a length of 131072 bytes.

.. list-table::

   * - Supported :json:schema:`~PrecomputedVolume.data_type`
     - Any
   * - Supported :json:schema:`~PrecomputedVolume.num_channels`
     - Any

.. _precomputed-volume-encoding-compressed-segmentation:

compressed_segmentation
~~~~~~~~~~~~~~~~~~~~~~~

Each chunk is encoded using the multi-channel `compressed
segmentation format
<https://github.com/google/neuroglancer/blob/master/src/sliceview/compressed_segmentation/README.md>`__.
The compression block size is specified by the
:json:schema:`~PrecomputedVolume.scales.compressed_segmentation_block_size`
metadata property.

.. list-table::

   * - Supported :json:schema:`~PrecomputedVolume.data_type`
     - :json:`"uint32"` or :json:`"uint64"`
   * - Supported :json:schema:`~PrecomputedVolume.num_channels`
     - Any

.. _precomputed-volume-encoding-compresso:

compresso
~~~~~~~~~

Each chunk is encoded in `Compresso format
<https://vcg.seas.harvard.edu/publications/compresso-efficient-compression-of-segmentation-data-for-connectomics>`__.

2-d image format encodings
~~~~~~~~~~~~~~~~~~~~~~~~~~

When using 2-d image format-based encodings, each chunk is encoded as an image
where the number of components is equal to
:json:schema:`~PrecomputedVolume.num_channels`. The width and height of the
image may be arbitrary, provided that the total number of pixels is equal to the
product of the x, y, and z dimensions of the subvolume, and that the 1-D array
obtained by concatenating the horizontal rows of the image corresponds to the
flattened ``[X, Y, Z]`` Fortran-order representation of the subvolume.

.. note::

   For effective compression (and to minimize artifacts when using lossy
   compression), however, it is recommended to use either ``[X, Y * Z]`` or
   ``[X * Y, Z]`` as the width and height, respectively.

.. warning::

   Lossy encodings should not be used for
   :json:schema:`~PrecomputedVolume.type.segmentation` volumes or
   :json:schema:`~PrecomputedVolume.type.image` volumes where it is important to
   retain the precise values.

.. _precomputed-volume-encoding-jpeg:

jpeg
^^^^

Each chunk is encoded as a `JPEG <https://en.wikipedia.org/wiki/JPEG>`__ image.

.. list-table::

   * - Supported :json:schema:`~PrecomputedVolume.data_type`
     - :json:`"uint8"`
   * - Supported :json:schema:`~PrecomputedVolume.num_channels`
     - 1 or 3

.. _precomputed-volume-encoding-png:

png
~~~

Each chunk is encoded as a `PNG <https://en.wikipedia.org/wiki/PNG>`__ image.

.. list-table::

   * - Supported :json:schema:`~PrecomputedVolume.data_type`
     - :json:`"uint8"` or :json:`"uint16"`
   * - Supported :json:schema:`~PrecomputedVolume.num_channels`
     - 1-4

.. _precomputed-volume-encoding-jxl:

jxl
~~~

Each chunk is encoded as a `JPEG-XL <https://en.wikipedia.org/wiki/JPEG_XL>`__
image.

.. list-table::

   * - Supported :json:schema:`~PrecomputedVolume.data_type`
     - :json:`"uint8"`
   * - Supported :json:schema:`~PrecomputedVolume.num_channels`
     - 1, 3, or 4
