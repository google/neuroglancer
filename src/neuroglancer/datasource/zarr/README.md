zarr datasource
=================

This directory defines Neuroglancer support for the [zarr](https://zarr.readthedocs.io/) format.

Supported compressors:

- raw
- gzip
- zlib
- blosc

Filters are not supported.

Dimension names may be specified using an `_ARRAY_DIMENSIONS` attribute, as defined by xarray:
http://xarray.pydata.org/en/latest/internals.html#zarr-encoding-specification

Supported data types (little and big endian):

- uint8
- int8
- uint16
- int16
- uint32
- int32
- uint64
- float32
