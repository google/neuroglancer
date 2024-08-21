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
import { computePercentilesFromEmpiricalHistogram } from "#src/util/empirical_cdf.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
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
  numDataBins: number = 254,
): Float32Array {
  // Total number of bins is numDataBins + 2, one for values below the lower
  // bound and one for values above the upper bound.
  const counts = new Float32Array(numDataBins + 2).fill(0);
  let binSize: number;
  let binIndex: number;
  const numerator64 = new Uint64();
  if (dataType === DataType.UINT64) {
    Uint64.subtract(numerator64, max as Uint64, min as Uint64);
    binSize = numerator64.toNumber() / numDataBins;
  } else {
    binSize = ((max as number) - (min as number)) / numDataBins;
  }
  for (let i = 0; i < inputData.length; i++) {
    const value = inputData[i];
    if (dataTypeCompare(value, min) < 0) {
      counts[0]++;
    } else if (dataTypeCompare(value, max) > 0) {
      counts[numDataBins + 1]++;
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
    const dataValues = generateSequentialArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      it(`Calculates min and max for ${DataType[dataType]} on range ${dataRange}`, () => {
        const range = findPercentilesFromIterativeHistogram(
          dataValues,
          dataType,
        );
        checkPercentileAccuracy(dataRange, range, dataType);
      });
    }
  }

  // 100 to 125 inclusive
  {
    const dataRange = [100, 125] as [number, number];
    const dataValues = generateSequentialArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      it(`Calculates min and max for ${DataType[dataType]} on range ${dataRange}`, () => {
        const range = findPercentilesFromIterativeHistogram(
          dataValues,
          dataType,
        );
        checkPercentileAccuracy(dataRange, range, dataType);
      });
    }
  }

  // Try larger values and exclude low bit data types
  {
    const dataRange = [28791, 32767] as [number, number];
    const dataValues = generateSequentialArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      if (dataType === DataType.UINT8 || dataType === DataType.INT8) continue;
      it(`Calculates min and max for ${DataType[dataType]} on range ${dataRange}`, () => {
        const tolerance = (dataRange[1] - dataRange[0] + 1) / 254;
        const range = findPercentilesFromIterativeHistogram(
          dataValues,
          dataType,
        );
        checkPercentileAccuracy(dataRange, range, dataType, 0, 1, tolerance);
      });
    }
  }

  // 1 - 99 percentile over 0-100
  {
    const dataRange = [0, 100] as [number, number];
    const dataValues = generateSequentialArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      it(`Calculates 1-99% for ${DataType[dataType]} on range ${dataRange}`, () => {
        const minPercentile = 0.01;
        const maxPercentile = 0.99;
        const range = findPercentilesFromIterativeHistogram(
          dataValues,
          dataType,
          minPercentile,
          maxPercentile,
        );
        checkPercentileAccuracy(
          dataRange,
          range,
          dataType,
          minPercentile,
          maxPercentile,
        );
      });
    }
  }

  // 5 - 95 percentile over 0-100
  {
    const dataRange = [0, 100] as [number, number];
    const dataValues = generateSequentialArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      it(`Calculates 5-95% for ${DataType[dataType]} on range ${dataRange}`, () => {
        const minPercentile = 0.05;
        const maxPercentile = 0.95;
        const range = findPercentilesFromIterativeHistogram(
          dataValues,
          dataType,
          minPercentile,
          maxPercentile,
        );
        checkPercentileAccuracy(
          dataRange,
          range,
          dataType,
          minPercentile,
          maxPercentile,
        );
      });
    }
  }

  // Large data values on 5-95 percentile
  {
    const dataRange = [28791, 32767] as [number, number];
    const dataValues = generateSequentialArray(dataRange);
    for (const dataType of Object.values(DataType)) {
      if (typeof dataType === "string") continue;
      if (dataType === DataType.UINT8 || dataType === DataType.INT8) continue;
      it(`Calcalates 5-95% for ${DataType[dataType]} on range ${dataRange}`, () => {
        const minPercentile = 0.05;
        const maxPercentile = 0.95;
        const tolerance = (dataRange[1] - dataRange[0] + 1) / 254;
        const range = findPercentilesFromIterativeHistogram(
          dataValues,
          dataType,
          minPercentile,
          maxPercentile,
        );
        checkPercentileAccuracy(
          dataRange,
          range,
          dataType,
          minPercentile,
          maxPercentile,
          tolerance,
        );
      });
    }
  }

  function generateSequentialArray(dataRange: [number, number]) {
    return Array.from(
      { length: dataRange[1] - dataRange[0] + 1 },
      (_, i) => i + dataRange[0],
    );
  }
});

function determineInitialDataRange(dataType: DataType) {
  return dataType === DataType.FLOAT32
    ? ([-10000, 10000] as [number, number])
    : defaultDataTypeRange[dataType];
}

function findPercentilesFromIterativeHistogram(
  inputDataValues: number[],
  inputDataType: DataType,
  minPercentile = 0.0,
  maxPercentile = 1.0,
) {
  const data =
    inputDataType === DataType.UINT64
      ? inputDataValues.map((v) => Uint64.fromNumber(v))
      : inputDataValues;
  let numIterations = 0;
  const startRange = determineInitialDataRange(inputDataType);
  let oldRange = startRange;
  let newRange = startRange;
  do {
    const binCounts = countDataInBins(
      data,
      inputDataType,
      newRange[0],
      newRange[1],
    );
    oldRange = newRange;
    newRange = computePercentilesFromEmpiricalHistogram(
      binCounts,
      minPercentile,
      maxPercentile,
      newRange,
      inputDataType,
    ).range;
    ++numIterations;
  } while (
    !dataTypeIntervalEqual(inputDataType, oldRange, newRange) &&
    numIterations < 32
  );
  expect(numIterations, "Too many iterations").toBeLessThan(16);
  return newRange;
}

function checkPercentileAccuracy(
  actualDataRange: [number, number],
  computedPercentiles: DataTypeInterval,
  inputDataType: DataType,
  minPercentile: number = 0.0,
  maxPercentile: number = 1.0,
  tolerance: number = 0,
) {
  const min =
    inputDataType === DataType.UINT64
      ? (computedPercentiles[0] as Uint64).toNumber()
      : (computedPercentiles[0] as number);
  const max =
    inputDataType === DataType.UINT64
      ? (computedPercentiles[1] as Uint64).toNumber()
      : (computedPercentiles[1] as number);
  const diff = actualDataRange[1] - actualDataRange[0];
  const correctRange = [
    actualDataRange[0] + minPercentile * diff,
    actualDataRange[0] + maxPercentile * diff,
  ];
  expect(
    Math.abs(Math.round(min - correctRange[0])),
    `Got lower bound ${min} expected ${correctRange[0]}`,
  ).toBeLessThanOrEqual(tolerance);
  expect(
    Math.abs(Math.round(max - correctRange[1])),
    `Got upper bound ${max} expected ${correctRange[1]}`,
  ).toBeLessThanOrEqual(tolerance);
}
