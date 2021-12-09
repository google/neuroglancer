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

import compressoWasmDataUrl from './compresso.wasm';

const libraryEnv = {
  emscripten_notify_memory_growth: function () {},
  proc_exit: (code: number) => {
    throw `proc exit: ${code}`;
  },
};

const compressoModulePromise = (async () => {
  const response = await fetch(compressoWasmDataUrl);
  const wasmCode = await response.arrayBuffer();
  const m = await WebAssembly.instantiate(wasmCode, {
    env: libraryEnv,
    wasi_snapshot_preview1: libraryEnv,
  });
  (m.instance.exports._initialize as Function)();
  return m;
})();

// not a full implementation of read header, just the parts we need
function readHeader(buffer: Uint8Array) 
  : {sx:number,sy:number,sz:number,dataWidth:number} 
{
  // check for header "cpso"
  const magic = (
       buffer[0] === 'c'.charCodeAt(0) && buffer[1] === 'p'.charCodeAt(0)
    && buffer[2] === 's'.charCodeAt(0) && buffer[3] === 'o'.charCodeAt(0)
  );
  if (!magic) {
    throw new Error("compresso: didn't match magic numbers")
  }
  const format = buffer[4];
  if (format !== 0) {
    throw new Error("compresso: didn't match format version")
  }

  const bufview = new DataView(buffer.buffer, 0);

  const dataWidth = buffer[5];
  const sx = bufview.getUint16(6, /*littleEndian=*/true);
  const sy = bufview.getUint16(8, /*littleEndian=*/true);
  const sz = bufview.getUint16(10, /*littleEndian=*/true);

  return {sx,sy,sz,dataWidth};
}

export async function decompressCompresso(buffer: Uint8Array) 
  : Promise<Uint8Array> {
  
  const m = await compressoModulePromise;

  const {sx, sy, sz, dataWidth} = readHeader(buffer);
  const voxels = sx * sy * sz;
  const nbytes = voxels * dataWidth;

  if (nbytes < 0) {
    throw new Error(`Failed to decode compresso image. image size: ${nbytes}`);
  }
  
  // heap must be referenced after creating bufPtr because
  // memory growth can detatch the buffer.
  const imagePtr = (m.instance.exports.malloc as Function)(nbytes);
  const bufPtr = (m.instance.exports.malloc as Function)(buffer.byteLength);
  const heap = new Uint8Array((m.instance.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, bufPtr);
  
  const code = (m.instance.exports.compresso_decompress as Function)(
    bufPtr, buffer.byteLength, imagePtr
  );

  try {
    if (code !== 0) {
      throw new Error(`Failed to decode compresso image. decoder code: ${code}`);
    }

    // Likewise, we reference memory.buffer instead of heap.buffer
    // because memory growth during decompress could have detached
    // the buffer.
    const image = new Uint8Array(
      (m.instance.exports.memory as WebAssembly.Memory).buffer,
      imagePtr, voxels * dataWidth
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
