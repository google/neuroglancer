## TODOs

### priority

- optimize frontend brush (test caching etc..)
- optimize flushPendings and the downsampling
- optimize the flood fill
- add `ctrl + middleclick` to flood fill when the brush is active
- `ctrl + shift` is no longer displaying the red cursor, it only appears after a click
- preview of selective eraser is broken
- optimize spheres using the full chunk
- see about the list of pending edits for the preview
- when chunk write fails, the chunk is not reloaded

### later

### questionable

- add color feedback on the brush cursor
- add preview for the undo/redo
- add support for volumes with rank different from 3
- add support to float32 dataset
- add support to unaligned hierarchy (e.g. child chunks that may have multiple parents)
- adapt the brush size to the zoom level linearly
