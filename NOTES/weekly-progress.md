# Weekly progress on the vox annotation project

## Week 1 (2025-09-02 → 2025-09-07)

### Weekly narrative
The first week established the foundations for voxel annotations in Neuroglancer. The goal was to first familiarize myself with the project and the codebase while standing up a minimal yet end-to-end path for visualizing vox data and validating the rendering contract. We introduced the Vox layer type, a procedural dummy source to feed predictable data (a simple checkerboard). The main challenges were stabilizing the initial rendering path (fighting artifacts) and iterating on a concise but extensible annotation specification.

### Delivered capabilities
- Bootstrapped the Vox layer type and initial tooling for voxel annotations.
- Implemented the first rendering path and specification; added a procedural demo (VoxDummyChunkSource) to visualize data.
- Brought up the checkerboard demo and iterated on rendering stability.
- Reworked/expanded the voxel annotation specifications documentation.

### Notable commits (by brieuc.crosson)
- 2025-09-02 9b71be4f feat: add new dummy layer type: voxel annotation (vox)
- 2025-09-02 c1d2e802 feat: add a new dummy pixel tool
- 2025-09-02 07c116ad feat: retreive mouse position and current LOD scale
- 2025-09-04 c0ceef34 feat: add support for voxel annotation rendering and specification
- 2025-09-04 cbe55c86 feat: introduce VoxDummyChunkSource for procedural voxel annotation demo
- 2025-09-04 ff13ca26 feat: no errors but no checkboard tho
- 2025-09-05 8ea20800 feat: finaly the checkboard is showing, but it is a bit bugged out, it seems there is some fighting.
- 2025-09-05 6140a28b doc: rework voxel annotation specs

## Week 2 (2025-09-08 → 2025-09-14)

### Weekly narrative
This week focused on making editing practical and robust. We hardened the pixel tool, added a brush with configurable size, and tackled UX responsiveness during drawing. To persist user work, we introduced a local IndexedDB-backed store with RPC plumbing and laid groundwork for labels. We also began exploring remote sources and improved settings to handle extreme zoom-out safely. Key hurdles included a data corruption bug during edits and a coordinate conversion bug when scales differed; both were resolved while redesigning the toolbox UI.

### Delivered capabilities
- Made the pixel tool robust and added a brush tool with radius, eraser mode, continuous strokes, and disk/sphere shapes.
- Added user settings for scale and bounds; introduced a guard source for safe extreme zoom-out.
- Persisted edits to the backend and improved drawing responsiveness; redesigned the toolbox UI with structured layout.
- Implemented IndexedDB-backed local storage for maps/chunks/labels with RPC plumbing; added label creation and UI rendering.
- Supported region-based voxel initialization and expanded map options in the UI.
- Introduced remote HTTP(S) voxel source; migrated label API to addLabel; added project overview and process documentation.

### Notable commits (by brieuc.crosson)
- 2025-09-08 65565130 feat: working on the pixel tool, there are interaction but a bug seems to corruped the chunk after the usage of the tool. Added a front end buffer which is the only drawing storage for now. Added user settings to set the voxel_annotation layer scale and bounds. Added a second empty source to DummyMultiscaleVolumeChunkSource to prevent crashs when zoomed out too much
- 2025-09-08 14336ab4 feat: pixel tool is now working as intended
- 2025-09-08 44a6754f feat: fix pixel tool not working when the scale is not equal to the global one (there where a missing convertion) ; add a primitive brush tool
- 2025-09-08 a3f05989 refactor: rename DummyMultiscaleVolumeChunkSource to VoxMultiscaleVolumeChunkSource and update related imports
- 2025-09-08 238958a8 feat: brush size, eraser mode and little trivial optimization
- 2025-09-08 3017fe4c feat: continuous drawing and shape selection for the brush
- 2025-09-08 c517586e doc: add TODO list
- 2025-09-09 94af3d47 feat: small improvement on the drawing render delay
- 2025-09-09 faf0947d feat: persist voxel edits to backend and improve drawing responsiveness
- 2025-09-09 29d53634 feat: redesign toolbox with structured layout, tool selection, and expanded brush settings
- 2025-09-09 19f4e103 feat: implement new local voxel storage with IndexedDB, map initialization, and improved backend edit handling
- 2025-09-09 5172bc76 doc: brainstorming LOD
- 2025-09-10 92c3c215 feat: support region-based voxel initialization with corners, update map options and UI settings
- 2025-09-10 e70c9ff3 feat: expand TODOs with plans for segmentation compression, multi-user remote workflows, label creation, and new drawing tools
- 2025-09-10 e04b3167 feat: implement voxel label creation, persistence via IndexedDB, and enhanced UI rendering
- 2025-09-11 07a59c38 feat: implement RPC-based voxel label persistence
- 2025-09-11 73460e1d refactor: ran 'npm run format:fix'
- 2025-09-11 02e28fd4 feat: add support for remote voxel sources via HTTP(S) - (note: the labels are not sync currently)
- 2025-09-12 7c1a3b4e feat: replace `setLabelIds` with `addLabel` for label management
- 2025-09-12 673cea63 doc: add guidelines for junie and write project overview file
- 2025-09-12 d90b5569 feat: map creation and selection, the min scale is currently not saved and part of the codebase for this feature is subject to rewritting because of ugly code.
- 2025-09-12 39b3ff6f feat: cleanup map init/selection implementation, the remote still needs an update to align with the new architecture

## Week 3 (2025-09-15 → 2025-09-22)

### Weekly narrative
We turned to multiscale workflows and consistency across levels of detail. LOD-based painting and LOD locking shipped, and we began modularizing VoxSource implementations. We added chunk reload and downsample propagation to keep edited data coherent. An attempted “dirty-tree upscaling” approach was explored and intentionally dropped after discovering fundamental conflicts and quality loss when reconciling upscaled strokes. The system gained a centralized VoxelEditController, better invalidation/reload handling, a flood fill tool, a downscale job queue, and an export flow.

### Delivered capabilities
- Advanced multiscale/LOD workflow: enabled LOD-based brush painting and LOD locking; began moving VoxSource implementations into separate files.
- Introduced chunk reload and downsample propagation APIs; experimented with dirty-tree upscaling, then disabled it due to conflicts/quality loss; restricted brush size for stability.
- Added VoxelEditController to centralize edit flows; improved chunk invalidation and reload mechanics.
- Added flood fill tool; implemented a downscale job queue; refined reload handling and improved flood fill stability.
- Added Zarr export and reworked map settings UI, and started working on the import flow.

### Notable commits (by brieuc.crosson)
- 2025-09-15 0992672c refactor: remove `VoxelPixelLegacyTool`, update references, and enable LOD-based brush painting
- 2025-09-15 b08e9dd2 feat: add LOD locking for voxel rendering and extend brush size range
- 2025-09-15 92edee99 feat: move local and remote VoxSource to separate files, updated the LocalVoxSource and VoxChunkSource backend for handling of different lod level chunks
- 2025-09-15 e5ae7112 feat: move local and remote VoxSource to separate files, updated the LocalVoxSource and VoxChunkSource backend for handling of different lod level chunks
- 2025-09-16 6ec2674c feat: introduce chunk reload and downsample propagation APIs
- 2025-09-16 6ed8adda feat: chunk reloading from the backend -> currently do not work due to a design issue: the VoxSource is not unique, one is created for each VoxChunkSource
- 2025-09-16 1360c3ec feat: add Zarr export functionality and dirty-tree upscaling (not working for now)
- 2025-09-17 c8464f87 feat: dirty tree upscaling is kinda working, at least enough to conclude that this upscaling method wont work due to unsolvable conficts and lost unavoidable lost of quality due to upscaling of downscaled strokes. A new approach will be to enqueue every upscale and downscale and throttle the user when the queue is too full, with some kind of indicator in the ui. We also may need to restrict the max brush size to avoid too long waiting time.
- 2025-09-17 958df676 feat: restrict brush size and disable dirty tree upscaling
- 2025-09-18 c53888fc feat: introduce VoxelEditController for centralized edit handling and map management
- 2025-09-18 2508c671 refactor: improve chunk invalidation and reload workflows
- 2025-09-18 5335bc94 feat: add flood fill tool and export UI improvements
- 2025-09-18 e42d4fa4 feat: implement downscale job queue and improve chunk reload handling
- 2025-09-19 64f5f38e feat: enhance flood fill stability and optimize Zarr export
- 2025-09-19 ddc5c73e feat: rework map settings UI and add import/export improvements
- 2025-09-19 2addad4e doc: update TODOs

## Week 4 (2025-09-22 → 2025-09-29) — ongoing

### Weekly narrative
Week 4 kicked off the final leg of the basic I/O story by adding Zarr import and a remote-chunk fallback path. The motivation is to ensure people can round-trip data and recover missing local chunks from a remote source when needed. Early challenges include aligning fallback semantics with caching and ensuring consistency across LODs during import. Work is in progress.

### Delivered capabilities
- Started Week 4 with Zarr import support and integration of remote chunk fallback to complete the basic I/O path.

### Notable commits (by brieuc.crosson)
- 2025-09-22 73eb4ec3 feat: add Zarr import support and integrate remote chunk fallback
