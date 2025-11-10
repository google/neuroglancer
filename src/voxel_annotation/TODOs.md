
### priority
- url completion for the ssa+https source

- should we support compressed chunks? if yes, we should find a better way to handle them.

### later
- optimize flood fill tool (it is too slow on area containing uncached chunks, due to the getEnsuredValueAt() calls)
- the flood fill sometimes leaves artifacts in sharp areas (maybe increase fillBorderRegion() radius)
- write a testsuite for the downsampler and ensure its proper working on exotic lod levels

### questionable
- design a dataset creation feature
- adapt the brush size to the zoom level linearly
