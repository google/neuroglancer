import { IndexedDBKvStore } from "#src/kvstore/indexeddb/implementation.js";
import { fetchZarrChunkIfAvailable } from "#src/voxel_annotation/import_from_zarr.js";
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

// Simple read only local source, this class can be instantiated multiple times without side effects.
export class LocalVoxSource extends VoxSource {
  protected kvStore: IndexedDBKvStore;
  protected labelsKvStore: IndexedDBKvStore;

  override async init(map: VoxMapConfig): Promise<{ mapId: string }> {
    const meta = await super.init(map);
    this.kvStore = new IndexedDBKvStore("neuroglancer_vox", "chunks");
    this.labelsKvStore = new IndexedDBKvStore("neuroglancer_vox", "labels");
    return meta;
  }
  
  async getSavedChunk(key: string): Promise<SavedChunk | undefined> {
    const compositeKey = compositeChunkDbKey(this.mapId, key);
    const readResponse = await this.kvStore.read(compositeKey, {});
    if (readResponse) {
      const buffer = await readResponse.response.arrayBuffer();
      const dataArray = new Uint32Array(buffer);
      return {
        data: dataArray,
        size: new Uint32Array(this.mapCfg!.chunkDataSize as any),
      };
    }
    // Fallback to remote Zarr import if available
    const remote = await fetchZarrChunkIfAvailable(this.mapCfg, key);
    if (remote) {
      return remote;
    }
    return undefined;
  }
}

/** IndexedDB-backed local source. */
// More complete local source that supports writing and more, THIS CLASS SHOULD NOT BE INSTANTIATED MULTIPLE TIMES per maps
export class LocalVoxSourceWriter extends VoxSourceWriter {

  protected kvStore: IndexedDBKvStore;
  protected labelsKvStore: IndexedDBKvStore;

  private ensureArrayBuffer(value: ArrayBufferLike): ArrayBuffer {
    if (value instanceof ArrayBuffer) return value;
    const out = new ArrayBuffer(value.byteLength);
    new Uint8Array(out).set(new Uint8Array(value));
    return out;
  }


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
      const key = compositeLabelsDbKey(this.mapId);
      const readResponse = await this.labelsKvStore.read(key, {});
      if (!readResponse) return [];
      const buffer = await readResponse.response.arrayBuffer();
      const text = new TextDecoder().decode(new Uint8Array(buffer));
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) return [];
      return arr.map((v: unknown) => Number(v) >>> 0);
    } catch {
      return [];
    }
  }


  override async addLabel(value: number): Promise<number[]> {
    const v = value >>> 0;
    const key = compositeLabelsDbKey(this.mapId);
    const readResponse = await this.labelsKvStore.read(key, {} as any);
    let arr: number[] = [];
    if (readResponse) {
      const buffer = await readResponse.response.arrayBuffer();
      const text = new TextDecoder().decode(new Uint8Array(buffer));
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) arr = parsed.map((x: unknown) => Number(x) >>> 0);
    }
    if (!arr.some((x) => x === v)) arr.push(v);
    const encoded = new TextEncoder().encode(JSON.stringify(arr));
    await this.labelsKvStore.write(key, this.ensureArrayBuffer(encoded.buffer));
    return arr.slice();
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
    this.kvStore = new IndexedDBKvStore("neuroglancer_vox", "chunks");
    this.labelsKvStore = new IndexedDBKvStore("neuroglancer_vox", "labels");
    return meta;
  }

  async getSavedChunk(key: string): Promise<SavedChunk | undefined> {
      const existing = this.saved.get(key);
      if (existing) {
        this.touch(key);
        return existing;
      }
      const composite = compositeChunkDbKey(this.mapId, key);
      const readResponse = await this.kvStore.read(composite, {});
      if (readResponse) {
        const buffer = await readResponse.response.arrayBuffer();
        const arr = new Uint32Array(buffer);
        const sc: SavedChunk = {
          data: arr,
          size: new Uint32Array(this.mapCfg!.chunkDataSize as any),
        };
        this.saved.set(key, sc);
        this.enforceCap();
        return sc;
      }
      // Try remote Zarr import on miss
      const remote = await fetchZarrChunkIfAvailable(this.mapCfg, key);
      if (remote) {
        this.saved.set(key, remote);
        this.enforceCap();
        await this.kvStore.write(composite, this.ensureArrayBuffer(remote.data.buffer));
        return remote;
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
    const composite = compositeChunkDbKey(this.mapId, key);
    const readResponse = await this.kvStore.read(composite, {});
    if (readResponse) {
      const buffer = await readResponse.response.arrayBuffer();
      const arr = new Uint32Array(buffer);
      sc = { data: arr, size: new Uint32Array(this.mapCfg!.chunkDataSize as any) };
      this.saved.set(key, sc);
      this.enforceCap();
      return sc;
    }
    // Try fetching from remote Zarr before allocating an empty chunk
    const remote = await fetchZarrChunkIfAvailable(this.mapCfg, key);
    if (remote) {
      sc = remote;
      this.saved.set(key, sc);
      this.enforceCap();
      await this.kvStore.write(composite, this.ensureArrayBuffer(sc.data.buffer));
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
    for (const e of edits) {
      const count = (e.indices as any)?.length | 0;
      if (count <= 0) {
        continue;
      }
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
    const flushedKeys: string[] = [];
    for (const key of keys) {
      const sc = this.saved.get(key);
      if (!sc) continue;
      if (this._isAllZero(sc.data)) continue;
      const composite = compositeChunkDbKey(this.mapId, key);
      await this.kvStore.write(composite, this.ensureArrayBuffer(sc.data.buffer));
      flushedKeys.push(key);
    }
    this.saveTimer = undefined;
    setTimeout(() => {
      this.callChunkReload(flushedKeys);
    }, 100);
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
    };
    req.onsuccess = () => resolve(req.result);
  });
}
