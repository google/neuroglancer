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

import zfpcWasmDataUrl from './libzfpc.wasm';
import { wasmModuleInstance } from 'neuroglancer/sliceview/base';

const libraryEnv = {
  emscripten_notify_memory_growth: function () {},
  proc_exit: (code: number) => {
    throw `proc exit: ${code}`;
  },
};

let wasmModule:wasmModuleInstance|null = null;

async function loadZfpcModule () {
  if (wasmModule !== null) {
    return wasmModule;
  }

  const response = await fetch(zfpcWasmDataUrl);
  const wasmCode = await response.arrayBuffer();
  const m = await WebAssembly.instantiate(wasmCode, {
    env: libraryEnv,
    wasi_snapshot_preview1: libraryEnv,
  });
  (m.instance.exports._initialize as Function)();
  wasmModule = m;
  return m;
}

// not a full implementation of read header, just the parts we need
function readHeader(buffer: Uint8Array) 
  : {sx:number,sy:number,sz:number,sw:number,dataWidth:number} 
{
  // check for header "zfpc"
  const magic = (
       buffer[0] === 'z'.charCodeAt(0) && buffer[1] === 'f'.charCodeAt(0)
    && buffer[2] === 'p'.charCodeAt(0) && buffer[3] === 'c'.charCodeAt(0)
  );
  if (!magic) {
    throw new Error("zfpc: didn't match magic numbers");
  }
  const format = buffer[4];
  if (format > 0) {
    throw new Error("zfpc: didn't match format version");
  }

  const bufview = new DataView(buffer.buffer, 0);

  let dataWidth = buffer[5] & 0b111;
  const sx = bufview.getUint32(6, /*littleEndian=*/true);
  const sy = bufview.getUint32(10, /*littleEndian=*/true);
  const sz = bufview.getUint32(14, /*littleEndian=*/true);
  const sw = bufview.getUint32(18, /*littleEndian=*/true);


  if (dataWidth === 2 || dataWidth === 4) {
    dataWidth = 8; // uint64 or float64
  }
  else if (dataWidth === 1 || dataWidth === 3) {
    dataWidth = 4; // uint32 or float32
  }
  else {
    throw new Error("zfpc: unsupported data width.");
  }

  return {sx,sy,sz,sw,dataWidth};
}

export async function decompressZfpc(
  buffer: Uint8Array
) : Promise<Uint8Array> {
  
  const m = await loadZfpcModule();
  let {sx,sy,sz,sw,dataWidth} = readHeader(buffer);

  const voxels = sx * sy * sz * sw;
  const nbytes = voxels * dataWidth;
  if (nbytes < 0) {
    throw new Error(`zfpc: Failed to decode png image size. image size: ${nbytes}`);
  }

  // heap must be referenced after creating bufPtr and imagePtr because
  // memory growth can detatch the buffer.
  let bufPtr = (m.instance.exports.malloc as Function)(buffer.byteLength);
  const imagePtr = (m.instance.exports.malloc as Function)(nbytes);
  let heap = new Uint8Array((m.instance.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, bufPtr);

  const code = (m.instance.exports.zfpc_decompress as Function)(
    bufPtr, buffer.byteLength, imagePtr, nbytes
  );

  try {
    if (code !== 0) {
      throw new Error(`zfpc: Failed to decode image. decoder code: ${code}`);
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
