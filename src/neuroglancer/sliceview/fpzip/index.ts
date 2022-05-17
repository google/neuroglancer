/**
 * @license
 * Copyright 2022 William Silvermsith
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

import fpzipWasmDataUrl from './libfpzip.wasm';

const libraryEnv = {
  emscripten_notify_memory_growth: function () {},
  proc_exit: (code: number) => {
    throw `proc exit: ${code}`;
  },
};

const fpzipModulePromise = (async () => {
  const response = await fetch(fpzipWasmDataUrl);
  const wasmCode = await response.arrayBuffer();
  const m = await WebAssembly.instantiate(wasmCode, {
    env: libraryEnv,
    wasi_snapshot_preview1: libraryEnv,
  });
  (m.instance.exports._initialize as Function)();
  return m;
})();

export async function decompressFpzip(
  buffer: Uint8Array, 
  width: number, height: number, depth: number,
  numComponents: number, bytesPerPixel:number,
) : Promise<Float32Array> {
  return decompress_helper(
    buffer, 
    width, height, depth, 
    numComponents, bytesPerPixel,
    /*kempressed=*/false
  );
}

export async function decompressKempressed(
  buffer: Uint8Array, 
  width: number, height: number, depth: number,
  numComponents: number, bytesPerPixel:number,
) : Promise<Float32Array> {
  return decompress_helper(
    buffer, 
    width, height, depth, 
    numComponents, bytesPerPixel,
    /*kempressed=*/true
  );
}

async function decompress_helper(
  buffer: Uint8Array, 
  width: number, height: number, depth: number,
  numComponents: number, bytesPerPixel:number,
  kempressed: boolean
) : Promise<Float32Array> {
  
  const m = await fpzipModulePromise;

  const nbytes = width * height * depth * bytesPerPixel * numComponents;
  if (nbytes < 0) {
    throw new Error(`fpzip: Failed to decode fpzip image size. image size: ${nbytes}`);
  }

  // heap must be referenced after creating bufPtr and imagePtr because
  // memory growth can detatch the buffer.
  let bufPtr = (m.instance.exports.malloc as Function)(buffer.byteLength);
  const imagePtr = (m.instance.exports.malloc as Function)(nbytes);
  let heap = new Uint8Array((m.instance.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, bufPtr);

  try {
    const is_valid = (m.instance.exports.check_valid as Function)(
      bufPtr, width, height, depth, 
      numComponents, bytesPerPixel
    );

    if (!is_valid) {
      throw new Error(
        `fpzip: Image decode parameters did not match expected chunk parameters.
           Expected: width: ${width} height: ${height} depth: ${depth} channels: ${numComponents} bytes per pixel: ${bytesPerPixel}
        `
      );
    }

    const fn = kempressed 
      ? (m.instance.exports.fpzip_dekempress as Function)
      : (m.instance.exports.fpzip_decompress as Function)

    const code = fn(
      bufPtr, buffer.byteLength, imagePtr, nbytes
    );

    if (code !== 0) {
      throw new Error(`fpzip: Failed to decode fpzip image. decoder code: ${code}`);
    }

    // Likewise, we reference memory.buffer instead of heap.buffer
    // because memory growth during decompress could have detached
    // the buffer.
    const image = new Float32Array(
      (m.instance.exports.memory as WebAssembly.Memory).buffer,
      imagePtr, (width * height * depth * numComponents)
    );
    // copy the array so it can be memory managed by JS
    // and we can free the emscripten buffer
    return image.slice(0);
  }
  finally {
    (m.instance.exports.free as Function)(bufPtr);
    (m.instance.exports.free as Function)(imagePtr);      
  }
}
