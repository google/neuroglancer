.. _precomputed-skeleton-format:

Skeleton format
===============

A skeleton representation of some or all segmented objects may be specified as a directory tree
consisting of the following files:

- :file:`info` file in JSON format specifying the
  :json:schema:`metadata<PrecomputedSkeleton>`.
- For each segment ID for which there is a skeleton representation, a segment
  data file specifying the :ref:`encoded
  skeleton<precomputed-skeleton-format-encoding>` for a single segment.

The actual storage of the manifest and mesh fragment data depends on whether the
:ref:`unsharded<precomputed-skeleton-format-unsharded>` or
:ref:`sharded<precomputed-skeleton-format-sharded>` format is used.

:file:`info` metadata file
--------------------------

The :file:`info` file is a JSON-format text file with the following schema:

.. json:schema:: PrecomputedSkeleton

.. _precomputed-skeleton-format-encoding:

Encoded skeleton file format
----------------------------

The skeleton representation for a single segment ID is a binary file with the
following format:

- ``num_vertices``: uint32le, specifies the number of vertices.
- ``num_edges``: uint32le, specifies the number of edges.
- ``vertex_positions``: ``3*num_vertices`` float32le, as a C-order
  ``[num_vertices, 3]`` array specifying the ``x``, ``y``, and ``z`` vertex
  positions in "stored model" coordinates.
- ``edges``: ``2*num_edges`` uint32le, as a C-order ``[num_edges, 2]`` array
  specifying the source and target vertex index in the range ``[0,
  num_vertices)``.
- For each additional attribute in ``vertex_attributes``:

  - ``attribute_data``: ``num_vertices * num_components`` elements of the
    specified ``data_type`` in little-endian format.

.. _precomputed-skeleton-format-unsharded:

Unsharded format
----------------

In the unsharded format, the encoded skeleton data is stored as a separate file
within the same directory as the :file:`info` file under the name
:file:`{<segment-id>}`, where :file:`{<segment-id>}` is the base-10 string
representation of the segment ID.

.. _precomputed-skeleton-format-sharded:

Sharded format
--------------

In the :ref:`sharded format<precomputed-sharded-format>`, the encoded skeleton
data is retrieved using the segment ID as the key. The shard files are stored in
the same directory as the :file:`info` file.
