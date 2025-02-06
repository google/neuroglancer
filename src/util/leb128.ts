/**
 * @license
 * Copyright 2025 Google Inc.
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

export function decodeLeb128(
  array: DataView,
  offset: number,
): { offset: number; value: number } {
  let result = 0;
  let shift = 0;
  for (let i = offset, length = array.byteLength; i < length; ++i) {
    const byte = array.getUint8(i);
    result += (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (result > Number.MAX_SAFE_INTEGER) {
        throw new Error(`Value exceeded ${Number.MAX_SAFE_INTEGER}`);
      }
      return { offset: i + 1, value: result };
    }
    shift += 7;
  }
  throw new Error("Unexpected EOF");
}

export function decodeLeb128Bigint(
  array: DataView,
  offset: number,
): { offset: number; value: bigint } {
  let result = 0n;
  let shift = 0n;
  for (let i = offset, length = array.byteLength; i < length; ++i) {
    const byte = array.getUint8(i);
    result |= BigInt(byte & 0x7f) << BigInt(shift);
    if ((byte & 0x80) === 0) {
      return { offset: i + 1, value: result };
    }
    shift += 7n;
  }
  throw new Error("Unexpected EOF");
}
