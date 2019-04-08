/**
 * @license
 * Copyright 2019 Google Inc.
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

import {Uint64} from './uint64';

/**
 * Decodes a "compressed" 3-d morton index.
 *
 * Decoded bit `i` of `x`, `y`, and `z` is at bit `i + min(i, yBits) + min(i, zBits)`, `i + min(i +
 * 1, xBits) + min(i, zBits)`, and `i + min(i + 1, xBits) + min(i + 1, zBits)` of `zindex`,
 * respectively, for `i` in `[0, xBits)`, `[0, yBits)`, `[0, zBits)`, respectively.
 */
export function decodeZIndexCompressed(
    zindex: Uint64, xBits: number, yBits: number, zBits: number): Uint32Array {
  const maxCoordBits = Math.max(xBits, yBits, zBits);
  let inputBit = 0;
  let inputValue = zindex.low;
  let x = 0, y = 0, z = 0;
  for (let coordBit = 0; coordBit < maxCoordBits; ++coordBit) {
    if (coordBit < xBits) {
      const bit = (inputValue >>> inputBit) & 1;
      x |= (bit << coordBit);
      if (inputBit === 31) {
        inputBit = 0;
        inputValue = zindex.high;
      } else {
        ++inputBit;
      }
    }
    if (coordBit < yBits) {
      const bit = (inputValue >>> inputBit) & 1;
      y |= (bit << coordBit);
      if (inputBit === 31) {
        inputBit = 0;
        inputValue = zindex.high;
      } else {
        ++inputBit;
      }
    }
    if (coordBit < zBits) {
      const bit = (inputValue >>> inputBit) & 1;
      z |= (bit << coordBit);
      if (inputBit === 31) {
        inputBit = 0;
        inputValue = zindex.high;
      } else {
        ++inputBit;
      }
    }
  }
  return Uint32Array.of(x, y, z);
}

function lessMsb(a: number, b: number) {
  return a < b && a < (a ^ b);
}

/**
 * Returns `true` if `(x0, y0, z0)` occurs before `(x1, y1, z1)` in Z-curve order.
 */
export function zorder3LessThan(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  let mostSignificant0 = z0, mostSignificant1 = z1;

  if (lessMsb(mostSignificant0 ^ mostSignificant1, y0 ^ y1)) {
    mostSignificant0 = y0;
    mostSignificant1 = y1;
  }

  if (lessMsb(mostSignificant0 ^ mostSignificant1, x0 ^ x1)) {
    mostSignificant0 = x0;
    mostSignificant1 = x1;
  }

  return mostSignificant0 < mostSignificant1;
}
