import { makeVoxChunkKey, parseVoxChunkKey } from "#src/voxel_annotation/base.js";
import type { SavedChunk} from "#src/voxel_annotation/index.js";
import { VoxSourceWriter ,
  compositeChunkDbKey,
  compositeLabelsDbKey,
  VoxSource,
} from "#src/voxel_annotation/index.js";
import type {
  VoxMapConfig} from "#src/voxel_annotation/map.js";
import {
  constructVoxMapConfig
, computeSteps } from "#src/voxel_annotation/map.js";

/**
 * Calculates the number of meaningful downsample passes for the worst case
 */
function calculateDownsamplePasses(chunkSize: number) {
  if (chunkSize <= 1) {
    return 0;
  }

  return Math.ceil(Math.log2(chunkSize));
}


// Simple read only local source, this class can be instantiated multiple times without side effects.
export class LocalVoxSource extends VoxSource {
  private dbPromise: Promise<IDBDatabase> | null = null;
  
  private async getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = openVoxDb();
    return this.dbPromise;
  }
  
  async getSavedChunk(key: string): Promise<SavedChunk | undefined> {
    const db = await this.getDb();
    const composite = compositeChunkDbKey(this.mapId, key);
    const buf = await idbGet<ArrayBuffer>(db, "chunks", composite);
    if (buf) {
      const arr = new Uint32Array(buf);
      const sc: SavedChunk = {
        data: arr,
        size: new Uint32Array(this.mapCfg!.chunkDataSize as any),
      };
      return sc;
    }
    return undefined;
  }
}

/** IndexedDB-backed local source. */
// More complete local source that supports writing and more, THIS CLASS SHOULD NOT BE INSTANTIATED MULTIPLE TIMES per maps
export class LocalVoxSourceWriter extends VoxSourceWriter {

  // Upscaling halted
  /*
    private static readonly DIRTY_STORE = "dirty";

    private async readChunkFromDbWithoutSideEffects(key: string): Promise<SavedChunk | undefined> {
      const existing = this.saved.get(key);
      if (existing) return existing;
      const db = await this.getDb();
      const composite = compositeChunkDbKey(this.mapId, key);
      const buf = await idbGet<ArrayBuffer>(db, "chunks", composite);
      if (!buf) return undefined;
      const arr = new Uint32Array(buf);
      const sc: SavedChunk = {
        data: arr,
        size: new Uint32Array(this.mapCfg!.chunkDataSize as any),
      };
      this.saved.set(key, sc);
      this.enforceCap();
      return sc;
    }

    private async setDirtyTreeFlag(key: string, isDirty: boolean): Promise<void> {
      const db = await this.getDb();
      const tx = db.transaction(LocalVoxSource.DIRTY_STORE, "readwrite");
      const store = tx.objectStore(LocalVoxSource.DIRTY_STORE);
      const composite = compositeChunkDbKey(this.mapId, key);
      await idbPut(store, isDirty ? 1 : 0, composite);
      await txDone(tx);
    }

    private async getDirtyTreeValue(key: string): Promise<0 | 1 | undefined> {
      const db = await this.getDb();
      const composite = compositeChunkDbKey(this.mapId, key);
      const v = await idbGet<number | undefined>(db, LocalVoxSource.DIRTY_STORE, composite);
      if (v === undefined) return undefined;
      if (v !== 0 && v !== 1) throw new Error(`Invalid dirty-tree value for ${key}: ${String(v)}`);
      return v as 0 | 1;
    }*/

  private parentKeyOf(childKey: string): string | null {
    const info = parseVoxChunkKey(childKey);
    if (!info) return null;
    const parentLod = info.lod * 2;
    const maxLOD = this.mapCfg!.steps[this.mapCfg!.steps.length - 1];
    if (parentLod > maxLOD) return null;
    const px = Math.floor(info.x / 2);
    const py = Math.floor(info.y / 2);
    const pz = Math.floor(info.z / 2);
    return makeVoxChunkKey(`${px},${py},${pz}`, parentLod);
  }

  // Upscaling halted
  /*
    private childKeysOf(parentKey: string): string[] {
      const info = parseVoxChunkKey(parentKey);
      if (!info) throw new Error(`Invalid voxel chunk key: ${parentKey}`);
      const childLod = info.lod / 2;
      if (childLod < 1) return [];
      const baseX = info.x * 2;
      const baseY = info.y * 2;
      const baseZ = info.z * 2;
      const out: string[] = [];
      for (let dz = 0; dz < 2; dz++) {
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            out.push(makeVoxChunkKey(`${baseX + dx},${baseY + dy},${baseZ + dz}`, childLod));
          }
        }
      }
      return out;
    }

    private async markChildrenDirtyInTree(parentKey: string): Promise<void> {
      const children = this.childKeysOf(parentKey);
      if (children.length === 0) return;
      const db = await this.getDb();
      const tx = db.transaction(LocalVoxSource.DIRTY_STORE, "readwrite");
      const store = tx.objectStore(LocalVoxSource.DIRTY_STORE);
      for (const ck of children) {
        await idbPut(store, 1, compositeChunkDbKey(this.mapId, key));
      }
      await txDone(tx);
    }

    private async ensureUpscaledPathTo(targetKey: string): Promise<void> {
      // Find nearest CLEAN ancestor using the dirty-tree only, then descend regenerating dirty/missing nodes.
      const parsedTarget = parseVoxChunkKey(targetKey);
      if (!parsedTarget) throw new Error(`ensureUpscaledPathTo: invalid target key: ${targetKey}`);
      const maxLOD = this.mapCfg!.steps[this.mapCfg!.steps.length - 1];

      // Build ancestor chain from target up to the root (inclusive)
      const ancestors: string[] = [targetKey];
      while (true) {
        const last = ancestors[ancestors.length - 1];
        const p = this.parentKeyOf(last);
        if (!p) break;
        ancestors.push(p);
        const pInfo = parseVoxChunkKey(p)!;
        if (pInfo.lod === maxLOD) break;
      }

      // Find the nearest clean ancestor after a dirty one
      let cleanAncestorIndex = -1;
      let hasDirt = false;
      for (let i = 0; i < ancestors.length; i++) {
        const k = ancestors[i];
        const v = await this.getDirtyTreeValue(k);
        if (v === 0 && hasDirt) {
          cleanAncestorIndex = i;
          break;
        }
        if (v === 1){
          hasDirt = true;
        }
      }
      if (cleanAncestorIndex === -1) {
        // No clean ancestor registered in tree -> nothing to upscale from.
        return;
      }

      // Descend from that ancestor down to the target
      for (let i = cleanAncestorIndex - 1; i >= 0; i--) {
        const childKey = ancestors[i];
        const parentKey = ancestors[i + 1];

        // A clean ancestor must exist physically. Enforce invariant strictly.
        const parentChunk = await this.readChunkFromDbWithoutSideEffects(parentKey);
        if (!parentChunk) throw new Error(`Missing parent chunk for clean node during upscaling: ${parentKey} ${ancestors}`);

        const childDirtyVal = await this.getDirtyTreeValue(childKey);
        const needsRegeneration = childDirtyVal === 1 || childDirtyVal === undefined;
        if (needsRegeneration) {
          await this.upscaleFromParentIntoChild(parentChunk, parentKey, childKey);
          await this.setDirtyTreeFlag(childKey, false);
          await this.markChildrenDirtyInTree(childKey);
          console.log(`Upscaled ${childKey} from ${parentKey}`);
        }
      }
    }

    private async upscaleFromParentIntoChild(parentChunk: SavedChunk, parentKey: string, childKey: string): Promise<void> {
      const pInfo = parseVoxChunkKey(parentKey);
      const cInfo = parseVoxChunkKey(childKey);
      if (!pInfo || !cInfo) throw new Error("Invalid parent/child keys for upscaling");
      if (cInfo.lod !== pInfo.lod / 2) throw new Error("Upscale expects child lod to be half of parent lod");

      const childSize = new Uint32Array(this.mapCfg!.chunkDataSize as any);
      const total = (childSize[0] | 0) * (childSize[1] | 0) * (childSize[2] | 0);
      let child = this.saved.get(childKey);
      if (!child) {
        child = { data: new Uint32Array(total), size: childSize };
        this.saved.set(childKey, child);
        this.enforceCap();
      }

      const [cw, ch, cd] = child.size;
      const [pw, ph] = parentChunk.size;
      const subW = pw / 2;
      const subH = ph / 2;
      const subD = parentChunk.size[2] / 2;
      const offX = (cInfo.x % 2) * subW;
      const offY = (cInfo.y % 2) * subH;
      const offZ = (cInfo.z % 2) * subD;

      for (let z = 0; z < cd; z++) {
        const pz = Math.floor(z / 2) + offZ;
        for (let y = 0; y < ch; y++) {
          const py = Math.floor(y / 2) + offY;
          for (let x = 0; x < cw; x++) {
            const px = Math.floor(x / 2) + offX;
            const pIndex = (pz | 0) * pw * ph + (py | 0) * pw + (px | 0);
            const cIndex = z * cw * ch + y * cw + x;
            (child.data as Uint32Array)[cIndex] = (parentChunk.data as Uint32Array)[pIndex];
          }
        }
      }

      this.saved.set(childKey, child);
      this.markDirty(childKey);
    }
    */

  override async listMaps(): Promise<VoxMapConfig[]> {
    try {
      const db = await this.getDb();
      const tx = db.transaction("maps", "readonly");
      const store = tx.objectStore("maps");
      const getAll = (store as any).getAll?.bind(store);
      const rows: any[] = await new Promise((resolve, reject) => {
        if (getAll) {
          const req = getAll();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result || []);
          return;
        }
        const out: any[] = [];
        const req = store.openCursor();
        req.onerror = () => reject(req.error);
        req.onsuccess = (ev: any) => {
          const cursor = ev.target.result as IDBCursorWithValue | null;
          if (cursor) {
            out.push(cursor.value);
            cursor.continue();
          } else {
            resolve(out);
          }
        };
      });
      const maps: VoxMapConfig[] = [];
      for (const r of rows) {
        try {
          if (
            r?.id === undefined ||
            r?.baseVoxelOffset === undefined ||
            r?.upperVoxelBound === undefined ||
            r?.chunkDataSize === undefined ||
            r?.dataType === undefined ||
            r?.scaleMeters === undefined ||
            r?.unit === undefined
          ) {
            throw new Error("Invalid map configuration");
          }
          const id = String(r.id);
          const lower = Array.from(r.baseVoxelOffset).map((v: any) =>
            Number(v),
          ) as number[];
          const upper = Array.from(r.upperVoxelBound).map((v: any) =>
            Number(v),
          ) as number[];
          const cds = Array.from(r.chunkDataSize).map((v: any) =>
            Math.max(1, Number(v)),
          ) as number[];
          const bounds = [
            (upper[0] | 0) - (lower[0] | 0),
            (upper[1] | 0) - (lower[1] | 0),
            (upper[2] | 0) - (lower[2] | 0),
          ];
          const steps = computeSteps(bounds, cds);
          const map = constructVoxMapConfig({
            id,
            name: r?.name ?? id,
            baseVoxelOffset: new Float32Array(lower),
            upperVoxelBound: new Float32Array(upper),
            chunkDataSize: new Uint32Array(cds),
            dataType: Number(r.dataType),
            scaleMeters: Array.from(r.scaleMeters ?? [1,1,1]),
            unit: String(r.unit),
            steps: Array.isArray(r?.steps) ? r.steps : steps,
            serverUrl: r?.serverUrl,
            token: r?.token,
            importUrl: r?.importUrl,
          });
          maps.push(map);
        } catch {
          // skip malformed
        }
      }
      return maps;
    } catch {
      return [] as VoxMapConfig[];
    }
  }
  private dbPromise: Promise<IDBDatabase> | null = null;

  override async getLabelIds(): Promise<number[]> {
    try {
      const db = await this.getDb();
      const key = compositeLabelsDbKey(this.mapId);
      const arr = await idbGet<number[]>(db, "labels", key);
      if (arr && Array.isArray(arr)) return arr.map((v) => v >>> 0);
      return [];
    } catch {
      return [];
    }
  }


  override async addLabel(value: number): Promise<number[]> {
    const v = value >>> 0;
    const db = await this.getDb();
    const key = compositeLabelsDbKey(this.mapId);
    const arr = (await idbGet<number[]>(db, "labels", key)) || [];
    // Ensure uniqueness
    if (!arr.some((x) => (x >>> 0) === v)) arr.push(v);
    const tx = db.transaction("labels", "readwrite");
    await idbPut(tx.objectStore("labels"), arr.map((x) => x >>> 0), key);
    await txDone(tx);
    return arr.map((x) => x >>> 0);
  }

  private touch(key: string) {
    const v = this.saved.get(key);
    if (!v) return;
    this.saved.delete(key);
    this.saved.set(key, v);
  }

  private enforceCap() {
    // Evict only non-dirty entries to avoid losing unsaved edits.
    while (this.saved.size > this.maxSavedChunks) {
      let oldestKey: string | undefined = undefined;
      for (const k of this.saved.keys()) {
        if (!this.dirty.has(k)) {
          oldestKey = k;
          break;
        }
      }
      if (oldestKey === undefined) {
        // All entries are dirty; wait until they are flushed before evicting.
        break;
      }
      this.saved.delete(oldestKey);
    }
  }

  override async init(map: VoxMapConfig) {
    const meta = await super.init(map);
    const db = await this.getDb();
    // Persist/update map metadata
    const tx = db.transaction("maps", "readwrite");
    const cfg = this.mapCfg!;
    tx.objectStore("maps").put(
      cfg,
      this.mapId,
    );
    await txDone(tx);
    return meta;
  }

  async getSavedChunk(key: string): Promise<SavedChunk | undefined> {
      // Before returning, ensure any pending upscales are realized for this key.
    // Upscaling halted
    /*if (this.mapCfg) {
      try {
        await this.ensureUpscaledPathTo(key);
      } catch (e) {
        console.error("ensureUpscaledPathTo failed", e);
      }
    }*/
      const existing = this.saved.get(key);
      if (existing) {
        this.touch(key);
        return existing;
      }
      const db = await this.getDb();
      const composite = compositeChunkDbKey(this.mapId, key);
      const buf = await idbGet<ArrayBuffer>(db, "chunks", composite);
      if (buf) {
        const arr = new Uint32Array(buf);
        const sc: SavedChunk = {
          data: arr,
          size: new Uint32Array(this.mapCfg!.chunkDataSize as any),
        };
        this.saved.set(key, sc);
        this.enforceCap();
        return sc;
      }
      return undefined;
    }

  async ensureChunk(
    key: string,
    size?: Uint32Array | number[],
  ): Promise<SavedChunk> {
    let sc = this.saved.get(key);
    if (sc) {
      this.touch(key);
      return sc;
    }
    // Attempt to satisfy this chunk by performing any pending upscales along its path.
    // Upscaling halted
    /*
    if (this.mapCfg) {
      try {
        await this.ensureUpscaledPathTo(key);
      } catch (e) {
        console.error("ensureUpscaledPathTo failed in ensureChunk", e);
      }
    }*/
    const db = await this.getDb();
    const composite = compositeChunkDbKey(this.mapId, key);
    const buf = await idbGet<ArrayBuffer>(db, "chunks", composite);
    if (buf) {
      const arr = new Uint32Array(buf);
      sc = { data: arr, size: new Uint32Array(this.mapCfg!.chunkDataSize as any) };
      this.saved.set(key, sc);
      this.enforceCap();
      return sc;
    }
    const fallbackSize = new Uint32Array(this.mapCfg!.chunkDataSize as any);
    const sz = new Uint32Array(size ?? fallbackSize);
    let total = 1;
    for (let i = 0; i < 3; ++i) total *= sz[i];
    const arr = new Uint32Array(total);
    sc = { data: arr, size: new Uint32Array(sz) };
    this.saved.set(key, sc);
    this.enforceCap();
    return sc;
  }

  async applyEdits(
    edits: {
      key: string;
      indices: ArrayLike<number>;
      value?: number;
      values?: ArrayLike<number>;
      size?: number[];
    }[],
  ) {
    const touchedKeys = new Set<string>();
    for (const e of edits) {
      const count = (e.indices as any)?.length | 0;
      if (count <= 0) {
        // No actual edits for this key. Do not allocate, do not mark dirty.
        continue;
      }
      const sc = await this.ensureChunk(
        e.key,
        e.size ? new Uint32Array(e.size) : (this.mapCfg!.chunkDataSize as any),
      );
      this.applyEditsIntoChunk(sc, e.indices, e.value, e.values);
      this.markDirty(e.key);
      // Upscaling halted
      //await this.setDirtyTreeFlag(e.key, false);
      //await this.markChildrenDirtyInTree(e.key);
      touchedKeys.add(e.key);
    }
    console.log(`Applied ${edits.length} edits to ${touchedKeys.size} chunks`);
    for (const key of touchedKeys) {
      this.propagateDownsample(key);
    }
  }

  private chunksToReload = new Set<string>();
  private DELAY_BEFORE_CHUNK_RELOAD = 100;

  // Downscale job queue to serialize downsampling cascades
  private downscaleQueue: string[] = [];
  private downscaleQueuedKeys = new Set<string>();
  private isProcessingDownscaleQueue = false;

  /**
   * Public entry point to start the downsampling cascade for a modified chunk.
   * @param sourceKey The key of the chunk that was edited.
   */
  public async propagateDownsample(sourceKey: string): Promise<void> {
    const keyInfo = parseVoxChunkKey(sourceKey);
    if (!keyInfo || !this.mapCfg) return;
    if (!this.downscaleQueuedKeys.has(sourceKey)) {
      this.downscaleQueuedKeys.add(sourceKey);
      this.downscaleQueue.push(sourceKey);
    }
    // Trigger processor but do not await full drain here to avoid blocking callers
    void this._processDownscaleQueue();
  }

  private async _processDownscaleQueue(): Promise<void> {
    if (this.isProcessingDownscaleQueue) return;
    this.isProcessingDownscaleQueue = true;
    try {
      while (this.downscaleQueue.length > 0) {
        const nextKey = this.downscaleQueue.shift();
        if (nextKey === undefined) {
          throw new Error("Downscale queue returned undefined key");
        }
        this.downscaleQueuedKeys.delete(nextKey);
        try {
          await this._performDownsampleCascade(nextKey);
        } catch (err) {
          console.error("Downscale job failed for key", nextKey, err);
        }
      }
    } finally {
      this.isProcessingDownscaleQueue = false;
    }
  }

  private async _performDownsampleCascade(sourceKey: string): Promise<void> {
    if (!this.mapCfg) return;
    // Assuming cubic chunks
    const chunkSize = this.mapCfg.chunkDataSize[0];
    const maxPasses = calculateDownsamplePasses(chunkSize);
    const maxLOD = this.mapCfg.steps[this.mapCfg.steps.length - 1];

    let currentKey: string | null = sourceKey;
    for (let i = 0; i < maxPasses; i++) {
      if (!currentKey) break;
      const currentKeyInfo = parseVoxChunkKey(currentKey);
      if (!currentKeyInfo) break;
      if (currentKeyInfo.lod >= maxLOD) {
        break;
      }
      const targetKey = await this._downsampleStep(currentKey);
      if (!targetKey) {
        break;
      }
      currentKey = targetKey;
    }
  }

  /**
   * Performs a single downsample step, creating one lower-resolution chunk
   * from a higher-resolution one.
   */
  private async _downsampleStep(sourceKey: string): Promise<string | null> {
    const sourceKeyInfo = parseVoxChunkKey(sourceKey);
    if (!sourceKeyInfo) return null;

    const sourceChunk = await this.getSavedChunk(sourceKey);
    if (!sourceChunk) return null; // Cannot downsample if source doesn't exist.

    const targetKey = this.parentKeyOf(sourceKey);
    if (!targetKey) return null;

    const targetChunk = await this.ensureChunk(targetKey);

    // Determine the 32x32x32 sub-volume to write into the target chunk
    const [chunkW, chunkH, chunkD] = targetChunk.size;
    const [subW, subH, subD] = [chunkW / 2, chunkH / 2, chunkD / 2];
    const offsetX = (sourceKeyInfo.x % 2) * subW;
    const offsetY = (sourceKeyInfo.y % 2) * subH;
    const offsetZ = (sourceKeyInfo.z % 2) * subD;

    for (let z = 0; z < subD; z++) {
      for (let y = 0; y < subH; y++) {
        for (let x = 0; x < subW; x++) {
          const sourceValues: number[] = [];
          // Collect the 8 corresponding source voxels
          for (let dz = 0; dz < 2; dz++) {
            for (let dy = 0; dy < 2; dy++) {
              for (let dx = 0; dx < 2; dx++) {
                const val = this._getVoxel(sourceChunk, x * 2 + dx, y * 2 + dy, z * 2 + dz);
                sourceValues.push(val as number); // WARNING: Bigint not supported
              }
            }
          }
          const mode = this._calculateMode(sourceValues);
          this._setVoxel(targetChunk, x + offsetX, y + offsetY, z + offsetZ, mode);
        }
      }
    }

    this.saved.set(targetKey, targetChunk);
    this.markDirty(targetKey);
    this.chunksToReload.add(targetKey);
    // Upscaling halted
    //await this.setDirtyTreeFlag(targetKey, false);
    return targetKey;
  }

  private _getVoxel(chunk: SavedChunk, x: number, y: number, z: number): number | bigint {
    const [sx, sy] = chunk.size;
    // Bounds check is implicitly handled by the loop structure but good practice
    const index = z * sx * sy + y * sx + x;
    return chunk.data[index];
  }

  private _setVoxel(chunk: SavedChunk, x: number, y: number, z: number, value: number | bigint): void {
    const [sx, sy] = chunk.size;
    const index = z * sx * sy + y * sx + x;
    chunk.data[index] = value;
  }

  /** Calculates the most frequent non-zero value (mode) for label data. */
  // TODO: support bigint
  private _calculateMode(values: number[] | bigint[]): number | bigint {
    if (values.length === 0) return 0;
    const counts = new Map<number | bigint, number>();
    let maxCount = 0;
    let mode = 0; // Default to 0 (background)

    for (const val of values) {
      if (val === 0) continue; // Ignore the background label
      const count = (counts.get(val) || 0) + 1;
      counts.set(val, count);
      if (count > maxCount) {
        maxCount = count;
        mode = val as number; // WARNING: this will break if bigint is used for labels
      }
    }
    return mode;
  }


  protected override async flushSaves() {
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
      const sc = this.saved.get(key);
      if (!sc) continue;
      if (this._isAllZero(sc.data))
        continue;

      await idbPut(store, sc.data.buffer, compositeChunkDbKey(this.mapId, key));
    }
    await txDone(tx);
    this.saveTimer = undefined;
    const toReload = Array.from(this.chunksToReload);
    this.chunksToReload.clear();
    setTimeout(() => {
      this.callChunkReload(toReload);
    }, this.DELAY_BEFORE_CHUNK_RELOAD);
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = openVoxDb();
    return this.dbPromise;
  }

  private _isAllZero(arr: Uint32Array | BigUint64Array): boolean {
    for (let i = 0; i < arr.length; i++) {
      if ((arr as any)[i] !== 0 && (arr as any)[i] !== 0n) return false;
    }
    return true;
  }
}

export function openVoxDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("neuroglancer_vox", 3);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("maps")) db.createObjectStore("maps");
      if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks");
      if (!db.objectStoreNames.contains("labels")) db.createObjectStore("labels");

      // Ensure dirty store exists
      // Upscaling halted
    /*
      let dirtyStore: IDBObjectStore;
      if (!db.objectStoreNames.contains("dirty")) {
        dirtyStore = db.createObjectStore("dirty");
      } else {
        dirtyStore = (req.transaction as IDBTransaction).objectStore("dirty");
      }

      // Backfill: for every key in chunks, write a clean (0) entry in dirty store.
      const tx = req.transaction as IDBTransaction;
      if (Array.from(db.objectStoreNames).includes("chunks")) {
        const chunksStore = tx.objectStore("chunks");
        const cursorReq = (chunksStore as any).openKeyCursor();
        cursorReq.onsuccess = () => {
          const cursor: IDBCursor | null = cursorReq.result as IDBCursor | null;
          if (cursor) {
            dirtyStore.put(0, cursor.key);
            cursor.continue();
          }
        };
      }*/
    };
    req.onsuccess = () => resolve(req.result);
  });
}

// --- Small IDB helpers ---
export function idbGet<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result as any);
  });
}

export function idbPut(store: IDBObjectStore, value: any, key?: IDBValidKey) {
  return new Promise<void>((resolve, reject) => {
    const req = key === undefined ? store.put(value) : store.put(value, key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

export function txDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
