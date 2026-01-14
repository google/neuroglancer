## TODOs

### priority

- optimize frontend brush (test caching etc..)
- optimize flushPendings and the downsampling
- ensure the operation load tracking goes until the end of the pipeline (e.g. the downsampling), currently it stops at the flushPendings
- add `ctrl + middleclick` to flood fill when the brush is active
- rework the sphere/disk calculation to only calculate the difference between the new sphree/disk and the last one
- optimize spheres using the full chunk
- see about the list of pending edits for the preview

### later

### questionable

- add color feedback on the brush cursor
- add preview for the undo/redo
- add support for volumes with rank different from 3
- add support to float32 dataset
- add support to unaligned hierarchy (e.g. child chunks that may have multiple parents)
- adapt the brush size to the zoom level linearly
