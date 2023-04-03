The `"deepzoom"` data source format is based on static collections of files served directly over
HTTP; it therefore can be used without any special serving infrastructure.  In particular, it can be
used with data hosted by a cloud storage provider like Google Cloud Storage or Amazon S3.  Note that
it is necessary, however, to either host the Neuroglancer client from the same server or enable CORS
access to the data.

This is an implementation of the single-image Deep Zoom Image (DZI) format:

* Detailed documentation from Daniel Gasienica (OpenZoom): https://www.openzoom.org/ ("OpenZoom: Behind the Scenes" at the bottom of the page), [Part II: Mathematical Analysis](https://www.gasi.ch/blog/inside-deep-zoom-2) in particular
* Short documentation from OpenSeadragon: http://openseadragon.github.io/examples/tilesource-dzi/
* Original documentation from Microsoft: https://learn.microsoft.com/en-us/previous-versions/windows/silverlight/dotnet-windows-silverlight/cc645077(v=vs.95)

For creating Deep Zoom images, [OpenSeadragon](http://openseadragon.github.io/) has a compilation of software which can help: http://openseadragon.github.io/examples/creating-zooming-images/ - [`PyramidIO`](https://github.com/usnistgov/pyramidio) and [`VIPS`](https://libvips.github.io/libvips/) may be the most commonly used ones.

Deep Zoom data sources are specified using the following data source URL syntax:

`deepzoom://FILE_URL`, where `FILE_URL` is a URL to the DZI descriptor file (`XML` document with `.xml` or `.dzi` extension) using any [supported file protocol](../file_protocols.md).
