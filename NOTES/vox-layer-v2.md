L'implementation actuelle du vox layer ne suis pas le principe fondamental de neuroglancer visant a separer les layer des data source. Cela ce manifest dans le fait que le vox layer ne support seulement le format zarr v2 sans compression grace a deux fichiers temporaires que sont [import_from_zarr.ts](../src/voxel_annotation/import_from_zarr.ts) et [export_to_zarr.ts](../src/voxel_annotation/export_to_zarr.ts). Ces fichiers ont ete cree pour un besoin de proofs of concept (POC) mais il va de soi qu'une implementation propre du vox layer ne sera possible que lorsque les differents datasource seront supporte. Mais supporter ces datasource n'est pas trivial, cela require de faire des changements dans le code de neuroglancer qui ne support que les operation de lecture. Alors Kvstore, datasource et autre auront besoin d'etre augmenter de capacite d'ecriture.
En sommes, nous arrivons a un point de bascule qui require un potentiel fort refactor de l'implementation actuelle du vox layer, mais cette tache est complexe a cadrer et c'est pourquoi notre premier travail sera de realiser un etat des lieu de l'implementation et d'en reecrire par la suite la nouvelle architecture. 


Jalon no1:
Abstraction des datasources, writtable kvstore&datasource:
- L'utilisation de l'indexedDB (local datasource) ne doit plus etre systematique, celle-ci doit etre encapsulee dans un datasource a l'instar de zarr ou precomputed.
- Deux nouvelles classes 

## What do we have right now

### Custom map system / data source

To facilitate the creation of a proof of concept, I bypassed the data handling pipeline of neuroglancer, I used a dummy `local://voxel_annotation` datasource and created a secondary simple data management system that includes a ui for map (the term I used to refer to a specific dataset) creation, selection and importation/exportation from/to zarr v2 uncompressed dataset on s3 buckets. The data is also saved in a local IndexedDB (note: the use of OPFS would have been more appropriate) with a custom format for persistence.
The related code include:
- [map.ts](../src/voxel_annotation/map.ts) map utils including a VoxMapConfig object to transmit the selected map config
- [index.ts](../src/voxel_annotation/index.ts) and [local_source.ts](../src/voxel_annotation/local_source.ts) the data source and its indexedDB management, it exposed a `VoxSource` which is read-only and destined to be used by the chunk source and a `VoxSourceWriter` which is writable and destined to be used by the unique edit controller
- [settings.ts](../src/layer/vox/tabs/settings.ts) the ui for map creation and selection
- [import_from_zarr.ts](../src/voxel_annotation/import_from_zarr.ts) and [export_to_zarr.ts](../src/voxel_annotation/export_to_zarr.ts) the zarr v2 import/export tools

### Rendering

A simple `VoxelAnnotationRenderLayer` ([renderlayer.ts](../src/voxel_annotation/renderlayer.ts)) provides a shader who proceduraly assigns a color to an uint64 label value (similarely to the segmentation layer) and renders those colors at 50% opacity. If the label is 0, nothing is displayed.

### Chunking

A `VoxMultiscaleVolumeChunkSource` ([volume_chunk_source.ts](../src/voxel_annotation/volume_chunk_source.ts)) handles the multi-resolution chunking for the voxel data. It generates a hierarchy of resolutions (levels of detail) based on the `steps` defined in the `VoxMapConfig`. For each resolution level, it creates a `VoxChunkSource` ([frontend.ts](../src/voxel_annotation/frontend.ts)) which is responsible for fetching individual data chunks. The backend counterpart, [backend.ts](../src/voxel_annotation/backend.ts), retrieves chunk data from the local IndexedDB source or the remote Zarr import source if available, otherwise returning an empty, zero-filled chunk.

### Editing

Only the max resolution voxels can be painted, when painting, the chunk are scheduled to be downsampled. The edited chunk are directly updated in the frontend and then persisted to the data source. We can paint using a brush (disk shape or sphere) or a flood fill tool (flooding only on 2d slices). 

The choice was made to first make the annotation work at this max resolution detail and later look at how to make upscaling work (two approach are possible, one direct like the downscaling or one delegated to when we actually need the chunk, the first one is simple but will not work for approx 3/4 levels max, the second could be less limited but comport confict handling issue which would require us to design a more complex system)

Editing functionality is managed through a `VoxelEditController` which acts as a bridge between the user interface and the backend data storage. The frontend controller ([edit_controller.ts](../src/voxel_annotation/edit_controller.ts)) receives edit commands, such as painting with a brush, from UI tools defined in [voxel_annotations.ts](../src/ui/voxel_annotations.ts).

These edits are then batched and sent via RPC to the `VoxelEditController` backend ([edit_backend.ts](../src/voxel_annotation/edit_backend.ts)). The backend owns the authoritative `VoxSourceWriter` for a given map and applies these edits. To persist the changes, the edited chunks are written to the local IndexedDB. The backend also queue Downsampling jobs for each edited chunk, when downsampled, a chunk is then triggered to be realoaded (note: this reloading feature still needs to be correctly implemented, for now I invalidate a whole VoxChunkSource to force a reload of the chunk).

The live preview of paintings and chunk reloading are handled in the `VoxChunkSource`, as well as some calculations for the painting tool (e.g. the flood fill algorithm for example, which requires reading voxels around the target).

## What we want to achieve

Obviously, we want to replace the current custom data handling with the one of neuroglancer. But neuroglancer has been design as a read-only system. Without delving too much into the technical details, we first need to choose how we want to consider our writting path:
- we could require to use datasource that are read-write, then if we want to modify a segmentation the user would need to copy the wanted area to a writtable source.
- we could add a way to specify a secondary writtable datasource aside of the read-only one. Then the writtable source would contain an overlay of edits to apply over the original data.

This new approach would replace the whole `custom map system / data source` detailed above.
