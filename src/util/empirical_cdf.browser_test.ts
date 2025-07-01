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
import { computePercentilesFromEmpiricalHistogram } from "#src/util/empirical_cdf.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import {
  dataTypeCompare,
  dataTypeIntervalEqual,
  defaultDataTypeRange,
} from "#src/util/lerp.js";
import { describe, expect, it } from "vitest";

// The first and last bin are for values below the lower bound/above the upper
// To simulate output from the GLSL shader function on CPU
function countDataInBins(
  inputData: (number | bigint)[],
  dataType: DataType,
  min: number | bigint,
  max: number | bigint,
  numDataBins: number = 254,
): Float32Array {
  // Total number of bins is numDataBins + 2, one for values below the lower
  // bound and one for values above the upper bound.
  const counts = new Float32Array(numDataBins + 2).fill(0);
  let binSize: number;
  let binIndex: number;
  if (dataType === DataType.UINT64) {
    binSize = Number((max as bigint) - (min as bigint)) / numDataBins;
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
        binIndex = Math.floor(
          Number((value as bigint) - (min as bigint)) / binSize,
        );
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
        checkPercentileAccuracy(dataRange, range);
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
        checkPercentileAccuracy(dataRange, range);
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
        checkPercentileAccuracy(dataRange, range, 0, 1, tolerance);
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
        checkPercentileAccuracy(dataRange, range, minPercentile, maxPercentile);
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
        checkPercentileAccuracy(dataRange, range, minPercentile, maxPercentile);
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
      ? inputDataValues.map(BigInt)
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
  } while (!dataTypeIntervalEqual(oldRange, newRange) && numIterations < 32);
  expect(numIterations, "Too many iterations").toBeLessThan(16);
  return newRange;
}

function checkPercentileAccuracy(
  actualDataRange: [number, number],
  computedPercentiles: DataTypeInterval,
  minPercentile: number = 0.0,
  maxPercentile: number = 1.0,
  tolerance: number = 0,
) {
  const min = Number(computedPercentiles[0]);
  const max = Number(computedPercentiles[1]);
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
