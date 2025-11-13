## TODOs

### priority

- the writing pipeline is only working for uint32 data, which was to be expected as I only used uint32 throughout the development, now that the dataset creation ~~is~~ (will soon be) working (so it is easy to test for every data type), I should fix this.
- the brush circle is not always correct: it is currently aligned with the global voxel size and not the local one, also it may not always be a circle?
- look into @chrisj comment
- rework zarr writing to support compression and v3

- Dataset creation:
  - the copy from existing seems to not be right on all settings
  - complete zarr support (compression and zarr v3)

### later

- add preview for the undo/redo
- url completion for the ssa+https source

### questionable

- write a testsuite for the downsampler and ensure its proper working on exotic lod levels
- adapt the brush size to the zoom level linearly
