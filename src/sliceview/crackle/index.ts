/**
 * @license
 * Copyright 2026 William Silversmith
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

const headerSize = 29;

const libraryEnv = {
  emscripten_notify_memory_growth: function () {},
  proc_exit: (code: number) => {
    throw `proc exit: ${code}`;
  },
};

function crc8(data: Uint8Array<ArrayBuffer>) {
  let crc = 0xff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; ++bit) {
      crc = crc & 1 ? (crc >> 1) ^ 0xe7 : crc >> 1;
    }
  }
  return crc;
}

let crackleModulePromise: Promise<WebAssembly.Instance> | undefined;

function getCrackleModulePromise() {
  if (crackleModulePromise === undefined) {
    crackleModulePromise = (async () => {
      const m = (
        await WebAssembly.instantiateStreaming(
          fetch(new URL("./libcrackle.wasm", import.meta.url)),
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
  return crackleModulePromise;
}

// not a full implementation of read header, just the parts we need
export function readHeader(buffer: Uint8Array<ArrayBuffer>): {
  sx: number;
  sy: number;
  sz: number;
  dataWidth: number;
} {
  if (buffer.byteLength < headerSize) {
    throw new Error(`crackle: Invalid image size: ${buffer.byteLength}`);
  }

  // check for header "crkl"
  const magic =
    buffer[0] === "c".charCodeAt(0) &&
    buffer[1] === "r".charCodeAt(0) &&
    buffer[2] === "k".charCodeAt(0) &&
    buffer[3] === "l".charCodeAt(0);
  if (!magic) {
    throw new Error("crackle: didn't match magic numbers");
  }
  const format = buffer[4];
  if (format > 1) {
    throw new Error("crackle: didn't match format version");
  }
  if (format > 0 && crc8(buffer.subarray(5, 28)) !== buffer[28]) {
    throw new Error("crackle: didn't match header checksum");
  }

  const bufview = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  const format_bytes = bufview.getUint16(5, /*littleEndian=*/ true);
  const dataWidth = Math.pow(2, format_bytes & 0b11);
  const sx = bufview.getUint32(7, /*littleEndian=*/ true);
  const sy = bufview.getUint32(11, /*littleEndian=*/ true);
  const sz = bufview.getUint32(15, /*littleEndian=*/ true);

  return { sx, sy, sz, dataWidth };
}

export async function decompressCrackle(
  buffer: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const m = await getCrackleModulePromise();
  const { sx, sy, sz, dataWidth } = readHeader(buffer);

  const voxels = sx * sy * sz;
  const nbytes = voxels * dataWidth;
  if (!Number.isSafeInteger(nbytes) || nbytes < 0) {
    throw new Error(
      `crackle: Failed to decode image size. image size: ${nbytes}`,
    );
  }

  // heap must be referenced after creating bufPtr and imagePtr because
  // memory growth can detatch the buffer.
  const bufPtr = (m.exports.malloc as Function)(buffer.byteLength);
  if (bufPtr === 0) {
    throw new Error("crackle: malloc failed for input buffer (out of memory)");
  }
  const imagePtr = (m.exports.malloc as Function)(nbytes);
  if (imagePtr === 0) {
    (m.exports.free as Function)(bufPtr);
    throw new Error("crackle: malloc failed for output buffer (out of memory)");
  }

  try {
    const heap = new Uint8Array(
      (m.exports.memory as WebAssembly.Memory).buffer,
    );
    heap.set(buffer, bufPtr);

    const code = (m.exports.crackle_decompress as Function)(
      bufPtr,
      buffer.byteLength,
      imagePtr,
      nbytes,
    );

    if (code !== 0) {
      throw new Error(`crackle: Failed to decode image. decoder code: ${code}`);
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
    return image.slice(0);
  } finally {
    (m.exports.free as Function)(bufPtr);
    (m.exports.free as Function)(imagePtr);
  }
}
