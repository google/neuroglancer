/**
 * @license
 * Copyright 2021 William Silvermsith
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

import pngWasmDataUrl from './libpng.wasm';

const libraryEnv = {
  emscripten_notify_memory_growth: function () {},
  proc_exit: (code: number) => {
    throw `proc exit: ${code}`;
  },
};

const pngModulePromise = (async () => {
  const response = await fetch(pngWasmDataUrl);
  const wasmCode = await response.arrayBuffer();
  const m = await WebAssembly.instantiate(wasmCode, {
    env: libraryEnv,
    wasi_snapshot_preview1: libraryEnv,
  });
  (m.instance.exports._initialize as Function)();
  return m;
})();

export async function decompressPng(buffer: Uint8Array) 
  : Promise<Uint8Array> {
  
  const m = await pngModulePromise;
  
  // heap must be referenced after creating bufPtr because
  // memory growth can detatch the buffer.
  let bufPtr = (m.instance.exports.malloc as Function)(buffer.byteLength);
  let heap = new Uint8Array((m.instance.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, bufPtr);

  // Using a C call here because it's tricky to discover the
  // final size of a PNG by inspecting headers.
  const nbytes = (m.instance.exports.png_nbytes as Function)(
    bufPtr, buffer.byteLength
  );
  if (nbytes < 0) {
    (m.instance.exports.free as Function)(bufPtr);
    throw new Error(`Failed to decode png image. image size: ${nbytes}`);
  }

  const imagePtr = (m.instance.exports.malloc as Function)(nbytes);

  // heap must be redefined after creating imagePtr because
  // memory growth can detatch the buffer.
  heap = new Uint8Array((m.instance.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, bufPtr);

  const code = (m.instance.exports.png_decompress as Function)(
    bufPtr, buffer.byteLength, imagePtr
  );

  try {
    if (code !== 0) {
      throw new Error(`Failed to decode png image. decoder code: ${code}`);
    }

    // Likewise, we reference memory.buffer instead of heap.buffer
    // because memory growth during decompress could have detached
    // the buffer.
    const image = new Uint8Array(
      (m.instance.exports.memory as WebAssembly.Memory).buffer,
      imagePtr, nbytes
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
