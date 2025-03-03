/**
 * @license
 * Copyright 2021 Google Inc.
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

import {
  bigintAbs,
  bigintMax,
  bigintMin,
  clampToUint64,
  roundToUint64,
  UINT64_MAX,
} from "#src/util/bigint.js";
import { DataType } from "#src/util/data_type.js";
import { nextAfterFloat64 } from "#src/util/float.js";
import { parseFixedLengthArray, parseUint64 } from "#src/util/json.js";

export type DataTypeInterval = [number, number] | [bigint, bigint];

export type UnknownDataTypeInterval = [number | bigint, number | bigint];

export const defaultDataTypeRange: Record<DataType, DataTypeInterval> = {
  [DataType.UINT8]: [0, 0xff],
  [DataType.INT8]: [-0x80, 0x7f],
  [DataType.UINT16]: [0, 0xffff],
  [DataType.INT16]: [-0x8000, 0x7fff],
  [DataType.UINT32]: [0, 0xffffffff],
  [DataType.INT32]: [-0x80000000, 0x7fffffff],
  [DataType.UINT64]: [0n, 0xffffffffffffffffn],
  [DataType.FLOAT32]: [0, 1],
};

/**
 * Compute inverse linear interpolation on the interval [0, 1].
 * @param range Values at start and end of interval.
 * @param value Value to interpolate at.
 * @returns Coordinate of interpolated point.
 */
export function computeInvlerp(
  range: DataTypeInterval,
  value: number | bigint,
): number {
  const [minValue, maxValue] = range as [any, any];
  return Number((value as any) - minValue) / Number(maxValue - minValue);
}

/**
 * Compute linear interpolation on the interval [0, 1].
 * @param range Values at start and end of interval.
 * @param dataType
 * @param value Coordinate to interpolate at.
 * @returns Interpolated value.
 */
export function computeLerp(
  range: DataTypeInterval,
  dataType: DataType,
  value: number,
): number | bigint {
  if (typeof range[0] === "number") {
    const minValue = range[0] as number;
    const maxValue = range[1] as number;
    let result = minValue * (1 - value) + maxValue * value;
    if (dataType !== DataType.FLOAT32) {
      const dataTypeRange = defaultDataTypeRange[dataType];
      result = Math.round(result);
      result = Math.max(dataTypeRange[0] as number, result);
      result = Math.min(dataTypeRange[1] as number, result);
    }
    return result;
  }
  const minValue = range[0] as bigint;
  const maxValue = range[1] as bigint;
  const scalar = Number(maxValue - minValue);
  let result: bigint;
  if (value >= 1) {
    result = maxValue + BigInt(Math.round(scalar * (value - 1)));
  } else {
    result = minValue + BigInt(Math.round(scalar * value));
  }
  return clampToUint64(result);
}

export function clampToInterval(
  range: DataTypeInterval,
  value: number | bigint,
): number | bigint {
  if (typeof value === "number") {
    return Math.min(Math.max(range[0] as number, value), range[1] as number);
  }
  return bigintMin(bigintMax(range[0] as bigint, value), range[1] as bigint);
}

export function getClampedInterval(
  bounds: DataTypeInterval,
  range: DataTypeInterval,
): DataTypeInterval {
  return [
    clampToInterval(bounds, range[0]),
    clampToInterval(bounds, range[1]),
  ] as DataTypeInterval;
}

// Validates that the lower bound is <= the upper bound.
export function validateDataTypeInterval(
  interval: DataTypeInterval,
): DataTypeInterval {
  if (dataTypeCompare(interval[0], interval[1]) <= 0) return interval;
  throw new Error(`Invalid interval: [${interval[0]}, ${interval[1]}]`);
}

// Ensures the lower bound is <= the upper bound.
export function normalizeDataTypeInterval(
  interval: DataTypeInterval,
): DataTypeInterval {
  if (dataTypeCompare(interval[0], interval[1]) <= 0) return interval;
  return [interval[1], interval[0]] as DataTypeInterval;
}

export function dataTypeCompare(a: number | bigint, b: number | bigint) {
  return (a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0;
}

export function getClosestEndpoint(
  range: DataTypeInterval,
  value: number | bigint,
): number {
  if (typeof value === "number") {
    return Math.abs(value - (range[0] as number)) <
      Math.abs(value - (range[1] as number))
      ? 0
      : 1;
  }
  return bigintAbs((range[0] as bigint) - value) <
    bigintAbs((range[1] as bigint) - value)
    ? 0
    : 1;
}

export function parseDataTypeValue(
  dataType: DataType,
  x: unknown,
): number | bigint {
  let s: string;
  if (typeof x !== "string") {
    s = "" + x;
  } else {
    s = x;
  }
  switch (dataType) {
    case DataType.UINT64:
      return parseUint64(s);
    case DataType.FLOAT32: {
      const value = parseFloat(s);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid float32 value: ${JSON.stringify(s)}`);
      }
      return value;
    }
    default: {
      const value = parseInt(s);
      const dataTypeRange = defaultDataTypeRange[dataType];
      if (
        !Number.isInteger(value) ||
        value < (dataTypeRange[0] as number) ||
        value > (dataTypeRange[1] as number)
      ) {
        throw new Error(
          `Invalid ${DataType[dataType].toLowerCase()} value: ${JSON.stringify(
            s,
          )}`,
        );
      }
      return value;
    }
  }
}

export function parseUnknownDataTypeValue(x: unknown): number | bigint {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const num = Number(x);
    try {
      const num64 = parseUint64(x);
      if (num64.toString() === num.toString()) {
        return num;
      }
      return num64;
    } catch {
      // Ignore failure to parse as uint64.
    }
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid value: ${JSON.stringify(x)}`);
    }
    return num;
  }
  throw new Error(`Invalid value: ${JSON.stringify(x)}`);
}

export function parseDataTypeInterval(
  obj: unknown,
  dataType: DataType,
): DataTypeInterval {
  return parseFixedLengthArray(new Array(2), obj, (x) =>
    parseDataTypeValue(dataType, x),
  ) as DataTypeInterval;
}

export function parseUnknownDataTypeInterval(
  obj: unknown,
): UnknownDataTypeInterval {
  return parseFixedLengthArray(new Array(2), obj, (x) =>
    parseUnknownDataTypeValue(x),
  ) as UnknownDataTypeInterval;
}

export function dataTypeIntervalEqual(
  a: DataTypeInterval,
  b: DataTypeInterval,
) {
  return a[0] === b[0] && a[1] === b[1];
}

export function dataTypeIntervalToJson(
  range: DataTypeInterval,
  dataType: DataType,
  defaultRange = defaultDataTypeRange[dataType],
) {
  if (dataTypeIntervalEqual(range, defaultRange)) return undefined;
  if (dataType === DataType.UINT64) {
    return [range[0].toString(), range[1].toString()];
  }
  return range;
}

export function dataTypeValueNextAfter(
  dataType: DataType,
  value: number | bigint,
  sign: 1 | -1,
): number | bigint {
  switch (dataType) {
    case DataType.FLOAT32:
      return nextAfterFloat64(value as number, sign * Infinity);
    case DataType.UINT64: {
      return clampToUint64((value as bigint) + BigInt(sign));
    }
    default: {
      const range = defaultDataTypeRange[dataType] as [number, number];
      return Math.max(range[0], Math.min(range[1], (value as number) + sign));
    }
  }
}

// Returns the offset such that within the floating point range `[-offset, 1+offset]`, there is an
// equal-sized interval corresponding to each number in `interval`.
//
// For dataType=FLOAT32, always returns 0.  For integer data types, returns:
//
//   0.5 / (1 + abs(interval[1] - interval[0]))
export function getIntervalBoundsEffectiveOffset(
  dataType: DataType,
  interval: DataTypeInterval,
) {
  switch (dataType) {
    case DataType.FLOAT32:
      return 0;
    case DataType.UINT64:
      return (
        0.5 /
        Number(bigintAbs((interval[0] as bigint) - (interval[1] as bigint)))
      );
    default:
      return 0.5 / Math.abs((interval[0] as number) - (interval[1] as number));
  }
}

export function getIntervalBoundsEffectiveFraction(
  dataType: DataType,
  interval: DataTypeInterval,
) {
  switch (dataType) {
    case DataType.FLOAT32:
      return 1;
    case DataType.UINT64: {
      const diff = Number(
        bigintAbs((interval[0] as bigint) - (interval[1] as bigint)),
      );
      return diff / (diff + 1);
    }
    default: {
      const diff = Math.abs((interval[0] as number) - (interval[1] as number));
      return diff / (diff + 1);
    }
  }
}

export function convertDataTypeInterval(
  interval: UnknownDataTypeInterval | undefined,
  dataType: DataType,
): DataTypeInterval {
  if (interval === undefined) {
    return defaultDataTypeRange[dataType];
  }
  let [lower, upper] = interval;
  if (dataType === DataType.UINT64) {
    return [
      roundToUint64(Number.isNaN(lower) ? 0n : lower),
      roundToUint64(Number.isNaN(upper) ? UINT64_MAX : upper),
    ];
  }
  lower = Number(lower);
  upper = Number(upper);
  if (dataType !== DataType.FLOAT32) {
    lower = Math.round(lower);
    upper = Math.round(upper);
    const range = defaultDataTypeRange[dataType] as [number, number];
    if (!Number.isFinite(lower)) {
      lower = range[0];
    } else {
      lower = Math.min(Math.max(range[0], lower), range[1]);
    }
    if (!Number.isFinite(upper)) {
      upper = range[1];
    } else {
      upper = Math.min(Math.max(range[0], upper), range[1]);
    }
  }
  return [lower, upper];
}
