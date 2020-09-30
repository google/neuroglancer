/**
 * @license
 * Copyright 2020 Google Inc.
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

import {DATA_TYPE_ARRAY_CONSTRUCTOR, DataType} from 'neuroglancer/util/data_type';
import {getRandomValues} from 'neuroglancer/util/random';
import {Uint64} from 'neuroglancer/util/uint64';
import {computeInvlerp, computeLerp, DataTypeInterval, defineInvlerpShaderFunction, defineLerpShaderFunction, enableLerpShaderFunction} from 'neuroglancer/webgl/lerp';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

function getRandomValue(dataType: DataType) {
  switch (dataType) {
    case DataType.UINT8:
    case DataType.INT8:
    case DataType.UINT16:
    case DataType.INT16:
    case DataType.UINT32:
    case DataType.INT32: {
      const buf = new DATA_TYPE_ARRAY_CONSTRUCTOR[dataType](1);
      getRandomValues(buf);
      return buf[0];
    }
    case DataType.UINT64:
      return Uint64.random();
    case DataType.FLOAT32:
      return Math.random();
  }
}

function getRandomInterval(dataType: DataType): DataTypeInterval {
  while (true) {
    if (dataType === DataType.UINT64) {
      let a = Uint64.random();
      let b = Uint64.random();
      let c = Uint64.compare(a, b);
      if (c === 0) continue;
      return (c < 0) ? [a, b] : [b, a];
    } else {
      let a = getRandomValue(dataType) as number;
      let b = getRandomValue(dataType) as number;
      if (a === b) continue;
      return (a < b) ? [a, b] : [b, a];
    }
  }
}

const u64 = Uint64.parseString;

function testInvlerpRoundtrip(dataType: DataType, interval: DataTypeInterval, values: (number|Uint64)[]) {
  for (const x of values) {
    const t = computeInvlerp(interval, x);
    const y = computeLerp(interval, dataType, t);
    expect(y.toString()).toBe(x.toString(), `interval=[${interval[0]}, ${interval[1]}]`);
  }
}

function getAbsDifference(a: number|Uint64, b: number|Uint64): number {
  if (typeof a === 'number') {
    return Math.abs(a - (b as number));
  } else {
    return Uint64.absDifference(new Uint64(), a as Uint64, b as Uint64).toNumber();
  }
}

function getLerpErrorBound(interval: DataTypeInterval, dataType: DataType) {
  if (dataType === DataType.FLOAT32) {
    // For float, the error bound is independent of the interval.
    return 1e-6;
  }
  const size = getAbsDifference(interval[0], interval[1]);
  return Math.max(1e-6, 1 / size);
}

function computeLerpRoundtrip(dataType: DataType, interval: DataTypeInterval, t: number) {
  const x = computeLerp(interval, dataType, t);
  return {u: computeInvlerp(interval, x), x};
}

function testLerpRoundtrip(dataType: DataType, interval: DataTypeInterval, t: number, roundtrip = computeLerpRoundtrip) {
  const {x, u} = roundtrip(dataType, interval, t);
  const errorBound = getLerpErrorBound(interval, dataType);
  expect(u).toBeGreaterThan(
      t - errorBound,
      `x=${x}, t=${t}, errorBound=${errorBound}, interval=[${interval[0]}, ${interval[1]}]`);
  expect(u).toBeLessThan(
      t + errorBound,
      `x=${x}, t=${t}, errorBound=${errorBound}, interval=[${interval[0]}, ${interval[1]}]`);
}

function testRoundtripInterval(
    dataType: DataType, interval: DataTypeInterval, valueInterval = interval) {
  const values: number[] = [];
  for (let i = valueInterval[0] as number; i <= (valueInterval[1] as number); ++i) {
    values.push(i);
  }
  testInvlerpRoundtrip(dataType, interval, values);
}

function testRoundtripRandom(dataType: DataType, numIntervals: number, numInvlerpSamples: number, numLerpSamples: number) {
  for (let i = 0; i < numIntervals; ++i) {
    const interval = getRandomInterval(dataType);
    testInvlerpRoundtrip(dataType, interval, interval);
    {
      const values: (number|Uint64)[] = [];
      for (let j = 0; j < numInvlerpSamples; ++j) {
        values.push(getRandomValue(dataType));
      }
      testInvlerpRoundtrip(dataType, interval, values);
    }
    for (let j = 0; j < numLerpSamples; ++j) {
      testLerpRoundtrip(dataType, interval, Math.random());
    }
  }
}

describe('computeLerp', () => {
  it('works for float32 identity transform', () => {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(computeLerp([0, 1], DataType.FLOAT32, x)).toEqual(x);
    }
  });
  it('works for uint8', () => {
    expect(computeLerp([0, 255], DataType.UINT8, 0)).toEqual(0);
    expect(computeLerp([0, 255], DataType.UINT8, 0.999)).toEqual(255);
    expect(computeLerp([0, 255], DataType.UINT8, 0.99)).toEqual(252);
  });
  it('works for uint64', () => {
    expect(computeLerp([u64('0'), u64('255')], DataType.UINT64, 0).toString()).toEqual('0');
    expect(computeLerp([u64('0'), u64('255')], DataType.UINT64, 0.999).toString()).toEqual('255');
    expect(computeLerp([u64('0'), u64('255')], DataType.UINT64, 0.99).toString()).toEqual('252');
    expect(computeLerp([u64('0'), u64('255')], DataType.UINT64, 0.99).toString()).toEqual('252');
    expect(computeLerp([u64('0'), u64('18446744073709551615')], DataType.UINT64, 0.0).toString())
        .toEqual('0');
    expect(computeLerp([u64('0'), u64('18446744073709551615')], DataType.UINT64, 1.0).toString())
        .toEqual('18446744073709551615');
    expect(computeLerp(
               [u64('18446744073709551613'), u64('18446744073709551615')], DataType.UINT64, 0.5)
               .toString())
        .toEqual('18446744073709551614');
  });
  it('round trips for uint8', () => {
    testRoundtripInterval(DataType.UINT8, [0, 255]);
    testRoundtripInterval(DataType.UINT8, [5, 89], [0, 255]);
  });
  for (const dataType of Object.values(DataType)) {
    if (typeof dataType === 'string') continue;
    it(`round trips for random ${DataType[dataType].toLowerCase()}`, () => {
      let numInvlerpSamples: number;
      switch (dataType) {
        case DataType.UINT64:
        case DataType.FLOAT32:
          numInvlerpSamples = 0;
          break;
        default:
          numInvlerpSamples = 10;
          break;
      }
      testRoundtripRandom(dataType, 10, numInvlerpSamples, 10);
    });
  }
});

describe('computeLerp on gpu', () => {
  for (const dataType of Object.values(DataType)) {
    if (typeof dataType === 'string') continue;
    it(`round trips for random ${DataType[dataType].toLowerCase()}`, () => {
      const numIntervals = 10;
      const numLerpSamples = 10;
      fragmentShaderTest({inputValue: 'float'}, {outputValue: 'float', lerpOutput: dataType}, tester => {
        const {builder} = tester;
        builder.addFragmentCode(defineInvlerpShaderFunction(builder, 'doInvlerp', dataType));
        builder.addFragmentCode(defineLerpShaderFunction(builder, 'doLerp', dataType));
        builder.setFragmentMain(`outputValue = doInvlerp(doLerp(inputValue));`);
        const {shader} = tester;
        for (let i = 0; i < numIntervals; ++i) {
          const interval = getRandomInterval(dataType);
          enableLerpShaderFunction(shader, 'doInvlerp', dataType, interval);
          enableLerpShaderFunction(shader, 'doLerp', dataType, interval);
          const roundtrip = (_dataType: DataType, _interval: DataTypeInterval, t: number) => {
            tester.execute({inputValue: t});
            const values = tester.values;
            return {u: values.outputValue, x: values.lerpOutput};
          };
          for (let j = 0; j < numLerpSamples; ++j) {
            const t = Math.random();
            testLerpRoundtrip(dataType, interval, t, roundtrip);
          }
        }
      });
    });
  }
});
