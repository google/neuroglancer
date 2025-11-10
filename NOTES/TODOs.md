# TODO List

- LOD -> where am I:
  - choosing the lod level depanding on the brush size, live rendering is working local data saving is working.
  - there are some performance issues at very high brush sizes (>1000)
  - fix the redownload trigger from the backend to the front -> making VoxLayer a true singleton
  - implement upscaling and dirty chunks marks

- cleanup label handling code (more specifically in the ui code: layer/vox/index.ts, would be nice to have a handler similar to the one for maps)
- Add redundancy to avoid corrupt/unsaved chunks on the remote
- Test token authentication
- Try to import pre-computed segmentation (in zarr format) into the remote server
- continue to study the segmentation compression, using it should greatly reduce the ram and indexDB usage, but it no easy integration of the hot chunk reloading in the frontend for drawing tool responsiveness has been found.
- add flood fill tool (with a max expansion safeguard), this tool should be 2d (e.g. act on a plane, the plane normal to the z axis is sufficient for a v1)
- Fix the orientation of the disk in the brush tool
- the uncaching of chunks the VoxSource is working great, but since it has no way of knowing which chunks are in view, it will delete them, causing flickering of the drawings.
- look into the massive ram usage when a lot of voxel annotations are drawn
- Add Uint64 support for annotation id
- Replace the current map settings to use the built-ins of neuroglancer (viewable under the datasource url), handle multimap with link choices, look into how to keep the init/creation logic.
- adapt the brush size to the zoom level linearly







# Saving/importing/exporting

The ExternalVoxSource will be activated when a zarr:// or precomputed:// link is provided. This will load the data from the remote to display, on edits, the data will still be saved in the local indexedDB. On retrieval of chunks, we must first check the IndexedDB and if not locally present, fetch the remote. An export feature should be added, this will hold the drawing capabilities, retrieve the entire data from the remote and merge it with the local modifications. Then reformat everything to the desired format.

The RemoteVoxSource will be activated when a https:// link to a specially made server is provided. This server will replace the local indexedDB and will be the new data owner, such a workflow may allow for multi-user collaboration.

# LOD

- the saving of drawing data is already indexed with their scale; to allow for multiscale rendering, we should also provide a way to display the data coming from different scales than the current one. This involves two steps:

1. on saving of data, we should propagate the complete voxel cube to the upper levels (lower zoom levels) recursively
2. on loading of data, we should retrieve not only the current scale chunks but also the ones from the lower zoom levels.
   This last step will introduce conflicts what if the same voxel does not have the same value in the different scales? And how to know if there has been deletion or if there are just no data? To solve this, we must introduce a special value for the deleted voxels and also timestamp for the last chunk updates. ~~To avoid too many conficts, we should resolve them when loading the data.~~ Actually, we should not resolve those conflicts live as doing so will prevent us from implementing an undo feature.

Drawing Flow chart:
-> Brush stroke start
  -> lock LOD level to the brush size one
  -> Live render the drawing
  -> Commit modifications to backend -> Save, downsample and mark upsamples as dirty (they will be recalculated on the fly when needed)
-> Brush stoke ends
  -> Unlock LOD level (maybe add a small delay to avoid flickering)
  -> Progressivly download upscalings as they roll out
