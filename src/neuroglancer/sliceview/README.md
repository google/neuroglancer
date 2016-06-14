This directory contains the code for `SliceView`, which provides the cross-sectional view.

# Architecture

A volume is divided into a regular grid of 3-d chunks.  Each chunk has voxel dimensions `chunkDataSize` (a 3-d vector of positive integers).  All chunks have the same dimensions, except at the the upper bound of the volume in each dimension, where the chunks are allowed to be truncated to fit within the volume dimensions.

Chunks are the unit at which portions of the volume are queued, retrieved, transcoded (if necessary), copied to the GPU, and rendered:

- `SliceView.prototype.computeVisibleChunks` in [base.ts](base.ts) determines the set of chunks from each layer that intersect the planar viewport.  This is called each time the viewport changes or the set of layers changes in *both* the frontend UI thread and the backend worker thread:
  - In the UI thread, this information determines the set of chunks that are *potentially* rendered.  Of this set, only chunks already in GPU memory are actually rendered.
  - In the backend worker thread, this information is used to update the chunk priority, which results in these chunks being queued, and eventually downloaded and loaded onto the GPU.
  While this requires some redundant work in the worker thread, it simplifies the interaction between the frontend and backend threads.
- Each chunk is loaded into GPU memory as a texture.  The precise format depends on the type of chunk, but because WebGL only supports 2-D textures with certain limits on both of the dimensions (typically 4096, 8192 or 16384), it is necessary to pack the data into a 2-D texture regardless of its actual form.  For example, image data is represented as a dense 3-d array.  Segmentation data can be represented either as a dense 3-d array or in the [compressed segmentation format](compressed_segmentation/README.md).
- A plane may intersect the faces of a rectangular cuboid at 3 to 6 points.  Each chunk is rendered as a single `TRIANGLE_FAN` with 3 to 6 vertices.  The number and location of these intersections is computed entirely on the GPU in GLSL vertex shader, based on the approach from the paper:  Christof Rezk Salama and Adreas Kolb.  A Vertex Program for Efficient Box-Plane Intersection.  VMV 2005.  <http://www.cg.informatik.uni-siegen.de/data/Publications/2005/rezksalamaVMV2005.pdf>  The texture containing the chunk data bound to a texture unit, and a GLSL fragment shader retrieves the voxel value associated with each pixel of the viewport, and converts it to a color.

# Chunk size selection

There are a number of trade-offs associated with the selection of chunk size:
- There is per-chunk overhead in:
  - computing the set of chunks that intersect the viewport;
  - managing the queuing, retrieval, and  GPU transfer of chunks;
  - HTTP requests to retrieve the chunk data (typically one HTTP request per chunk);
  - issuing WebGL calls to bind the associated texture and draw each chunk.
  This overhead is reduced by making the chunk size larger.  Note in particular that the number of HTTP requests required can be an important factor, since browsers often limit the number of concurrent requests per `hostname:port` combination to a small number (6 on Chrome).  This can be mitigated, however, by the use of hostname sharding.
- There is memory and network transfer overhead associated with each chunk.  Because a typical chunk size is 3-d but the viewport is a plane, only a small fraction of the voxels in a chunk are actually displayed at any given time.  Although much of the chunk may ultimately change as the user adjusts the viewport:
  - the full chunk must be downloaded before any of it may be displayed;
  - the minimum amount of system and GPU memory required by just the currently-visible set of chunks is proportional to the chunk depth;
  - some portions of the chunk may never be displayed.
  On the other hand, a larger chunk size does provide a simple form of prefetching.  Currently there is no real prefetching supported (of chunks that are not at least partially visible), although the chunk management code was designed to support prefeteching.

In practice `64^3` seems to be a reasonble chunk size.

Neuroglancer also supports multiple (anisotropic) chunk sizes to be used simultaneously with a single volume, in which case each SliceView selects the chunk size (at each resolution) that is most efficient.  For example, to support XY, XZ, and YZ cross-sectional views, chunk sizes of `(512, 512, 1)`, `(512, 1, 512)` and `(1, 512, 512)` could be used.  This does have the disadvantage, however, that chunk data is not shared at all by the 3 views.
