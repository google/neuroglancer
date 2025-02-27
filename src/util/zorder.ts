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

import type { TypedNumberArray } from "#src/util/array.js";

export function getOctreeChildIndex(x: number, y: number, z: number) {
  return (x & 1) | ((y << 1) & 2) | ((z << 2) & 4);
}

/**
 * Decodes a "compressed" 3-d morton index.
 *
 * Decoded bit `i` of `x`, `y`, and `z` is at bit `i + min(i, yBits) + min(i, zBits)`, `i + min(i +
 * 1, xBits) + min(i, zBits)`, and `i + min(i + 1, xBits) + min(i + 1, zBits)` of `zindex`,
 * respectively, for `i` in `[0, xBits)`, `[0, yBits)`, `[0, zBits)`, respectively.
 */
export function decodeZIndexCompressed(
  zindex: bigint,
  xBits: number,
  yBits: number,
  zBits: number,
): Uint32Array {
  const maxCoordBits = Math.max(xBits, yBits, zBits);
  let inputBit = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let coordBit = 0; coordBit < maxCoordBits; ++coordBit) {
    if (coordBit < xBits) {
      const bit = Number((zindex >> BigInt(inputBit++)) & BigInt(1));
      x |= bit << coordBit;
    }
    if (coordBit < yBits) {
      const bit = Number((zindex >> BigInt(inputBit++)) & BigInt(1));
      y |= bit << coordBit;
    }
    if (coordBit < zBits) {
      const bit = Number((zindex >> BigInt(inputBit++)) & BigInt(1));
      z |= bit << coordBit;
    }
  }
  return Uint32Array.of(x, y, z);
}

export function encodeZIndexCompressed3d(
  xBits: number,
  yBits: number,
  zBits: number,
  x: number,
  y: number,
  z: number,
): bigint {
  const maxBits = Math.max(xBits, yBits, zBits);
  let outputBit = 0;
  let zIndex = 0n;
  function writeBit(b: number): void {
    zIndex |= BigInt(b) << BigInt(outputBit++);
  }
  for (let bit = 0; bit < maxBits; ++bit) {
    if (bit < xBits) {
      writeBit((x >> bit) & 1);
    }
    if (bit < yBits) {
      writeBit((y >> bit) & 1);
    }
    if (bit < zBits) {
      writeBit((z >> bit) & 1);
    }
  }
  return zIndex;
}

export function encodeZIndexCompressed(
  position: TypedNumberArray,
  shape: TypedNumberArray,
): bigint {
  let zIndex = 0n;
  let outputBit = 0;
  const rank = position.length;
  function writeBit(b: number): void {
    zIndex |= BigInt(b & 1) << BigInt(outputBit++);
  }

  for (let bit = 0; bit < 32; ++bit) {
    for (let dim = 0; dim < rank; ++dim) {
      if ((shape[dim] - 1) >>> bit) {
        writeBit(position[dim] >>> bit);
      }
    }
  }
  return zIndex;
}

function lessMsb(a: number, b: number) {
  return a < b && a < (a ^ b);
}

/**
 * Returns `true` if `(x0, y0, z0)` occurs before `(x1, y1, z1)` in Z-curve order.
 */
export function zorder3LessThan(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): boolean {
  let mostSignificant0 = z0;
  let mostSignificant1 = z1;

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
