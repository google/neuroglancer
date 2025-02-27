.. _zarr-datasource:

zarr
====

The Zarr :ref:`data format driver<data-formats>` provides access to `Zarr
version 2 <https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html>`__ and
`Zarr version 3
<https://zarr-specs.readthedocs.io/en/latest/v3/core/v3.0.html>`__ arrays, and
`OME-Zarr multiscale
<https://ngff.openmicroscopy.org/latest/index.html#multiscale-md>`__ v4.0 and
v5.0 arrays.

URL syntax
----------

- :file:`{KVSTORE-URL/}|zarr:` (auto-detect zarr version)
- :file:`{KVSTORE-URL/}|zarr2:` (v2 only)
- :file:`{KVSTORE-URL/}|zarr3:` (v3 only)
- :file:`{KVSTORE-URL/}|zarr:{additional/path/}`
- :file:`{KVSTORE-URL/}|zarr2:{additional/path/}`
- :file:`{KVSTORE-URL/}|zarr3:{additional/path/}`
- :file:`{KVSTORE-URL/}|zarr:#dimension_separator=/`
- :file:`{KVSTORE-URL/}|zarr2:#dimension_separator=/`

Specifying an :file:`{additional/path/}` after the zarr URL scheme is currently
equivalent to including it in the :file:`{KVSTORE-URL/}`, but may be
preferred for distinguishing the root of a zarr hierarchy from the path within
it, and may be necessary to support group-level storage transformers which may
be added to the specification in the future.

For zarr v2 only, if a dimension separator of ``/`` is used but not indicated in
the metadata, it must be specified using the :file:`#dimension_separator=/`
syntax.

The :file:`{KVSTORE-URL/}` must refer to a directory, and the combination
of :file:`{KVSTORE-URL/}` and any :file:`{additional/path/}` after the zarr
URL scheme must specify either a Zarr array or a Zarr group with OME-Zarr
multiscale metadata.

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

Coordinate spaces
-----------------

Units specified by OME-Zarr multiscale metadata are supported.

Additionally, as a Neuroglancer-specific extension, dimension units may be
specified using the ``dimension_units`` user attribute. For example, to specify
that the voxel size is 4x5x30nm for a 3-d array, the following attribute may be
set:

.. code-block:: json

   {
     "dimension_units": ["4 nm", "5 nm", "30 nm"]
   }

Zarr v2 features
----------------

Supported compressors:

- blosc
- gzip
- null (raw)
- zlib
- zstd

Filters are not supported.

Dimension names may be specified using an ``_ARRAY_DIMENSIONS`` attribute, `as
defined by xarray
<https://xarray.pydata.org/en/latest/internals/zarr-encoding-spec.html>`__.

Zarr v3 features
----------------

Supported codecs:

- crc32c (not validated)
- blosc
- bytes
- gzip
- sharding_indexed
- transpose
- zstd

Auto detection
--------------

- Zarr v2 is detected automatically based on the presence of the :file:`.zarray`
  and :file:`.zattrs` files.
- Zarr v3 is detected automatically based on the presence of the
  :file:`zarr.json` file.
