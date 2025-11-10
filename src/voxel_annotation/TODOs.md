
### priority
- url completion for the ssa+https source
- different mouse cursors for the different tools

- should we support compressed chunks? if yes, we should find a better way to handle them.

### later
- rework the ui (draw tabs) to fit neuroglancer style
- optimize flood fill tool (it is too slow on area containing uncached chunks, due to the getEnsuredValueAt() calls)
- rework the url autocomplete for the ssa+https source.
- the flood fill sometimes leaves artifacts in sharp areas (maybe increase fillBorderRegion() radius)
- add shortcuts for tools (switching tools, toggle erase mode and adjusting brush size) and label creation
- write a testsuite for the downsampler and ensure its proper working on exotic lod levels
- fix undo/redo buttons activation states (see tabs/tools.ts)

### questionable
- design a dataset creation feature
- adapt the brush size to the zoom level linearly
