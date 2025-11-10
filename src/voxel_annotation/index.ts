/**
 * Local/Remote voxel annotation data sources and a shared base.
 * The LocalVoxSource persists per-chunk arrays into IndexedDB with a debounced saver.
 */

export interface VoxMapInitOptions {
  mapId?: string;
  dataType?: number;
  chunkDataSize: number[] | Uint32Array;
  upperVoxelBound?: number[] | Uint32Array | Float32Array;
  unit?: string;
  scaleKey?: string;
}

export interface SavedChunk {
  data: Uint32Array; // MVP stores UINT32 labels
  size: Uint32Array; // canonical size used for linearization (usually spec.chunkDataSize)
}

export class VoxSource {
  protected mapId: string = 'default';
  protected scaleKey: string = '';
  protected chunkDataSize: Uint32Array = new Uint32Array([64, 64, 64]);
  protected upperVoxelBound: Uint32Array = new Uint32Array([0, 0, 0]);
  protected dataType: number = 6; // DataType.UINT32 default
  protected unit: string = '';

  // In-memory cache of loaded chunks
  protected maxSavedChunks = 128; // cap to prevent unbounded growth
  protected saved = new Map<string, SavedChunk>();

  // Dirty tracking and debounced save
  protected dirty = new Set<string>();
  protected saveTimer: number | undefined;

  init(_opts: VoxMapInitOptions): Promise<{ mapId: string; scaleKey: string }> {
    // Base provides default bookkeeping; persistence layer does real work.
    const opts = _opts || ({} as VoxMapInitOptions);
    this.mapId = opts.mapId || this.mapId || (typeof crypto !== 'undefined' && (crypto as any).randomUUID?.()) || String(Date.now());
    this.chunkDataSize = new Uint32Array(Array.from(opts.chunkDataSize));
    this.upperVoxelBound = new Uint32Array(Array.from(opts.upperVoxelBound ?? [0, 0, 0]));
    this.dataType = opts.dataType ?? this.dataType;
    this.unit = opts.unit ?? '';
    this.scaleKey = opts.scaleKey || `${this.chunkDataSize[0]}_${this.chunkDataSize[1]}_${this.chunkDataSize[2]}`;
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
    this.saveTimer = (setTimeout(() => this.flushSaves(), 750) as unknown) as number;
  }

  // Overridden by subclass to actually persist dirty chunks.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async flushSaves(): Promise<void> {}

  // Apply edits into an in-memory chunk array; returns the SavedChunk.
  protected applyEditsIntoChunk(sc: SavedChunk, indices: ArrayLike<number>, value?: number, values?: ArrayLike<number>) {
    const dst = sc.data;
    if (values != null) {
      const vv = values as ArrayLike<number>;
      const n = Math.min((indices as any).length ?? 0, (vv as any).length ?? 0);
      for (let i = 0; i < n; ++i) {
        const idx = (indices as any)[i] | 0;
        if (idx >= 0 && idx < dst.length) dst[idx] = (vv as any)[i] >>> 0;
      }
    } else if (value != null) {
      const v = value >>> 0;
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
  private dbPromise: Promise<IDBDatabase> | null = null;

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
        if (!this.dirty.has(k)) { oldestKey = k; break; }
      }
      if (oldestKey === undefined) {
        // All entries are dirty; wait until they are flushed before evicting.
        break;
      }
      this.saved.delete(oldestKey);
    }
  }

  override async init(opts: VoxMapInitOptions) {
    const meta = await super.init(opts);
    const db = await this.getDb();
    // Persist/update map metadata
    const tx = db.transaction('maps', 'readwrite');
    tx.objectStore('maps').put({
      mapId: this.mapId,
      dataType: this.dataType,
      chunkDataSize: Array.from(this.chunkDataSize),
      upperVoxelBound: Array.from(this.upperVoxelBound),
      unit: this.unit,
      scaleKey: this.scaleKey,
      updatedAt: Date.now(),
    }, this.mapId);
    await txDone(tx);
    return meta;
  }

  async getSavedChunk(key: string): Promise<SavedChunk | undefined> {
    const existing = this.saved.get(key);
    if (existing) { this.touch(key); return existing; }
    const db = await this.getDb();
    const composite = this.compositeKey(key);
    const buf = await idbGet<ArrayBuffer>(db, 'chunks', composite);
    if (buf) {
      const arr = new Uint32Array(buf);
      const sc: SavedChunk = { data: arr, size: new Uint32Array(this.chunkDataSize) };
      this.saved.set(key, sc);
      this.enforceCap();
      return sc;
    }
    return undefined;
  }

  async ensureChunk(key: string, size?: Uint32Array | number[]): Promise<SavedChunk> {
    let sc = this.saved.get(key);
    if (sc) { this.touch(key); return sc; }
    const db = await this.getDb();
    const composite = this.compositeKey(key);
    const buf = await idbGet<ArrayBuffer>(db, 'chunks', composite);
    if (buf) {
      const arr = new Uint32Array(buf);
      sc = { data: arr, size: new Uint32Array(this.chunkDataSize) };
      this.saved.set(key, sc);
      this.enforceCap();
      return sc;
    }
    const sz = new Uint32Array(size ?? this.chunkDataSize);
    let total = 1; for (let i = 0; i < 3; ++i) total *= sz[i];
    const arr = new Uint32Array(total);
    sc = { data: arr, size: new Uint32Array(sz) };
    this.saved.set(key, sc);
    this.enforceCap();
    this.markDirty(key);
    return sc;
  }

  async applyEdits(edits: { key: string; indices: ArrayLike<number>; value?: number; values?: ArrayLike<number>; size?: number[] }[]) {
    for (const e of edits) {
      const sc = await this.ensureChunk(e.key, e.size ? new Uint32Array(e.size) : this.chunkDataSize);
      this.applyEditsIntoChunk(sc, e.indices, e.value, e.values);
      this.markDirty(e.key);
    }
  }

  protected override async flushSaves() {
    const keys = Array.from(this.dirty);
    if (keys.length === 0) { this.saveTimer = undefined; return; }
    this.dirty.clear();
    const db = await this.getDb();
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    for (const key of keys) {
      const sc = this.saved.get(key);
      if (!sc) continue;
      await idbPut(store, sc.data.buffer, this.compositeKey(key));
    }
    await txDone(tx);
    this.saveTimer = undefined;
  }

  private compositeKey(key: string) {
    return `${this.mapId}:${this.scaleKey}:${key}`;
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('neuroglancer_vox', 1);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('maps')) db.createObjectStore('maps');
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      };
      req.onsuccess = () => resolve(req.result);
    });
    return this.dbPromise;
  }
}

export class RemoteVoxSource extends VoxSource {
  constructor(public url: string) {
    super();
  }
}

// --- Small IDB helpers ---
function idbGet<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result as any);
  });
}

function idbPut(store: IDBObjectStore, value: any, key?: IDBValidKey) {
  return new Promise<void>((resolve, reject) => {
    const req = key === undefined ? store.put(value) : store.put(value, key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

function txDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
