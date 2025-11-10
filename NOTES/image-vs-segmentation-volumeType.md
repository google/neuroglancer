### High-level difference

- IMAGE: Continuous-valued voxels (intensities). Intended for interpolation, contrast/brightness adjustments, and colormap visualization.
- SEGMENTATION: Discrete/categorical labels (segment IDs). Must not be interpolated; visualized by mapping IDs to colors, supporting selection/highlighting of segments.

### Semantics and typical data types

- IMAGE
  - Common types: UINT8, UINT16, FLOAT32 (sometimes INT16, etc.).
  - Often multi-channel (RGB, multi-stain, etc.).
- SEGMENTATION
  - Common types: UINT32, UINT64 (single-channel ID field).
  - Values represent object IDs; exact integrity of values matters.

### Sampling and interpolation

- IMAGE
  - Linear interpolation for smooth zooming and slicing.
  - Pyramids/scales typically produced via averaging or linear filters.
- SEGMENTATION
  - Nearest-neighbor sampling (no linear interpolation) to avoid fractional/invalid IDs.
  - Pyramids/scales should be built with label-aware reducers (e.g., majority vote), not averaging.

### Rendering and shader behavior

- IMAGE
  - Intensity pipelines: window/level, colormaps, per-channel blending, histograms.
  - Smooth transitions; edges may be anti-aliased by interpolation.
- SEGMENTATION
  - ID-to-color mapping (hash/lookup) with crisp, non-interpolated boundaries.
  - UI and shaders support features like selected/visible segments, recoloring, and highlighting.

### Compression and storage defaults

- IMAGE
  - Uses standard chunk formats; compression (if any) is typically external/transport-level.
- SEGMENTATION
  - Eligible for compressed segmentation formats (blockwise) when rank/type conditions match (e.g., 3D, UINT32/UINT64). This reduces bandwidth and memory for uniform regions.
  - In Neuroglancer’s code, makeVolumeChunkSpecificationWithDefaultCompression enables compressedSegmentationBlockSize when volumeType is SEGMENTATION (or discreteValues is true) and other criteria are met.

### Picking and interaction

- IMAGE
  - Picking returns intensities (possibly per-channel). Useful for measurements/QA.
- SEGMENTATION
  - Picking returns a segment ID. The UI typically supports selecting, showing/hiding segments, equivalence mapping, and integration with meshes/skeletons for that ID.

### Histograms and UI controls

- IMAGE
  - Histogram-based contrast controls, colormap selection, per-channel adjustments.
- SEGMENTATION
  - No meaningful intensity histogram. UI focuses on segment sets, visibility, and highlighting.

### Multiscale generation expectations

- IMAGE: Averaging/linear filtering for downsampling.
- SEGMENTATION: Mode/majority voting or other label-preserving downsampling.

### Channel semantics

- IMAGE: Multi-channel common; RGB or arbitrary channel mixing.
- SEGMENTATION: Typically single-channel ID. Multiple channels would imply multiple label volumes and need custom handling.

### Choosing between IMAGE and SEGMENTATION

Pick SEGMENTATION if:

- Voxels encode labels/IDs that must be exact (no interpolation).
- You need segment selection/highlighting and ID-centric tooling.
- You want segmentation block compression benefits.

Pick IMAGE if:

- Voxels are continuous intensities.
- You want linear interpolation, window/level, and colormaps.
- You handle multi-channel blending or RGB imagery.

### Practical impact in this codebase

- VolumeType is defined in src/sliceview/volume/base.ts and used by multiscale and render paths to pick defaults.
- Compression choice: shouldTranscodeToCompressedSegmentation and makeVolumeChunkSpecificationWithDefaultCompression check VolumeType and DataType to set compressedSegmentationBlockSize for segmentation.
- Render paths for sampling, decoding, and shader helpers differ for segmentation vs image (e.g., nearest sampling and optional decompression for segmentation).

### Notes for your DummyMultiscaleVolumeChunkSource

- You set volumeType = SEGMENTATION and dataType = UINT32, which is appropriate for label volumes.
- Your shader currently draws a procedural checkerboard and doesn’t sample voxel data; it won’t yet exercise segmentation decoding or nearest sampling. If you later sample voxel values to color by ID or enable segment picking, the SEGMENTATION setting will align with the right defaults and UI behavior.

### Summary

- IMAGE = continuous intensities, linear interpolation, histogram/colormap UI, typical UINT8/16/F32, averaged pyramids.
- SEGMENTATION = discrete labels/IDs, nearest sampling, segment-centric UI, typical UINT32/64, label-preserving pyramids, compressed segmentation support.
