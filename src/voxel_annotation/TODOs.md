## TODOs

### priority

- url completion for the ssa+https source
- fix the case of multiple datasources in the same layer

### later

- should we allow drawing even when there are no writable volume, and in that case inform the user about it and only draw edits in the preview layer? I am not sure about the real use cases tho.
- add preview for the undo/redo
- optimize flood fill tool (it is too slow on area containing uncached chunks, due to the getEnsuredValueAt() calls)
- the flood fill sometimes leaves artifacts in sharp areas (maybe increase fillBorderRegion() radius)
- write a testsuite for the downsampler and ensure its proper working on exotic lod levels

### questionable

- design a dataset creation feature
- adapt the brush size to the zoom level linearly
