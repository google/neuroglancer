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
 * Colormap data is shipped as a single uncompressed Zarr v3 chunk file
 * at src/webgl/colormaps.zarr/c/0/0/0 — chunk_shape == shape, just the
 * `bytes` codec, so the chunk file's bytes ARE the raw uint8 LUT data in
 * C-order. The JS bundle fetches that file directly via the standard
 * `new URL(path, import.meta.url)` asset pattern; the bundler emits the
 * chunk file alongside the bundle with no custom rules.
 *
 * Both the chunk file and the accompanying zarr.json are produced at
 * build time by build_tools/generate_colormaps_zarr.py (run via the
 * `generate-colormaps` npm script, hooked into pre-build/dev-server
 * scripts and build_tools/build-package.ts). zarr.json itself is NOT
 * fetched at runtime — it exists so external tools (`tensorstore`,
 * `zarr-python`) can still open the array.
 *
 * Per-colormap byte offset in the chunk: `i * 768` where i is the
 * colormap's index in `COLORMAP_BIN_NAMES`.
 */

import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import {
  COLORMAP_BIN_NAMES,
  COLORMAP_NAMES,
} from "#src/webgl/colormap_names_generated.js";
import type { GL } from "#src/webgl/context.js";
import { setRawTextureParameters } from "#src/webgl/texture.js";

export { COLORMAP_BIN_NAMES, COLORMAP_NAMES };
export type ColormapBinName = (typeof COLORMAP_BIN_NAMES)[number];
export type ColormapName = (typeof COLORMAP_NAMES)[number];

/** Bytes per colormap LUT: 256 entries × 3 channels (RGB). */
export const COLORMAP_STRIDE = 256 * 3;

/**
 * Fires every time a new colormap's bytes finish loading (per colormap,
 * not once-only). Subscribers are responsible for retrying / re-rendering.
 */
export const colormapDataLoaded = new NullarySignal();

// Per-colormap cache (permanent once populated).
const colormapBytesCache = new Map<ColormapBinName, Uint8Array>();
// In-flight per-colormap fetches; deduplicates concurrent callers.
const inFlightFetches = new Map<ColormapBinName, Promise<Uint8Array>>();

// rspack/webpack/vite all rewrite this `new URL(static-string, import.meta.url)`
// call at build time so it resolves to the emitted (content-hashed) asset
// URL at runtime — no custom rules in rspack.config.ts. The chunk file's
// bytes ARE the raw LUT data because the Zarr `bytes` codec on uint8 is a
// no-op.
const CHUNK_URL = new URL("./colormaps.zarr/c/0/0/0", import.meta.url).href;

/**
 * Fetches the LUT bytes for one colormap via an HTTP Range request
 * against the single shared chunk file. Idempotent: concurrent calls for
 * the same name share an in-flight Promise; completed calls return from
 * the per-colormap cache instantly.
 */
export function getColormapBytesAsync(
  name: ColormapBinName,
): Promise<Uint8Array> {
  const cached = colormapBytesCache.get(name);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = inFlightFetches.get(name);
  if (existing !== undefined) return existing;
  const idx = COLORMAP_BIN_NAMES.indexOf(name);
  if (idx < 0) {
    return Promise.reject(new Error(`Unknown colormap: ${name}`));
  }
  const start = idx * COLORMAP_STRIDE;
  const end = start + COLORMAP_STRIDE - 1;
  const promise = (async (): Promise<Uint8Array> => {
    try {
      const response = await fetch(CHUNK_URL, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      // 206 Partial Content is the success status for a satisfied Range
      // request. Some servers may respond 200 with the full body if they
      // don't support Range — slice it ourselves in that case.
      if (response.status !== 206 && response.status !== 200) {
        throw new Error(
          `Failed to fetch colormap ${name}: ${response.status} ${response.statusText}`,
        );
      }
      const buffer = await response.arrayBuffer();
      let bytes: Uint8Array;
      if (response.status === 200 && buffer.byteLength > COLORMAP_STRIDE) {
        // Server ignored the Range header; slice client-side.
        bytes = new Uint8Array(buffer, start, COLORMAP_STRIDE);
      } else {
        bytes = new Uint8Array(buffer);
      }
      if (bytes.length !== COLORMAP_STRIDE) {
        throw new Error(
          `Colormap ${name}: expected ${COLORMAP_STRIDE} bytes, got ${bytes.length}`,
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
 * Fetches every colormap in one HTTP request and partitions the result
 * into the per-colormap cache. Used by the dropdown widget so all
 * swatches can render in one round-trip. Idempotent — skips colormaps
 * that are already cached.
 */
export async function getAllColormapsAsync(): Promise<void> {
  if (COLORMAP_BIN_NAMES.every((n) => colormapBytesCache.has(n))) return;
  const response = await fetch(CHUNK_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch colormaps chunk: ${response.status} ${response.statusText}`,
    );
  }
  const all = new Uint8Array(await response.arrayBuffer());
  const expectedBytes = COLORMAP_BIN_NAMES.length * COLORMAP_STRIDE;
  if (all.length !== expectedBytes) {
    throw new Error(
      `colormaps chunk: expected ${expectedBytes} bytes, got ${all.length}`,
    );
  }
  for (let i = 0; i < COLORMAP_BIN_NAMES.length; i++) {
    const name = COLORMAP_BIN_NAMES[i];
    if (!colormapBytesCache.has(name)) {
      colormapBytesCache.set(
        name,
        all.subarray(i * COLORMAP_STRIDE, (i + 1) * COLORMAP_STRIDE),
      );
    }
  }
  colormapDataLoaded.dispatch();
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

// Singleton 768-byte all-zero LUT used as the first-load "loading"
// texture content (samples as deterministic black).
let zeroLut: Uint8Array | undefined;
function getZeroLutBytes(): Uint8Array {
  if (zeroLut === undefined) zeroLut = new Uint8Array(COLORMAP_STRIDE);
  return zeroLut;
}
