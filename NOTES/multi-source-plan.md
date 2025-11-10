### Objective
Convert the vox layer from bespoke sources (`VoxMultiscaleVolumeChunkSource`, monolithic `VoxChunkSource`) to a datasource-agnostic overlay that wraps any existing `VolumeChunkSource`, while keeping `LocalVoxSource` as the persistence layer.

### Non-negotiable constraints
- Strong typing: explicit interfaces, no silent fallbacks, throw on unsupported types or missing wiring.
- No changes to base classes (`SliceViewChunkSource`, `VolumeChunkSource`, `MultiscaleVolumeChunkSource`).
- No casting with `as` unless absolutely necessary; prefer explicit type guards.
- MVP data type is `UINT32`. Reject others clearly.

### Current inventory (relevant files)
- `src/voxel_annotation/volume_chunk_source.ts`: `VoxMultiscaleVolumeChunkSource` builds `VoxChunkSource` levels.
- `src/voxel_annotation/frontend.ts`: frontend `VoxChunkSource` subclass of `VolumeChunkSource` with editing concerns.
- `src/voxel_annotation/backend.ts`: backend `VoxChunkSource` subclass of `VolumeChunkSource`, returns saved or zero-filled chunks.
- `src/voxel_annotation/local_source.ts`: `LocalVoxSource` persistence.
- `src/voxel_annotation/remote_source.ts`: deprecated, do not use
- `src/layer/vox/index.ts`: vox layer entry.
- Base stack: `src/sliceview/volume/{frontend,backend}.ts`, `src/datasource/*` (e.g., `zarr/backend.ts`).

### Target architecture (overlay-based)
- Frontend overlay: `VoxVolumeChunkSource` that wraps an existing `VolumeChunkSource` instance, delegates fetching, integrates edit tools and invalidation hooks, and initializes a backend overlay via RPC.
- Backend overlay: `VoxVolumeChunkSource` that wraps the backend counterpart of the real datasource source and merges edits from `LocalVoxSource` before handing data back to the pipeline.
- Layer: `vox` layer consumes any `MultiscaleVolumeChunkSource` (precomputed, zarr, nifti, …), and wraps each returned `chunkSource` with `VoxVolumeChunkSource` on-the-fly.

### New/updated types and RPCs
- `VoxVolumeChunkSourceFrontendOptions` with `spec`, `innerSourceRpcId`, `map: VoxMapConfig` (and optional `sharedKvStoreContextRpcId` if needed by remote import only).
- `VoxVolumeChunkSourceBackendOptions` with `innerSourceRpcId`, `map: VoxMapConfig`.
- Keep existing `VOX_MAP_INIT_RPC_ID` to initialize the overlay with the map.
- Keep existing `makeVoxChunkKey` scheme; include LOD in key calculation.

### Step-by-step conversion plan

#### Phase 0 — Preflight checks and guards
- Add hard validations in the overlay creation path:
  - `spec.dataType === DataType.UINT32`, else throw `Error("Vox overlay supports only UINT32")`.
  - `volumeType === VolumeType.SEGMENTATION` (or explicitly permitted types), else throw.
  - `innerSourceRpcId` is provided and resolves to a `VolumeChunkSource` on backend, else throw.
- Decide per-level LOD factor source of truth. Store it explicitly when wrapping each level (do not infer implicitly).

#### Phase 1 — Introduce overlay classes alongside existing code
- Frontend: add `VoxVolumeChunkSource` (new file `src/voxel_annotation/overlay_frontend.ts`). Responsibilities:
  - Holds `inner: VolumeChunkSource` instance and does not fetch itself.
  - Overrides `initializeCounterpart` to create the backend overlay and pass `innerSourceRpcId` and `map` via RPC.
  - Proxies `fetchChunk`, `getChunk`, `chunkFormat`, `getValueAt` to `inner`. Editing tools interact with this wrapper to trigger edits and invalidations.
  - Provides explicit methods `commitEdit(edits: VoxEditBatch): void` that save through RPC and then invalidate by keys.
- Backend: add `VoxVolumeChunkSource` (new file `src/voxel_annotation/overlay_backend.ts`). Responsibilities:
  - On `initialize(options)`, resolve `inner` from `innerSourceRpcId`, instantiate `LocalVoxSource`, and initialize with `map`.
  - On `download(chunk, signal)`: `await inner.download(...)`, then merge saved edits from `LocalVoxSource` for the chunk key.
  - Expose `invalidateChunksByKey(keys: string[])` RPC to trigger sliceview invalidation via the owning `ChunkManager`/source.
- Ensure both classes are registered with `registerSharedObjectOwner`/`registerSharedObject` and use the existing `VOX_MAP_INIT_RPC_ID` to confirm map initialization.

Deliverable code artifacts to add:
- `src/voxel_annotation/overlay_frontend.ts`
- `src/voxel_annotation/overlay_backend.ts`
- Reusable small utilities in `src/voxel_annotation/chunk_merge.ts` to copy overlapping subregions without casting.

#### Phase 2 — Wire the overlay in the vox layer
- Modify `src/layer/vox/index.ts` to accept a generic `MultiscaleVolumeChunkSource` from URL parsing (like image/seg).
- In `getSources(...)` of the layer, iterate the single-resolution sources returned by the underlying multiscale and wrap each `chunkSource` with `VoxVolumeChunkSource` while preserving the `chunkToMultiscaleTransform`.
- Explicitly pass per-level LOD factor to the overlay (e.g., compute from scale transform or read from `VoxMapConfig.steps[index]`). If neither is available, throw.

Sketch:
```ts
function wrapLevelWithVox(
  manager: ChunkManager,
  level: SliceViewSingleResolutionSource<VolumeChunkSource>,
  map: VoxMapConfig,
  lodFactor: number,
) {
  const { chunkSource: inner } = level;
  const voxWrapped = manager.getChunkSource(VoxEditableVolumeSource, {
    spec: inner.spec,
    inner,
    map,
    lodFactor,
  });
  return {
    ...level,
    chunkSource: voxWrapped,
  };
}
```

#### Phase 3 — Migrate editing controllers to use the overlay
- Update `src/voxel_annotation/edit_controller.ts` to call methods on `VoxVolumeChunkSource` (or a service it exposes) for:
  - Paint/fill operations scheduling
  - Persistent save via RPC
  - Invalidate by affected chunk keys
- Remove direct coupling to old `VoxChunkSource` frontend methods.

#### Phase 4 — Pair with LocalVoxSource (backend overlay)
- Instantiate and initialize `LocalVoxSource` inside `VoxVolumeChunkSource` backend using the provided `map`.
- Implement merge routine without assumptions about array type other than validated `UINT32`.

#### Phase 5 — Invalidation and cache coherence
- When edits are committed, compute affected chunk keys with LOD and call `invalidateChunksByKey` on the overlay frontend, which calls through to the backend overlay and the underlying `inner` for proper cache invalidation.
- Ensure invalidation bridges both CPU cache and GPU textures via sliceview’s existing invalidation pathways.

#### Phase 6 — Deprecate old classes in stages
- Mark `VoxMultiscaleVolumeChunkSource` and old frontend/backend `VoxChunkSource` as deprecated.
- Switch the vox layer to the overlay implementation behind a feature flag `voxOverlay.enabled` (default on in dev).
- After verification, delete old classes and their references.

### Detailed implementation checklist

1) Overlay backend implementation details
- Class `VoxVolumeChunkSource` extends backend `VolumeChunkSource`.
- Fields: `inner: VolumeChunkSource`, `local: LocalVoxSource`, `lodFactor: number`.
- `initialize(options)`: resolve `inner` from RPC id; validate types; set `lodFactor` from options; init `local` with `map`.
- `download(chunk, signal)`:
  - `await this.inner.download(chunk, signal)`;
  - get `cds = chunk.chunkDataSize` from `inner`;
  - compute `key = chunk.chunkGridPosition.join()`;
  - `const saved = await local.getSavedChunk(makeVoxChunkKey(key, lodFactor));`
  - if `saved`, overlay using safe copier that clamps to min extents.
- Expose RPC for invalidation; internally use the chunk manager to invalidate the wrapped source’s key.

2) Overlay frontend implementation details
- Class `VoxVolumeChunkSource` extends `SliceViewChunkSource<VolumeChunkSpecification, VolumeChunk>` but delegates to `inner: VolumeChunkSource` for `fetchChunk`, `getChunk`, `getValueAt`.
- `initializeCounterpart(rpc, options)`: create backend counterpart for overlay and send `VOX_MAP_INIT_RPC_ID` with `map`.
- Provide editing API surface:
  - `beginEdit()` / `commitEdit(edits)` → RPC to backend edit service (already exists via `edit_backend.js`), then `invalidate(keys)`.
  - Implement `invalidate(keys: string[])` that forwards to backend overlay and triggers visible-chunk re-fetch.

3) Layer glue
- In `src/layer/vox/index.ts`, when constructing visible sources, wrap the datasource-provided multiscale levels with `VoxVolumeChunkSource` as per Phase 2 sketch.
- Compute `lodFactor` per level deterministically:
  - Prefer explicit `map.steps[index]`.
  - Alternatively, derive from transform if steps are not provided; if derivation is ambiguous (non-uniform scale), throw.

4) Strict typing additions
- Add `VoxMapConfig` fields used by overlay: `steps: number[]`, `chunkDataSize: [number,number,number]`, `upperVoxelBound: [number,number,number]`, `baseVoxelOffset: [number,number,number]`, optional `serverUrl`, `token`.
- Define `VoxEditBatch` shape used by `commitEdit` path to ensure edits map cleanly to chunk keys.

5) Error handling policy
- Throw on:
  - Missing `innerSourceRpcId` or it resolves to a non-`VolumeChunkSource`.
  - Unsupported `dataType` or `volumeType`.
  - Missing `lodFactor` for a level.
  - Any attempt to edit without initialized map.

### Example minimal code snippets

Backend overlay merge loop (typed and bounds-checked):
```ts
function overlaySavedIntoChunk(
  dst: Uint32Array,
  dstSize: readonly [number, number, number],
  src: Uint32Array,
  srcSize: readonly [number, number, number],
) {
  const ox = Math.min(srcSize[0], dstSize[0]);
  const oy = Math.min(srcSize[1], dstSize[1]);
  const oz = Math.min(srcSize[2], dstSize[2]);
  for (let z = 0; z < oz; z++) {
    for (let y = 0; y < oy; y++) {
      const s0 = (z * srcSize[1] + y) * srcSize[0];
      const d0 = (z * dstSize[1] + y) * dstSize[0];
      dst.set(src.subarray(s0, s0 + ox), d0);
    }
  }
}
```

Frontend wrapper fetch delegation with typed guard:
```ts
fetchChunk(position: Float32Array, transform: (c: VolumeChunk) => void) {
  if (!this.inner) throw new Error("inner source is not set");
  return this.inner.fetchChunk(position, transform);
}
```

### Testing plan

- Unit tests
  - `overlay_backend`: merging logic overlays correctly for different sizes and partially clipped chunks.
  - Type guards throw on unsupported `dataType` and invalid `inner` references.
- Worker integration tests
  - Initialize overlay with a mock `inner` that returns deterministic data; verify merge with `LocalVoxSource` saved chunk.
  - Verify invalidation: commit an edit, ensure subsequent `download` sees the overlayed data.
- Frontend integration
  - Wrap a `ZarrVolumeChunkSource` level, render, paint single voxel, commit, and expect visual update without page reload.
- Performance checks
  - Measure `download` timings with and without overlay for typical chunk sizes; ensure O(n) merge overhead is acceptable.

### Rollout plan with PR slicing

1) PR1: Introduce backend overlay class and copier utility. No references; covered by unit tests.
2) PR2: Introduce frontend overlay class; basic delegation tests.
3) PR3: Wire vox layer to wrap existing multiscale sources; behind a feature flag.
4) PR4: Migrate edit controller to call overlay wrapper; enable invalidation path.
5) PR5: Remove `VoxMultiscaleVolumeChunkSource` from layer; keep class deprecated but unused.
6) PR6: Delete old `VoxChunkSource` frontend/backend, consolidate RPC initializers.
7) PR7: Clean-up and documentation: update `NOTES/vox-annotation-project-overview.md`.

### Risks and mitigations
- Risk: Cache invalidation gaps cause stale visuals.
  - Mitigation: Comprehensive integration tests around `invalidateChunksByKey` and visible chunk refetch.
- Risk: Datasource variations (e.g., channel dims) complicate `getValueAt`.
  - Mitigation: Delegate all value access to `inner`; overlay only touches raw array during merge.
- Risk: Ambiguous LOD factor.
  - Mitigation: Require explicit `map.steps[index]` for MVP; throw otherwise.

### Definition of done
- Vox edits visualize and persist correctly when wrapping at least one external datasource (zarr) with no changes to core base classes.
- Old `VoxMultiscaleVolumeChunkSource` and old `VoxChunkSource` are removed.
- All new code paths have unit/integration tests and pass CI.
- Type validations prevent unsupported modes and clearly explain errors.
