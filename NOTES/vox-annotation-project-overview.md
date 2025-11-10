# Vox Annotation Project — Motivation, Vision, State, and Roadmap

Updated: 2025-09-12 10:55 (local)

TL;DR
- Goal: A performant voxel annotation workflow in Neuroglancer where users can paint integer labels directly on the voxel grid with smooth UX, predictable storage, and optional collaboration via a simple HTTP server.
- Today: A working Vox layer with pixel/brush tools, immediate visual feedback, debounced persistence to IndexedDB, and optional remote save/load via a Zarr-based HTTP server design. Label lists can be created/managed. Rendering integrates with existing sliceview/volume infrastructure.
- Next: Add flood-fill, LOD/downsampling pipeline, compression, better caching and memory bounds, improved remote features (auth, multi-user?), and export/import tools.


1) Motivation
- Traditional Neuroglancer annotations are vector-based (points, segments, etc.). They are great for geometry-centric workflows but not for dense voxel labeling required in ML training, segmentation curation, and painting workflows.
- Need: A voxel-aligned labeling system that:
  - Writes label IDs into a 3D grid (uint32/uint64), lives nicely with multiscale viewing.
  - Feels responsive: edits appear immediately; saving is asynchronous and robust.
  - Can work offline (local browser storage) and switch to online collaboration (HTTP API over Zarr) without major UI changes.


2) Vision and Principles
- Ergonomic painting:
  - Pixel and brush tools as baseline; flood-fill and eraser next; plane-aware disk brush by default, spherical brush optionally.
  - Label palette that maps integers to colors deterministically.
- Performance and scalability:
  - Chunked editing and streaming via standard sliceview/volume system.
  - Immediate local overlay/display + debounced background persistence to avoid UI stalls.
  - Multiscale integration for zoomed-out views with downsampling over time.
- Portability and openness:
  - Zarr v2 layout for persistent storage and an HTTP server spec compatible with CDNs/object stores.
  - Simple security: magic-link auth in MVP.
- Extensibility:
  - Clean separation of frontend UI, worker-side authoritative state, and persistence backends (IndexedDB or HTTP server).
  - Future multi-user support following doc-edit style concurrency (last-writer-wins MVP, richer models later).


3) Current State (What works now)
3.1 Layer, tools, and interaction
- Vox layer type with settings and tool tabs: src/layer/vox/index.ts
  - UI for choosing scale/region (voxel bounds), brush size/shape, eraser mode, remote URL/token parsing, and label selection.
  - Hooks to rebuild sources when settings change.
- Tools: src/ui/voxel_annotations.ts
  - Pixel tool (VoxelPixelLegacyTool): line interpolation to fill continuous strokes.
  - Brush tool (VoxelBrushLegacyTool): disk (aligned to slice plane) or sphere; configurable radius; oriented-disk uses the current slice basis when available.
  - Tools call VoxelEditController which routes edits to the vox chunk source.
- Edit controller: src/voxel_annotation/edit_controller.ts
  - paintVoxelsBatch for arbitrary point lists.
  - paintBrushWithShape for disk/sphere brush generation with plane orientation support.

3.2 Data flow and chunk sources
- Multiscale source: src/voxel_annotation/volume_chunk_source.ts
  - Returns a base scale with real bounds and a coarse “guard” scale (empty bounds but huge voxel transform) to prevent extreme-zoom memory blow-ups.
  - DataType = UINT32, VolumeType = SEGMENTATION, rank = 3.
  - Passes optional vox serverUrl/token to worker.
- Frontend chunk owner: src/voxel_annotation/frontend.ts (class VoxChunkSource)
  - Pairs with a worker counterpart via RPC type id VOX_CHUNK_SOURCE_RPC_ID.
  - Local optimistic edit path: paintVoxelsBatch computes the chunk/local indices, writes into the CPU array if present, and invalidates GPU uploads per chunk to achieve immediate visual updates.
  - Sends batched edit RPCs (VOX_COMMIT_VOXELS_RPC_ID) to backend with {key, indices, value, size}.
  - Map initialization RPC (VOX_MAP_INIT_RPC_ID): best-effort init of worker storage and metadata.
  - Label APIs: VOX_LABELS_GET_RPC_ID, VOX_LABELS_ADD_RPC_ID.
- Backend counterpart: src/voxel_annotation/backend.ts (class VoxChunkSource)
  - Chooses a persistence backend:
    - LocalVoxSource for IndexedDB (default).
    - RemoteVoxSource when serverUrl/token supplied (HTTP).
  - download(...) computes chunk bounds, returns a typed array matching spec dtype, and overlays any saved chunk data for in-bounds region (merges saved content into the allocated array).
  - commitVoxels applies batched edits into the authoritative source; saving is debounced.

3.3 Persistence backends (authoritative state in worker)
- Shared helper/types: src/voxel_annotation/index.ts
  - toScaleKey(chunkDataSize, baseVoxelOffset, upperVoxelBound).
  - compositeChunkDbKey(mapId, scaleKey, chunkKey) and compositeLabelsDbKey.
  - VoxSource abstract base managing: mapId, scaleKey, chunkDataSize, base/upper bounds, dtype, unit, in-memory LRU cache, dirty set, and debounced flush (≈750ms).
  - applyEditsIntoChunk supports both single value and per-index values arrays; typed arrays switch (Uint32 vs BigUint64 for future UINT64 support).
- LocalVoxSource (IndexedDB):
  - IDB stores: maps (metadata), chunks (ArrayBuffer per chunk), labels (label list).
  - Debounced flush writes dirty chunks; in-memory LRU avoids unbounded growth; avoids evicting dirty entries.
  - Label persistence: getLabelIds, addLabel ensure id uniqueness.
- RemoteVoxSource (HTTP):
  - Base URL + optional token; GET /chunk?mapId&chunkKey returns bytes or 404 for missing; PUT /chunk persists bytes.
  - Map init: best-effort GET /init?mapId&scaleKey&dtype.
  - Label endpoints: GET/PUT /labels.
  - Maintains a small LRU and reuses the same debounced flush policy; failed PUT keeps keys dirty for retry.

3.4 Rendering
- Custom render layer: src/voxel_annotation/renderlayer.ts
  - Extends SliceViewVolumeRenderLayer and colors non-zero labels via SegmentColorHash; zero is transparent with alpha 0; non-zero alpha ≈ 0.5.
  - Uses standard data sampling hooks (getDataValue/getUint64DataValue path) so real chunk data shows; includes helpful shader build error logging.

3.5 Remote URL provider
- src/datasource/vox_remote.ts
  - Provides a DataSource for vox+http(s):// URLs used by the Vox layer; mainly a stub that allows the layer to detect a remote source and pass URL/token to worker.

3.6 Labels UI state
- Layer wires a simple label list; frontend/backend support getting and adding labels. Rendering maps label ids to colors via hashing; there is no named palette UI yet (hash-based is deterministic).


4) Storage and API (Backend)
4.1 Zarr-based HTTP server (MVP)
- See NOTES/backend.md for full spec. Summary:
  - Zarr v2, arrays per scale 0/, 1/, ... under a root with NGFF multiscales.
  - Missing chunk => fill_value (0) semantics.
  - Chunk addressing at 0/ix/iy/iz.
- Key endpoints:
  - GET /info → dataset metadata union (.zattrs + .zarray summaries) + publicBase.
  - GET /chunk?mapId&chunkKey → raw bytes of a full chunk (padded at edges).
  - PUT /chunk?mapId&chunkKey → raw bytes; writes in-bounds region for edge chunks; last-writer-wins.
  - GET /init?mapId&scaleKey&dtype → initialize new map metadata.
  - GET /labels?mapId → { labels: number[] }.
  - PUT /labels?mapId → { labels: number[] } (adds new label id).
- Non-functional (MVP):
  - CORS for configured origins; simple metrics; health checks; magic-link auth; local single-node Docker Compose with MinIO (S3-compatible) for development.

4.2 Scale key and chunk key
- Scale key format used throughout (frontend and backend helpers):
  - toScaleKey(chunkDataSize, baseVoxelOffset, upperVoxelBound) → "cx_cy_cz:lx_ly_lz-ux_uy_uz" (e.g., 64_64_64:0_0_0-1024_1024_1024).
- Chunk key:
  - toChunkKey([cx, cy, cz]) → "cx,cy,cz" (e.g., 0,0,0).


5) Codebase Map (vox annotation related)
- Layer/UI
  - src/layer/vox/index.ts — VoxUserLayer: settings tab (scale, bounds, remote URL/token), tool tab (tools, labels UI), wiring to render layer and multiscale.
  - src/ui/voxel_annotations.ts — Legacy tools (pixel, brush) and registration. Generates voxel positions, handles stroke interpolation, uses oriented disk brush.
- Chunk sources / rendering
  - src/voxel_annotation/volume_chunk_source.ts — VoxMultiscaleVolumeChunkSource: returns base and guard scales, passes vox server options.
  - src/voxel_annotation/renderlayer.ts — VoxelAnnotationRenderLayer: simple segment-hash coloring of non-zero labels.
- Edit logic and RPC owner/counterpart
  - src/voxel_annotation/frontend.ts — Frontend VoxChunkSource with optimistic CPU updates, batched commit RPCs, map init, label RPCs.
  - src/voxel_annotation/backend.ts — Backend VoxChunkSource resolves LocalVoxSource vs RemoteVoxSource, downloads/saves chunk data, responds to RPCs.
  - src/voxel_annotation/index.ts — VoxSource base; LocalVoxSource (IndexedDB); RemoteVoxSource (HTTP); scale/chunk key helpers; IDB utils.
  - src/voxel_annotation/edit_controller.ts — Bridges layer tools to VoxChunkSource.
- Datasource integration
  - src/datasource/vox_remote.ts — Provider for vox+http(s):// schemes to pass remote info into the layer.
- Reference and architecture notes
  - NOTES/voxel-annotation-specification.md — Overall voxel annotation spec and tiered architecture.
  - NOTES/annotation-chunk-source-and-sync.md — How frontend/backend chunk sources pair and how optimistic buffering works.
  - NOTES/classExplanations/*.md — Deeper dives into MultiscaleVolumeChunkSource and chunk-source concepts.
  - NOTES/backend.md — Zarr HTTP server requirements and API.
  - NOTES/TODOs.md — Current to-do list.


6) Editing Model (UX + Data)
- Immediate visual feedback: edits write into CPU arrays of visible chunks when present; GPU uploads are invalidated and refreshed on the next frame.
- Authoritative state: worker holds canonical per-chunk arrays via VoxSource; writes are batched and saved after debounce to IDB or PUT to remote server.
- Batched per-chunk commits: indices are linearized local indices in the canonical chunk size; backend handles edge clips and merges into the in-memory state.
- Label management: labels are simple integer lists scoped to map/scale; API supports GET and ADD; used to drive color mapping and selected label value in UI.


7) Brainstorming / Reflections / Debates
- Flood fill:
  - Start with 2D fill in current slice plane; impose max expansion safeguards to prevent runaway fills.
  - For 3D fill, consider connected-components with thresholding against underlying image/segmentation data.
- LOD / downsampling:
  - MVP: hide when zoomed too far, or use guard scale to avoid huge memory usage.
  - Phase 2: On-the-fly downsampling in worker: request 8 children at LOD0 to synthesize LOD1 with majority voting; cache generated lower-LOD chunks and invalidate on parent edits.
  - Persistence across scales: consider propagating writes upward (write-through) and merging on load. Conflicts arise when values differ across scales; needs a deleted-marker and per-chunk timestamps to disambiguate absence vs deletion vs disagreement.
  - Undo/future: Do not resolve conflicts “live” if it precludes implementing undo/redo; prefer to defer resolution or track lineage with timestamps.
- Compression and memory:
  - Compressed segmentation block formats reduce RAM/IndexDB usage. Integration is non-trivial for hot-edit rendering because in-place CPU texture updates are needed for smooth UX. Explore per-chunk compressed backing store + uncompressed hot copy for visible chunks.
  - Investigate RAM usage spikes during heavy painting; ensure chunk eviction policies consider viewport visibility to avoid flicker (see TODO on uncaching without visibility awareness).
- Multi-user / concurrency:
  - Remote server MVP uses last-writer-wins. For collaborative editing, introduce per-chunk versions/ETags, server-side mergers, or operational transforms tuned for voxel arrays (conflict resolution policy per-voxel or per-chunk).
  - Live updates: server can emit change streams or polling-based invalidation to notify clients of updated chunks.
- Authentication / Security:
  - Magic-link token is a pragmatic MVP. Add CORS configs, short metadata caching, and health endpoints. Long-lived caching of 404s should be avoided.
- Import/Export:
  - “ExternalVoxSource” concept: For zarr:// or precomputed:// reads, load remote for display; keep edits local (IDB) and implement export that merges local modifications back into a chosen persistent format.


8) Roadmap and TODOs
8.1 From NOTES/TODOs.md (selected and grouped)
- Storage/robustness
  - Add redundancy to avoid corrupt/unsaved chunks on remote (e.g., write temp objects then rename, MD5/ETag checks).
  - Test token authentication thoroughly.
  - Add Uint64 label id support end-to-end (frontend arrays, server dtype, render sampling already supports uint64 colors).
- Performance/UX
  - Fix brush disk orientation edge cases; ensure correct plane basis on arbitrary slices.
  - Visibility-aware eviction to avoid flicker when LocalVoxSource evicts unseen chunks; integrate with chunk manager visible set.
  - Investigate and reduce RAM usage on heavy painting sessions.
  - Segmentation compression strategy compatible with hot updates.
- Tools
  - Flood fill tool (start 2D, plane normal z is ok for v1). Add eraser tooling (value 0 path exists; improve UX toggles/shortcuts).
- LOD
  - Implement LOD rendering by propagating writes upward and fetching across scales; ensure deleted-marker and per-chunk timestamps to tackle conflicts; do not auto-resolve live to keep undo viable.
- Data workflows
  - Import precomputed/Zarr segmentation into server; support full dataset retrieval and merge with local modifications; export to desired format.
- Remote labels sync
  - Current remote server code supports labels endpoints; ensure layer UI syncs and handles errors.

8.2 Additional tasks inferred from code and commits
- Finish wiring of map initialization from layer UI (ensure scaleKey matches UI region and chunk sizes, call initializeMap on source creation).
- Improve error handling for remote PUT/GET (status messages, retries, and user feedback).
- Add basic metrics/observability overlays (chunk read/write counters) for development.
- Provide example docker-compose and client connection snippet in docs.


9) Git History Highlights (vox-related)
- 7c1a3b4e feat: replace setLabelIds with addLabel for label management.
- 02e28fd4 feat: remote voxel sources via HTTP(S) (note: labels not sync initially).
- 07a59c38 feat: RPC-based voxel label persistence.
- e04b3167 feat: voxel label creation, persistence via IndexedDB, enhanced UI.
- e70c9ff3 feat: expand TODOs (compression, multi-user, tools).
- 92c3c215 feat: region-based voxel initialization with corners; update map options and UI.
- 19f4e103 feat: new local voxel storage with IndexedDB; map initialization; improved backend edits.
- faf0947d feat: persist voxel edits to backend and improve drawing responsiveness.
- 3017fe4c feat: continuous drawing and brush shape selection.
- 238958a8 feat: brush size, eraser mode, minor optimization.
- a3f05989 refactor: rename DummyMultiscaleVolumeChunkSource→VoxMultiscaleVolumeChunkSource.
- 44a6754f feat: fix pixel tool scaling issues; add primitive brush tool.
- 14336ab4 feat: pixel tool working as intended.
- 65565130 feat: WIP pixel tool; added front-end buffer; layer settings for scale/bounds; added guard scale to prevent zoom-out crashes.
- 6140a28b doc: rework voxel annotation specs.
- cbe55c86 feat: introduce VoxDummyChunkSource procedural demo.
- c0ceef34 feat: add support for voxel annotation rendering and spec.
- 9b71be4f feat: add new dummy layer type: voxel annotation (vox).

These commits capture the evolution from a procedural/demo stage to a functional editing and persistence pipeline with labels and remote integration.


10) How everything connects (end-to-end)
- User paints with a tool → UI generates voxel positions (points or brush patterns).
- VoxelEditController forwards edits to the frontend VoxChunkSource.
- Frontend VoxChunkSource:
  - Computes chunk indices and local offsets.
  - Writes into CPU arrays when available and invalidates GPU uploads (instant feedback).
  - Batches linearized indices per chunk and sends VOX_COMMIT_VOXELS_RPC_ID to the worker, including canonical size.
- Backend VoxChunkSource receives the RPC and applies edits via VoxSource (Local or Remote) — authoritative state updated immediately.
- Debounced saver writes chunks to IDB or HTTP server /chunk endpoint.
- When chunks stream (or re-stream) to the frontend (e.g., on navigation), download merges saved data and provides typed arrays; the render layer displays labels (zero → transparent, nonzero → colored).


11) Open Questions
- Undo/redo: Requires a journal of edits or chunk snapshots. Interaction with LOD propagation needs careful design.
- Multi-user semantics: Per-voxel conflict resolution vs per-chunk; latency trade-offs; server push vs polling.
- Remote cache invalidation: How do clients learn about external updates? ETag + If-None-Match and/or change streams.
- Label metadata: Should labels be plain integers only or have names/colors? Today rendering uses a deterministic hash; UI for named palettes could be added.
- Security: Token format and rotation; scope per-map vs per-store; server-side audit.


12) Quickstart (MVP)
- Local-only (IndexedDB):
  1) Add a Vox layer, set bounds and chunk size in the Settings tab.
  2) Pick a label value, select Pixel/Brush tool, paint. Data persists into your browser (IndexedDB).
- Remote (HTTP server):
  1) Run the Zarr server (see NOTES/backend.md for spec; Docker Compose recommended with MinIO for S3-like storage).
  2) In Vox layer, set source to vox+http://host:port/?token=... (or vox+https://...).
  3) Paint. Edits are PUT to the server; missing chunks read as zeros.


13) Glossary
- Chunk: A small 3D block of voxels (e.g., 64×64×64) used for efficient storage and rendering.
- Multiscale: Multiple resolutions of the same volume for performance at varying zoom levels.
- LOD: Level of detail; lower resolution representation used when zoomed out.
- NGFF/Zarr: Open formats for n-dimensional arrays with chunked storage; used here for persistence.


14) References (in repo)
- NOTES/backend.md — server API/requirements.
- NOTES/voxel-annotation-specification.md — tiered architecture, tools, and phases.
- NOTES/annotation-chunk-source-and-sync.md — RPC pairing and buffering model.
- NOTES/classExplanations/MultiscaleVolumeChunkSource.md — multiscale details.
- NOTES/classExplanations/chunk-source.md — owner/counterpart model; visibility-driven chunking.
- src/* — see Codebase Map above.


Appendix A) Helper formulas
- Scale key:
  toScaleKey(chunkDataSize, baseVoxelOffset, upperVoxelBound) → "cx_cy_cz:lx_ly_lz-ux_uy_uz".
- Chunk key:
  toChunkKey([cx, cy, cz]) → "cx,cy,cz".
