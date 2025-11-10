
## TODOs

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


## Merging vox layer into seg and img layers

The proposed architecture integrates voxel editing directly into the existing Image and Segmentation layers by leveraging their inherent capabilities, rather than introducing a separate, simplified render layer. The core of the design is a new UserLayerWithVoxelEditingMixin which equips a host UserLayer with an editing controller and an associated in-memory VolumeChunkSource for optimistic previews. When a user paints, the edits are applied locally to this in-memory source. A second instance of the layer's primary, feature-rich RenderLayer class is then used to draw these edits as an overlay. This ensures the live preview is rendered with the exact same user-defined shaders and settings as the base data for perfect visual fidelity, while also elegantly handling the performance issue of editing compressed chunks by operating on an uncompressed in-memory source. This architecture reuses existing components, simplifies the overall codebase by eliminating the need for a separate VoxelAnnotationRenderLayer, and cleanly separates the concerns of displaying committed data versus previewing transient edits.

```mermaid
sequenceDiagram
participant User
participant Tool as VoxelBrushTool
participant ControllerFE as VoxelEditController (FE)
participant EditSourceFE as OverlayChunkSource (FE)
participant BaseSourceFE as VolumeChunkSource (FE)
participant ControllerBE as VoxelEditController (BE)
participant BaseSourceBE as VolumeChunkSource (BE)

    User->>Tool: Mouse Down/Drag
    Tool->>ControllerFE: paintBrushWithShape(mouse, ...)
    ControllerFE->>ControllerFE: Calculates affected voxels and chunks

    ControllerFE->>EditSourceFE: applyLocalEdits(chunkKeys, ...)
    activate EditSourceFE
    EditSourceFE->>EditSourceFE: Modifies its own in-memory chunk data
    note over EditSourceFE: This chunk's texture is re-uploaded to the GPU
    deactivate EditSourceFE

    ControllerFE->>ControllerBE: commitEdits(edits, ...) [RPC]

    activate ControllerBE
    ControllerBE->>ControllerBE: Debounces and batches edits
    ControllerBE->>BaseSourceBE: applyEdits(chunkKeys, ...)
    activate BaseSourceBE
    BaseSourceBE-->>ControllerBE: Returns VoxelChange (for undo stack)
    deactivate BaseSourceBE
    ControllerBE->>ControllerFE: callChunkReload(chunkKeys) [RPC]
    activate ControllerFE
    ControllerFE->>BaseSourceFE: invalidateChunks(chunkKeys)
    note over BaseSourceFE: BaseSourceFE re-fetches chunk with the now-permanent edit.
    ControllerFE->>EditSourceFE: clearOptimisticChunk(chunkKeys)
    deactivate ControllerFE

    ControllerBE->>ControllerBE: Pushes change to Undo Stack & enqueues for downsampling
    deactivate ControllerBE

    loop Downsampling & Reload Cascade
        ControllerBE->>ControllerBE: downsampleStep(chunkKeys)
        ControllerBE->>ControllerFE: callChunkReload(chunkKeys) [RPC]
        activate ControllerFE
        ControllerFE->>BaseSourceFE: invalidateChunks(chunkKeys)
        note over BaseSourceFE: BaseSourceFE re-fetches chunk with the now-permanent edit.
        ControllerFE->>EditSourceFE: clearOptimisticChunk(chunkKeys)
        deactivate ControllerFE
    end
```
