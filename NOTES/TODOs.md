# TODO List
- optimize drawing tools (they are not really responsive rn)
- add color picker
- Fix the orientation of the disk in the brush tool 
- the uncaching of chunks the VoxSource is working great but since it has no way of knowing which chunks are in view it will delete them causing flickering of the drawings.

- exporting feature -> what format (a big map), which area (maybe add a setting in the voxel tab, or even better set by drawing a square), metadata?? 



# LOD

- the saving of drawing data are already indexed with their scale, to allow for multiscale rendering we should also provide a way to display the data coming from different scales then the current one. This involve two steps:
1. on saving of data, we should propagate complete voxel cube to the upper levels (lower zoom levels) recursively
2. on loading of data, we should retreive not only the current scale chunks but also the ones from the lower zoom levels.
This last step will introduce conflictsm what if the same voxel does not have the same value in the different scales? And how to know if there are been deletion or if there are just no data? To solve this we must introduce a special value for the deleted voxels and also timestamp for the last chunk updates. ~~To avoid too many conficts, we should resolve them when loading the data.~~ Actually, we should not resolve those conflicts live as doing so will prevent us from implementing an undo feature.
1
