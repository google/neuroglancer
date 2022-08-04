zarr data source
================

The `"zarr"` data source allows Neuroglancer to directly read [zarr](https://zarr.readthedocs.io/)
format arrays, using the following data source URL syntax:

`zarr://FILE_URL`, where `FILE_URL` is a URL to the directory containing the `.zarray` metadata file
using any [supported file protocol](../file_protocols.md).

Alternatively, `FILE_URL` may be a URL to the directory containing the `.zattrs` metadata file that
specifies an [OME-NGFF multiscale](https://ngff.openmicroscopy.org/0.4/#multiscale-md) dataset.
Multiscale metadata versions `0.4`, `0.5-dev` and `0.5` are supported.

If the zarr array uses `/` rather than the default of `.` as the dimension separator in chunk keys,
you can either specify the separator as the `dimension_separator` member in the `.zarray` metadata
file (preferred) or use a data source URL of `zarr://FILE_URL?dimension_separator=/`.

Supported compressors:

- raw
- gzip
- zlib
- blosc

Filters are not supported.

Dimension names may be specified using an `_ARRAY_DIMENSIONS` attribute, 
[as defined by xarray](https://xarray.pydata.org/en/latest/internals/zarr-encoding-spec.html).

Supported data types (little and big endian):

- uint8
- int8
- uint16
- int16
- uint32
- int32
- uint64
- float32
