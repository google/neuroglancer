import { makeVoxChunkKey, parseVoxChunkKey } from "#src/voxel_annotation/base.js";
import type { SavedChunk } from "#src/voxel_annotation/index.js";
import {
  compositeChunkDbKey,
  compositeLabelsDbKey,
  VoxSource,
} from "#src/voxel_annotation/index.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import { computeSteps } from "#src/voxel_annotation/map.js";

/**
 * Calculates the number of meaningful downsample passes for the worst case
 */
function calculateDownsamplePasses(chunkSize: number) {
  if (chunkSize <= 1) {
    return 0;
  }

  return Math.ceil(Math.log2(chunkSize));
}

/** IndexedDB-backed local source. */
export class LocalVoxSource extends VoxSource {
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
          maps.push({
            id,
            name: r?.name ?? id,
            baseVoxelOffset: new Float32Array(lower),
            upperVoxelBound: new Float32Array(upper),
            chunkDataSize: new Uint32Array(cds),
            dataType: r.dataType,
            scaleMeters: r.scaleMeters,
            unit: r.unit,
            steps,
          });
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
    const existing = this.saved.get(key);
    if (existing) {
      this.touch(key);
      return existing;
    }
    const db = await this.getDb();
    const composite = this.compositeKey(key);
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
    const db = await this.getDb();
    const composite = this.compositeKey(key);
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
    this.markDirty(key);
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
    for (const e of edits) {
      const sc = await this.ensureChunk(
        e.key,
        e.size ? new Uint32Array(e.size) : (this.mapCfg!.chunkDataSize as any),
      );
      this.applyEditsIntoChunk(sc, e.indices, e.value, e.values);
      this.markDirty(e.key);
      this.propagateDownsample(e.key);
    }
  }

  /**
   * Public entry point to start the downsampling cascade for a modified chunk.
   * @param sourceKey The key of the chunk that was edited.
   */
  public async propagateDownsample(sourceKey: string): Promise<void> {
    const keyInfo = parseVoxChunkKey(sourceKey);
    if (!keyInfo || !this.mapCfg) return;

    // Assuming cubic chunks
    const chunkSize = this.mapCfg.chunkDataSize[0];
    const maxPasses = calculateDownsamplePasses(chunkSize);
    const maxLOD = this.mapCfg.steps[this.mapCfg.steps.length - 1];

    let currentKey = sourceKey;
    for (let i = 0; i < maxPasses; i++) {
      const currentKeyInfo = parseVoxChunkKey(currentKey)!;
      if (currentKeyInfo.lod >= maxLOD) {
        console.log(`Reached max LOD ${maxLOD}, stopping downsample.`);
        break;
      }

      const targetKey = await this._downsampleStep(currentKey);
      if (!targetKey) {
        console.log("Downsample step failed or was unnecessary, stopping cascade.");
        break;
      }
      console.log(`Downsampled ${currentKey} to ${targetKey}`);
      this.callChunkReload(targetKey);
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

    const targetLOD = sourceKeyInfo.lod * 2;
    const targetX = Math.floor(sourceKeyInfo.x / 2);
    const targetY = Math.floor(sourceKeyInfo.y / 2);
    const targetZ = Math.floor(sourceKeyInfo.z / 2);
    const targetKey = makeVoxChunkKey(`${targetX},${targetY},${targetZ}`, targetLOD);

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
      await idbPut(store, sc.data.buffer, this.compositeKey(key));
    }
    await txDone(tx);
    this.saveTimer = undefined;
  }

  private compositeKey(key: string) {
    return compositeChunkDbKey(this.mapId, key);
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = openVoxDb();
    return this.dbPromise;
  }
}

export function openVoxDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("neuroglancer_vox", 2);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("maps")) db.createObjectStore("maps");
      if (!db.objectStoreNames.contains("chunks"))
        db.createObjectStore("chunks");
      if (!db.objectStoreNames.contains("labels"))
        db.createObjectStore("labels");
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
