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

import {DataType} from 'neuroglancer/util/data_type';
import {nextAfterFloat64} from 'neuroglancer/util/float';
import {parseFixedLengthArray} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';

export type DataTypeInterval = [number, number]|[Uint64, Uint64];

export const defaultDataTypeRange: Record<DataType, DataTypeInterval> = {
  [DataType.UINT8]: [0, 0xff],
  [DataType.INT8]: [-0x80, 0x7f],
  [DataType.UINT16]: [0, 0xffff],
  [DataType.INT16]: [-0x8000, 0x7fff],
  [DataType.UINT32]: [0, 0xffffffff],
  [DataType.INT32]: [-0x80000000, 0x7fffffff],
  [DataType.UINT64]: [Uint64.ZERO, new Uint64(0xffffffff, 0xffffffff)],
  [DataType.FLOAT32]: [0, 1],
};

export function computeInvlerp(range: DataTypeInterval, value: number|Uint64): number {
  if (typeof value === 'number') {
    const minValue = range[0] as number;
    const maxValue = range[1] as number;
    return (value - minValue) / (maxValue - minValue);
  } else {
    const minValue = range[0] as Uint64;
    const maxValue = range[1] as Uint64;
    let numerator: number;
    if (Uint64.compare(value, minValue) < 0) {
      numerator = -Uint64.subtract(tempUint64, minValue, value).toNumber();
    } else {
      numerator = Uint64.subtract(tempUint64, value, minValue).toNumber();
    }
    let denominator = Uint64.absDifference(tempUint64, maxValue, minValue).toNumber();
    if (Uint64.compare(minValue, maxValue) > 0) denominator *= -1;
    return numerator / denominator;
  }
}

export function computeLerp(range: DataTypeInterval, dataType: DataType, value: number): number|
    Uint64 {
  if (typeof range[0] === 'number') {
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
  } else {
    let minValue = range[0] as Uint64;
    let maxValue = range[1] as Uint64;
    if (Uint64.compare(minValue, maxValue) > 0) {
      [minValue, maxValue] = [maxValue, minValue];
      value = 1 - value;
    }
    const scalar = Uint64.subtract(tempUint64, maxValue, minValue).toNumber();
    const result = new Uint64();
    if (value <= 0) {
      tempUint64.setFromNumber(scalar * -value);
      Uint64.subtract(result, minValue, Uint64.min(tempUint64, minValue));
    } else if (value >= 1) {
      tempUint64.setFromNumber(scalar * (value - 1));
      Uint64.add(result, maxValue, tempUint64);
      if (Uint64.less(result, maxValue)) {
        result.low = result.high = 0xffffffff;
      }
    } else {
      tempUint64.setFromNumber(scalar * value);
      Uint64.add(result, minValue, tempUint64);
      if (Uint64.less(result, minValue)) {
        result.low = result.high = 0xffffffff;
      }
    }
    return result;
  }
}

export function clampToInterval(range: DataTypeInterval, value: number|Uint64): number|Uint64 {
  if (typeof value === 'number') {
    return Math.min(Math.max(range[0] as number, value), range[1] as number);
  } else {
    return Uint64.min(Uint64.max(range[0] as Uint64, value), range[1] as Uint64);
  }
}

export function getClampedInterval(
    bounds: DataTypeInterval, range: DataTypeInterval): DataTypeInterval {
  return [clampToInterval(bounds, range[0]), clampToInterval(bounds, range[1])] as DataTypeInterval;
}

// Validates that the lower bound is <= the upper bound.
export function validateDataTypeInterval(interval: DataTypeInterval): DataTypeInterval {
  if (dataTypeCompare(interval[0], interval[1]) <= 0) return interval;
  throw new Error(`Invalid interval: [${interval[0]}, ${interval[1]}]`);
}

// Ensures the lower bound is <= the upper bound.
export function normalizeDataTypeInterval(interval: DataTypeInterval): DataTypeInterval {
  if (dataTypeCompare(interval[0], interval[1]) <= 0) return interval;
  return [interval[1], interval[0]] as DataTypeInterval;
}

export function dataTypeCompare(a: number|Uint64, b: number|Uint64) {
  if (typeof a === 'number') {
    return (a as number) - (b as number);
  } else {
    return Uint64.compare(a as Uint64, b as Uint64);
  }
}

const tempUint64 = new Uint64();
const temp2Uint64 = new Uint64();

export function getClosestEndpoint(range: DataTypeInterval, value: number|Uint64): number {
  if (typeof value === 'number') {
    return (Math.abs(value - (range[0] as number)) < Math.abs(value - (range[1] as number))) ? 0 :
                                                                                               1;
  } else {
    return Uint64.less(
               Uint64.absDifference(tempUint64, range[0] as Uint64, value as Uint64),
               Uint64.absDifference(temp2Uint64, range[1] as Uint64, value as Uint64)) ?
        0 :
        1;
  }
}

export function parseDataTypeValue(dataType: DataType, x: unknown): number|Uint64 {
  let s: string;
  if (typeof x !== 'string') {
    s = '' + x;
  } else {
    s = x;
  }
  switch (dataType) {
    case DataType.UINT64:
      return Uint64.parseString(s);
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
      if (!Number.isInteger(value) || value < (dataTypeRange[0] as number) ||
          value > (dataTypeRange[1] as number)) {
        throw new Error(`Invalid ${DataType[dataType].toLowerCase()} value: ${JSON.stringify(s)}`);
      }
      return value;
    }
  }
}

export function parseDataTypeInterval(obj: unknown, dataType: DataType): DataTypeInterval {
  return parseFixedLengthArray(new Array(2), obj, x => parseDataTypeValue(dataType, x)) as
      DataTypeInterval;
}

export function dataTypeIntervalEqual(
    dataType: DataType, a: DataTypeInterval, b: DataTypeInterval) {
  if (dataType === DataType.UINT64) {
    return Uint64.equal(a[0] as Uint64, b[0] as Uint64) &&
        Uint64.equal(a[1] as Uint64, b[1] as Uint64);
  } else {
    return a[0] === b[0] && a[1] === b[1];
  }
}

export function dataTypeIntervalToJson(
    range: DataTypeInterval, dataType: DataType, defaultRange = defaultDataTypeRange[dataType]) {
  if (dataTypeIntervalEqual(dataType, range, defaultRange)) return undefined;
  if (dataType === DataType.UINT64) {
    return [range[0].toString(), range[1].toString()];
  } else {
    return range;
  }
}

export function dataTypeValueNextAfter(
    dataType: DataType, value: number|Uint64, sign: 1|- 1): number|Uint64 {
  switch (dataType) {
    case DataType.FLOAT32:
      return nextAfterFloat64(value as number, sign * Infinity);
    case DataType.UINT64:
      const v = value as Uint64;
      if (sign === -1) {
        if (v.low === 0 && v.high === 0) return v;
        return Uint64.decrement(new Uint64(), v);
      } else {
        if (v.low === 0xffffffff && v.high === 0xffffffff) return v;
        return Uint64.increment(new Uint64(), v);
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
export function getIntervalBoundsEffectiveOffset(dataType: DataType, interval: DataTypeInterval) {
  switch (dataType) {
    case DataType.FLOAT32:
      return 0;
    case DataType.UINT64:
      return 0.5 /
          (Uint64.absDifference(tempUint64, interval[0] as Uint64, interval[1] as Uint64)
               .toNumber());
    default:
      return 0.5 / (Math.abs((interval[0] as number) - (interval[1] as number)));
  }
}

export function getIntervalBoundsEffectiveFraction(dataType: DataType, interval: DataTypeInterval) {
  switch (dataType) {
    case DataType.FLOAT32:
      return 1;
    case DataType.UINT64: {
      const diff =
          Uint64.absDifference(tempUint64, interval[0] as Uint64, interval[1] as Uint64).toNumber();
      return diff / (diff + 1);
    }
    default: {
      const diff = Math.abs((interval[0] as number) - (interval[1] as number));
      return diff / (diff + 1);
    }
  }
}
