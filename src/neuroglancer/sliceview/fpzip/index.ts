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

const magicSpec = [ 'f', 'p', 'z', '\0' ];

const enum FpzipDataWidth {
  FLOAT = 0,
  DOUBLE = 1
}

function readHeader(buffer: Uint8Array) 
  : {sx:number,sy:number,sz:number,dataWidth:number,numChannels:number} { 

  function arrayEqualTrucated(a:any, b:any) : boolean {
    return a.every((val:number, idx:number) => String.fromCharCode(val) === b[idx]);
  }

  if (buffer.length < 164) {
    throw new Error(`fpzip: Invalid image size: ${buffer.length}`);
  }

  // check for header for magic sequence
  const validMagic = arrayEqualTrucated(magicSpec, buffer);
  if (!validMagic) {
    throw new Error(`fpzip: didn't match magic numbers: ${buffer.slice(0,8)}`);
  }

  const bufview = new DataView(buffer.buffer, magicSpec.length); 
  const major_ver = bufview.getUint16(0, /*littleEndian=*/true);
  const minor_ver = bufview.getUint8(2, /*littleEndian=*/true);

  if (major_ver !== 1 or minor_ver != 3) {
    throw new Error(`fpzip: Invalid version: ${major_ver}.${minor_ver} (expected 1.3)`);
  }

  const type_prec = bufview.getUint8(4, /*littleEndian=*/true);
  const type = (0b10000000 & type_prec) >>> 7; // 0: float, 1: double
  const prec = type_prec & 0b01111111;

  const sx = bufview.getUint32(1);
  const sy = bufview.getUint32(2);
  const sz = bufview.getUint32(3);
  const numChannels = bufview.getUint32(4);

  const dataWidth = (type === FpzipDataWidth.FLOAT)
    ? 4
    : 8;

  return { sx, sy, sz, dataWidth, numChannels };
}

export async function decompressFpzip(
  buffer: Uint8Array, 
  width: number, height: number, depth: number,
  numComponents: number, bytesPerPixel:number,
) : Promise<Float32Array> {
  
  const m = await fpzipModulePromise;
  let {sx,sy,sz,dataWidth,numChannels} = readHeader(buffer);

  if (
    sx !== width 
    || sy !== height
    || sz !== depth
    || numComponents !== numChannels
    || bytesPerPixel !== dataWidth
  ) {
    throw new Error(
      `fpzip: Image decode parameters did not match expected chunk parameters.
         Expected: width: ${width} height: ${height} depth: ${depth} channels: ${numComponents} bytes per pixel: ${bytesPerPixel} 
         Decoded:  width: ${sx} height: ${sy} depth: ${sz} channels: ${numChannels} bytes per pixel: ${dataWidth}
        `
    );
  }

  const nbytes = sx * sy * sz * dataWidth * numChannels;
  if (nbytes < 0) {
    throw new Error(`fpzip: Failed to decode fpzip image size. image size: ${nbytes}`);
  }

  // heap must be referenced after creating bufPtr and imagePtr because
  // memory growth can detatch the buffer.
  let bufPtr = (m.instance.exports.malloc as Function)(buffer.byteLength);
  const imagePtr = (m.instance.exports.malloc as Function)(nbytes);
  let heap = new Uint8Array((m.instance.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, bufPtr);

  const code = (m.instance.exports.fpzip_decompress as Function)(
    bufPtr, buffer.byteLength, imagePtr, nbytes
  );

  try {
    if (code !== 0) {
      throw new Error(`fpzip: Failed to decode fpzip image. decoder code: ${code}`);
    }

    // Likewise, we reference memory.buffer instead of heap.buffer
    // because memory growth during decompress could have detached
    // the buffer.
    const image = new Float32Array(
      (m.instance.exports.memory as WebAssembly.Memory).buffer,
      imagePtr, (sx * sy * sz * numChannels)
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
