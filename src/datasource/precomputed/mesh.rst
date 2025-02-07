.. _precomputed-mesh-format:

Precomputed mesh format
=======================

The precomputed mesh format maps uint64 keys to corresponding 3-d triangulated meshes.

Commonly, these meshes represent the surfaces of the segmented objects in a 3-d
segmentation volume.

The are two variants of the mesh format:

- :ref:`precomputed-mesh-format-multiresolution`
  (preferred even for single-resolution meshes)
- :ref:`precomputed-mesh-format-legacy`

.. note::

   A mesh may be associated with a :ref:`precomputed segmentation
   volume<precomputed-volume-format>` via the
   :json:schema:`~PrecomputedVolume.mesh` metadata property.

.. _precomputed-mesh-format-multiresolution:

Multi-resolution mesh format
----------------------------

Multi-resolution meshes are represented as a directory tree containing the
following data:

- :file:`info` file in JSON format specifying the
  :json:schema:`metadata<PrecomputedMultiresolutionMesh>`.

- For each segment ID for which there is a mesh representation:

  - a :ref:`manifest file<precomputed-mesh-format-multiresolution-manifest>`
    that specifies the levels of detail and octree decomposition for the object;
  - a :ref:`mesh fragment data
    file<precomputed-mesh-format-multiresolution-fragment-data>` specifying an
    encoded mesh representation corresponding to each octree node.

The actual storage of the manifest and mesh fragment data depends on whether the
:ref:`unsharded<precomputed-mesh-format-multiresolution-unsharded>` or
:ref:`sharded<precomputed-mesh-format-multiresolution-sharded>` variant of the
format is used.

:file:`info` metadata file
~~~~~~~~~~~~~~~~~~~~~~~~~~

.. json:schema:: PrecomputedMultiresolutionMesh

.. _precomputed-mesh-format-multiresolution-manifest:

Encoded manifest format
~~~~~~~~~~~~~~~~~~~~~~~

For each segment ID for which there is a mesh representation, there is an
encoded *manifest* in the following format:

- ``chunk_shape``: 3x float32le, specifies the ``x``, ``y``, and ``z`` extents of
  finest octree node in the "stored model" coordinate space.
- ``grid_origin``: 3x float32le, specifies the ``x``, ``y``, and ``z`` origin of
  the octree decomposition in the "stored model" coordinate space.
- ``num_lods``: uint32le, specifies the number of levels of detail.
- ``lod_scales``: ``num_lods`` float32le, specifies the scale in "stored model" spatial units
  corresponding to each level of detail. Each scale value is multiplied by the
  :json:schema:`~PrecomputedMultiresolutionMesh.lod_scale_multiplier` metadata property.
- ``vertex_offsets``: ``num_lods*3`` float32le, as a C order ``[num_lods, 3]``
  array specifying an offset (in the "stored model" coordinate space) to add to
  vertex positions for each level of detail.
- ``num_fragments_per_lod``: ``num_lods`` uint32le, specifies the number of
  fragments (octree nodes) for each level of detail.
- For each ``lod`` in the range ``[0, num_lods)``:

  - ``fragment_positions``: ``num_fragments_per_lod[lod]*3`` uint32le, C order
    ``[3, numFragments_per_lod[lod]]`` array specifying the ``x``, ``y``, and
    ``z`` coordinates of the octree nodes for the given ``lod``. The node
    positions must be in ``x``, ``y``, ``z`` Z-curve order. The node corresponds
    to the axis-aligned bounding box within the "stored model" coordinate space
    with an origin of: ``grid_origin + [x, y, z] * chunk_shape * (2**lod)`` and
    a shape of ``chunk_shape * (2**lod)``.
  - ``fragment_offsets``: ``num_fragments_per_lod[lod]`` uint32le, specifies the
    size in bytes of the encoded mesh fragment in the [mesh fragment data
    file](#multi-resolution-mesh-fragment-data-file-format) corresponding to
    each octree node in the ``fragment_positions`` array. The starting offset of
    the encoded mesh data corresponding to a given octree node is equal to the
    sum of all prior ``fragment_offsets`` values.

.. _precomputed-mesh-format-multiresolution-fragment-data:

Encoded mesh fragment data
~~~~~~~~~~~~~~~~~~~~~~~~~~

The mesh fragment data files consist of the concatenation of the encoded mesh
data for all octree nodes specified in the manifest file, in the same order the
nodes are specified in the manifest, starting with ``lod`` 0. Each mesh fragment
is a `Draco <https://google.github.io/draco/>`__-encoded triangular mesh with a
3-component integer vertex position attribute. Each position component ``j``
must be a value ``x`` in the range ``[0, 2**vertex_quantization_bits)``, which
corresponds to a "stored model" coordinate of::

  grid_origin[j] +
  vertex_offsets[lod,j] +
  chunk_shape[j] * (2**lod) * (fragmentPosition[j] +
                               x / ((2**vertex_quantization_bits)-1))

.. note::

   The built-in Draco attribute quantization is not supported.

Each mesh fragment for ``lod > 0`` must be partitioned by a ``2x2x2`` grid such
that no triangle crosses a grid boundary (but may be incident to a grid
boundary).

.. _precomputed-mesh-format-multiresolution-unsharded:

Unsharded format
~~~~~~~~~~~~~~~~~

In the *unsharded* variant of the format, the manifest of each object is stored
as a separate file under the name :file:`{<segment-id>}.index`, and the mesh
fragment data is stored under the name :file:`{<segment-id>}`, where
:file:`{<segment-id>}` is the base-10 string representation of the segment ID.
These files are stored in the same directory as the :file:`info` metadata file.

.. _precomputed-mesh-format-multiresolution-sharded:

Sharded variant
~~~~~~~~~~~~~~~

In the *sharded* variant of the format, the manifest of each object is stored in
:ref:`sharded format<precomputed-sharded-format>` using the segment ID as the
key.

The shard data is stored in the same directory as the :file:`info` metadata
file. The mesh fragment data for each object is located immediately before the
encoded manifest in the same shard data file. The starting offset within that
shard data file is not specified explicitly but may be computed from the
starting offset of the manifest file and the sum of the mesh fragment sizes
specified in the manifest.

.. note::

   From the perspective of the sharded format as a plain key-value store, the
   encoded manifests are the values and the mesh fragment data is effectively
   stored in what would normally be considered unused space.

.. note::

   The mesh fragment data is always stored without additional compression,
   regardless of the :json:schema:`~PrecomputedSharding.data_encoding`
   parameter.

.. _precomputed-mesh-format-legacy:

Legacy single-resolution mesh format
------------------------------------

In addition to the multi-resolution mesh format, an older single-resolution mesh
format is also supported.

This format consists of a directory containing:

- an (optional) :ref:`precomputed-mesh-format-legacy-metadata` in JSON-format,
- :ref:`manifest files<precomputed-mesh-format-legacy-manifest>` in JSON format
  named :file:`{segment-id}:0`, where :file:`{segment-id}` is the base-10 string
  representation of the uint64 segment ID;
- :ref:`mesh fragment files<precomputed-mesh-format-legacy-fragment>` with
  arbitrary names specified in the manifest files.

.. note::

   Unlike the multi-resolution format, this legacy mesh format does not support
   a sharded storage representation.

.. _precomputed-mesh-format-legacy-metadata:

:file:`info` metadata file
~~~~~~~~~~~~~~~~~~~~~~~~~~

The :file:`info` metadata file, if present, must be in JSON format with the
following schema:

.. json:schema:: PrecomputedLegacyMesh

.. note::

   The :file:`info` metadata file is optional but strongly recommended. If there
   is no :file:`info` metadata file, the mesh format cannot be auto-detected and
   instead must be specified by an explicit data source URL of the form:
   :file:`{KVSTORE-URL/}|neuroglancer-precomputed:#type=mesh`.

.. _precomputed-mesh-format-legacy-manifest:

Manifest files
~~~~~~~~~~~~~~

The :file:`{segment-id}:0` manifest files are in JSON format with the following
schema:

.. json:schema:: PrecomputedLegacyMeshManifest

In the simplest case, each object mesh may be stored as a single fragment,
meaning each manifest specifies just a single mesh fragment filename. In
general, though, the mesh may be split into one or more separate fragments (e.g.
corresponding to chunks of the volume).

.. _precomputed-mesh-format-legacy-fragment:

Mesh fragment files
~~~~~~~~~~~~~~~~~~~

Each fragment file is specified in the following binary format:

- The file begins with a little-endian 32-bit unsigned integer ``num_vertices``
  specifying the number of vertices.
- The ``[x, y, z]`` vertex positions (as nanometer offsets within the global
  coordinate frame) are stored as little-endian single precision/binary32
  floating point values starting at an offset of ``4`` bytes from the start of
  the file (immediately after the ``num_vertices`` value) and ending at a byte
  offset of ``4 + 4 * 3 * num_vertices``. The x, y, and z components of the
  vertex positions are interleaved, i.e. ``[x0, y0, z0, x1, y1, z1, ...]``.
- The number of triangles is inferred as the number of remaining bytes in the
  file after the vertex position data divided by 12 (the number of remaining
  bytes must be a multiple of 12). The triangles are specified as an array of
  interleaved triplets ``[a, b, c]`` of vertex indices. The vertex indices are
  encoded as little-endian 32-bit unsigned integers.
