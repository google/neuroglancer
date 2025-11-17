## TODOs

### priority

- writable float32 dataset is not working (expected), either block its usage or fix

- Dataset creation:
  - the chunk size is currently hardcoded to 64x64x64, preventing use of rank different than 3 

### later

- add preview for the undo/redo
- url completion for the ssa+https source

### questionable

- write a testsuite for the downsampler and ensure its proper working on exotic lod levels
- adapt the brush size to the zoom level linearly
