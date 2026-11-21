/**
 * @license
 * Copyright 2026 Google Inc.
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
 * @file The warpfield decoder: the reference Rust implementation
 * (zarr-warpfield, crate `warpfield-wasm`), compiled to WebAssembly.
 *
 * The module has no imports and a plain C ABI: `wf_alloc` / `wf_free`,
 * `wf_decode(cfg, cfg_len, buf, buf_len, shape, rank, dtype, out)` returning
 * 0 or an error status with the message at `wf_error_ptr` / `wf_error_len`.
 * Rebuild with `build_wasm.sh`.
 */

interface WarpfieldExports {
  memory: WebAssembly.Memory;
  wf_alloc(n: number): number;
  wf_free(p: number, n: number): void;
  wf_error_ptr(): number;
  wf_error_len(): number;
  wf_decode(
    cfgPtr: number,
    cfgLen: number,
    bufPtr: number,
    bufLen: number,
    shapePtr: number,
    rank: number,
    dtype: number,
    outPtr: number,
  ): number;
}

export class WarpfieldDecoder {
  private exports: WarpfieldExports;
  private configCache = new Map<string, [number, number]>();

  constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports as unknown as WarpfieldExports;
  }

  static async instantiate(
    source: BufferSource | Promise<Response>,
  ): Promise<WarpfieldDecoder> {
    const { instance } =
      source instanceof Promise
        ? await WebAssembly.instantiateStreaming(source, {})
        : await WebAssembly.instantiate(source, {});
    return new WarpfieldDecoder(instance);
  }

  private copyIn(bytes: Uint8Array): number {
    const ptr = this.exports.wf_alloc(bytes.length);
    new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  }

  // The configuration JSON stays in wasm memory, one copy per configuration.
  private config(json: string): [number, number] {
    let c = this.configCache.get(json);
    if (c === undefined) {
      const bytes = new TextEncoder().encode(json);
      c = [this.copyIn(bytes), bytes.length];
      this.configCache.set(json, c);
    }
    return c;
  }

  /** Decodes one float32 chunk, C order of `shape`. */
  decode(
    encoded: Uint8Array,
    shape: ArrayLike<number>,
    configJson: string,
  ): Float32Array<ArrayBuffer> {
    return this.decodeAs(encoded, shape, configJson, Float32Array);
  }

  decodeAs<T extends Float32ArrayConstructor | Float64ArrayConstructor>(
    encoded: Uint8Array,
    shape: ArrayLike<number>,
    configJson: string,
    arrayType: T,
  ): InstanceType<T> {
    const size = arrayType.BYTES_PER_ELEMENT;
    const e = this.exports;
    const n = Array.from(shape).reduce((a, b) => a * b, 1);
    const [cfgPtr, cfgLen] = this.config(configJson);
    const bufPtr = this.copyIn(encoded);
    const shapePtr = e.wf_alloc(4 * shape.length);
    new Uint32Array(e.memory.buffer, shapePtr, shape.length).set(
      Array.from(shape),
    );
    const outPtr = e.wf_alloc(size * n);
    try {
      const status = e.wf_decode(
        cfgPtr,
        cfgLen,
        bufPtr,
        encoded.length,
        shapePtr,
        shape.length,
        size === 4 ? 0 : 1,
        outPtr,
      );
      if (status !== 0) {
        const msg = new TextDecoder().decode(
          new Uint8Array(e.memory.buffer, e.wf_error_ptr(), e.wf_error_len()),
        );
        throw new Error(`warpfield: ${msg}`);
      }
      // Copy out: the wasm memory may grow (and move) on the next call.
      return new arrayType(
        e.memory.buffer,
        outPtr,
        n,
      ).slice() as InstanceType<T>;
    } finally {
      e.wf_free(bufPtr, encoded.length);
      e.wf_free(shapePtr, 4 * shape.length);
      e.wf_free(outPtr, size * n);
    }
  }
}

let decoderPromise: Promise<WarpfieldDecoder> | undefined;

/** The decoder of this worker, loaded on first use. */
export function getWarpfieldDecoder(): Promise<WarpfieldDecoder> {
  if (decoderPromise === undefined) {
    decoderPromise = WarpfieldDecoder.instantiate(
      fetch(new URL("./warpfield.wasm", import.meta.url)),
    );
  }
  return decoderPromise;
}
