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

import { describe, it, expect } from "vitest";
import { DataType } from "#src/util/data_type.js";
import { computeRangeForCdf } from "#src/util/empirical_cdf.js";
import {
  dataTypeCompare,
  dataTypeIntervalEqual,
  defaultDataTypeRange,
} from "#src/util/lerp.js";
import { Uint64 } from "#src/util/uint64.js";

// The first and last bin are for values below the lower bound/above the upper
// To simulate output from the GLSL shader function on CPU
function countDataInBins(
  inputData: (number | Uint64)[],
  dataType: DataType,
  min: number | Uint64,
  max: number | Uint64,
  numBins: number = 254,
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
  // 0 to 100 inclusive
  {
    const dataRange = [0, 100] as [number, number];
    const dataValues = buildDataArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      it(`Calculates min and max for ${DataType[dataType]} on range ${dataRange}`, () => {
        findOptimalDataRange(dataRange, dataValues, dataType);
      });
    }
  }

  // 100 to 125 inclusive
  {
    const dataRange = [100, 125] as [number, number];
    const dataValues = buildDataArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      it(`Calculates min and max for ${DataType[dataType]} on range ${dataRange}`, () => {
        findOptimalDataRange(dataRange, dataValues, dataType);
      });
    }
  }

  // Try larger values and exclude low bit data types
  {
    const dataRange = [28791, 32767] as [number, number];
    const dataValues = buildDataArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      if (dataType === DataType.UINT8 || dataType === DataType.INT8) continue;
      it(`Calculates min and max for ${DataType[dataType]} on range ${dataRange}`, () => {
        findOptimalDataRange(
          dataRange,
          dataValues,
          dataType,
          (dataRange[1] - dataRange[0] + 1) / 244,
        );
      });
    }
  }

  // 1 - 99 percentile
  {
    const dataRange = [0, 100] as [number, number];
    const dataValues = buildDataArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      it(`Calculates 1-99% for ${DataType[dataType]} on range ${dataRange}`, () => {
        findOptimalDataRange(dataRange, dataValues, dataType, 0, 0.01, 0.99);
      });
    }
  }

  // 5 - 95 percentile
  {
    const dataRange = [0, 100] as [number, number];
    const dataValues = buildDataArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      it(`Calculates 5-95% for ${DataType[dataType]} on range ${dataRange}`, () => {
        findOptimalDataRange(dataRange, dataValues, dataType, 0, 0.05, 0.95);
      });
    }
  }

  // Large data values on 5-95 percentile
  {
    const dataRange = [28791, 32767] as [number, number];
    const dataValues = buildDataArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      if (dataType === DataType.UINT8 || dataType === DataType.INT8) continue;
      it(`Calcalates 5-95% for ${DataType[dataType]} on range ${dataRange}`, () => {
        findOptimalDataRange(
          dataRange,
          dataValues,
          dataType,
          (dataRange[1] - dataRange[0] + 1) / 244,
          0.05,
          0.95,
        );
      });
    }
  }

  function buildDataArray(dataRange: [number, number]) {
    return Array.from(
      { length: dataRange[1] - dataRange[0] + 1 },
      (_, i) => i + dataRange[0],
    );
  }
});
function getDataRange(dataType: DataType) {
  return dataType === DataType.FLOAT32
    ? ([-10000, 10000] as [number, number])
    : defaultDataTypeRange[dataType];
}

function findOptimalDataRange(
  dataRange: [number, number],
  dataValues: number[],
  dataType: DataType,
  tolerance: number = 0,
  minPercentile = 0.0,
  maxPercentile = 1.0,
) {
  const data =
    dataType === DataType.UINT64
      ? dataValues.map((v) => Uint64.fromNumber(v))
      : dataValues;
  let numIterations = 0;
  const startRange = getDataRange(dataType);
  let oldRange = startRange;
  let newRange = startRange;
  do {
    const binCounts = countDataInBins(data, dataType, newRange[0], newRange[1]);
    oldRange = newRange;
    newRange = computeRangeForCdf(
      binCounts,
      minPercentile,
      maxPercentile,
      newRange,
      dataType,
    ).range;
    ++numIterations;
  } while (
    !dataTypeIntervalEqual(dataType, oldRange, newRange) &&
    numIterations < 32
  );

  const min =
    dataType === DataType.UINT64
      ? (newRange[0] as Uint64).toNumber()
      : (newRange[0] as number);
  const max =
    dataType === DataType.UINT64
      ? (newRange[1] as Uint64).toNumber()
      : (newRange[1] as number);

  const diff = dataRange[1] - dataRange[0];
  const correctRange = [
    dataRange[0] + minPercentile * diff,
    dataRange[0] + maxPercentile * diff,
  ];
  expect(
    Math.abs(Math.round(min - correctRange[0])),
    `Got lower bound ${min} expected ${correctRange[0]}`,
  ).toBeLessThanOrEqual(tolerance);
  expect(
    Math.abs(Math.round(max - correctRange[1])),
    `Got upper bound ${max} expected ${correctRange[1]}`,
  ).toBeLessThanOrEqual(tolerance);
  expect(numIterations, "Too many iterations").toBeLessThan(16);
}
