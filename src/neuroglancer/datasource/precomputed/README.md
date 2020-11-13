The `"precomputed"` data source format is based on static collections of files served directly over
HTTP; it therefore can be used without any special serving infrastructure.  In particular, it can be
used with data hosted by a cloud storage provider like Google Cloud Storage or Amazon S3.  Note that
it is necessary, however, to either host the Neuroglancer client from the same server or enable CORS
access to the data.

Several types of data are supported:
- [Single-resolution or multi-resolution image/segmentation volume](./volume.md)
- [Single-resolution](./meshes.md#legacy-single-resolution-mesh-format) or [multi-resolution](./meshes.md#multi-resolution-mesh-format) object surface meshes (keyed by uint64 object ids)
- [Object skeleton representations (keyed by uint64 object ids)](./skeletons.md)
- [Collection of point/line/bounding box/ellipsoid annotations](./annotations.md)
- [Segment property maps](./segment_properties.md)

Precomputed data sources are specified using the following data source URL syntax:

`precomputed://FILE_URL`, where `FILE_URL` is a URL to the directory containing a precomputed format
`info` metadata file using any [supported file protocol](../file_protocols.md).

For a [legacy single-resolution mesh dataset](./meshes.md#legacy-single-resolution-mesh-format)
without an `info` metadata file, you must specify the type explicitly:

`precomputed://FILE_URL#type=mesh`

where `FILE_URL` is a URL to the directory containing the mesh data.

# HTTP Content-Encoding

The normal HTTP `Content-Encoding` mechanism may be used by the HTTP server to transmit data in
compressed form; this is particularly useful for the JSON metadata files, unsharded `"raw"` or
`"compressed_segmentation"` volume chunk data, unsharded skeleton data, and unsharded mesh
manifests, which are likely to benefit from compression and do not support other forms of
compression.  Some HTTP servers can perform this compression on the fly, while others, like Google
Cloud Storage, require that the data be compressed ahead of time.  Note that with Google Cloud
Storage (and any other system that requires ahead-of-time compression), the use of
`Content-Encoding` is not compatible with HTTP `Range` requests that are needed for the sharded
index and data files and unsharded multi-scale mesh fragment data files; therefore, ahead-of-time
compression should not be used on such files.
