/**
 * Local/Remote voxel annotation data sources and a shared base.
 * The LocalVoxSource persists per-chunk arrays into IndexedDB with a debounced saver.
 */

import { DataType } from "#src/util/data_type.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import { computeSteps } from "#src/voxel_annotation/map.js";


export interface SavedChunk {
  data: Uint32Array | BigUint64Array; // Supports UINT32 and UINT64
  size: Uint32Array; // canonical size used for linearization (usually spec.chunkDataSize)
}

export function toScaleKey(
  chunkDataSize: number[] | Uint32Array,
  baseVoxelOffset?: number[] | Uint32Array | Float32Array,
  upperVoxelBound?: number[] | Uint32Array | Float32Array,
): string {
  const cds = Array.from(chunkDataSize);
  const lower = Array.from(baseVoxelOffset ?? [0, 0, 0]);
  const upper = Array.from(upperVoxelBound ?? [0, 0, 0]);
  return `${cds[0]}_${cds[1]}_${cds[2]}:${lower[0]}_${lower[1]}_${lower[2]}-${upper[0]}_${upper[1]}_${upper[2]}`;
}

export function compositeChunkDbKey(
  mapId: string,
  scaleKey: string,
  chunkKey: string,
): string {
  return `${mapId}:${scaleKey}:${chunkKey}`;
}

export function compositeLabelsDbKey(mapId: string, scaleKey: string): string {
  return `${mapId}:${scaleKey}:labels`;
}

export abstract class VoxSource {
  /**
   * Optional listing of available maps for the current source.
   * Remote sources should query their endpoint; local may enumerate local IndexedDB entries.
   */
  async listMaps(_args?: { baseUrl?: string; token?: string }): Promise<any[]> {
    return [];
  }
  protected mapId: string = "default";
  protected scaleKey: string = "";
  protected mapCfg: VoxMapConfig; // Keep the entire configuration in one place

  // In-memory cache of loaded chunks
  protected maxSavedChunks = 128; // cap to prevent unbounded growth
  protected saved = new Map<string, SavedChunk>();

  // Dirty tracking and debounced save
  protected dirty = new Set<string>();
  protected saveTimer: number | undefined;

  /**
   * Generic label persistence hooks. Subclasses override to connect to the chosen datasource.
   * Default implementation is a no-op empty list.
   */
  async getLabelIds(): Promise<number[]> {
    return [];
  }
  async addLabel(_value: number): Promise<number[]> {
    // Default: pretend success with no labels
    return [];
  }

  init(map: VoxMapConfig): Promise<{ mapId: string; scaleKey: string }> {
    if(!map)
    {
      throw new Error("VoxSource: init: Map config is required");
    }
    this.mapCfg = map;
    this.mapId = map.id;
    this.scaleKey = toScaleKey(map.chunkDataSize, map.baseVoxelOffset, map.upperVoxelBound);
    return Promise.resolve({ mapId: this.mapId, scaleKey: this.scaleKey });
  }

  // Common helpers
  protected markDirty(key: string) {
    this.dirty.add(key);
    this.scheduleSave();
  }

  protected scheduleSave() {
    if (this.saveTimer !== undefined) return;
    // Debounce writes ~750ms
    this.saveTimer = setTimeout(
      () => this.flushSaves(),
      750,
    ) as unknown as number;
  }

  // Overridden by subclass to actually persist dirty chunks.
  protected async flushSaves(): Promise<void> {}

  // Abstract persistence API the backend expects
  abstract getSavedChunk(key: string): Promise<SavedChunk | undefined>;
  abstract ensureChunk(
    key: string,
    size?: Uint32Array | number[],
  ): Promise<SavedChunk>;
  abstract applyEdits(
    edits: {
      key: string;
      indices: ArrayLike<number>;
      value?: number;
      values?: ArrayLike<number>;
      size?: number[];
    }[],
  ): Promise<void>;

  // Apply edits into an in-memory chunk array; returns the SavedChunk.
  protected applyEditsIntoChunk(
    sc: SavedChunk,
    indices: ArrayLike<number>,
    value?: number,
    values?: ArrayLike<number>,
  ) {
    const dst = sc.data as any;
    const is64 = dst instanceof BigUint64Array;
    if (values != null) {
      const vv = values as ArrayLike<number>;
      const n = Math.min((indices as any).length ?? 0, (vv as any).length ?? 0);
      for (let i = 0; i < n; ++i) {
        const idx = (indices as any)[i] | 0;
        if (idx >= 0 && idx < dst.length) {
          const v = (vv as any)[i] >>> 0;
          dst[idx] = is64 ? BigInt(v) : v;
        }
      }
    } else if (value != null) {
      const vNum = value >>> 0;
      const v = (is64 ? BigInt(vNum) : vNum) as any;
      const n = (indices as any).length ?? 0;
      for (let i = 0; i < n; ++i) {
        const idx = (indices as any)[i] | 0;
        if (idx >= 0 && idx < dst.length) dst[idx] = v;
      }
    }
    return sc;
  }
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

export class RemoteVoxSource extends VoxSource {
  async listMaps(): Promise<VoxMapConfig[]> {
    try {
      const qs = this.qs({});
      const json = await this.httpGetJson(`${this.baseUrl}/info${qs}`);
      const datasets = Array.isArray(json?.datasets) ? json.datasets : [];
      const out: VoxMapConfig[] = [];
      const toXYZ = (ary: number[]) => {
        const a = ary.map((v) => Math.max(0, Math.floor(v ?? 0)));
        if (a.length >= 3) return [a[2] || 0, a[1] || 0, a[0] || 0];
        return [a[0] || 0, a[1] || 0, a[2] || 0];
      };
      for (const ds of datasets) {
        try {
          const id: string = String(ds?.mapId ?? ds?.id ?? ds?.name ?? ds?.url ?? `map-${Date.now()}`);
          const arrays = Array.isArray(ds?.arrays) ? ds.arrays : [];
          const arr = arrays.find((a: any) => a?.path === "0") ?? arrays[0];
          if (!arr) continue;
          // TODO: the server way of storing maps is wrong, espcially the bounds, data organization and missing scale and unit
          const dtype = String(arr?.dtype) === "uint64" ? DataType.UINT64 : DataType.UINT32;
          const upper = toXYZ(arr.shape);
          const cds = toXYZ(arr.chunks).map((v) => Math.max(1, v));
          const lower = [0, 0, 0];
          const steps = computeSteps(upper, cds);
          out.push({
            scaleMeters: [0.000000008, 0.000000008, 0.000000008],
            unit: "nm",
            id,
            name: ds?.name ?? id,
            baseVoxelOffset: new Float32Array(lower),
            upperVoxelBound: new Float32Array(upper),
            chunkDataSize: new Uint32Array(cds),
            dataType: dtype,
            steps,
            serverUrl: this.baseUrl,
            token: this.token
          });
        } catch {
          // ignore
        }
      }
      return out;
    } catch {
      return [] as VoxMapConfig[];
    }
  }
  private labelsCache: number[] = [];
  private baseUrl: string;
  private token?: string;

  constructor(url: string, token?: string) {
    super();
    this.baseUrl = url.replace(/\/$/, "");
    this.token = token;
  }

  // ---- Public API overrides ----
  override async init(map: VoxMapConfig) {
    const meta = await super.init(map);
    // Bind dtype string
    const dtypeStr = this.dtypeToString((this.mapCfg?.dataType ?? DataType.UINT32) as number);
    // Call /init (best-effort; server may already have it)
    const qs = this.qs({
      mapId: this.mapId,
      scaleKey: this.scaleKey,
      dtype: dtypeStr,
    });
    try {
      await this.httpGet(`${this.baseUrl}/init${qs}`);
    } catch {
      // ignore
    }
    return meta;
  }

  async getSavedChunk(key: string): Promise<SavedChunk | undefined> {
    const existing = this.saved.get(key);
    if (existing) return existing;
    const qs = this.qs({ mapId: this.mapId, chunkKey: key });
    try {
      const buf = await this.httpGetArrayBuffer(`${this.baseUrl}/chunk${qs}`);
      if (!buf) return undefined;
      const arr = this.makeTypedArrayFromBuffer(buf);
      const sc: SavedChunk = { data: arr, size: new Uint32Array(this.mapCfg!.chunkDataSize as any) };
      this.saved.set(key, sc);
      this.enforceCap();
      return sc;
    } catch (e: any) {
      // 404 → not found
      return undefined;
    }
  }

  async ensureChunk(key: string, size?: Uint32Array | number[]): Promise<SavedChunk> {
    let sc = this.saved.get(key);
    if (sc) return sc;
    sc = await this.getSavedChunk(key);
    if (sc) return sc;
    // allocate zero-filled
    const fallbackSize = new Uint32Array(this.mapCfg!.chunkDataSize as any);
    const sz = new Uint32Array(size ?? fallbackSize);
    const total = (sz[0] | 0) * (sz[1] | 0) * (sz[2] | 0);
    const data = this.allocateTypedArray(total);
    sc = { data, size: new Uint32Array(sz) };
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
    for (const key of keys) {
      const sc = this.saved.get(key);
      if (!sc) continue;
      const qs = this.qs({ mapId: this.mapId, chunkKey: key });
      try {
        await this.httpPutArrayBuffer(`${this.baseUrl}/chunk${qs}`, sc.data as any);
      } catch (e) {
        // If failed, keep dirty to retry later
        this.dirty.add(key);
      }
    }
    this.saveTimer = undefined;
  }

  // ---- Helpers ----
  private qs(params: Record<string, string | number | undefined>) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      usp.set(k, String(v));
    }
    if (this.token) usp.set("token", this.token);
    const s = usp.toString();
    return s ? `?${s}` : "";
  }

  private dtypeToString(dt: number): "uint32" | "uint64" {
    return dt === DataType.UINT64 ? "uint64" : "uint32";
  }

  private allocateTypedArray(total: number): Uint32Array | BigUint64Array {
    if ((this.mapCfg?.dataType ?? DataType.UINT32) === DataType.UINT64) return new BigUint64Array(total);
    return new Uint32Array(total);
  }

  private makeTypedArrayFromBuffer(buf: ArrayBuffer): Uint32Array | BigUint64Array {
    if ((this.mapCfg?.dataType ?? DataType.UINT32) === DataType.UINT64) return new BigUint64Array(buf);
    return new Uint32Array(buf);
  }

  private async httpGet(url: string): Promise<Response> {
    const res = await fetch(url, { method: "GET", credentials: "omit" });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res;
  }

  private async httpGetArrayBuffer(url: string): Promise<ArrayBuffer | undefined> {
    const res = await fetch(url, { method: "GET", credentials: "omit" });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return await res.arrayBuffer();
  }

  private async httpPutArrayBuffer(
    url: string,
    body: ArrayBufferLike | ArrayBufferView,
  ): Promise<void> {
    // Ensure we pass an ArrayBufferView to satisfy fetch BodyInit typing across platforms.
    let payload: ArrayBufferView;
    if (body instanceof ArrayBuffer) {
      payload = new Uint8Array(body);
    } else if ((body as any).buffer && (body as any).byteLength !== undefined) {
      payload = body as ArrayBufferView;
    } else {
      payload = new Uint8Array(body as ArrayBufferLike);
    }
    const res = await fetch(url, {
      method: "PUT",
      body: payload as any,
      headers: { "Content-Type": "application/octet-stream" },
      credentials: "omit",
    });
    if (!res.ok) throw new Error(`PUT ${url} -> ${res.status}`);
  }

  private async httpGetJson(url: string): Promise<any> {
    const res = await fetch(url, { method: "GET", credentials: "omit" });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return await res.json();
  }

  private async httpPutJson(url: string, body: any): Promise<any> {
    const res = await fetch(url, {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
    });
    if (!res.ok) throw new Error(`PUT ${url} -> ${res.status}`);
    return await res.json();
  }

  // --- Labels via remote server endpoints ---
  override async getLabelIds(): Promise<number[]> {
    const qs = this.qs({ mapId: this.mapId });
    const json = await this.httpGetJson(`${this.baseUrl}/labels${qs}`);
    const arr = Array.isArray(json?.labels) ? json.labels : [];
    this.labelsCache = arr.map((v: any) => (v as number) >>> 0);
    return Array.from(this.labelsCache);
  }


  override async addLabel(value: number): Promise<number[]> {
    const v = value >>> 0;
    // If dtype is UINT64 we still send a 32-bit value; server must accept as valid subset. -> TODO: no
    const qs = this.qs({ mapId: this.mapId });
    const json = await this.httpPutJson(`${this.baseUrl}/labels${qs}`, { value: v });
    const arr = Array.isArray(json?.labels) ? json.labels : [];
    this.labelsCache = arr.map((x: any) => (x as number) >>> 0);
    return Array.from(this.labelsCache);
  }

  // LRU-style cap similar to LocalVoxSource
  private enforceCap() {
    while (this.saved.size > this.maxSavedChunks) {
      let oldestKey: string | undefined;
      for (const k of this.saved.keys()) {
        if (!this.dirty.has(k)) {
          oldestKey = k;
          break;
        }
      }
      if (oldestKey === undefined) break;
      this.saved.delete(oldestKey);
    }
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
