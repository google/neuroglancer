### What “chunk sources” are in the annotation system

In Neuroglancer, rendering and data flow are built around chunked sources:

- Frontend chunk sources live on the main thread and integrate with rendering, visibility, and GPU upload.
- Backend chunk sources live in a Web Worker and actually fetch/produce the bytes for each chunk.
- The two halves are paired via a small RPC layer. The frontend owner has a type id; the backend counterpart class registers itself under the same id. When the frontend initializes, it requests the backend to construct the counterpart, and they talk by sending messages with ids.

For annotations, the system uses three closely-related chunk sources on the frontend side (with backend counterparts):
- AnnotationGeometryChunkSource: provides spatially indexed geometry of annotations to draw (slice-view geometry per chunk).
- AnnotationSubsetGeometryChunkSource: a filtered geometry source tied to segmentation relationships; supplies geometry subsets keyed by segment id.
- AnnotationMetadataChunkSource: per-annotation metadata keyed by annotation id (used to keep the value of AnnotationReference in sync).

These objects are owned on the frontend and mirrored on the backend. They’re coordinated by MultiscaleAnnotationSource, which:
- Holds and wires the three sources together.
- Keeps local references and local-update state for edits (add/update/delete).
- Initializes its counterparts in the worker (passing nested shared-object references, like its metadata/filtered sources and the chunk manager id).

The voxel_annotation dummy volume you added (VoxDummyChunkSource) uses the same pairing mechanism as the standard volume/annotation sources: the frontend owner sets a shared type id; the backend counterpart registers with the same id and implements download(), which fills chunk.data with a procedurally generated pattern.


### Frontend↔Backend synchronization: the RPC pairing

- On the owner side, classes are decorated with @registerSharedObjectOwner("…ID…"). When they call initializeCounterpart(rpc, options), the RPC sends a SharedObject.new(type=ID, options) message.
- On the worker side, counterpart classes are decorated with @registerSharedObject("…ID…"). The worker’s SharedObject.new handler looks up the constructor for that id and constructs the backend instance.
- Both sides keep ref-counted object handles with a shared numeric id. You can nest references to other shared objects inside options (e.g., pass a MetadataChunkSource id to the backend inside the parent’s initialize payload).

For annotation commit flow specifically, there are two named RPCs (strings exported from annotation/base):
- ANNOTATION_COMMIT_UPDATE_RPC_ID: frontend→backend to request an add/update/delete commit.
- ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID: backend→frontend to return success/failure and the updated annotation (or null for deletion).


### The annotation edit pipeline (buffering + commit system)

The key design goal is to show edits immediately on the frontend (optimistic UI), while guaranteeing consistency as the authoritative backend accepts/rejects them.

1) Local overlay buffering on the frontend
- MultiscaleAnnotationSource maintains:
  - references: Map from annotation id to AnnotationReference; each holds the current value and a changed signal for listeners.
  - localUpdates: Map from id → LocalUpdateUndoState. Tracks:
    - existingAnnotation: the server-committed annotation prior to local edits (if any).
    - commitInProgress: the annotation payload (or null for deletion) that has been sent and is awaiting backend result.
    - pendingCommit: a queued annotation payload to send after commitInProgress finishes (if the user edited again before the prior commit returned).
  - temporary: an in-memory “temporary geometry chunk” overlay that stores serialized bytes for the edited version of an annotation until the commit completes.

- When you call add/update/delete (or add followed by commit):
  - applyLocalUpdate() moves geometry bytes out of any existing visible geometry chunks (deleteAnnotation from those chunks) and writes the edited geometry into the temporary overlay chunk (updateAnnotation). This ensures rendering immediately reflects the local edit.
  - It updates the AnnotationReference.value on the frontend and notifies listeners (notifyChanged), causing render invalidation and UI updates without waiting for the backend.

2) Sending the commit request
- If commit=true, applyLocalUpdate() either:
  - queues the new edit into pendingCommit if a commit is already in-flight for that annotation, or
  - calls sendCommitRequest():
    - increments a global commit-in-progress counter (used to show a StatusMessage like “Committing annotations”).
    - sets commitInProgress to the payload.
    - invokes ANNOTATION_COMMIT_UPDATE_RPC_ID with { id: this.rpcId, annotationId?, newAnnotation? }:
      - annotationId undefined + newAnnotation → add
      - annotationId set + newAnnotation → update
      - annotationId set + newAnnotation null → delete

3) Backend receives commit
- The worker-side registerRPC(ANNOTATION_COMMIT_UPDATE_RPC_ID, …) handler looks up the AnnotationSource counterpart object from x.id and dispatches to obj.add/delete/update as appropriate. Those methods are expected to return a Promise with the outcome.
- Once resolved, it invokes ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID to the frontend with { id, annotationId, newAnnotation | error }. Note there’s a FIXME in the backend handler: “Handle new chunks requested prior to update but not yet sent to frontend.” This is a hint that the backend does not yet buffer/resynchronize in-flight visible-chunk streams vs. the commit result; the frontend overlay is the primary buffering mechanism for edits.

4) Frontend applies commit result
- The frontend registerRPC(ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID, …) handler calls either handleSuccessfulUpdate or handleFailedUpdate.

- On success (handleSuccessfulUpdate):
  - Decrement the global commit counter and potentially clear the “Committing annotations” StatusMessage.
  - If the server returned a new id (common on add), re-key all local state:
    - Update AnnotationReference.id and references map entries.
    - If there is an overlay entry in the temporary chunk, delete the old-id overlay and write a new overlay with the updated id.
  - Set existingAnnotation to the newAnnotation (or undefined if null), clear commitInProgress.
  - If there was a pendingCommit queued during the in-flight commit, update its id to the returned id (if needed) and immediately send a new commit request. Otherwise, revert the local overlay to finish the cycle (see below).

- On failure (handleFailedUpdate):
  - Show an error StatusMessage.
  - Revert local overlay and references (revertLocalUpdate):
    - Remove any edited overlay geometry for this id from the temporary chunk.
    - If there was an existingAnnotation, add its geometry back into visible geometry chunks (updateAnnotation for those chunks) so the display matches server state.
    - Restore AnnotationReference.value to existingAnnotation (or null) and dispatch its changed signal.
  - Decrement the global commit counter.

5) Reverting overlay after a successful cycle
- If there is no pending commit, revertLocalUpdate() is called to remove the overlay and restore the world to a “no local edits pending” state. Since existingAnnotation has already been updated to the committed version, the visible chunks + metadata now represent the committed data, and the temporary overlay can be dropped.

6) Metadata sync for live references
- MetadataChunkSource is used so that references.get(id) consumers stay synced: when a metadata chunk arrives for an id, AnnotationMetadataChunkSource.addChunk sets the associated AnnotationReference.value and dispatches changed.
- notifyChanged() is also called whenever local overlay changes the value, so UI stays responsive.


### How chunk streaming and visibility interact with edits

- Geometry chunks are streamed independently of commits. The backend recomputes priorities for visible annotation chunks based on the view, and for each needed chunk requests it from the appropriate backend geometry source (spatially indexed or subset by segmentation). When bytes arrive, the frontend replaces or updates the corresponding chunk’s AnnotationGeometryData.
- The frontend overlay logic in temporary ensures local edits appear immediately, regardless of when backend geometry chunks stream in. The overlay is kept separate from streamed chunks and is applied/removed deterministically during the commit flow.
- A note in backend commit handling acknowledges a potential race: a chunk could be requested based on an outdated state. The overlay strategy on the frontend is what guarantees the user sees their edits; any mismatches are corrected as commits resolve and overlay is removed.


### The buffering model in a nutshell

- Frontend buffering: a dedicated temporary chunk stores serialized geometry for locally edited annotations. It is immediately read by the renderer to display edits. This buffer is the single source of truth for in-flight user edits.
- Queuing and coalescing: if an edit for the same annotation happens while a commit is in-flight, the new payload is queued in pendingCommit. As soon as the in-flight commit returns, the queued payload is updated with the authoritative id (if needed) and is sent immediately. This effectively debounces rapid user edits into a linear sequence of commits without losing intermediate UI responsiveness.
- Backend buffering: the backend does not do significant edit buffering; it executes add/update/delete and returns results. The FIXME suggests future work could better correlate pre-commit chunk requests with post-commit state, but the current design relies on the frontend overlay to mask such transitions.


### Where to look in code (ready-made pointers)

Frontend (src/annotation/frontend_source.ts):
- MultiscaleAnnotationSource
  - applyLocalUpdate() — creates/updates the local overlay, manages pending/active commit flags.
  - sendCommitRequest() — sends ANNOTATION_COMMIT_UPDATE_RPC_ID and marks commitInProgress.
  - handleSuccessfulUpdate() — applies server result, re-keys ids, chains pending commits, and reverts overlay when done.
  - handleFailedUpdate() — shows error, reverts overlay to the last committed state.
  - revertLocalUpdate() — the overlay/undo routine.
  - notifyChanged() — synchronizes AnnotationReference and invalidates rendering.
- AnnotationGeometryChunkSource, AnnotationSubsetGeometryChunkSource, AnnotationMetadataChunkSource — the three chunk sources used by the layer to render and to keep references synced.

Backend (src/annotation/backend.ts):
- registerRPC(ANNOTATION_COMMIT_UPDATE_RPC_ID, …) — receives commit requests, routes them to add/update/delete, sends result via ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID.
- AnnotationSpatiallyIndexedRenderLayerBackend.recomputeChunkPriorities() — visibility-driven chunk scheduling that requests geometry chunks.


### Relation to your VoxDummyChunkSource

Your voxel_annotation VoxDummyChunkSource mirrors the standard infrastructure used above:
- Frontend owner: VoxDummyChunkSource (src/voxel_annotation/frontend.ts) extends volume/frontend VolumeChunkSource and is annotated with @registerSharedObjectOwner(VOX_DUMMY_CHUNK_SOURCE_RPC_ID).
- Backend counterpart: VoxDummyChunkSource (src/voxel_annotation/backend.ts) extends volume/backend VolumeChunkSource and is decorated with @registerSharedObject(VOX_DUMMY_CHUNK_SOURCE_RPC_ID). It implements download() to fill chunk.data with a checkerboard pattern.
- The RPC pairing and chunk lifecycle are the same: frontend requests visible chunks, backend download() produces bytes, they’re transferred back and uploaded to GPU by the frontend’s format handler; rendering samples those textures in your custom render layer.


### Practical implications for modifying or extending the commit/buffering logic

- To change how many edits can be coalesced: adjust logic around pendingCommit and commitInProgress in applyLocalUpdate, handleSuccessfulUpdate, and sendCommitRequest. The current model serializes edits: one in-flight + at most one queued per annotation id. You could extend it to keep a small queue and squash updates.
- To draw overlay differently (e.g., highlight uncommitted edits): modify how the temporary chunk is fed into the shader/render mix. Today, temporary bytes are written in a separate chunk object; your render layer or geometry-data upload path could add a visual flag.
- To ensure consistency with streaming chunks: if you need stronger guarantees that streamed chunks reflect post-commit state, you could implement a small backend-side buffer or generation tracking in the annotation geometry sources, then drop or re-request chunks when a commit completes.
- To wire new properties into commit: extend AnnotationPropertySerializer and the serialize/deserialize paths used by updateAnnotation/deleteAnnotation/computeNumPickIds.


### TL;DR flow

- User edits → frontend immediately updates a “temporary” overlay chunk and updates the AnnotationReference value; UI responds instantly.
- If commit requested → frontend sends ANNOTATION_COMMIT_UPDATE_RPC_ID to worker, marks commitInProgress; subsequent edit on same id sets pendingCommit.
- Backend performs add/update/delete; returns via ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID.
- Frontend success: re-key ids if needed, chain any pendingCommit, or revert overlay to the committed state; failure: revert overlay to prior committed state and show error.
- Meanwhile, visible annotation geometry chunks stream independently; the overlay ensures visual correctness during the transition.

If you want, I can also trace the exact WebGL upload path for AnnotationGeometryData and where the temporary overlay’s bytes are combined with streamed chunks at draw time, or sketch how to add a visual “pending commit” tint to uncommitted annotations.
