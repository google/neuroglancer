import { DataType } from "#src/sliceview/base.js";
import type { SavedChunk} from "#src/voxel_annotation/index.js";
import { VoxSourceWriter } from "#src/voxel_annotation/index.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import { computeSteps } from "#src/voxel_annotation/map.js";

export class RemoteVoxSource extends VoxSourceWriter {
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
