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
 * @file Colormap names and runtime LUT loader.
 *
 * Colormap data is shipped as a single binary asset (colormaps.bin), a
 * concatenation of N 256x3 RGB LUTs in the order of `COLORMAP_NAMES`. The
 * file is fetched once at app start; shaders sample it through a 1D texture
 * uniform instead of inlining polynomial approximations.
 *
 * Regenerate the binary with `build_tools/generate_colormaps_bin.py`.
 */

import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import COLORMAPS_BIN_URL from "#src/webgl/colormaps.bin";
import type { GL } from "#src/webgl/context.js";
import { setRawTextureParameters } from "#src/webgl/texture.js";

// Full list of colormaps present in colormaps.bin, in offset order. Includes
// back-compat-only colormaps (e.g. `jet`) that are not exposed in the user-
// facing dropdown but are reachable via free GLSL functions like
// `colormapJet`. MUST match generate_colormaps_bin.py.
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

/** Bytes per colormap LUT: 256 entries x 3 channels (RGB). */
export const COLORMAP_STRIDE = 256 * 3;

/** Fires once when colormap LUT data finishes loading. */
export const colormapDataLoaded = new NullarySignal();

let colormapDataPromise: Promise<Uint8Array> | undefined;
let colormapDataCache: Uint8Array | undefined;

/**
 * Returns a promise resolving to the full concatenated LUT buffer. The fetch
 * is started lazily on first call and shared across all callers.
 */
export function getColormapDataPromise(): Promise<Uint8Array> {
  if (colormapDataPromise === undefined) {
    colormapDataPromise = fetch(COLORMAPS_BIN_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to fetch colormaps.bin: ${response.status} ${response.statusText}`,
          );
        }
        return response.arrayBuffer();
      })
      .then((buffer) => {
        const expectedSize = COLORMAP_BIN_NAMES.length * COLORMAP_STRIDE;
        if (buffer.byteLength !== expectedSize) {
          throw new Error(
            `colormaps.bin size mismatch: got ${buffer.byteLength}, expected ${expectedSize}`,
          );
        }
        colormapDataCache = new Uint8Array(buffer);
        colormapDataLoaded.dispatch();
        return colormapDataCache;
      });
  }
  return colormapDataPromise;
}

/**
 * Synchronous accessor: returns a 768-byte RGB view into the cached LUT for
 * `name`, or `undefined` if the data hasn't loaded yet. Callers that need
 * the data must either await `getColormapDataPromise()` or subscribe to
 * `colormapDataLoaded` and retry on dispatch.
 */
export function getColormapBytes(
  name: ColormapBinName,
): Uint8Array | undefined {
  if (colormapDataCache === undefined) return undefined;
  const idx = COLORMAP_BIN_NAMES.indexOf(name);
  if (idx < 0) return undefined;
  return colormapDataCache.subarray(
    idx * COLORMAP_STRIDE,
    (idx + 1) * COLORMAP_STRIDE,
  );
}

/**
 * Returns a 768-byte grayscale LUT (R=G=B=i for i in 0..255). Used as a
 * fallback before the binary asset has finished loading.
 */
let grayscaleFallback: Uint8Array | undefined;
export function getGrayscaleFallbackBytes(): Uint8Array {
  if (grayscaleFallback === undefined) {
    const buf = new Uint8Array(COLORMAP_STRIDE);
    for (let i = 0; i < 256; i++) {
      buf[i * 3 + 0] = i;
      buf[i * 3 + 1] = i;
      buf[i * 3 + 2] = i;
    }
    grayscaleFallback = buf;
  }
  return grayscaleFallback;
}

/**
 * A 256x1 RGB texture holding one colormap's LUT. The texture is uploaded
 * lazily on first use and re-uploaded only when the requested colormap name
 * changes. Uses LINEAR filtering so the GPU interpolates between adjacent
 * LUT entries.
 */
export class ColormapTexture extends RefCounted {
  private texture: WebGLTexture | null = null;
  private currentColormap: ColormapBinName | undefined = undefined;
  private currentlyUsingFallback = false;
  constructor(public gl: GL) {
    super();
  }
  /**
   * Binds this texture to the given unit and uploads the requested colormap
   * if it has changed since last call (or if the cache became populated
   * after a fallback upload).
   */
  bindAndUpload(textureUnit: number, name: ColormapBinName): void {
    const { gl } = this;
    if (this.texture === null) {
      this.texture = gl.createTexture();
    }
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, this.texture);
    let bytes = getColormapBytes(name);
    let usingFallback = false;
    if (bytes === undefined) {
      bytes = getGrayscaleFallbackBytes();
      usingFallback = true;
    }
    // Re-upload if the colormap name changed, or if we were previously
    // showing a fallback and the real data has now arrived.
    if (
      this.currentColormap === name &&
      this.currentlyUsingFallback === usingFallback
    ) {
      return;
    }
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
    this.currentColormap = name;
    this.currentlyUsingFallback = usingFallback;
  }
  disposed() {
    if (this.texture !== null) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
    super.disposed();
  }
}
