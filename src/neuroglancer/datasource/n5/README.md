n5 data source
==============

The `"n5"` data source allows Neuroglancer to directly read [n5](https://github.com/saalfeldlab/n5)
format datasets, using the following data source URL syntax:

`n5://FILE_URL`, where `FILE_URL` is a URL to the directory containing the `attributes.json`
metadata file using any [supported file protocol](../file_protocols.md).

Both single-scale and multi-scale datasets are supported.

Dimension names may be specified using the `axes` metadata attribute; if present, the `axes`
attribute must be an array of strings, specifying the name of each dimension in the same order as
the `dimensions` attribute.

As a Neuroglancer-specific extension, coordinate arrays may be specified using the
`coordinateArrays` metadata attribute; if present, the `coordinateArrays` attribute must be an
object, where the keys correspond to dimension names in `axes` and the values are arrays of strings
specifying the coordinate labels starting at 0.  For example:

```json
{
  "dimensions": [10000, 10000, 5],
  "dataType": "uint8",
  "blockSize": [512, 512, 1],
  "compression": {"type": "raw"},
  "axes": ["x", "y", "c"],
  "coordinateArrays": {
    "c": ["A", "B', "C', "D', "E"]
  }
}
```

For mutli-scale datasets, both the [n5-viewer](https://github.com/saalfeldlab/n5-viewer) and
[bigdataviewer-n5](https://github.com/bigdataviewer/bigdataviewer-core/blob/master/BDV%20N5%20format.md)
formats are supported.  `FILE_URL` must specify a directory with the following contents:

- `attributes.json`: Specifies the multi-scale metadata with the following attributes:
  - `"downsamplingFactors"`: array of arrays, where `downsamplingFactors[i]` is an array specifying
    the downsampling factor for each dimension of scale `i`.  For example, `[[1, 1, 1], [2, 2, 1],
    [4, 4, 1]]` indicates that there are three downsampling levels, where scale `s0` is full
    resolution, scale `s1` is downsampled by `2` in the first two dimensions and `1` in the third
    dimension, and scale `s2` is downsampled by `4` in the first two dimensions and `1` in the third
    dimensions.  For compatibility with [n5-viewer](https://github.com/saalfeldlab/n5-viewer), this
    attribute may also be named `scales`.
  - `"resolution"`: Array of numbers specifying the size along each dimension of a single voxel at
    the base resolution, in the units specified by `"units"`.  For example, if `"resolution"` is
    `[4, 4, 30]` and `"units"` is `["nm", "nm", "nm"]`, then the first two dimensions have a voxel
    size of 4nm and the third dimension has a voxel size of 30nm.
  - `"units"`: Array of strings specifying the units in which `"resolution"` is specified for each
    dimension.  May be `"m"` (for meters), `"s"` (for seconds), or `"Hz"` (Hertz) with any SI
    prefix.  May be an empty string to indicate a unit-less dimension.
  - `"pixelResolution"`: For compatibility with
    [n5-viewer](https://github.com/saalfeldlab/n5-viewer), may be specified in place of
    `"resolution"` and `"units"`.  Must be an object with the following properties:
    - `"unit"`: String specifying the unit for all dimensions.
    - `"dimensions"`: Array of numbers specifying the voxel size for each dimension, in the
      specified unit.
- `s0/`: directory containing dataset for base resolution.
- `s1/`: directory containing dataset for first downsampling level.
- `sN/`: directory containing dataset for Nth downsampling level.

Supported compression types:

- raw
- blosc
- gzip

Supported data types:

- uint8
- int8
- uint16
- int16
- uint32
- int32
- uint64
- float32
