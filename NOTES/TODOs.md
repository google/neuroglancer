# TODO List
- continue to study the segmentation compression, using it should greatly reduce the ram and indexDB usage, but it no easy integration of the hot chunk reloading in the frontend for drawing tool responsiveness has been found.
- add flood fill tool (with a max expansion safeguard), this tool should be 2d (e.g. act on a plane, the plane normal to the z axis is sufficient for a v1)
- Fix the orientation of the disk in the brush tool 
- the uncaching of chunks the VoxSource is working great, but since it has no way of knowing which chunks are in view, it will delete them, causing flickering of the drawings.
- Add Uint64 support for annotation id

# Saving/importing/exporting

The ExternalVoxSource will be activated when a zarr:// or precomputed:// link is provided. This will load the data from the remote to display, on edits, the data will still be saved in the local indexedDB. On retrieval of chunks, we must first check the IndexedDB and if not locally present, fetch the remote. An export feature should be added, this will hold the drawing capabilities, retrieve the entire data from the remote and merge it with the local modifications. Then reformat everything to the desired format.

The RemoteVoxSource will be activated when a https:// link to a specially made server is provided. This server will replace the local indexedDB and will be the new data owner, such a workflow may allow for multi-user collaboration.

# LOD

- the saving of drawing data is already indexed with their scale; to allow for multiscale rendering, we should also provide a way to display the data coming from different scales than the current one. This involves two steps:
1. on saving of data, we should propagate the complete voxel cube to the upper levels (lower zoom levels) recursively
2. on loading of data, we should retrieve not only the current scale chunks but also the ones from the lower zoom levels.
This last step will introduce conflicts what if the same voxel does not have the same value in the different scales? And how to know if there has been deletion or if there are just no data? To solve this, we must introduce a special value for the deleted voxels and also timestamp for the last chunk updates. ~~To avoid too many conficts, we should resolve them when loading the data.~~ Actually, we should not resolve those conflicts live as doing so will prevent us from implementing an undo feature.

