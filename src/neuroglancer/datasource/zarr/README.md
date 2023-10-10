zarr data source
================

The `"zarr"` data source allows Neuroglancer to directly read
[zarr](https://zarr-specs.readthedocs.io/) format arrays, using the following data source URL
syntax:

`zarr://FILE_URL`, where `FILE_URL` is a URL to the directory containing the `.zarray` (v2) or
`zarr.json` (v3) metadata file using any [supported file protocol](../file_protocols.md).

Alternatively, `FILE_URL` may be a URL to the directory containing the `.zattrs` (v2) or `zarr.json`
(v3) group metadata file that specifies an [OME-NGFF
multiscale](https://ngff.openmicroscopy.org/0.4/#multiscale-md) dataset.  Multiscale metadata
versions `0.4`, `0.5-dev` and `0.5` are supported.

Supported data types (little and big endian):

- uint8
- int8
- uint16
- int16
- uint32
- int32
- uint64
- float32

As an extension, dimension units may be specified using the `dimension_units` user attribute.  For
example, to specify that the voxel size is 4x5x30nm for a 3-d array, the following attribute may be
set:

```json
{
  "dimension_units": ["4 nm", "5 nm", "30 nm"]
}
```

## Zarr v2

If the zarr array uses `/` rather than the default of `.` as the dimension separator in chunk keys,
you can either specify the separator as the `dimension_separator` member in the `.zarray` metadata
file (preferred) or use a data source URL of `zarr://FILE_URL?dimension_separator=/`.

Supported compressors:

- blosc
- gzip
- null (raw)
- zlib
- zstd

Filters are not supported.

Dimension names may be specified using an `_ARRAY_DIMENSIONS` attribute,
[as defined by xarray](https://xarray.pydata.org/en/latest/internals/zarr-encoding-spec.html).

## Zarr v3

Supported codecs:

- crc32c (not validated)
- blosc
- bytes
- gzip
- sharding_indexed
- transpose
- zstd
