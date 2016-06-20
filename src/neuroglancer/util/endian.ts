/**
 * @license
 * Copyright 2016 Google Inc.
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

/**
 * Facilities for endianness detection and swapping.
 */

export enum Endianness {
  LITTLE = 0,
  BIG = 1
}

export function determineEndianness() {
  const a = Uint16Array.of(0x1122);
  const b = new Uint8Array(a.buffer);
  return b[0] === 0x11 ? Endianness.BIG : Endianness.LITTLE;
}

/**
 * The native endianness of the runtime.
 */
export const ENDIANNESS = determineEndianness();

/**
 * Swaps the endianness of an array assumed to contain 16-bit values.
 */
export function swapEndian16(array: ArrayBufferView) {
  let view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let i = 0, length = view.length; i < length; i += 2) {
    let temp = view[i];
    view[i] = view[i + 1];
    view[i + 1] = temp;
  }
}

/**
 * Swaps the endianness of an array assumed to contain 32-bit values.
 */
export function swapEndian32(array: ArrayBufferView) {
  let view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let i = 0, length = view.length; i < length; i += 4) {
    let temp = view[i];
    view[i] = view[i + 3];
    view[i + 3] = temp;
    temp = view[i + 1];
    view[i + 1] = view[i + 2];
    view[i + 2] = temp;
  }
}

/**
 * Converts the endianness of an array assumed to contain 16-bit values from source to target.
 *
 * This does nothing if source === target.
 */
export function convertEndian16(
    array: ArrayBufferView, source: Endianness, target: Endianness = ENDIANNESS) {
  if (source !== target) {
    swapEndian16(array);
  }
}

/**
 * Converts the endianness of an array assumed to contain 16-bit values from native to little
 * endian.
 *
 * This does nothing if the native ENDIANNESS is little endian.
 */
export function nativeToLittle16(array: ArrayBufferView) {
  if (ENDIANNESS !== Endianness.LITTLE) {
    swapEndian16(array);
  }
}

/**
 * Converts the endianness of an array assumed to contain 32-bit values from source to target.
 *
 * This does nothing if source === target.
 */
export function convertEndian32(
    array: ArrayBufferView, source: Endianness, target: Endianness = ENDIANNESS) {
  if (source !== target) {
    swapEndian32(array);
  }
}

/**
 * Converts the endianness of an array assumed to contain 32-bit values from native to little
 * endian.
 *
 * This does nothing if the native ENDIANNESS is little endian.
 */
export function nativeToLittle32(array: ArrayBufferView) {
  if (ENDIANNESS !== Endianness.LITTLE) {
    swapEndian32(array);
  }
}
