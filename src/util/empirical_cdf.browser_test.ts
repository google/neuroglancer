/**
 * @license
 * Copyright 2024 Google Inc.
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

import { DataType } from "#src/util/data_type.js";
import { computeRangeForCdf } from "#src/util/empirical_cdf.js";
import {
  dataTypeCompare,
  DataTypeInterval,
  dataTypeIntervalEqual,
  defaultDataTypeRange,
} from "#src/util/lerp.js";
import { Uint64 } from "#src/util/uint64.js";
import { describe, it, expect } from "vitest";

// The first and last bin are for values below the lower bound/above the upper
// To simulate output from the GLSL shader function on CPU
function countDataInBins(
  inputData: (number | Uint64)[],
  dataType: DataType,
  min: number | Uint64,
  max: number | Uint64,
  numBins: number = 100,
): Float32Array {
  const counts = new Float32Array(numBins + 2).fill(0);
  let binSize: number;
  let binIndex: number;
  const numerator64 = new Uint64();
  if (dataType === DataType.UINT64) {
    Uint64.subtract(numerator64, max as Uint64, min as Uint64);
    const denominator64 = Uint64.fromNumber(numBins);
    binSize = numerator64.toNumber() / denominator64.toNumber();
  } else {
    binSize = ((max as number) - (min as number)) / numBins;
  }
  for (let i = 0; i < inputData.length; i++) {
    const value = inputData[i];
    if (dataTypeCompare(value, min) < 0) {
      counts[0]++;
    } else if (dataTypeCompare(value, max) > 0) {
      counts[numBins + 1]++;
    } else {
      if (dataType === DataType.UINT64) {
        Uint64.subtract(numerator64, value as Uint64, min as Uint64);
        binIndex = Math.floor(numerator64.toNumber() / binSize);
      } else {
        binIndex = Math.floor(((value as number) - (min as number)) / binSize);
      }
      counts[binIndex + 1]++;
    }
  }
  return counts;
}

describe("empirical_cdf", () => {
  const dataValues = Array.from({ length: 101 }, (_, i) => i);
  const dataValuesUint64 = dataValues.map((v) => Uint64.fromNumber(v));
  for (const dataType of Object.values(DataType)) {
    // TODO temp condition for debug
    if (typeof dataType === "string") continue;
    if (
      !(
        dataType === DataType.UINT8 ||
        dataType === DataType.UINT64 ||
        dataType === DataType.FLOAT32
      )
    )
      continue;
    // Fill with data from 0 to 100
    const data = dataType === DataType.UINT64 ? dataValuesUint64 : dataValues;
    const dataRange =
      dataType === DataType.FLOAT32
        ? ([-10000, 10000] as [number, number])
        : defaultDataTypeRange[dataType];
    let numIterations = 0;
    it(`computes the correct min and max for ${DataType[dataType]}`, () => {
      const correctedDataRange: DataTypeInterval =
        dataType === DataType.UINT64
          ? [Uint64.ZERO, Uint64.fromNumber(100)]
          : [0, 100];
      let oldRange = dataRange;
      let newRange = dataRange;
      do {
        const binCounts = countDataInBins(
          data,
          dataType,
          newRange[0],
          newRange[1],
        );
        console.log(newRange, binCounts);
        oldRange = newRange;
        newRange = computeRangeForCdf(binCounts, 0.0, 1.0, newRange, dataType);
        console.log("in loop", newRange);
        ++numIterations;
      } while (
        !dataTypeIntervalEqual(dataType, oldRange, newRange) &&
        numIterations < 10
      );
      console.log("final", newRange);
      expect(
        dataTypeIntervalEqual(dataType, newRange, correctedDataRange),
      ).toBeTruthy();
    });
  }
});
