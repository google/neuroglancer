## TODOs

### priority

### later

- add preview for the undo/redo
- url completion for the ssa+https source

### questionable

- add support for volumes with rank different from 3
- add support to float32 dataset
- add support to unaligned hierarchy (e.g. child chunks that may have multiple parents)
- adapt the brush size to the zoom level linearly

## Tests

- src/voxel_annotation/edit_backend.ts
  - [x] \_calculateParentUpdate
  - [x] \_getParentChunkInfo
  - [x] downsampleStep
  - [x] undo/redo
  - [x] flushPending
- src/voxel_annotation/edit_controller.ts
  - [ ] floodFillPlane2D
  - [ ] paintBrushWithShape
- src/layer/vox/index.ts
  - [x] getVoxelPositionFromMouse
  - [x] setVoxelPaintValue
  - [x] transformGlobalToVoxelNormal
- src/sliceview/volume/backend.ts
  - [x] applyEdits
- src/sliceview/volume/frontend.ts
  - [ ] applyLocalEdits
- src/datasource/zarr/backend.ts
  - [ ] writeChunk
