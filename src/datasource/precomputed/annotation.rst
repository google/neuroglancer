.. _precomputed-annotation-format:

Annotation format
=================

The precomputed annotation format defines an annotation collection for a given
n-dimensional coordinate space and one of the following five geometry types:

- Points (represented by a single position)
- Line segments (represented by the two endpoint positions)
- Axis-aligned bounding boxes (represented by two positions)
- Axis-aligned ellipsoids (represented by a center position and radii vector)
- Polylines (represented by the number of points in the line, followed by the positions of the points)

All annotations within the annotation collection have the same geometry type.

Each annotation is defined by:

- A unique uint64 annotation id;
- Position/radii vectors required by the annotation type;
- For each of the :json:schema:`~PrecomputedAnnotation.relationships` specified
  in the metadata, a list of associated uint64 ids (typically corresponding to
  segmented objects);
- Values for each of the :json:schema:`~PrecomputedAnnotation.properties`
  specified in the metadata.

An annotation collection is represented as a directory tree consisting of the following:

- :file:`info` file in JSON format specifying the
  :json:schema:`metadata<PrecomputedAnnotation>`;
- a sub-directory containing the annotations :ref:`indexed by their unique
  uint64 annotation ids<precomputed-annotation-format-id-index>`;
- for each relationship, a sub-directory containing the annotations
  :ref:`indexed by associated object
  ids<precomputed-annotation-format-related-object-index>`;
- a set of sub-directories containing a :ref:`multi-level spatial index of the
  annotations<precomputed-annotation-format-spatial-index>`.

:file:`info` metadata file
--------------------------

The :file:`info` file is a JSON-format text file with the following schema:

.. json:schema:: PrecomputedAnnotation

.. _precomputed-annotation-format-id-index:

Annotation id index
-------------------

The annotation id index supports efficient retrieval of individual annotations
by their uint64 id, and is used by Neuroglancer when selecting or hovering over
an annotation.

The annotation id index maps each uint64 annotation id to the [encoded
representation](#single-annotation-encoding) of the single corresponding
annotation. Depending on whether
:json:schema:`~PrecomputedAnnotation.by_id.sharding` parameters are specified,
the index is stored either in the :ref:`unsharded uint64 index
format<precomputed-annotation-format-unsharded-uint64-index>` or the
:ref:`sharded uint64 index
format<precomputed-annotation-format-sharded-uint64-index>`.

Note that the geometry and property data is duplicated in all indices, but only the annotation id
index encodes the complete lists of related object ids.

.. _precomputed-annotation-format-single-annotation-encoding:

Single annotation encoding
~~~~~~~~~~~~~~~~~~~~~~~~~~

Within the annotation id index, each annotation is encoded in the following binary format:

- The position/radii vectors required by the
  :json:schema:`~PrecomputedAnnotation.annotation_type` encoded as float32le
  values:

  - For :json:`"point"` type, the position vector.
  - For :json:`"line"` type, the first endpoint position followed by the second endpoint position.
  - For :json:`"axis_aligned_bounding_box"` type, the first position followed by the second position.
  - For :json:`"ellipsoid"` type, the center position followed by the radii vector.
  - For :json:`"polyline"` type, the number of points as a uint32le value, followed by the position of each point as float32le.

- For each property of type :json:`"uint32"`, :json:`"int32"`, or
  :json:`"float32"`: the value encoded as a little endian value.
- For each property of type :json:`"uint16"` or :json:`"int16"`: the value
  encoded as a little endian value.
- For each property of type :json:`"uint8"`, :json:`"int8"`, :json:`"rgb"`, or
  :json:`"rgba"`: the encoded value.
- Up to 3 padding bytes (with value of 0) to reach a byte offset that is a
  multiple of 4.
- For each of the :json:schema:`~PrecomputedAnnotation.relationships` specified
  in the :file:`info` metadata file:

  - The number of object ids as a uint32le value.
  - Each related object id, as a uint64le value.

.. _precomputed-annotation-format-unsharded-uint64-index:

Unsharded uint64 index
~~~~~~~~~~~~~~~~~~~~~~

The data corresponding to each uint64 annotation id or related object id is
stored in a file named :file:`{<id>}` within the directory indicated by the
:json:`"key"` member, where :file:`{<id>}` is the base-10 string representation
of the uint64 id.

.. _precomputed-annotation-format-sharded-uint64-index:

Sharded uint64 index
~~~~~~~~~~~~~~~~~~~~

The uint64 annotation id or related object id is used directly as the key within
the sharded representation within the directory indicated by the :json:`"key"`
member.

.. _precomputed-annotation-format-related-object-index:

Related object id index
-----------------------

The related object id index supports efficient retrieval of the list of annotations associated via a
given relationship with a given object id, and is used by Neuroglancer when filtering by segment
ids.

The related object id index maps each uint64 object id to the :ref:`encoded
representation<precomputed-annotation-format-multiple-annotation-encoding>` of
the list of related annotations. Depending on whether
:json:schema:`~PrecomputedAnnotation.relationships.sharding` parameters are
specified, the index is stored either in the :ref:`unsharded uint64 index
format<precomputed-annotation-format-unsharded-uint64-index>` or the
:ref:`sharded uint64 index
format<precomputed-annotation-format-sharded-uint64-index>`.

.. _precomputed-annotation-format-multiple-annotation-encoding:

Multiple annotation encoding
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Both the related object id index and the spatial index encode lists of
annotations in the following binary format:

- The number of annotations, ``count``, as a uint64le value.

- Repeated for ``i = 0`` up to ``count - 1``:

  - The position/radii vectors, the property values, and padding bytes of the
    ``i``\ th annotation are encoded exactly as in the :ref:`single annotation
    encoding<precomputed-annotation-format-single-annotation-encoding>`.

- Repeated for ``i = 0`` up to ``count - 1``:

  - The annotation id of the ``i``\ th annotation encoded as a uint64le value.

For the related object id index, the order of the annotations does not matter.
For the spatial index, the annotations should be ordered randomly.

.. _precomputed-annotation-format-spatial-index:

Spatial index
-------------

The spatial index supports efficient retrieval of the set of annotations that
intersects a given bounding box, with optional subsampling down to a desired
maximum density.

The spatial index is used by Neuroglancer when not filtering by related segment
ids.

Each spatial index level maps cell positions within the grid specified by the
:json:schema:`~PrecomputedAnnotation.spatial.chunk_size` and
:json:schema:`~PrecomputedAnnotation.spatial.grid_shape` to a spatially uniform
subsample of annotations intersecting that grid cell.

- A grid cell with coordinates ``cell`` corresponds to a spatial interval in
  dimension ``d`` of ``[lower_bound[d] + cell[d] * chunk_size[d],
  lower_bound[d] + (cell[d] + 1) * chunk_size[d]]``
- The ``chunk_size`` for spatial index level ``i+1`` should evenly divide the
  ``chunk_size`` for spatial index level ``i``. The grid cells within level
  ``i+1`` that are contained within a single level ``i`` grid cell are
  considered the child cells. For each level, the elementwise product of the
  ``grid_shape`` and the ``chunk_size`` should equal ``upper_bound -
  lower_bound``.
- Typically the ``grid_shape`` for level 0 should be a vector of all 1 (with
  ``chunk_size`` equal to ``upper_bound - lower_bound``), and each component of
  ``chunk_size`` of each successively level should be either equal to, or half
  of, the corresponding component of the prior level ``chunk_size``, whichever
  results in a more spatially isotropic chunk.

The spatial index levels should be computed as follows:

- For each grid position ``cell`` at the coarsest level, compute the set
  ``remaining_annotations(0, cell)`` of annotations that intersect the cell.
  Note that a single annotation may intersect multiple cells.
- Sequentially generate spatial index ``level``, starting at ``level=0`` (the
  coarsest level):

  - Define ``maxCount(level)`` to be the maximum over all ``cell`` positions of
    the size of ``remaining_annotations(level, cell)``.
  - For each ``cell``:

    - Compute a subset ``emitted(level, cell)`` of ``remaining_annotations(level, cell)`` where each
      annotation is chosen uniformly at random with probability ``min(1, limit / maxCount(level))``.
    - This spatial index level maps ``cell`` to the list of annotations in
      ``emitted(level, cell)``. The annotations are encoded in the
      :ref:`multiple annotation
      encoding<precomputed-annotation-format-multiple-annotation-encoding>` also
      used by the :ref:`related object id
      index<precomputed-annotation-format-related-object-index>`; the list
      should be ordered randomly (or perhaps pseudo-randomly based on the
      annotation id).
    - For each ``child_cell`` in level ``level+1`` contained within ``cell``:
      Compute the set ``remaining_annotations(level+1, child_cell)`` of
      annotations within ``remaining_annotations(level, cell) - emitted(level,
      cell)`` that intersect ``child_cell``.
  - Continue generating successively finer spatial index levels until no
    annotations remain.

Unsharded spatial index
~~~~~~~~~~~~~~~~~~~~~~~

The encoded annotation list corresponding to a grid cell ``cell`` is stored
within the directory indicated by the
:json:schema:`~PrecomputedAnnotation.spatial.key` member in a file named
``cell.join('_')``, i.e. the base-10 string representations of the grid cell
coordinates separated by the ``'_'`` character. For example, cell ``(1, 2, 3)``
is stored in the file named ``1_2_3``.

Sharded spatial index
~~~~~~~~~~~~~~~~~~~~~

The :ref:`compressed Morton code<precomputed-compressed-morton-code>` of the
grid cell is used as the key within the sharded representation stored in the
directory indicated by the :json:schema:`~PrecomputedAnnotation.spatial.key`
member.
