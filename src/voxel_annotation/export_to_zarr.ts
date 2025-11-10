// TODO: read the whole IndexedDB and write it to a S3 bucket in zarr v2 format without compression and multiscale. the function will take a url and the VoxMapConfig in args and will return a progress function that returns the current progress when called ({status: "loading", progress: 0.5} or {status: "done", progress: 1} or {status: "error", progress: 0, error: "error message"}). We can use the helper of the local_source.ts. The function will be called from the VoxUserLayer on the click of a new export button. A new export url field will also be added to the ui. After the export is started, the ui will display the current progress thanks to the progress function. We should also, before starting the export, descend the entire dirty tree and upscale every dirty node recursively. Once this is done we can simply export every chunks at lod level 1.

import { DataType } from "#src/util/data_type.js";
import { parseVoxChunkKey } from "#src/voxel_annotation/base.js";
import { openVoxDb } from "#src/voxel_annotation/local_source.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";

export type ExportStatus =
  | { status: "loading"; progress: number }
  | { status: "done"; progress: 1 }
  | { status: "error"; progress: 0; error: string };

interface NormalizedBaseUrl {
  baseUrl: string; // Must end with '/'
}

/**
 * Minimal Zarr v2 single-array exporter for voxel annotations.
 * - Writes only LOD=1 chunks present in IndexedDB.
 * - No dirty-tree traversal or upscaling is performed (feature under development).
 * - No compression and no multiscale hierarchy.
 * - Array is created at subpath "0" under the specified base URL.
 */
export function exportVoxToZarr(targetUrl: string, mapConfig: VoxMapConfig): () => ExportStatus {
  if (!targetUrl || typeof targetUrl !== "string") {
    throw new Error("exportVoxToZarr: targetUrl must be a non-empty string");
  }
  if (!mapConfig || typeof mapConfig !== "object") {
    throw new Error("exportVoxToZarr: mapConfig is required");
  }

  const progressState: { current: ExportStatus } = {
    current: { status: "loading", progress: 0 },
  };

  const { baseUrl } = normalizeBaseUrl(targetUrl);

  void (async () => {
    try {
      const db = await openVoxDb();
      const mapId = String(mapConfig.id);

      // First pass: count chunks per LOD and collect present LODs
      const { countsByLod, totalCount } = await countAllLodChunks(db, mapId);
      const presentLods = Array.from(countsByLod.keys()).sort((a, b) => a - b);
      const lodsToWrite = presentLods.length > 0 ? presentLods : [1];

      // We will write: root .zgroup + root .zattrs + per-lod (.zarray + .zattrs) + all chunks
      const metadataFiles = 2 + lodsToWrite.length * 2;
      const totalWrites = metadataFiles + totalCount;
      let writesCompleted = 0;
      const updateProgress = () => {
        if (totalWrites <= 0) {
          progressState.current = { status: "loading", progress: 0 };
          return;
        }
        progressState.current = {
          status: "loading",
          progress: Math.max(0, Math.min(1, writesCompleted / totalWrites)),
        };
      };

      // Root metadata
      await putJson(joinUrl(baseUrl, ".zgroup"), { zarr_format: 2 });
      writesCompleted++; updateProgress();
      await putJson(joinUrl(baseUrl, ".zattrs"), buildRootZattrsForLods(mapConfig, lodsToWrite));
      writesCompleted++; updateProgress();

      // Per-LOD arrays
      for (const lod of lodsToWrite) {
        const { shapeZYX, chunksZYX, dtype } = deriveZarrMetadataForLod(mapConfig, lod);
        const arrayBase = joinUrl(baseUrl, `${lod}/`);
        const zarray = {
          zarr_format: 2,
          shape: shapeZYX,
          chunks: chunksZYX,
          dtype,
          order: "C",
          fill_value: 0,
          filters: [] as unknown as [],
          compressor: null as unknown as null,
          dimension_separator: ".",
        };
        await putJson(joinUrl(arrayBase, ".zarray"), zarray);
        writesCompleted++; updateProgress();
        await putJson(joinUrl(arrayBase, ".zattrs"), { _ARRAY_DIMENSIONS: ["z", "y", "x"] });
        writesCompleted++; updateProgress();
      }

      // Second pass: upload chunks grouped by their LOD
      await iterateAllLodChunks(db, mapId, async ({ lod, x, y, z, value }) => {
        const chunkRelPath = `${lod}/${z}.${y}.${x}`;
        const chunkUrl = joinUrl(baseUrl, chunkRelPath);
        const buf = ensureArrayBuffer(value);
        await putBinary(chunkUrl, buf);
        writesCompleted++; updateProgress();
      });

      progressState.current = { status: "done", progress: 1 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progressState.current = { status: "error", progress: 0, error: message };
    }
  })();

  return () => progressState.current;
}

/** Normalize supported base URLs to an HTTP(S) base that ends with '/'. */
function normalizeBaseUrl(url: string): NormalizedBaseUrl {
  const trimmed = url.trim();
  // Direct HTTP(S) endpoints, e.g. MinIO: http://localhost:9000/zarr/mydataset/
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { baseUrl: ensureTrailingSlash(trimmed) };
  }
  // S3-compatible explicit endpoint, e.g. s3+http://localhost:9000/zarr/mydataset/
  if (trimmed.startsWith("s3+http://")) {
    return { baseUrl: ensureTrailingSlash(trimmed.substring("s3+".length)) };
  }
  if (trimmed.startsWith("s3+https://")) {
    return { baseUrl: ensureTrailingSlash(trimmed.substring("s3+".length)) };
  }
  // AWS-style shorthand: s3://bucket/path → https://bucket.s3.amazonaws.com/path
  if (trimmed.startsWith("s3://")) {
    const rest = trimmed.substring("s3://".length);
    const firstSlash = rest.indexOf("/");
    if (firstSlash < 0) {
      throw new Error("exportVoxToZarr: s3:// URL must include a path prefix");
    }
    const bucket = rest.substring(0, firstSlash);
    const keyPrefix = rest.substring(firstSlash + 1);
    if (bucket.length === 0) throw new Error("exportVoxToZarr: missing bucket in s3 URL");
    const httpsUrl = `https://${bucket}.s3.amazonaws.com/${keyPrefix}`;
    return { baseUrl: ensureTrailingSlash(httpsUrl) };
  }
  throw new Error(
    `exportVoxToZarr: Unsupported URL scheme; use http(s)://, s3+http(s)://, or s3:// (got: ${url})`,
  );
}

function ensureTrailingSlash(u: string): string {
  return u.endsWith("/") ? u : `${u}/`;
}

function joinUrl(base: string, path: string): string {
  if (!base.endsWith("/")) throw new Error("joinUrl: base must end with '/'");
  if (!path) throw new Error("joinUrl: path must be non-empty");
  if (path.startsWith("/")) path = path.substring(1);
  return base + path;
}

function ensureArrayBuffer(value: any): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer as ArrayBuffer;
  throw new Error("Expected ArrayBuffer value from IndexedDB");
}

async function putJson(url: string, obj: unknown): Promise<void> {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  await putBinary(url, bytes);
}

async function putBinary(url: string, data: ArrayBuffer | ArrayBufferView): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": inferContentTypeFromPath(url),
    },
    body: data,
  });
  if (!response.ok) {
    throw new Error(`Failed to PUT ${url}: ${response.status} ${response.statusText}`);
  }
}

function inferContentTypeFromPath(url: string): string {
  if (url.endsWith(".json") || url.endsWith(".zarray") || url.endsWith(".zattrs") || url.endsWith(".zgroup")) {
    return "application/json";
  }
  return "application/octet-stream";
}

function deriveZarrMetadata(mapCfg: VoxMapConfig): { shapeZYX: number[]; chunksZYX: number[]; dtype: string } {
  const lower = mapCfg.baseVoxelOffset;
  const upper = mapCfg.upperVoxelBound;
  if (!Array.isArray(lower) && !(lower instanceof Float32Array)) {
    throw new Error("mapCfg.baseVoxelOffset must be an array-like of length 3");
  }
  if (!Array.isArray(upper) && !(upper instanceof Float32Array)) {
    throw new Error("mapCfg.upperVoxelBound must be an array-like of length 3");
  }
  const bounds = [
    Math.max(0, Math.floor(Number(upper[0]) - Number(lower[0]))),
    Math.max(0, Math.floor(Number(upper[1]) - Number(lower[1]))),
    Math.max(0, Math.floor(Number(upper[2]) - Number(lower[2]))),
  ];
  const cds = mapCfg.chunkDataSize as unknown as ArrayLike<number>;
  const chunkXYZ = [
    Math.max(1, Math.floor(Number(cds[0]))),
    Math.max(1, Math.floor(Number(cds[1]))),
    Math.max(1, Math.floor(Number(cds[2]))),
  ];
  // We expose Zarr dims as [Z, Y, X]
  const shapeZYX = [bounds[2], bounds[1], bounds[0]];
  const chunksZYX = [chunkXYZ[2], chunkXYZ[1], chunkXYZ[0]];
  const dtype = toZarrDtype(mapCfg.dataType as number);
  return { shapeZYX, chunksZYX, dtype };
}

function deriveZarrMetadataForLod(mapCfg: VoxMapConfig, lod: number): { shapeZYX: number[]; chunksZYX: number[]; dtype: string } {
  if (!Number.isFinite(lod) || lod <= 0) throw new Error("deriveZarrMetadataForLod: lod must be positive");
  const base = deriveZarrMetadata(mapCfg);
  const shapeZYX = [
    Math.max(1, Math.ceil(base.shapeZYX[0] / lod)),
    Math.max(1, Math.ceil(base.shapeZYX[1] / lod)),
    Math.max(1, Math.ceil(base.shapeZYX[2] / lod)),
  ];
  return { shapeZYX, chunksZYX: base.chunksZYX, dtype: base.dtype };
}

function toZarrDtype(dt: number): string {
  switch (dt) {
    case DataType.UINT32:
      return "<u4";
    case DataType.UINT64:
      return "<u8";
    default:
      throw new Error(`Unsupported voxel data type for export: ${dt}`);
  }
}

function metersPerUnit(unit: string): number {
  switch (unit) {
    case "m":
      return 1;
    case "mm":
      return 1e-3;
    case "µm":
    case "um":
      return 1e-6;
    case "nm":
      return 1e-9;
    default:
      throw new Error(`Unsupported unit for OME-Zarr metadata: ${unit}`);
  }
}

function toOmeLongUnit(unit: string): string {
  switch (unit) {
    case "m":
      return "meter";
    case "mm":
      return "millimeter";
    case "µm":
    case "um":
      return "micrometer";
    case "nm":
      return "nanometer";
    default:
      throw new Error(`Unsupported unit for OME-Zarr axes: ${unit}`);
  }
}

function buildRootZattrsForLods(mapCfg: VoxMapConfig, lods: number[]): unknown {
  const rawUnit = String(mapCfg.unit);
  const scale = mapCfg.scaleMeters as unknown as ArrayLike<number>;
  if (scale == null || (scale as any).length < 3) {
    throw new Error("Invalid mapCfg.scaleMeters; expected length-3 array");
  }
  const omeUnit = toOmeLongUnit(rawUnit);
  const mPer = metersPerUnit(rawUnit);
  const sx = Number(scale[0]);
  const sy = Number(scale[1]);
  const sz = Number(scale[2]);
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) {
    throw new Error("scaleMeters contains non-finite values");
  }
  const baseScaleZYX = [sz / mPer, sy / mPer, sx / mPer];
  const datasets = lods.map((lod) => ({
    path: String(lod),
    coordinateTransformations: [
      { type: "scale", scale: [baseScaleZYX[0] * lod, baseScaleZYX[1] * lod, baseScaleZYX[2] * lod] },
    ],
  }));
  return {
    multiscales: [
      {
        version: "0.4",
        axes: [
          { name: "z", type: "space", unit: omeUnit },
          { name: "y", type: "space", unit: omeUnit },
          { name: "x", type: "space", unit: omeUnit },
        ],
        datasets,
      },
    ],
  } as const;
}

async function countAllLodChunks(db: IDBDatabase, mapId: string): Promise<{ countsByLod: Map<number, number>; totalCount: number }> {
  return new Promise((resolve, reject) => {
    const countsByLod = new Map<number, number>();
    let totalCount = 0;
    const tx = db.transaction("chunks", "readonly");
    const store = tx.objectStore("chunks");
    const req = (store as any).openKeyCursor ? (store as any).openKeyCursor() : (store as any).openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = (ev: any) => {
      const cursor: IDBCursor | IDBCursorWithValue | null = ev.target.result;
      if (!cursor) {
        resolve({ countsByLod, totalCount });
        return;
      }
      const key = String(cursor.key);
      const prefix = `${mapId}:`;
      if (key.startsWith(prefix)) {
        const voxKey = key.substring(prefix.length);
        const info = parseVoxChunkKey(voxKey);
        if (info) {
          const c = countsByLod.get(info.lod) ?? 0;
          countsByLod.set(info.lod, c + 1);
          totalCount++;
        }
      }
      cursor.continue();
    };
  });
}

async function iterateAllLodChunks(
  db: IDBDatabase,
  mapId: string,
  onChunk: (args: { lod: number; x: number; y: number; z: number; value: ArrayBuffer }) => Promise<void>,
): Promise<void> {
  const pendingUploads: Promise<void>[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("chunks", "readonly");
    const store = tx.objectStore("chunks");
    const req = store.openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = (ev: any) => {
      const cursor: IDBCursorWithValue | null = ev.target.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        const key = String(cursor.key);
        const prefix = `${mapId}:`;
        if (key.startsWith(prefix)) {
          const voxKey = key.substring(prefix.length);
          const info = parseVoxChunkKey(voxKey);
          if (info) {
            const value = cursor.value as ArrayBuffer;
            const cloned = value.slice(0);
            const uploadPromise = onChunk({ lod: info.lod, x: info.x, y: info.y, z: info.z, value: cloned });
            pendingUploads.push(uploadPromise);
          }
        }
        cursor.continue();
      } catch (e) {
        reject(e);
      }
    };
  });
  for (const p of pendingUploads) {
    await p;
  }
}
