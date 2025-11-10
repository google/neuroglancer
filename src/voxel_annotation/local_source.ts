import type {
  SavedChunk} from "#src/voxel_annotation/index.js";
import {
  compositeChunkDbKey,
  compositeLabelsDbKey,
  VoxSource,
} from "#src/voxel_annotation/index.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import { computeSteps } from "#src/voxel_annotation/map.js";

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
      const key = compositeLabelsDbKey(this.mapId, this.scaleKey);
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
    const key = compositeLabelsDbKey(this.mapId, this.scaleKey);
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
    }
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
    return compositeChunkDbKey(this.mapId, this.scaleKey, key);
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
