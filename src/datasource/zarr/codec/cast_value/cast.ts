/**
 * @license
 * Copyright 2026 Google Inc.
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

import { DATA_TYPE_SIGNED, DataType } from "#src/util/data_type.js";

export type Rounding =
  | "nearest-even"
  | "towards-zero"
  | "towards-positive"
  | "towards-negative"
  | "nearest-away";

export type OutOfRange = "clamp" | "wrap" | undefined;

export const ROUNDING_MODES: readonly Rounding[] = [
  "nearest-even",
  "towards-zero",
  "towards-positive",
  "towards-negative",
  "nearest-away",
];

const INTEGER_RANGE: Partial<Record<DataType, [number, number]>> = {
  [DataType.UINT8]: [0, 0xff],
  [DataType.INT8]: [-0x80, 0x7f],
  [DataType.UINT16]: [0, 0xffff],
  [DataType.INT16]: [-0x8000, 0x7fff],
  [DataType.UINT32]: [0, 0xffffffff],
  [DataType.INT32]: [-0x80000000, 0x7fffffff],
};

export function isSupportedCastType(dataType: DataType) {
  return dataType === DataType.FLOAT32 || INTEGER_RANGE[dataType] !== undefined;
}

function round(x: number, rounding: Rounding): number {
  switch (rounding) {
    case "towards-zero":
      return Math.trunc(x);
    case "towards-positive":
      return Math.ceil(x);
    case "towards-negative":
      return Math.floor(x);
    case "nearest-away":
      return Math.sign(x) * Math.round(Math.abs(x));
    case "nearest-even": {
      const r = Math.round(x); // rounds halves towards +infinity
      return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
    }
  }
}

/**
 * Converts each element to `outType` by numerical value, as the zarr-extensions
 * `cast_value` codec specifies: exact values pass through, others are rounded,
 * then out-of-range values are clamped, wrapped, or rejected.
 */
export function castValues(
  input: ArrayLike<number>,
  outType: DataType,
  rounding: Rounding,
  outOfRange: OutOfRange,
): ArrayBufferView<ArrayBuffer> {
  const n = input.length;
  if (outType === DataType.FLOAT32) {
    // assignment rounds to the nearest float32, ties to even
    const output = new Float32Array(new ArrayBuffer(4 * n));
    for (let i = 0; i < n; ++i) output[i] = input[i];
    return output;
  }
  const range = INTEGER_RANGE[outType];
  if (range === undefined) {
    throw new Error(`cast_value: unsupported data type ${DataType[outType]}`);
  }
  const [min, max] = range;
  const span = max - min + 1;
  const signed = DATA_TYPE_SIGNED[outType];
  const output = new (
    {
      [DataType.UINT8]: Uint8Array,
      [DataType.INT8]: Int8Array,
      [DataType.UINT16]: Uint16Array,
      [DataType.INT16]: Int16Array,
      [DataType.UINT32]: Uint32Array,
      [DataType.INT32]: Int32Array,
    } as Record<number, any>
  )[outType](n);
  for (let i = 0; i < n; ++i) {
    const x = input[i];
    if (!Number.isFinite(x)) {
      throw new Error(
        `cast_value: ${x} is not representable as ${DataType[outType]}`,
      );
    }
    let v = Number.isInteger(x) ? x : round(x, rounding);
    if (v < min || v > max) {
      if (outOfRange === "clamp") {
        v = v < min ? min : max;
      } else if (outOfRange === "wrap") {
        v = ((((v - min) % span) + span) % span) + min;
        if (!signed && v > max) v -= span;
      } else {
        throw new Error(
          `cast_value: ${x} is out of range for ${DataType[outType]}`,
        );
      }
    }
    output[i] = v;
  }
  return output;
}
