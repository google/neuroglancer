/**
 * @license
 * Copyright 2024 William Silvermsith
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

import type { DecodedImage } from "#src/async_computation/decode_png_request.js";

const libraryEnv = {
  emscripten_notify_memory_growth: () => {},
  proc_exit: (code: number) => {
    throw `proc exit: ${code}`;
  },
};

let jxlModulePromise: Promise<WebAssembly.Instance> | undefined;

function getJxlModulePromise() {
  if (jxlModulePromise === undefined) {
    jxlModulePromise = (async () => {
      const m = (
        await WebAssembly.instantiateStreaming(
          fetch(new URL("./jxl_decoder.wasm", import.meta.url)),
          {
            env: libraryEnv,
            wasi_snapshot_preview1: libraryEnv,
          },
        )
      ).instance;
      (m.exports._initialize as Function)();
      return m;
    })();
  }
  return jxlModulePromise;
}


// header constants
// obtained from 
// https://github.com/libjxl/libjxl/blob/8f22cb1fb98ed27ceee59887bd291ef4d277c89d/lib/jxl/decode.cc#L118-L130
const magicSpec = [
  0, 0, 0, 0xC, 
  'J'.charCodeAt(0), 'X'.charCodeAt(0), 'L'.charCodeAt(0), ' '.charCodeAt(0),
  0xD, 0xA, 0x87, 0xA
];

// not a full implementation of read header, just the parts we need
// References:
// 1. Overall PNG structure: http://www.libpng.org/pub/png/spec/1.2/PNG-Structure.html
// 2. Header structure: http://www.libpng.org/pub/png/spec/1.2/PNG-Chunks.html
function checkHeader(buffer: Uint8Array) {
  function arrayEqualTrucated(a: any, b: any): boolean {
    return a.every((val: number, idx: number) => val === b[idx]);
  }

  if (buffer.length < 8 + 4) {
    throw new Error(`jxl: Invalid image size: ${buffer.length}`);
  }

  // check for header for magic sequence
  const validMagic = arrayEqualTrucated(magicSpec, buffer);
  if (!validMagic) {
    throw new Error(`jxl: didn't match magic numbers: ${buffer.slice(0,12)}`);
  }
}

export async function decompressJxl(
  buffer: Uint8Array,
  width: number | undefined,
  height: number | undefined,
  numComponents: number | undefined,
  bytesPerPixel: number,
): Promise<DecodedImage> {
  const m = await getJxlModulePromise();
  
  checkHeader(buffer);

  width ||= 0;
  height ||= 0;
  numComponents ||= 1;

  const nbytes = width * height * bytesPerPixel * numComponents;

  const jxlImagePtr = (m.exports.malloc as Function)(buffer.byteLength);
  const imagePtr = (m.exports.malloc as Function)(nbytes);
  const heap = new Uint8Array((m.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, jxlImagePtr);

  // SDR = Standard Dynamic Range vs. HDR = High Dynamic Range (we're working with grayscale here)
  const decoder = (m.exports._jxlCreateInstance as Function)(/*wantSdr=*/true, /*displayNits=*/100);
  const code = (m.exports._jxlProcessInput as Function)(decoder, jxlImagePtr, buffer.byteLength);

  try {
    if (code !== 0) {
      throw new Error(`jxl: Failed to decode jxl image. decoder code: ${code}`);
    }

    // Likewise, we reference memory.buffer instead of heap.buffer
    // because memory growth during decompress could have detached
    // the buffer.
    const image = new Uint8Array(
      (m.exports.memory as WebAssembly.Memory).buffer,
      imagePtr,
      nbytes,
    );
    // copy the array so it can be memory managed by JS
    // and we can free the emscripten buffer
    return {
      width: width || 0,
      height: height || 0,
      numComponents: numComponents || 1,
      uint8Array: image.slice(0),
    };
  } finally {
    (m.exports.free as Function)(jxlImagePtr);
    (m.exports.free as Function)(imagePtr);
    (m.exports._jxlDestroyInstance as Function)(decoder);
  }
}
