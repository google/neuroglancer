The `"deepzoom"` data source format is based on static collections of files served directly over
HTTP; it therefore can be used without any special serving infrastructure.  In particular, it can be
used with data hosted by a cloud storage provider like Google Cloud Storage or Amazon S3.  Note that
it is necessary, however, to either host the Neuroglancer client from the same server or enable CORS
access to the data.

This is an implementation of the single-image Deep Zoom Image (DZI) format. 

Deep Zoom data sources are specified using the following data source URL syntax:

`deepzoom://FILE_URL`, where `FILE_URL` is a URL to the DZI descriptor file (`XML` document with `.xml` or `.dzi` extension) using any [supported file protocol](../file_protocols.md).
