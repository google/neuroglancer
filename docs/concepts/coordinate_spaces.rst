.. _coordinate-spaces:

Coordinate spaces
=================

A *coordinate space* associates a semantic meaning to *coordinate vectors*
within that space, vectors of real-valued coordinates specifying a coordinate
for each dimension of the coordinate space.  At any given time, a coordinate
space has a fixed number of dimensions, called the *rank* of the coordinate
space.

Commonly, Neuroglancer is used with 3-dimensional data, and hence coordinate
spaces of rank 3, but Neuroglancer supports degenerate coordinate spaces of rank
0, and there is no explicit upper limit on the number of dimensions.

In addition to rank, coordinate spaces have several other properties:

- The coordinate space specifies a unique name for each dimension, such as
  ``x``, ``y``, or ``z``. Dimension names must match the regular expression
  :regexp:`[a-zA-Z][a-zA-Z_0-9]*['^]?`: they must consist of an ASCII letter,
  and followed by zero or more ASCII letters, digits, or underscore characters.
  The optional suffix of ``'`` or ``^`` indicates a :ref:`local or channel
  dimension<dimension-kinds>`, respectively.
- For each dimension, the coordinate space specify either:
  
  - a *physical unit*, which may include both a base unit and a coefficient,
    such as ``4e-9 m``, or may omit a base unit to indicate a unitless
    dimension, such as ``1`` or ``1e3``; or
  - a *coordinate array* specifying a string label associated with some of the
    coordinates (indicating a discrete dimension).
- Coordinate spaces may optionally have a list of associated bounding boxes,
  from which lower and upper bounds for each coordinate may be inferred.

Neuroglancer makes use of a number of interrelated coordinate spaces and
associated positions, orientations, and other coordinate transformation
parameters:

.. graphviz:: coordinate_spaces.dot
   :caption: Coordinate spaces and transforms in Neuroglancer.  The labels above
             link to the corresponding description below.

The series of coordinate transformations, starting from the coordinate spaces of
each :ref:`data source<data-source-coordinate-space>`, into a common
:ref:`global coordinate space<global-coordinate-space>`, and then into the
coordinate space for each rendered view, is described below.

.. _data-source-coordinate-space:

Data source coordinate space
----------------------------

The starting point for all coordinate transformations in Neuroglancer is the
data source itself. Each :ref:`data source<layer-data-source>` added to a
:ref:`layer` has an inherent associated coordinate space.

..
  Screenshots not yet supported
  .. neuroglancer-screenshot:: concepts/data_source_coordinate_space

The dimension names, physical units or coordinate arrays, and bounds are
determined from the source data automatically; if dimension names or units
cannot be determined, default values are chosen by the data source
implementation.  The dimension names and bounds within the source coordinate
space are fixed, but the :ref:`coordinate
transform<data-source-coordinate-transform>` controls how the source data
coordinate space maps to the :ref:`layer and global coordinate
spaces<global-coordinate-space>`.

.. _data-source-coordinate-transform:

Coordinate transform
^^^^^^^^^^^^^^^^^^^^

A configurable :wikipedia:`affine<Affine_transformation>` *coordinate
transform*, represented by an :wikipedia:`affine transformation
matrix<Transformation_matrix#Affine_transformations>` and a list of output
dimension names, maps the source coordinate space to the :ref:`layer coordinate
space<layer-coordinate-space>` and to the :ref:`global coordinate
space<global-coordinate-space>`.

The data source provides a default value for the coordinate transform,
normally an identity matrix.

The user can configure the coordinate transform in three ways:

1. The affine transformation matrix scaling and translation coefficients may be
   changed directly.  Note that the translation coefficients are in the units
   specified for the output (layer) dimension.

2. The names of the output dimensions of the transform may be changed.
   Permuting the output dimension names has a similar effect to permuting the
   rows of the transformation matrix in the same way, but may be more
   convenient.

3. The source dimension scales/units may be changed, in order to rescale the
   input.  This is equivalent to applying an appropriate scale transformation to
   the affine transformation matrix, but in many cases is more convenient.

   .. note::

      Changing the units of an output dimension does *not* rescale the data, it
      simply changes the unit used to display coordinates.

The output space of the coordinate transform is a subspace of the :ref:`layer
coordinate space<layer-coordinate-space>`.  If two data sources associated with
a layer both have a coordinate transform with an output dimension named ``x``,
both coordinate transforms are referring to the same dimension ``x``.  In
contrast, the names of the *source dimensions* of the coordinate transform are
purely descriptive; if two data sources associated with a layer both have a
source dimension ``x``, there is no direct correspondence between those two
source dimensions.

.. _layer-coordinate-space:

Layer coordinate space
----------------------

The output coordinate spaces of the :ref:`coordinate
transforms<data-source-coordinate-transform>` of each data source in a given
layer are *merged* into a single coordinate space that is called the *layer
coordinate space*:

- If a layer has just a single data source (most common case), then the layer
  coordinate space is simply the output coordinate space of the coordinate
  transform.

- In general, if a layer has more than one data source, the layer coordinate
  space consists of the distinct output dimensions of the coordinate transforms
  of each of the data sources.

.. _dimension-kinds:

Global, local and channel dimensions
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

A layer coordinate space dimension may be one of three *kinds*, determined based
on the dimension name:

.. _global-dimensions:

Global dimensions
~~~~~~~~~~~~~~~~~

Global dimensions have names consisting of only ASCII
alphanumeric and underscore characters without a special suffix, e.g. ``x``.

- The global dimensions of each layer are merged into the :ref:`global
  coordinate space<global-coordinate-space>`, which specifies the units for
  global dimensions.

- A global dimension ``x`` in one layer refers to the same dimension as a
  global dimension ``x`` in another layer.

- Only global dimensions may be used as :ref:`display
  dimensions<display-dimensions>`.

.. _local-dimensions:

Local dimensions
~~~~~~~~~~~~~~~~

Local dimensions have names ending in ``'`` (ASCII single quote), e.g. ``c'``.

- The :ref:`local coordinate space<local-coordinate-space>` of each layer
  consists of the subset of the layer dimensions that are local dimensions,
  and specifies the units for local dimensions.

- A local dimension ``c'`` in one layer is completely independent from a local
  dimension with the same name ``c'`` in another layer.

- Local dimensions may not be used as :ref:`display
  dimensions<display-dimensions>`. Instead, :ref:`data views<data-view>` always
  display a cross section at a single position along each local dimension; this
  position is determined by the :ref:`local position<local-position>`.

- A global dimension with a unique name that is not a :ref:`display
  dimension<display-dimensions>` may be used as an alternative to a local
  dimension; a local dimension simply avoids the need to assign unique names,
  and may be more convenient in some cases.

.. _channel-dimensions:

Channel dimensions
~~~~~~~~~~~~~~~~~~

:ref:`Image layers<image-layer>` additionally support channel dimensions,
which have names ending ``^`` (ASCII caret), e.g. ``c^``.

- The :ref:`shader<image-layer-shader>` can access the value at every position
  within the channel dimensions when computing the output pixel color.  For
  example, if there is a single channel dimension with a range of ``[0, 3)``,
  the shader can compute the output pixel color based on the data value at
  each of the 3 positions.

- Like :ref:`local dimensions<local-dimensions>`, a channel dimension ``c^``
  in one layer is completely independent from a channel dimension with the
  same name ``c^`` in another layer.

- A dimension can be used as a channel dimensions only if the data source is
  unchunked along that dimension.

.. _local-coordinate-space:

Local coordinate space
^^^^^^^^^^^^^^^^^^^^^^

The local coordinate space of a layer consists of the local dimensions of the
layer coordinate space.

By default, dimensions are ordered based on when they are first added, with
dimensions added later ordered after dimensions added earlier, but dimensions
may be explicitly reordered.

.. _local-position:

Local position
~~~~~~~~~~~~~~

Each layer has an associated *local position*, specifying for each dimension in
the :ref:`local coordinate space<local-coordinate-space>` the single slice for
each dimension in the local coordinate space to be displayed in any views of the
layer.

.. _global-coordinate-space:

Global coordinate space
-----------------------

The global coordinate space consists of the global dimensions from the
coordinate spaces of each layer added to the viewer.

By default, dimensions are ordered based on when they are first added to a layer
coordinate space, with dimensions added later ordered after dimensions added
earlier, but dimensions may be explicitly reordered.


.. _global center position:

Global center position
^^^^^^^^^^^^^^^^^^^^^^

The viewer has a single default global position, called the global center
position, which specifies a center coordinate for each dimension in the
:ref:`global coordinate space<global-coordinate-space>`.

.. _global-mouse-position:

Global mouse position
^^^^^^^^^^^^^^^^^^^^^

The position within the :ref:`global-coordinate-space` corresponding to the
current mouse position within a :ref:`data view<data-view>` is called the
*global mouse position*.

.. _layer group center position:

Layer group center position
^^^^^^^^^^^^^^^^^^^^^^^^^^^

Additionally, each layer group sub-viewer has a separate center position in the
:ref:`global coordinate space<global-coordinate-space>` which may optionally be
fixed to, or linked by an offset to, the global center position.

.. _display-dimensions:

Display dimensions
------------------

:ref:`Data views<data-view>` project data from at most three
:ref:`global dimensions<global-coordinate-space>`; these projected dimensions
are called *display dimensions*. From all other global dimensions, only a
cross section of the data is displayed at any given time.
