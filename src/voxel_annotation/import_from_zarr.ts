import { DataType, DATA_TYPE_BYTES } from "#src/util/data_type.js";
import { parseVoxChunkKey } from "#src/voxel_annotation/base.js";
import type { SavedChunk } from "#src/voxel_annotation/index.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";

function toDataTypeEnum(dt: number): DataType {
  switch (dt) {
    case DataType.UINT8:
    case DataType.INT8:
    case DataType.UINT16:
    case DataType.INT16:
    case DataType.UINT32:
    case DataType.INT32:
    case DataType.UINT64:
    case DataType.FLOAT32:
      return dt as DataType;
    default:
      throw new Error(`Invalid DataType value: ${dt}`);
  }
}

/** Normalize supported base URLs to an HTTP(S) base that ends with '/'. */
function normalizeZarrBaseUrl(url: string): string {
  if (!url || typeof url !== "string") {
    throw new Error("normalizeZarrBaseUrl: url must be a non-empty string");
  }
  const trimmed = url.trim();
  // Neuroglancer canonical URLs may append a driver suffix after a '|' (e.g., "|zarr2:/" or "|n5").
  // Strip any such suffix before normalizing the base path to an HTTP(S) URL.
  const pipeIndex = trimmed.indexOf("|");
  const basePart = pipeIndex >= 0 ? trimmed.substring(0, pipeIndex) : trimmed;

  const ensureTrailingSlash = (u: string) => (u.endsWith("/") ? u : `${u}/`);

  // Allow explicit zarr+http(s):// or zarr:// prefixes as hints.
  if (basePart.startsWith("zarr+http://")) {
    return ensureTrailingSlash(basePart.substring("zarr+".length));
  }
  if (basePart.startsWith("zarr+https://")) {
    return ensureTrailingSlash(basePart.substring("zarr+".length));
  }
  if (basePart.startsWith("zarr://")) {
    const rest = basePart.substring("zarr://".length);
    if (rest.startsWith("http://") || rest.startsWith("https://")) {
      return ensureTrailingSlash(rest);
    }
    // Treat as https by default if scheme omitted after zarr://
    return ensureTrailingSlash(`https://${rest}`);
  }

  // Direct HTTP(S) endpoints, e.g. MinIO: http://localhost:9000/zarr/mydataset/
  if (basePart.startsWith("http://") || basePart.startsWith("https://")) {
    return ensureTrailingSlash(basePart);
  }
  // S3-compatible explicit endpoint, e.g. s3+http://localhost:9000/zarr/mydataset/
  if (basePart.startsWith("s3+http://")) {
    return ensureTrailingSlash(basePart.substring("s3+".length));
  }
  if (basePart.startsWith("s3+https://")) {
    return ensureTrailingSlash(basePart.substring("s3+".length));
  }
  // AWS-style shorthand: s3://bucket/path → https://bucket.s3.amazonaws.com/path
  if (basePart.startsWith("s3://")) {
    const rest = basePart.substring("s3://".length);
    const firstSlash = rest.indexOf("/");
    if (firstSlash < 0) {
      throw new Error("normalizeZarrBaseUrl: s3:// URL must include a path prefix");
    }
    const bucket = rest.substring(0, firstSlash);
    const keyPrefix = rest.substring(firstSlash + 1);
    if (bucket.length === 0) throw new Error("normalizeZarrBaseUrl: missing bucket in s3 URL");
    return ensureTrailingSlash(`https://${bucket}.s3.amazonaws.com/${keyPrefix}`);
  }
  throw new Error(
    `normalizeZarrBaseUrl: Unsupported URL scheme; use http(s)://, s3+http(s)://, s3://, or zarr(+http(s)):// (got: ${url})`,
  );
}

function joinUrl(base: string, path: string): string {
  if (!base.endsWith("/")) throw new Error("joinUrl: base must end with '/'");
  if (!path) throw new Error("joinUrl: path must be non-empty");
  if (path.startsWith("/")) path = path.substring(1);
  return base + path;
}

async function fetchBinary(url: string, signal?: AbortSignal): Promise<ArrayBuffer | undefined> {
  const resp = await fetch(url, { method: "GET", signal });
  if (resp.status === 404) return undefined;
  if (!resp.ok) {
    throw new Error(`Failed to GET ${url}: ${resp.status} ${resp.statusText}`);
  }
  return await resp.arrayBuffer();
}

function constructTypedArray(dataType: DataType, buffer: ArrayBuffer): Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | BigUint64Array | Float32Array {
  switch (dataType) {
    case DataType.UINT8: return new Uint8Array(buffer);
    case DataType.INT8: return new Int8Array(buffer);
    case DataType.UINT16: return new Uint16Array(buffer);
    case DataType.INT16: return new Int16Array(buffer);
    case DataType.UINT32: return new Uint32Array(buffer);
    case DataType.INT32: return new Int32Array(buffer);
    case DataType.UINT64: return new BigUint64Array(buffer);
    case DataType.FLOAT32: return new Float32Array(buffer);
    default:
      throw new Error(`Unsupported dataType for zarr import: ${dataType}`);
  }
}

export async function fetchZarrChunkIfAvailable(mapCfg: VoxMapConfig | undefined, voxKey: string, signal?: AbortSignal): Promise<SavedChunk | undefined> {
  if (!mapCfg) throw new Error("fetchZarrChunkIfAvailable: mapCfg is required");
  const importUrl = mapCfg.importUrl;
  if (!importUrl) return undefined;
  const info = parseVoxChunkKey(voxKey);
  if (!info) throw new Error(`fetchZarrChunkIfAvailable: invalid voxKey: ${voxKey}`);
  const baseUrl = normalizeZarrBaseUrl(importUrl);
  const chunkPath = `${info.lod}/${info.z}.${info.y}.${info.x}`;
  const url = joinUrl(baseUrl, chunkPath);
  const buf = await fetchBinary(url, signal);
  if (buf === undefined) return undefined; // Not present remotely

  const expectedCount = (mapCfg.chunkDataSize[0] | 0) * (mapCfg.chunkDataSize[1] | 0) * (mapCfg.chunkDataSize[2] | 0);
  const dataTypeEnum = toDataTypeEnum(Number(mapCfg.dataType));
  const bytesPer = DATA_TYPE_BYTES[dataTypeEnum];
  const expectedBytes = expectedCount * bytesPer;
  if (buf.byteLength !== expectedBytes) {
    throw new Error(`Zarr chunk size mismatch for ${voxKey}: expected ${expectedBytes}B, got ${buf.byteLength}B`);
  }
  const arr = constructTypedArray(dataTypeEnum, buf) as unknown as Uint32Array | BigUint64Array | any;
  const saved: SavedChunk = { data: arr, size: new Uint32Array(mapCfg.chunkDataSize as any) };
  return saved;
}
