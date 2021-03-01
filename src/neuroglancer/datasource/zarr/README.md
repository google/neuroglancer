zarr data source
================

The `"zarr"` data source allows Neuroglancer to directly read [zarr](https://zarr.readthedocs.io/)
format arrays, using the following data source URL syntax:

`zarr://FILE_URL`, where `FILE_URL` is a URL to the directory containing the `.zarray` metadata file
using any [supported file protocol](../file_protocols.md).

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
