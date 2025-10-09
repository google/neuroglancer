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

const libraryEnv = {};

let jxlModulePromise: Promise<WebAssembly.Instance> | undefined;

async function getJxlModulePromise() {
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
      return m;
    })();
  }
  return jxlModulePromise;
}

// header constants
// obtained from
// // https://github.com/libjxl/libjxl/blob/8f22cb1fb98ed27ceee59887bd291ef4d277c89d/lib/jxl/decode.cc#L118-L130
const magicSpec = [
  0,
  0,
  0,
  0xc,
  "J".charCodeAt(0),
  "X".charCodeAt(0),
  "L".charCodeAt(0),
  " ".charCodeAt(0),
  0xd,
  0xa,
  0x87,
  0xa,
];

// not a full implementation of read header, just the parts we need
function checkHeader(buffer: Uint8Array) {
  function arrayEqualTrucated(a: any, b: any): boolean {
    return a.every((val: number, idx: number) => val === b[idx]);
  }

  const len = buffer.length;
  const kCodestreamMarker = 0x0a;

  if (len < 8 + 4) {
    throw new Error(`jxl: Invalid image size: ${len}`);
  }

  // JPEG XL codestream: 0xff 0x0a
  if (len >= 1 && buffer[0] === 0xff) {
    if (len < 2) {
      throw new Error(`jxl: Not enough bytes. Got: ${len}`);
    } else if (buffer[1] === kCodestreamMarker) {
      // valid codestream
      return;
    } else {
      throw new Error(`jxl: Invalid codestream.`);
    }
  }

  // JPEG XL container
  // check for header for magic sequence
  const validMagic = arrayEqualTrucated(magicSpec, buffer);
  if (!validMagic) {
    throw new Error(`jxl: didn't match magic numbers: ${buffer.slice(0, 12)}`);
  }
}

export async function decompressJxl(
  buffer: Uint8Array,
  area: number,
  numComponents: number,
  bytesPerPixel: number,
): Promise<DecodedImage> {
  const m = await getJxlModulePromise();
  checkHeader(buffer);
  area ||= 0;
  numComponents ||= 1;

  const jxlImagePtr = (m.exports.malloc as Function)(buffer.byteLength);
  const heap = new Uint8Array((m.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, jxlImagePtr);

  let imagePtr: number = 0;
  // Will be set after we probe metadata (single probe call now).
  let frameCount = 1;
  let nbytes = 0;

  try {
    // Allocate 3 u32s for combined probe [width,height,frames]
    const probePtr = (m.exports.malloc as Function)(3 * 4);
    try {
      const rc = (m.exports.width_height_frames_out as Function)(
        jxlImagePtr,
        buffer.byteLength,
        probePtr,
      );
      if (rc !== 0) {
        throw new Error(`jxl: metadata probe failed code=${rc}`);
      }
      const view = new DataView(
        (m.exports.memory as WebAssembly.Memory).buffer,
        probePtr,
        12,
      );
      const width = view.getUint32(0, true);
      const height = view.getUint32(4, true);
      frameCount = view.getUint32(8, true) || 1;

      if (width <= 0 || height <= 0) {
        throw new Error(
          `jxl: Decoding failed. Width (${width}) and/or height (${height}) invalid.`,
        );
      }
      if (
        area !== undefined &&
        area !== 0 &&
        width * height * frameCount !== area
      ) {
        throw new Error(
          `jxl: Expected volume area ${width}x${height}x${frameCount}=${width * height * frameCount} to match area: ${area}.`,
        );
      }
      // Compute bytes required using probed metadata.
      nbytes = width * height * frameCount * numComponents * bytesPerPixel;

      if (bytesPerPixel === 1) {
        imagePtr = (m.exports.decode as Function)(
          jxlImagePtr,
          buffer.byteLength,
          nbytes,
        );
      } else {
        imagePtr = (m.exports.decode_with_bpp as Function)(
          jxlImagePtr,
          buffer.byteLength,
          nbytes,
          bytesPerPixel,
        );
      }

      if (imagePtr === 0) {
        throw new Error("jxl: Decoding failed. Null pointer returned.");
      }

      // Likewise, we reference memory.buffer instead of heap.buffer
      // because memory growth during decompress could have detached
      // the buffer.
      const image = new Uint8Array(
        (m.exports.memory as WebAssembly.Memory).buffer,
        imagePtr,
        nbytes,
      );

      return {
        width: width || 0,
        height: height || 0,
        numComponents: numComponents || 1,
        uint8Array: image.slice(0),
      };
    } finally {
      (m.exports.free as Function)(probePtr, 3 * 4);
    }
  } finally {
    (m.exports.free as Function)(jxlImagePtr, buffer.byteLength);
    if (imagePtr) {
      (m.exports.free as Function)(imagePtr, nbytes);
    }
  }
}
