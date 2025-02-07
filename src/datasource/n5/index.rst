.. _n5-datasource:

n5
==

The N5 :ref:`data format driver<data-formats>` provides access to N5
single-resolution and multi-resolution arrays.

URL syntax
----------

- :file:`{base-kvstore-url/}|n5:`
- :file:`{base-kvstore-url/}|n5:{additional/path/}`

Specifying an :file:`{additional/path/}` after the n5 URL scheme is currently
equivalent to including it in the :file:`{base-kvstore-url/}`, but may be
preferred for distinguishing the root of an N5 hierarchy from the path within
it.

Multiscale datasets
-------------------

Multiscale datasets are specified by directory tree containing the following
files and directories:

- :file:`attributes.json` (multiscale metadata, also inherits attributes from
  ancestor directories)
- :file:`s0/` (base resolution)
- :file:`s1/` (first downsampling level)
- :file:`s{N}/` (:file:`N`\ th downsampling level)

The downsampling factors for each level may be specified in several ways:

- Each :file:`s{N}/attribute.json` file may specify a ``downsamplingFactors``
  attribute as an array specifying the downsampling factor corresponding to each
  dimension of the array. For example :file:`s1/attributes.json` may specify:

  .. code-block:: json

     {
       "dataType": "uint8",
       "dimensions": [1000, 1000, 1000],
       "blockSize": [100, 100, 100],
       "compression": {"type": "raw"},
       "downsamplingFactors": [2, 2, 1]
    }

  to indicate that the first two dimensions are downsampled by 2 and the last
  dimension is not downsampled. If the base resolution :file:`s0/` array does
  not specify a ``downsamplingFactors`` attribute, the downsampling factor is
  assume to be 1 for all dimensions.

  .. note::

     In this case, the set of downsampling levels is determined by a list
     operation on the base key-value store, and fails if listing is not
     supported.

- The top-level :file:`attributes.json` may specify a ``downsamplingFactors`` or
  ``scales`` attribute as an array of arrays, where the outer array ranges over
  downsampling levels, starting from 0, and the inner array ranges over
  dimensions. For example:

  .. code-block:: json

     {
       "downsamplingFactors": [
         [1, 1, 1],
         [2, 2, 1],
         [4, 4, 1]
       ]
     }

  indicates that there are 3 downsampling levels, where:

  - :file:`s0/` has downsampling factors of :json:`[1, 1, 1]`,
  - :file:`s1/` has downsampling factors of :json:`[2, 2, 1]`, and
  - :file:`s2/` has downsampling factors of :json:`[4, 4, 1]`.

  .. note::

     When the downsampling factors are specified in the top-level metadata in
     this way, any ``downsamplingFactors`` attributes specified in the
     individual :file:`s{N}/attributes.json` metadata files are ignored, and the
     base key-value store need not support listing.

  The behavior is identical if the attribute is specified as ``scales`` instead
  of ``downsamplingFactors``.

Data types
----------

Supported data types:

- uint8
- int8
- uint16
- int16
- uint32
- int32
- uint64
- float32

Codecs
------

Supported compression types:

- raw
- blosc
- gzip

Coordinate space metadata
-------------------------

Dimension names
~~~~~~~~~~~~~~~

Dimension names may be specified using the ``axes`` metadata attribute; if
present, the ``axes`` attribute must be an array of strings, specifying the name
of each dimension in the same order as the ``dimensions`` attribute.

Physical units
~~~~~~~~~~~~~~

Units may be specified using the ``resolution`` and ``units`` attributes, which
specify the coefficient and unit of each dimension in the same order as the
``dimensions`` attribute.  For example, for a 3-d array:

.. code-block:: json

   {
     "resolution": [4, 4, 30],
     "units": ["nm", "nm", "nm"]
   }

Alternatively, units may be specified using the ``pixelResolution`` attribute:

.. code-block:: json

   {
     "pixelResolution": {
       "unit": "nm",
       "dimensions": [4, 4, 30]
     }
   }

The ``pixelResolution`` attribute is not recommended, however, since it is less
widely supported and requires all dimensions to have the same base unit.

Coordinate arrays
~~~~~~~~~~~~~~~~~

As a Neuroglancer-specific extension, coordinate arrays may be specified using
the ``coordinateArrays`` metadata attribute; if present, the
``coordinateArrays`` attribute must be an object, where the keys correspond to
dimension names in ``axes`` and the values are arrays of strings specifying the
coordinate labels starting at 0. For example:

.. code-block:: json

   {
     "dimensions": [10000, 10000, 5],
     "dataType": "uint8",
     "blockSize": [512, 512, 1],
     "compression": { "type": "raw" },
     "axes": ["x", "y", "c"],
     "coordinateArrays": {
       "c": ["A", "B", "C", "D", "E"]
     }
   }
