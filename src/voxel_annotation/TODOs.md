## TODOs

### priority

### later

- add preview for the undo/redo
- url completion for the ssa+https source
- writable float32 dataset is not working (expected), either block its usage or fix

### questionable

- add support for volumes with rank different from 3
- adapt the brush size to the zoom level linearly

## Tests

- src/voxel_annotation/edit_backend.ts
  - [x] \_calculateParentUpdate
  - [x] \_getParentChunkInfo
  - [x] downsampleStep
  - [ ] undo/redo
  - [x] flushPending
- src/voxel_annotation/edit_controller.ts
  - [ ] floodFillPlane2D
  - [ ] paintBrushWithShape
- src/layer/vox/index.ts
  - [ ] getVoxelPositionFromMouse
  - [ ] setVoxelPaintValue
  - [ ] transformGlobalToVoxelNormal
- src/sliceview/volume/backend.ts
  - [x] applyEdits
  - [ ] computeChunkBounds
- src/sliceview/volume/frontend.ts
  - [ ] applyLocalEdits
- src/datasource/zarr/backend.ts
  - [ ] writeChunk
