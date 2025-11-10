### Goal

Implement backend-side saving for the voxel annotation “map,” mirroring the annotation system’s commit/buffer architecture, add a map-initialization endpoint, and evaluate persistent storage in the browser (WebWorker-accessible) for offline resilience.

Below is a concrete design that fits the current codebase and follows the attached notes. It references actual files and lines to make implementation straightforward.

---

### What we already have in the repo

- Frontend Vox chunk owner with optimistic edit overlay:
  - src/voxel_annotation/frontend.ts
    - VoxChunkSource extends a volume chunk source owner and adds an in-memory sparse overlay for immediate visual feedback.
    - paintVoxel(voxel, value): updates overlay and triggers re-upload to GPU (L164 lines total; key logic at lines 67–94 and helpers at 124–146).
- Backend Vox chunk counterpart producing procedural data:
  - src/voxel_annotation/backend.ts
    - VoxChunkSource backend counterpart returns a checkerboard in download() (lines 24–54).
- A dummy multiscale provider and layer hookup:
  - src/voxel_annotation/volume_chunk_source.ts: builds multiscale and returns our frontend VoxChunkSource (lines 64–129).
  - src/layer/vox/index.ts: the Vox layer, its settings/draw tabs, and the render layer. It already has UI hooks to rebuild based on scale/bounds (lines 194–253), and a simple toolset that calls VoxelEditController which calls VoxChunkSource.paintVoxel() (src/voxel_annotation/edit_controller.ts lines 10–22 and 24–52; ui tools in src/ui/voxel_annotations.ts lines 26–187).

This is already close to the “tiered” architecture in the spec:

- Tier 1 (Frontend hot cache): the sparse overlay in src/voxel_annotation/frontend.ts lines 15–52.
- Tier 2 (Worker authoritative map): to be added in backend VoxChunkSource (this proposal).
- Tier 3 (Persistent storage): to be added (this proposal; IndexedDB/OPFS in worker).

---

### High-level design

#### 1) Worker-side authoritative state (Tier 2)

Add an in-worker map of chunk data keyed by scale and chunk-id, a dirty set, and a debounced saver.

- Data structures in src/voxel_annotation/backend.ts (backend VoxChunkSource instance):

  - mapId: string (unique id for this map instance)
  - spec metadata: chunkDataSize, upperVoxelBound, dataType (already in spec)
  - voxels: Map<string, Uint32Array> where key = `${scaleKey}/${cx},${cy},${cz}`
  - dirty: Set<string> of keys needing persistence
  - saver: debounced function to flush dirty chunks to persistent storage

- Chunk keying and scale:

  - MVP assumes a single user-selected scale (as per spec §3.1). We can encode that as scaleKey = `${spec.chunkDataSize[0]}_${spec.chunkDataSize[1]}_${spec.chunkDataSize[2]}` or a numeric “scaleId” supplied at init.
  - Chunk id format: the grid coords string `${cx},${cy},${cz}` (consistent with the frontend overlay key at src/voxel_annotation/frontend.ts line 141). If you prefer the spec example (ranges like `0-64_0-64_0-64`) we can derive that on persistence, but the grid format is simpler and consistent with running code.

- download(chunk):

  - Compute cx,cy,cz and use key = `${scaleKey}/${cx},${cy},${cz}`.
  - Look up voxels.get(key), or lazily allocate a zero-filled Uint32Array sized for the clipped chunkDataSize; store it in the map and return it as chunk.data.
  - This makes the worker the authoritative “warm” state backing the streamed chunks.

- Edit API in worker:
  - Implement RPC to handle edits: set-voxel (and later brush/fill batches). For performance, always batch by chunk: payload is { key, edits: Uint32Array or array of [localIndex, value] pairs }.
  - Apply into voxels map and mark dirty; schedule saver.

This mirrors the annotation commit pipeline where the frontend immediately shows edits while the backend is authoritative and persists results (see NOTES/annotation-chunk-source-and-sync.md, esp. the optimistic overlay + commit queue flow at lines 33–105).

#### 2) Frontend→Worker edit flow (Tier 1→Tier 2)

Keep the current “optimistic overlay” in the frontend, but also send edits to worker as actions:

- In src/voxel_annotation/frontend.ts VoxChunkSource:

  - In paintVoxel(...), after overlay.applyEdit, send an RPC to the backend counterpart with the chunk key and localIndex+value. This is analogous to ANNOTATION_COMMIT_UPDATE_RPC_ID from the notes (lines 28–61) but tailored for voxel edits.
  - Batch calls: for brush tool, aggregate per-chunk edits client-side and send one RPC per dirty chunk.

- RPC identifiers (in a new file src/voxel_annotation/base.ts):

  - export const VOX_CHUNK_SOURCE_RPC_ID = 'voxChunkSource'; (already exists and used)
  - export const VOX_EDIT_APPLY_RPC_ID = 'vox/edit/apply'; // frontend→worker
  - export const VOX_SAVE_STATUS_RPC_ID = 'vox/save/status'; // worker→frontend (optional)
  - export const VOX_MAP_INIT_RPC_ID = 'vox/map/init'; // frontend→worker
  - export const VOX_MAP_META_RPC_ID = 'vox/map/meta'; // worker→frontend (optional)

- Semantics:
  - VOX_EDIT_APPLY_RPC_ID payload: { id: backendObjectId, key: string, edits: Array<[number /*localIndex*/, number /*value*/]> }
  - Worker applies immediately and returns success or throws error. Frontend does not block rendering on this.

This aligns with the annotation approach: immediate local overlay + a commit-like call to the worker (see notes lines 50–63).

#### 3) Persistent storage (Tier 3)

localStorage is not available in Web Workers and is synchronous (bad for large data). Recommended options that work in workers:

- IndexedDB (IDB)

  - Available in dedicated workers. Good for large binary blobs. Transactional.
  - Store per-chunk ArrayBuffers and a small metadata store for maps.

- OPFS (Origin Private File System)
  - Available in workers (File System Access API). Sync access handle (FileSystemSyncAccessHandle) is worker-only and ideal for chunk files; supports atomic writes.
  - Simplifies storing each chunk as its own file under /maps/{mapId}/{scaleKey}/{cx},{cy},{cz}.bin.

Recommendation: IndexedDB is widely used and integrates well with existing code. OPFS is excellent for very large datasets and low-latency writes if you need it later. I’ll outline IDB now and note where OPFS would plug in similarly.

IndexedDB schema (db name: 'neuroglancer_vox'):

- objectStore 'maps' (key: mapId: string) → { mapId, createdAt, dataType, chunkDataSize [3], upperVoxelBound [3], unit, scaleKey }
- objectStore 'chunks' (key: `${mapId}:${scaleKey}:${cx},${cy},${cz}`) → ArrayBuffer (Uint32Array.buffer) + optional small header for clipping size.

Saving strategy:

- Maintain dirty: Set<string> of keys in worker. A debounced saver runs every e.g. 750 ms or when dirty size exceeds e.g. 32 chunks.
- On flush: open a 'chunks' readwrite transaction and put each dirty chunk, then clear them from dirty.
- Crash safety: each put is a separate record; IDB is durable. Optionally store a compact “dirtyIndex” record before and after flush for recovery.

Loading strategy:

- On download() for a chunk:
  - If not present in voxels map, try IDB.get(key). If found, deserialize into a typed array and put into voxels map; otherwise allocate zero array.
  - Return typed array as chunk.data.

Offline behavior:

- Because saving is local (IDB), edits persist without network. If you also have an HTTP backend, you can add a second “cloud sync” layer: write to IDB first, try to POST to server when navigator.onLine, retry later.

---

### Map Initialization Endpoint

We need a way to create a map with user-specified dimensions and scale. The repo currently sets these in the UI (src/layer/vox/index.ts lines 174–177 for scale/unit/bounds) and constructs a DummyMultiscaleVolumeChunkSource (lines 212–219) with chunkDataSize and upperVoxelBound.

Add a programmatic initialize step between the frontend owner and the worker counterpart:

- RPC VOX_MAP_INIT_RPC_ID (frontend→worker):

  - Request: { id, mapId?: string, dataType: number, chunkDataSize: [x,y,z], upperVoxelBound: [x,y,z], unit: string, scaleKey?: string }
  - Behavior: if mapId missing, generate one (e.g., UUID). Store metadata in worker instance and persist to IDB 'maps'. Return { mapId, scaleKey }.
  - On subsequent restores, the UI can pass a known mapId to re-open the same dataset.

- Wire from UI:

  - In src/layer/vox/index.ts, VoxUserLayer.applyVoxSettings(...) (lines 194–203) currently rebuilds the layer; extend buildOrRebuildVoxLayer() (lines 205–253) to call a new method on VoxChunkSource owner to initialize the map in the worker.
  - Implementation path:
    - After creating DummyMultiscaleVolumeChunkSource, call getSources(), take base source, grab its chunkSource (our VoxChunkSource owner instance) and call source.initializeMap(...) which internally calls the RPC.

- Frontend owner changes (src/voxel_annotation/frontend.ts):
  - Add initializeMap(opts) on VoxChunkSource owner which calls rpc.invoke(VOX_MAP_INIT_RPC_ID, { id: this.rpcId, ...opts }). You already have @registerSharedObjectOwner for this type (line 57), so you can use the existing counterpart wiring.

This mirrors the “counterpart initialization” mechanism described in NOTES/annotation-chunk-source-and-sync.md lines 22–31.

---

### Concrete API and pseudo-code

#### Constants (new) src/voxel_annotation/base.ts

```ts
export const VOX_CHUNK_SOURCE_RPC_ID = "voxChunkSource"; // already exists
export const VOX_MAP_INIT_RPC_ID = "vox/map/init";
export const VOX_EDIT_APPLY_RPC_ID = "vox/edit/apply";
export const VOX_SAVE_STATUS_RPC_ID = "vox/save/status"; // optional progress events
```

#### Frontend owner additions src/voxel_annotation/frontend.ts

- Add initializeMap() and sendEdits() methods.
- Call sendEdits() from paintVoxel() (batch for brush).

Pseudo-snippets around existing code:

```ts
@registerSharedObjectOwner(VOX_CHUNK_SOURCE_RPC_ID)
export class VoxChunkSource extends BaseVolumeChunkSource {
  // ...existing code...

  async initializeMap(opts: {
    mapId?: string;
    dataType?: number; // default DataType.UINT32
    chunkDataSize: [number, number, number];
    upperVoxelBound: [number, number, number];
    unit?: string;
    scaleKey?: string; // optional explicit scale identifier
  }) {
    const resp = await (this as any).rpc!.invoke(VOX_MAP_INIT_RPC_ID, {
      id: (this as any).rpcId,
      ...opts,
    });
    return resp; // { mapId, scaleKey }
  }

  private pendingChunkEdits = new Map<string, Array<[number, number]>>();
  private editFlushHandle: number | undefined;

  private queueEdit(key: string, localIndex: number, value: number) {
    let a = this.pendingChunkEdits.get(key);
    if (!a) {
      a = [];
      this.pendingChunkEdits.set(key, a);
    }
    a.push([localIndex, value]);
    if (this.editFlushHandle === undefined) {
      this.editFlushHandle = self.setTimeout(() => this.flushEdits(), 16);
    }
  }

  private async flushEdits() {
    const entries = Array.from(this.pendingChunkEdits.entries());
    this.pendingChunkEdits.clear();
    this.editFlushHandle = undefined;
    const rpc = (this as any).rpc!;
    for (const [key, edits] of entries) {
      try {
        await rpc.invoke(VOX_EDIT_APPLY_RPC_ID, {
          id: (this as any).rpcId,
          key,
          edits,
        });
      } catch (e) {
        console.warn("Failed to apply voxel edits to worker", e);
      }
    }
  }

  paintVoxel(voxel: Float32Array, value: number) {
    const { key, localIndex } = this.computeChunkKeyAndIndex(voxel);
    if (localIndex < 0) return;
    this.overlay.applyEdit(key, localIndex, value);
    // Existing CPU array merge + reupload
    const chunk = this.chunks.get(key) as VolumeChunk | undefined;
    if (chunk) {
      const baseArray = this.getCpuArrayForChunk(chunk);
      if (baseArray) {
        this.overlay.mergeIntoChunkData(key, baseArray);
        this.invalidateChunkUpload(chunk);
      }
    }
    // NEW: forward to worker authoritative state.
    this.queueEdit(key, localIndex, value);
    this.chunkManager.chunkQueueManager.visibleChunksChanged.dispatch();
  }
}
```

#### Backend counterpart additions src/voxel_annotation/backend.ts

- Maintain map state + IDB.
- Register RPCs: init and apply edits.
- Modify download() to source from voxels map/IDB instead of procedural.

Pseudo-structure inside class VoxChunkSource:

```ts
@registerSharedObject(VOX_CHUNK_SOURCE_RPC_ID)
export class VoxChunkSource extends BaseVolumeChunkSource {
  private mapId: string = "default";
  private scaleKey = "";
  private voxels = new Map<string, Uint32Array>();
  private dirty = new Set<string>();
  private dbPromise: Promise<IDBDatabase> | null = null;
  private saveTimer: number | undefined;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.scaleKey = `${this.spec.chunkDataSize[0]}_${this.spec.chunkDataSize[1]}_${this.spec.chunkDataSize[2]}`;
    // register RPCs
    (this as any).rpc!.register(VOX_MAP_INIT_RPC_ID, ({ id, ...opts }: any) =>
      this.handleInit(opts),
    );
    (this as any).rpc!.register(
      VOX_EDIT_APPLY_RPC_ID,
      ({ id, key, edits }: any) => this.handleApplyEdits(key, edits),
    );
  }

  private async handleInit(opts: {
    mapId?: string;
    unit?: string;
    dataType?: number;
    chunkDataSize?: number[];
    upperVoxelBound?: number[];
    scaleKey?: string;
  }) {
    // adopt metadata
    if (opts.scaleKey) this.scaleKey = opts.scaleKey;
    if (opts.mapId) this.mapId = opts.mapId;
    else this.mapId = crypto.randomUUID?.() ?? String(Date.now());
    // Open IDB and persist metadata row
    const db = await this.getDb();
    await put(db, "maps", {
      mapId: this.mapId,
      dataType: this.spec.dataType,
      chunkDataSize: Array.from(this.spec.chunkDataSize),
      upperVoxelBound: Array.from(this.spec.upperVoxelBound ?? []),
      unit: opts.unit ?? "",
      scaleKey: this.scaleKey,
      createdAt: Date.now(),
    });
    return { mapId: this.mapId, scaleKey: this.scaleKey };
  }

  private async handleApplyEdits(key: string, edits: Array<[number, number]>) {
    const arr = await this.getOrLoadChunk(key);
    for (const [idx, val] of edits) {
      if (idx >= 0 && idx < arr.length) arr[idx] = val >>> 0;
    }
    this.dirty.add(key);
    this.scheduleSave();
  }

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    const origin = this.computeChunkBounds(chunk); // existing helper
    const cds = chunk.chunkDataSize!; // clipped size
    const [cx, cy, cz] = [
      Math.floor(origin[0] / this.spec.chunkDataSize[0]),
      Math.floor(origin[1] / this.spec.chunkDataSize[1]),
      Math.floor(origin[2] / this.spec.chunkDataSize[2]),
    ];
    const key = `${this.scaleKey}/${cx},${cy},${cz}`;
    const arr = await this.getOrLoadChunk(key, cds);
    (chunk as any).data = arr;
  }

  private async getOrLoadChunk(
    key: string,
    cdsMaybe?: Uint32Array,
  ): Promise<Uint32Array> {
    let arr = this.voxels.get(key);
    if (arr) return arr;
    // Try IDB
    const db = await this.getDb();
    const buf = await get(db, "chunks", `${this.mapId}:${key}`);
    if (buf instanceof ArrayBuffer) {
      arr = new Uint32Array(buf);
      this.voxels.set(key, arr);
      return arr;
    }
    // allocate zero
    const cds = cdsMaybe ?? (this.spec.chunkDataSize as Uint32Array);
    let n = 1;
    for (let i = 0; i < 3; ++i) n *= cds[i];
    arr = new Uint32Array(n);
    this.voxels.set(key, arr);
    return arr;
  }

  private scheduleSave() {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(
      () => this.flushSaves(),
      750,
    ) as unknown as number;
  }

  private async flushSaves() {
    const keys = Array.from(this.dirty);
    if (keys.length === 0) {
      this.saveTimer = undefined;
      return;
    }
    this.dirty.clear();
    const db = await this.getDb();
    const tx = db.transaction("chunks", "readwrite");
    const store = tx.objectStore("chunks");
    for (const key of keys) {
      const arr = this.voxels.get(key);
      if (!arr) continue;
      await reqAsPromise(store.put(arr.buffer, `${this.mapId}:${key}`));
    }
    await txDone(tx);
    this.saveTimer = undefined;
  }

  // Helpers: IDB open and promisified ops (implementation omitted here for brevity)
}
```

You can swap the IDB bits for OPFS by writing to files under `/maps/${mapId}/${key}.bin` using FileSystemDirectoryHandle + FileSystemSyncAccessHandle (great for large data and atomic writes). The rest of the flow is identical.

---

### UI/Layer wiring for initialization

- src/layer/vox/index.ts already exposes a VoxSettingsTab with controls for scale/unit/bounds. Add an “Initialize Map” button that triggers map init after settings are applied.
- In buildOrRebuildVoxLayer() (lines 205–253), after creating DummyMultiscaleVolumeChunkSource and before adding the render layer, call something like:

```ts
const sources2D = dummySource.getSources({} as any);
const base = sources2D[0][0];
const source = base.chunkSource as any; // VoxChunkSource (frontend owner)
await source.initializeMap({
  dataType: dummySource.dataType,
  chunkDataSize: Array.from(dummySource["cfgChunkDataSize"] ?? [64, 64, 64]),
  upperVoxelBound: Array.from(this.voxUpperBound),
  unit: this.voxScaleUnit,
});
```

This ensures the worker knows the map identity and has persisted metadata before any edits.

---

### How this mirrors the annotation system

- Optimistic UI and buffering: frontend overlay mirrors “temporary chunk” approach from NOTES/annotation-chunk-source-and-sync.md lines 37–49, 84–96, 99–105.
- Commit requests: VOX_EDIT_APPLY_RPC_ID plays the role of ANNOTATION_COMMIT_UPDATE_RPC_ID (lines 28–61). We intentionally keep this simple (no per-id coalescing) because voxel edits are applied per chunk; batching per chunk provides similar debouncing semantics (spec §3 Tier 3 debounced writes).
- Backend counterpart object: Registered with the same shared id (VOX_CHUNK_SOURCE_RPC_ID) and receives RPCs for edits and map init (notes lines 22–31).

---

### Offline persistence study

- localStorage: Not available in Web Workers (and synchronous, low capacity). Not recommended.
- IndexedDB: Available in workers, supports large binary data and transactions. Good default. Write amplification is acceptable if batching edits.
- Cache Storage API: Good for HTTP response caching, less suited to mutable structured data per chunk.
- OPFS (Origin Private File System): Available in workers. Ideal for large persistent data, supports atomic, lock-free sync access in workers. Higher performance for heavy write loads than IDB in some browsers. Requires more code for directory/handle management, but is a strong option for “plus” offline feature.

Recommendation: Start with IndexedDB for MVP; keep the persistence layer abstract so OPFS can be plugged in.

---

### Edge cases and details

- Chunk clipping: Neuroglancer chunks near the upper bound may be smaller. Persist the full logical chunk size and optionally store clipped size per record if needed; or keep the array sized to actual chunkDataSize and let the geometry handle clipping.
- DataType: MVP DataType.UINT32 (as already configured in dummy multiscale). Keep type in map metadata; if supporting multiple types later, convert appropriately on load/save.
- Multi-user future: Store a per-map generation and per-chunk version; define conflict policy (e.g., last-writer-wins or CRDT). For now, single-user writes.
- Save frequency: Tune debounce (e.g., 250–1000 ms) and a max batch size (e.g., 64 chunks per flush). On tab close, hook self.onclose to flush synchronously if possible.
- Loading existing maps: Allow passing mapId to initializeMap to reopen; otherwise create a new one.
- Networked backend (optional future):
  - POST /maps to init; GET/PUT /maps/{id}/chunks/{key} to read/write chunks
  - Worker download(): fetch if not in IDB (then cache in IDB). Edits: write-through to IDB then attempt PUT to server. Retry queue when offline.

---

### Step-by-step implementation checklist

1. Add new RPC ids in src/voxel_annotation/base.ts.
2. Frontend owner (src/voxel_annotation/frontend.ts):

- Add initializeMap() invoking VOX_MAP_INIT_RPC_ID.
- Add batching queueEdit/flushEdits; call from paintVoxel().

3. Backend counterpart (src/voxel_annotation/backend.ts):

- Add fields voxels Map, dirty Set, mapId, scaleKey.
- Register VOX_MAP_INIT_RPC_ID and VOX_EDIT_APPLY_RPC_ID handlers.
- Replace procedural download() body to use getOrLoadChunk() and return stored Uint32Array.
- Implement debounced flush to IDB (and IDB helpers).

4. UI wiring (src/layer/vox/index.ts):

- After creating DummyMultiscaleVolumeChunkSource and before adding render layer, call initializeMap() with the UI settings.
- Optionally add an explicit “Initialize Map” button in VoxSettingsTab to force re-init/reset.

5. Optional: Add a small status notifier (VOX_SAVE_STATUS_RPC_ID) for “Saving…” progress.

---

### Minimal changes by file (where to edit)

- src/voxel_annotation/base.ts: define VOX_MAP_INIT_RPC_ID, VOX_EDIT_APPLY_RPC_ID, VOX_SAVE_STATUS_RPC_ID.
- src/voxel_annotation/frontend.ts:
  - Add initializeMap() method to VoxChunkSource owner.
  - Add batching RPC for edits (queueEdit/flushEdits) and call it from paintVoxel().
- src/voxel_annotation/backend.ts:
  - Add worker state (voxels, dirty, mapId, scaleKey) and IDB persistence, register RPC handlers, change download() to load from state/IDB.
- src/layer/vox/index.ts:
  - In buildOrRebuildVoxLayer(), after DummyMultiscaleVolumeChunkSource creation, grab the base source’s VoxChunkSource and call initializeMap() with current settings.
  - (Optional) add UI button to “Initialize/Reset Map”.

---

### Summary

- Keep the existing optimistic frontend overlay (fast UI).
- Make the worker the authoritative source of voxel data and persist it with a debounced saver.
- Add an initialization RPC to create/open a map with user-provided dimensions and scale.
- Use IndexedDB in the worker for persistence; OPFS is a strong future option. Avoid localStorage.
- The design mirrors the annotation system’s paired shared objects + RPC commit result loop, adapted for chunked voxel data.

If you want, I can follow up with concrete IDB helper utilities (openDb, get, put, txDone, reqAsPromise) and exact code patches to each file to accelerate implementation.
