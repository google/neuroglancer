### What MultiscaleVolumeChunkSource is and why it exists
MultiscaleVolumeChunkSource is the frontend abstraction for volumetric data in Neuroglancer that can be viewed at multiple resolutions and/or orientations. It doesn’t load or store voxels itself; instead it:
- Defines the set of per-scale, per-orientation chunk sources that the renderer can query.
- Encodes the coordinate transforms needed to map each chunk space into the layer’s “multiscale” space.
- Supplies metadata such as rank, data type, and volume type (image vs segmentation) to drive shader code paths and default compression decisions.

Concretely, the type is defined in src/sliceview/volume/frontend.ts:
- MultiscaleVolumeChunkSource extends the generic MultiscaleSliceViewChunkSource with Source = VolumeChunkSource and Options = VolumeSourceOptions. You must implement:
  - rank: number — typically 3 for a 3D volume (or 4 if you include channels as a dimension in chunking).
  - dataType: DataType — e.g., UINT8, UINT16, FLOAT32, UINT32/UINT64 (segmentation).
  - volumeType: VolumeType — IMAGE or SEGMENTATION (affects shader behavior and default compression rules downstream).
  - getSources(options: VolumeSourceOptions): SliceViewSingleResolutionSource<VolumeChunkSource>[][] — returns a 2D array: [orientation][scale]. Each element supplies:
    - chunkSource: VolumeChunkSource — the per-scale chunk producer/holder.
    - chunkToMultiscaleTransform: mat (rank+1 x rank+1) mapping chunk voxel coordinates into the multiscale space for this source.
    - lowerClipBound/upperClipBound (optional) — clip region in chunk voxel space.

How the renderer uses it (high level):
- SliceView requests transformed sources via getVolumetricTransformedSources (src/sliceview/frontend.ts). That function:
  1) Calls your getSources with the view’s transforms and channel mapping.
  2) Computes, for each source, the transforms between chunk space, multiscale space, and the 2D view, plus an effective voxel size at that scale.
  3) Chooses which scale(s) to render given current zoom, pixel size, and RenderLayer settings.
  4) Enumerates visible chunks for those sources and asks the ChunkManager to fetch them.

Where the actual voxel bytes come from:
- VolumeChunkSource (also in src/sliceview/volume/frontend.ts) is the frontend pair to your selected spec (VolumeChunkSpecification). It defines chunk layout/format and provides getValueAt for picking.
- The frontend VolumeChunkSource depends on a backend chunk source implementation (in workers) to fill chunk data on demand. Without a backend, no data arrives; rendering either shows nothing or can still draw “proced“procedural” effects that don’t sample the chunk textures.
  ural” effects that don’t sample the chunk textures.

Helpful related APIs:
- makeVolumeChunkSpecification in src/sliceview/volume/base.ts builds the spec (rank, bounds, chunk size, data type, etc.).
- makeVolumeChunkSpecificationWithDefaultCompression can choose compressed segmentation blocks for segmentation data.
- SliceViewVolumeRenderLayer in src/sliceview/volume/renderlayer.ts is the default renderer that consumes your MultiscaleVolumeChunkSource and handles WebGL setup, transforms, chunk iteration, and shader integration.


### How to use MultiscaleVolumeChunkSource
Typical usage pattern when building a layer:
1) Construct a subclass instance and pass it to a SliceViewVolumeRenderLayer (or your own subclass of it), e.g.:
  - const multiscale = new MyMultiscaleSource(chunkManager);
  - const renderLayer = new SliceViewVolumeRenderLayer(multiscale, { ... });
2) The layer uses your getSources to choose appropriate scales and request chunks through the ChunkManager.
3) A backend implementation for VolumeChunkSource provides the voxel bytes when requested.


### How to extend it (implement your own)
To implement a custom multiscale volume:
- Extend MultiscaleVolumeChunkSource.
- Define rank, dataType, and volumeType.
- Implement getSources(options). For each scale/orientation you want to expose:
  1) Create a VolumeChunkSpecification via makeVolumeChunkSpecification (or the default-compression variant for segmentation). You must provide at least:
    - rank
    - chunkDataSize (Uint32Array length = rank)
    - lowerVoxelBound (defaults to zeros if not given)
    - upperVoxelBound (required)
    - dataType
  2) Obtain a frontend VolumeChunkSource from the ChunkManager:
    - const source = chunkManager.getChunkSource(VolumeChunkSource, { spec })
  3) Provide chunkToMultiscaleTransform (Float32Array of size (rank+1)^2). This defines the voxel size/axis orientation and any downsampling between the chunk’s voxel grid and your multiscale space.
  4) Optionally specify lowerClipBound/upperClipBound to restrict rendering.
  5) Push a SliceViewSingleResolutionSource { chunkSource, chunkToMultiscaleTransform, ... } into the returned arrays. The outer array indexes orientations; the inner array indexes scales from fine to coarse (or vice-versa; the utility code reorders as needed, but keep a consistent order, typically coarse-to-fine or fine-to-coarse). The filterVisibleSources logic in src/sliceview/base.ts picks suitable scales given zoom.

Multiple scales example sketch:
- For a three-scale pyramid, you might set chunkToMultiscaleTransform with voxel sizes [1,1,1], [2,2,2], [4,4,4] (or encode that into the matrix). Each scale also can have different chunkDataSize to better match the level’s voxel size.

Backends:
- For real data, implement a corresponding backend chunk source (worker) that understands your source’s spec key and returns bytes. Most datasources under src/datasource/* demonstrate this by subclassing GenericMultiscaleVolumeChunkSource or MultiscaleVolumeChunkSource and providing a backend counterpart.


### Review of your DummyMultiscaleVolumeChunkSource
File: src/voxel_annotation/volume_chunk_source.ts

What it sets up:
- Extends MultiscaleVolumeChunkSource with:
  - dataType = DataType.UINT32
  - volumeType = VolumeType.SEGMENTATION
  - rank = 3
- getSources returns a single orientation with a single scale:
  - chunkDataSize = [64, 64, 64]
  - upperVoxelBound = [1000, 1000, 1000]
  - lowerVoxelBound defaults to [0, 0, 0] via makeSliceViewChunkSpecification
  - spec = makeVolumeChunkSpecification({ rank, dataType, chunkDataSize, upperVoxelBound })
  - chunkSource = chunkManager.getChunkSource(VolumeChunkSource, { spec })
  - chunkToMultiscaleTransform = identity (no scaling, no rotation, 1 voxel unit per multiscale unit)
  - lowerClipBound = spec.lowerVoxelBound; upperClipBound = spec.upperVoxelBound
  - returns [[single]]

What this means in practice:
- Geometry and bounds:
  - Your multiscale space is a simple axis-aligned 1000x1000x1000 volume with voxel size implicitly equal to 1 in all axes (identity transform). Chunks are 64^3.
- Data type and volume type:
  - You chose segmentation semantics (VolumeType.SEGMENTATION) with UINT32 values. This is coherent; many segmentations are UINT32. It will influence shader behavior in the stock SliceViewVolumeRenderLayer (e.g., how interpolation and histogram calculations are treated).
- Multiscale levels:
  - Only a single scale is provided. The viewer won’t be able to switch to a coarser level as you zoom out. For testing this is fine; for large volumes, consider adding multiple scales.
- Backend data:
  - The frontend VolumeChunkSource expects the backend to provide chunk bytes. As written, there is no backend companion to actually fill data. Your VoxelAnnotationRenderLayer’s shader currently emits a procedural checkerboard using vChunkPosition and uChunkDataSize, which can render without sampling voxel textures — that’s why this can still “show something” even without real data. However, if you later want to read voxel values in the shader (e.g., segmentation ID), you’ll need a backend chunk provider.

Correctness/consistency observations:
- Using makeVolumeChunkSpecification with minimal fields is valid; lowerVoxelBound defaults correctly.
- The identity chunkToMultiscaleTransform is valid; it means multiscale coordinates and chunk voxel coordinates coincide. If your layer’s model/render transforms assume a different physical voxel size (e.g., anisotropic data), you should encode that scale into this matrix.
- VolumeType.SEGMENTATION + UINT32 can optionally benefit from compressed segmentation block sizes, but that is set on the spec via makeVolumeChunkSpecificationWithDefaultCompression (and requires chunkToMultiscaleTransform and options.multiscaleToViewTransform). For a dummy source, skipping compression is fine.
- The return shape [[single]] is correct: outer index is orientation (only one), inner is scale (only one).

Suggestions to evolve DummyMultiscaleVolumeChunkSource:
- Multiple scales: Create a list of specs for different resolutions. For each coarser level:
  - Either encode a larger voxel size into chunkToMultiscaleTransform (e.g., 2x, 4x) and keep a similar chunkDataSize, or keep voxel size = 1 and adjust transforms so that coarser scales map appropriately into multiscale space.
  - Return [[level0, level1, level2]] ordered from fine to coarse (or vice-versa consistently).
- Anisotropic voxels: If your data units are not isotropic, build chunkToMultiscaleTransform with per-axis scales (e.g., diag([sx, sy, sz, 1])).
- Clip bounds: You can tighten lowerClipBound/upperClipBound (floats allowed) to define a visible subregion without changing retrieval bounds.
- Backend stub: For development, add a backend VolumeChunkSource that fills chunks procedurally (e.g., write a pattern or ID = x+y+z) so you can test sampling in shaders and getValueAt.


### Quick look at your VoxelAnnotationRenderLayer (to see integration)
File: src/voxel_annotation/renderlayer.ts
- Extends SliceViewVolumeRenderLayer and overrides defineShader to render a 2D checkerboard using vChunkPosition.xy and uChunkDataSize.xy, without sampling volume data. This is consistent with your dummy source and is why you can render even without actual chunk bytes.
- initializeShader is a no-op (fine for now). The base class takes care of binding uniforms like uChunkDataSize, uLowerClipBound, uUpperClipBound, etc.

If/when you want to use real voxel values in the shader, you’ll need to:
- Let defineChunkDataShaderAccess (already wired by the base class) provide sampling functions and texture bindings.
- Ensure your backend supplies chunk data with the right format for the selected DataType.


### Minimal template for a multiscale source you can extend
- class MyMultiscaleSource extends MultiscaleVolumeChunkSource {
  - dataType = DataType.UINT32;
  - volumeType = VolumeType.SEGMENTATION;
  - get rank() { return 3; }
  - constructor(cm) { super(cm); }
  - getSources(options) {
    - const rank = this.rank;
    - const upperVoxelBound = new Float32Array([X, Y, Z]);
    - const scales = [1, 2, 4]; // voxel size multipliers
    - const sources = scales.map(s => {
      - const spec = makeVolumeChunkSpecification({
        rank,
        dataType: this.dataType,
        chunkDataSize: new Uint32Array([64,64,64]),
        upperVoxelBound,
        });
      - const chunkSource = this.chunkManager.getChunkSource(VolumeChunkSource, { spec });
      - const xform = new Float32Array((rank+1)*(rank+1));
        // set identity and scale diagonal by s
      - for (let i=0;i<rank;++i) xform[i*(rank+1)+i] = s;
      - xform[rank*(rank+1)+rank] = 1;
      - return { chunkSource, chunkToMultiscaleTransform: xform, lowerClipBound: spec.lowerVoxelBound, upperClipBound: spec.upperVoxelBound };
        });
    - return [sources]; // single orientation
      }
      }

That gives you a simple pyramid where coarser scales have larger voxel sizes in multiscale space.


### Bottom line
- Purpose: MultiscaleVolumeChunkSource declares the pyramid of chunk sources plus transforms used for rendering volumetric data. It’s the bridge between your data model and the renderer’s chunking and zoom-level logic.
- How to use: Subclass it, return one or more sources in getSources, and plug it into a SliceViewVolumeRenderLayer.
- How to extend: Add scales/orientations, set appropriate transforms and bounds, and implement or connect a backend chunk loader if you want to render actual voxel content.
- Your DummyMultiscaleVolumeChunkSource is a valid single-scale, identity-transform setup for a 1000^3 volume with 64^3 chunks and segmentation semantics. It’s great as a scaffold for wiring the layer and experimenting with shaders. Consider adding scales and (eventually) a backend chunk provider if you need real data sampling.
