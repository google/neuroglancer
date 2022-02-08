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

const enum PngColorSpace {
  GRAYSCALE = 0,
  RGB = 2,
  PALETTE = 3,
  GRAYSCALE_ALPHA = 4,
  RGBA = 6
}

// header constants
const magicSpec = [ 137, 80, 78, 71, 13, 10, 26, 10 ];
const validHeaderCode = [ 'I', 'H', 'D', 'R' ];

// not a full implementation of read header, just the parts we need
// References: 
// 1. Overall PNG structure: http://www.libpng.org/pub/png/spec/1.2/PNG-Structure.html
// 2. Header structure: http://www.libpng.org/pub/png/spec/1.2/PNG-Chunks.html
function readHeader(buffer: Uint8Array) 
  : {sx:number,sy:number,dataWidth:number,numChannels:number} 
{

  function arrayEqualTrucated(a:any, b:any) : boolean {
    return a.every((val:number, idx:number) => val === b[idx]);
  }

  if (buffer.length < 8 + 4) {
    throw new Error(`png: Invalid image size: {buffer.length}`);
  }

  // check for header for magic sequence
  const validMagic = arrayEqualTrucated(magicSpec, buffer);
  if (!validMagic) {
    throw new Error(`png: didn't match magic numbers: {buffer.slice(0,8)}`);
  }
  
  // offset into IHDR chunk so we can read more naturally
  const bufview = new DataView(buffer.buffer, magicSpec.length); 
  const chunkLength = bufview.getUint32(0, /*littleEndian=*/false);
  const chunkHeaderLength = 12; // len (4), code (4), CRC (4)

  if (buffer.length < magicSpec.length + chunkLength + chunkHeaderLength) {
    throw new Error(`png: Invalid image size: {buffer.length}`);
  }

  const chunkCode = [ 4, 5, 6, 7 ].map( 
    (i) => String.fromCharCode(bufview.getUint8(i)) 
  );

  if (!arrayEqualTrucated(chunkCode, validHeaderCode)) {
    throw new Error(`png: Invalid header code (should be IHDR): ${chunkCode}`);
  }

  const sx = bufview.getUint32(8, /*littleEndian=*/false);
  const sy = bufview.getUint32(12, /*littleEndian=*/false);
  const bitDepth = bufview.getUint8(16);
  const colorSpace = bufview.getUint8(17);
  const compressionMethod = bufview.getUint8(18);
  const filterMethod = bufview.getUint8(19);
  const interlaceMethod = bufview.getUint8(20);

  if (sx === 0 || sy == 0) {
    throw new Error(`png: 0 is not a valid width or height. width: ${sx} height: ${sy}`)
  }
  if (compressionMethod !== 0) {
    throw new Error(`png: Invalid compression method Only 0 is supported (DEFLATE). Got: ${compressionMethod}`);
  }
  if (filterMethod !== 0) {
    throw new Error(`png: Invalid filter method. Only 0 (adaptive filtering) is supported. Got: ${filterMethod}`)
  }
  if (interlaceMethod > 1) {
    throw new Error(`png: invalid interlace method. Only 0 (no interlace) and 1 (adam7) are supported. Got: ${interlaceMethod}`);
  }

  const validBitDepths = [ 1, 2, 4, 8, 16 ];
  if (validBitDepths.indexOf(bitDepth) === -1) {
    throw new Error(`png: invalid bit depth. Got: ${bitDepth} Valid Depths: ${validBitDepths}`);
  }

  let dataWidth = (bitDepth <= 8) ? 1 : 2;
  let numChannels = 1;
  if (colorSpace === PngColorSpace.GRAYSCALE) {
    // do nothing, defaults are fine.
  }
  else if (colorSpace === PngColorSpace.RGB) {
    if (bitDepth !== 8 && bitDepth !== 16) {
      throw new Error(`png: invalid bit depth for RGB colorspace. Got: ${bitDepth}`);
    }
    numChannels = 3;
  }
  else if (colorSpace === PngColorSpace.PALETTE) {
    dataWidth = 1;
    numChannels = 3;
  }
  else if (colorSpace === PngColorSpace.RGBA) {
    if (bitDepth !== 8 && bitDepth !== 16) {
      throw new Error(`png: invalid bit depth for RGBA colorspace. Got: ${bitDepth}`);
    }
    numChannels = 4;
  }
  else if (colorSpace === PngColorSpace.GRAYSCALE_ALPHA) {
    if (bitDepth !== 8 && bitDepth !== 16) {
      throw new Error(`png: invalid bit depth for grayscale + alpha channel colorspace. Got: ${bitDepth}`);
    }
    numChannels = 4;
  }
  else {
    throw new Error(`png: Invalid color space: ${colorSpace}`);
  }

  return {sx,sy,dataWidth,numChannels};
}

export async function decompressPng(
  buffer: Uint8Array, width: number, height: number, 
  numComponents: number, bytesPerPixel:number, 
  convertToGrayscale: boolean
) : Promise<Uint8Array> {
  
  const m = await pngModulePromise;
  let {sx,sy,dataWidth,numChannels} = readHeader(buffer);

  if (convertToGrayscale) {
    dataWidth = 1;
    numChannels = 1;
  }

  if (
    sx !== width 
    || sy !== height 
    || numComponents !== numChannels
    || bytesPerPixel !== dataWidth
  ) {
    throw new Error(
      `png: Image decode parameters did not match expected chunk parameters.
         Expected: width: ${width} height: ${height} channels: ${numComponents} bytes per pixel: ${bytesPerPixel} 
         Decoded:  width: ${sx} height: ${sy} channels: ${numChannels} bytes per pixel: ${dataWidth}
         Convert to Grayscale? ${convertToGrayscale}
        `
    );
  }

  const nbytes = sx * sy * dataWidth * numChannels;
  if (nbytes < 0) {
    throw new Error(`png: Failed to decode png image size. image size: ${nbytes}`);
  }

  // heap must be referenced after creating bufPtr and imagePtr because
  // memory growth can detatch the buffer.
  let bufPtr = (m.instance.exports.malloc as Function)(buffer.byteLength);
  const imagePtr = (m.instance.exports.malloc as Function)(nbytes);
  let heap = new Uint8Array((m.instance.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, bufPtr);

  const code = (m.instance.exports.png_decompress as Function)(
    bufPtr, buffer.byteLength, imagePtr, nbytes, convertToGrayscale
  );

  try {
    if (code !== 0) {
      throw new Error(`png: Failed to decode png image. decoder code: ${code}`);
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
