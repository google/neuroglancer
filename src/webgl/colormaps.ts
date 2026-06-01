/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Colormap names and lazy per-colormap LUT loader.
 *
 * Colormap data is shipped as a Zarr v3 array (src/webgl/colormaps.zarr/)
 * of shape (N, 256, 3) uint8 with the `sharding_indexed` codec: all N
 * logical chunks (one per colormap) live in a single physical shard file
 * at c/0/0/0. The shard's trailing index makes per-colormap fetches
 * possible via HTTP Range requests against the shard.
 *
 * The loader is lazy and on-demand:
 *   - `getColormapBytesAsync(name)` fetches one colormap (one Range
 *     request, ~768 bytes after the metadata + index are cached).
 *   - `getAllColormapsAsync()` fetches every colormap in parallel; used by
 *     the dropdown widget when the user opens it.
 *   - `getColormapBytes(name)` is the synchronous accessor — returns
 *     cached bytes or undefined.
 *
 * Loading reuses Neuroglancer's Zarr v3 metadata parser and codec
 * pipeline, so the asset is opened the same way an external `tensorstore`
 * or `zarr-python` consumer would open it. Regenerate the on-disk array
 * with `uv run --no-project build_tools/generate_colormaps_zarr.py`.
 */

// Side-effect imports to register every codec we use, in both the
// resolve (metadata-parsing) and decode (chunk-decoding) registries.
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/bytes/decode.js";
import "#src/datasource/zarr/codec/crc32c/resolve.js";
import "#src/datasource/zarr/codec/crc32c/decode.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import type {
  CodecChainSpec,
  CodecSpec,
} from "#src/datasource/zarr/codec/index.js";

import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration as ShardingConfiguration } from "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import { ShardIndexLocation } from "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { parseV3Metadata } from "#src/datasource/zarr/metadata/parse.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";
import { setRawTextureParameters } from "#src/webgl/texture.js";

// Full list of colormaps present in colormaps.zarr, in N-axis order. Includes
// back-compat-only colormaps (e.g. `jet`) that are not exposed in the user-
// facing dropdown but are reachable via free GLSL functions like
// `colormapJet`. MUST match generate_colormaps_zarr.py and the
// `attributes.colormap_names` array in colormaps.zarr/zarr.json.
export const COLORMAP_BIN_NAMES = [
  "grayscale",
  "viridis",
  "plasma",
  "cividis",
  "magma",
  "coolwarm",
  "rdbu",
  "turbo",
  "cubehelix",
  "oranges",
  "jet",
] as const;

export type ColormapBinName = (typeof COLORMAP_BIN_NAMES)[number];

// User-facing list shown in the #uicontrol colormap dropdown.
export const COLORMAP_NAMES = [
  "grayscale",
  "viridis",
  "plasma",
  "cividis",
  "magma",
  "coolwarm",
  "rdbu",
  "turbo",
  "cubehelix",
  "oranges",
] as const;

export type ColormapName = (typeof COLORMAP_NAMES)[number];

const COLORMAP_DISPLAY_NAMES: Record<ColormapName, string> = {
  grayscale: "Grayscale",
  viridis: "Viridis",
  plasma: "Plasma",
  cividis: "Cividis",
  magma: "Magma",
  coolwarm: "Coolwarm",
  rdbu: "RdBu",
  turbo: "Turbo",
  cubehelix: "Cubehelix",
  oranges: "Oranges",
};

export function colormapDisplayName(name: ColormapName): string {
  return COLORMAP_DISPLAY_NAMES[name];
}

/** Bytes per colormap LUT: 256 entries × 3 channels (RGB). */
export const COLORMAP_STRIDE = 256 * 3;

/**
 * Fires every time a new colormap's bytes finish loading (per colormap,
 * not once-only). Subscribers are responsible for retrying / re-rendering.
 */
export const colormapDataLoaded = new NullarySignal();

// Per-colormap cache (permanent once populated).
const colormapBytesCache = new Map<ColormapBinName, Uint8Array>();
// In-flight per-colormap fetches, keyed by colormap name. Deduplicates
// concurrent callers.
const inFlightFetches = new Map<ColormapBinName, Promise<Uint8Array>>();

interface ShardIndexEntry {
  offset: number;
  length: number;
}

interface ColormapZarrMetadata {
  arrayMetadata: ArrayMetadata;
  shardUrl: string;
  subChunkCodecs: CodecChainSpec;
  indexCodecs: CodecChainSpec;
  indexLocation: ShardIndexLocation;
  indexEncodedSize: number;
}

// rspack-injected global identifying the deployed URL prefix for emitted
// assets. With `output.publicPath: "auto"` (the default in this config)
// it's resolved at runtime from the bundle's script URL, so it points to
// the directory containing the bundle and, via CopyRspackPlugin, the
// colormaps.zarr directory. We can't use `new URL("./colormaps.zarr/",
// import.meta.url)` because rspack only rewrites `new URL` references to
// paths it recognizes as assets; CopyRspackPlugin-emitted directories
// aren't in the module graph.
declare const __webpack_public_path__: string;

let metadataPromise: Promise<ColormapZarrMetadata> | undefined;
let shardIndexPromise: Promise<ShardIndexEntry[]> | undefined;

function getColormapMetadata(): Promise<ColormapZarrMetadata> {
  if (metadataPromise === undefined) {
    metadataPromise = (async (): Promise<ColormapZarrMetadata> => {
      const base = new URL("colormaps.zarr/", __webpack_public_path__);
      const metadataJson = await fetchJson(new URL("zarr.json", base).href);
      const arrayMetadata = parseV3Metadata(metadataJson, "array");
      if (arrayMetadata.nodeType !== "array") {
        throw new Error(
          `colormaps.zarr: expected an array node, got ${arrayMetadata.nodeType}`,
        );
      }
      if (arrayMetadata.dataType !== DataType.UINT8) {
        throw new Error(
          `colormaps.zarr: expected uint8 data, got ${arrayMetadata.dataType}`,
        );
      }
      const expectedShape = [COLORMAP_BIN_NAMES.length, 256, 3];
      if (
        arrayMetadata.shape.length !== expectedShape.length ||
        arrayMetadata.shape.some((v, i) => v !== expectedShape[i])
      ) {
        throw new Error(
          `colormaps.zarr: expected shape ${JSON.stringify(expectedShape)}, got ${JSON.stringify(arrayMetadata.shape)}`,
        );
      }
      const namesAttr = arrayMetadata.userAttributes.colormap_names;
      if (
        !Array.isArray(namesAttr) ||
        namesAttr.length !== COLORMAP_BIN_NAMES.length ||
        namesAttr.some((n, i) => n !== COLORMAP_BIN_NAMES[i])
      ) {
        throw new Error(
          `colormaps.zarr: attributes.colormap_names ${JSON.stringify(namesAttr)} does not match COLORMAP_BIN_NAMES ${JSON.stringify(COLORMAP_BIN_NAMES)}`,
        );
      }
      const arrayToBytesCodec: CodecSpec<CodecKind.arrayToBytes> =
        arrayMetadata.codecs[CodecKind.arrayToBytes];
      if (arrayToBytesCodec.name !== "sharding_indexed") {
        throw new Error(
          `colormaps.zarr: expected sharding_indexed codec, got ${arrayToBytesCodec.name}`,
        );
      }
      const shardingConfig =
        arrayToBytesCodec.configuration as ShardingConfiguration;
      const indexCodecs = shardingConfig.indexCodecs;
      const indexEncodedSize =
        indexCodecs.encodedSize[indexCodecs.encodedSize.length - 1];
      if (indexEncodedSize === undefined) {
        throw new Error(
          "colormaps.zarr: sharding index codecs must have a fixed encoded size",
        );
      }
      return {
        arrayMetadata,
        // The single outer chunk lives at "c/0/0/0" (default chunk key
        // encoding, "/" separator, all-zero chunk grid index).
        shardUrl: new URL("c/0/0/0", base).href,
        subChunkCodecs: shardingConfig.subChunkCodecs,
        indexCodecs,
        indexLocation: shardingConfig.indexLocation,
        indexEncodedSize,
      };
    })();
  }
  return metadataPromise;
}

function getShardIndex(): Promise<ShardIndexEntry[]> {
  if (shardIndexPromise === undefined) {
    shardIndexPromise = (async (): Promise<ShardIndexEntry[]> => {
      const meta = await getColormapMetadata();
      // Determine the byte range of the index within the shard.
      let rangeHeader: string;
      if (meta.indexLocation === ShardIndexLocation.END) {
        rangeHeader = `bytes=-${meta.indexEncodedSize}`;
      } else {
        rangeHeader = `bytes=0-${meta.indexEncodedSize - 1}`;
      }
      const encoded = await fetchRange(meta.shardUrl, rangeHeader);
      if (encoded.length !== meta.indexEncodedSize) {
        throw new Error(
          `colormaps.zarr: expected ${meta.indexEncodedSize}-byte shard index, got ${encoded.length}`,
        );
      }
      const decoded = await decodeArray(
        meta.indexCodecs,
        encoded,
        new AbortController().signal,
      );
      // After decoding, the index is a flat row-major array of shape
      // [N, 1, 1, 2] uint64 values: for each sub-chunk i, (offset, length).
      const view = new BigUint64Array(
        decoded.buffer,
        decoded.byteOffset,
        decoded.byteLength / 8,
      );
      const numSubChunks = COLORMAP_BIN_NAMES.length;
      if (view.length !== numSubChunks * 2) {
        throw new Error(
          `colormaps.zarr: expected ${numSubChunks * 2} uint64 index entries, got ${view.length}`,
        );
      }
      const result: ShardIndexEntry[] = [];
      for (let i = 0; i < numSubChunks; i++) {
        const offset = view[i * 2];
        const length = view[i * 2 + 1];
        // The Zarr spec uses 0xFFFFFFFFFFFFFFFFn (max uint64) to mark a
        // missing chunk. Our writer never produces those, but guard anyway.
        if (offset === 0xffffffffffffffffn) {
          throw new Error(
            `colormaps.zarr: sub-chunk ${i} (${COLORMAP_BIN_NAMES[i]}) is missing`,
          );
        }
        result.push({ offset: Number(offset), length: Number(length) });
      }
      return result;
    })();
  }
  return shardIndexPromise;
}

/**
 * Fetches the LUT bytes for one colormap. Idempotent: concurrent calls
 * for the same name share an in-flight Promise; completed calls return
 * from the per-colormap cache instantly.
 */
export function getColormapBytesAsync(
  name: ColormapBinName,
): Promise<Uint8Array> {
  const cached = colormapBytesCache.get(name);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = inFlightFetches.get(name);
  if (existing !== undefined) return existing;
  const promise = (async (): Promise<Uint8Array> => {
    try {
      const meta = await getColormapMetadata();
      const index = await getShardIndex();
      const idx = COLORMAP_BIN_NAMES.indexOf(name);
      if (idx < 0) throw new Error(`Unknown colormap: ${name}`);
      const { offset, length } = index[idx];
      const encoded = await fetchRange(
        meta.shardUrl,
        `bytes=${offset}-${offset + length - 1}`,
      );
      if (encoded.length !== length) {
        throw new Error(
          `colormaps.zarr: expected ${length}-byte sub-chunk for ${name}, got ${encoded.length}`,
        );
      }
      const decoded = await decodeArray(
        meta.subChunkCodecs,
        encoded,
        new AbortController().signal,
      );
      const bytes = new Uint8Array(
        decoded.buffer,
        decoded.byteOffset,
        decoded.byteLength,
      );
      if (bytes.length !== COLORMAP_STRIDE) {
        throw new Error(
          `colormaps.zarr: decoded sub-chunk for ${name} has ${bytes.length} bytes, expected ${COLORMAP_STRIDE}`,
        );
      }
      colormapBytesCache.set(name, bytes);
      colormapDataLoaded.dispatch();
      return bytes;
    } finally {
      inFlightFetches.delete(name);
    }
  })();
  inFlightFetches.set(name, promise);
  return promise;
}

/**
 * Fetches every colormap in parallel. Used by the dropdown widget so all
 * swatches can render. Shares the per-colormap cache + in-flight map with
 * `getColormapBytesAsync`, so calling this is safe alongside individual
 * fetches.
 */
export async function getAllColormapsAsync(): Promise<void> {
  await Promise.all(COLORMAP_BIN_NAMES.map((n) => getColormapBytesAsync(n)));
}

/**
 * Synchronous accessor: returns the cached 768-byte RGB LUT for `name`,
 * or `undefined` if it hasn't loaded yet. Callers needing the data must
 * await `getColormapBytesAsync(name)` or subscribe to `colormapDataLoaded`.
 */
export function getColormapBytes(
  name: ColormapBinName,
): Uint8Array | undefined {
  return colormapBytesCache.get(name);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

async function fetchRange(
  url: string,
  range: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { headers: { Range: range } });
  // 206 Partial Content is the success status for a satisfied Range request.
  // Some servers will respond 200 with the full body if they don't support
  // Range — that's a misconfiguration we want to surface explicitly.
  if (response.status !== 206 && response.status !== 200) {
    throw new Error(
      `Failed Range fetch ${url} [${range}]: ${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

// Singleton 768-byte all-zero LUT used as the "loading" texture content.
let zeroLut: Uint8Array | undefined;
function getZeroLutBytes(): Uint8Array {
  if (zeroLut === undefined) zeroLut = new Uint8Array(COLORMAP_STRIDE);
  return zeroLut;
}

/**
 * A 256×1 RGB texture holding one colormap's LUT. Tracks which colormap
 * is currently uploaded and exposes a ready/not-ready signal so render
 * layers can skip drawing on first load.
 *
 * Toggle behavior: when asked to bind a colormap whose bytes are not yet
 * cached AND a previous colormap is uploaded, the previous texture stays
 * bound. Once the new colormap's bytes arrive, `colormapDataLoaded` fires
 * and the next draw uploads the new bytes.
 *
 * First-load behavior: when no colormap has ever been uploaded and the
 * requested colormap isn't cached, a zero-byte "loading" LUT is uploaded
 * so the shader reads deterministic black. `ready: false` is returned so
 * callers may skip the draw entirely if they wish.
 */
export class ColormapTexture extends RefCounted {
  private texture: WebGLTexture | null = null;
  // The last uploaded REAL colormap (undefined until we have cached bytes).
  // While undefined, the texture is either uninitialized or holds the
  // zero-LUT loading state (see `showingZeroLut`).
  private currentColormap: ColormapBinName | undefined = undefined;
  private showingZeroLut = false;
  constructor(public gl: GL) {
    super();
  }
  bindAndUpload(
    textureUnit: number,
    name: ColormapBinName,
  ): { ready: boolean } {
    const cached = colormapBytesCache.get(name);
    if (cached !== undefined) {
      if (this.currentColormap !== name || this.showingZeroLut) {
        this.upload(textureUnit, cached);
        this.currentColormap = name;
        this.showingZeroLut = false;
      } else {
        this.bindOnly(textureUnit);
      }
      return { ready: true };
    }
    // Not cached — kick off the fetch (idempotent) but don't await it.
    // colormapDataLoaded will dispatch on completion, which drives a redraw.
    void getColormapBytesAsync(name);
    if (this.currentColormap !== undefined) {
      // Toggle path: keep rendering with the previously-uploaded colormap.
      this.bindOnly(textureUnit);
      return { ready: true };
    }
    // First load with no fallback. Upload a zero LUT so the shader reads
    // deterministic black (rather than whatever was previously bound).
    if (!this.showingZeroLut) {
      this.upload(textureUnit, getZeroLutBytes());
      this.showingZeroLut = true;
    } else {
      this.bindOnly(textureUnit);
    }
    return { ready: false };
  }
  private bindOnly(textureUnit: number) {
    const { gl } = this;
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, this.texture);
  }
  private upload(textureUnit: number, bytes: Uint8Array) {
    const { gl } = this;
    if (this.texture === null) {
      this.texture = gl.createTexture();
    }
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, this.texture);
    setRawTextureParameters(gl);
    gl.texParameteri(
      WebGL2RenderingContext.TEXTURE_2D,
      WebGL2RenderingContext.TEXTURE_MIN_FILTER,
      WebGL2RenderingContext.LINEAR,
    );
    gl.texParameteri(
      WebGL2RenderingContext.TEXTURE_2D,
      WebGL2RenderingContext.TEXTURE_MAG_FILTER,
      WebGL2RenderingContext.LINEAR,
    );
    gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      WebGL2RenderingContext.TEXTURE_2D,
      0,
      WebGL2RenderingContext.RGB8,
      256,
      1,
      0,
      WebGL2RenderingContext.RGB,
      WebGL2RenderingContext.UNSIGNED_BYTE,
      bytes,
    );
  }
  disposed() {
    if (this.texture !== null) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
    super.disposed();
  }
}
