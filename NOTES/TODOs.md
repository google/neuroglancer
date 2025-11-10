# TODO List

- FOR TOMORROW: start to prepare the problematic/email to JMS

- Fix the orientation of the disk in the brush tool
- Add support for flood fill on different planes
-? adapt the brush size to the zoom level linearly
- rework the ui (tabs)
- add shortcuts for tools (switching tools, toogle erase mode, select label from the pointed one in the slice view and adjusting brush size) and label creation
- the flood fill sometimes leaves artifacts in sharp areas
- rework the autocomplete for the ssa+https source.
- fix the flood fill for compressed chunks
- rework the drawing preview for compressed chunk (see applyLocalEdits())
- optimize flood fill tool (it is too slow on area containing uncached chunks, due to the getEnsuredValueAt() calls)

- rework vox backend
- rework label handling
