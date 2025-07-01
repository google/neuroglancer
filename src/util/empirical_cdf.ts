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

 * @file Defines facilities for manipulation of empirical cumulative distribution functions.
 */
import { DataType } from "#src/util/data_type.js";
import {
  clampToInterval,
  defaultDataTypeRange,
  type DataTypeInterval,
} from "#src/util/lerp.js";
<<<<<<< HEAD
=======
import { Uint64 } from "#src/util/uint64.js";
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)

const BIN_SIZE_MULTIPLIER_FOR_WINDOW = 64;

interface AutoRangeResult {
  range: DataTypeInterval;
  /** The window is set a bit larger than the range */
  window: DataTypeInterval;
}

function calculateEmpiricalCdf(histogram: Float32Array): Float32Array | null {
  const totalSamples = histogram.reduce((a, b) => a + b, 0);
  if (totalSamples === 0) {
    return null;
  }
  let cumulativeCount = 0;
  const empiricalCdf = histogram.map((count) => {
    cumulativeCount += count;
    return cumulativeCount / totalSamples;
  });
  return empiricalCdf;
}

function calculateBinSize(
  histogram: Float32Array,
  histogramRange: DataTypeInterval,
<<<<<<< HEAD
): number {
  const totalBins = histogram.length - 2; // Exclude the first and last bins.
  const [minValue, maxValue] = histogramRange as [any, any];
  return Number(maxValue - minValue) / totalBins;
}

function adjustBound(
  bound: number | bigint,
  dataType: DataType,
  change: number,
  increase: boolean,
): number | bigint {
=======
  inputDataType: DataType,
): number {
  const totalBins = histogram.length - 2; // Exclude the first and last bins.
  if (inputDataType === DataType.UINT64) {
    const numerator64 = new Uint64();
    const min = histogramRange[0] as Uint64;
    const max = histogramRange[1] as Uint64;
    Uint64.subtract(numerator64, max, min);
    return numerator64.toNumber() / totalBins;
  } else {
    const min = histogramRange[0] as number;
    const max = histogramRange[1] as number;
    return (max - min) / totalBins;
  }
}

function adjustBound(
  bound: number | Uint64,
  dataType: DataType,
  change: number,
  increase: boolean,
): number | Uint64 {
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
  const maxDataRange = defaultDataTypeRange[dataType];

  // If the bound is already at the limit, don't adjust it.
  if (dataType !== DataType.FLOAT32) {
    const boundLimit = increase ? maxDataRange[1] : maxDataRange[0];
    if (bound === boundLimit) {
      return bound;
    }
  }

  // Adjust the bound by the change amount up or down.
  const delta = dataType === DataType.FLOAT32 ? change : Math.round(change);
<<<<<<< HEAD
  const signedDelta = delta * (increase ? 1 : -1);
  const adjustedBound =
    dataType === DataType.UINT64
      ? (bound as bigint) + BigInt(Math.round(signedDelta))
      : (bound as number) + signedDelta;
=======
  const temp = new Uint64();
  const adjustedBound =
    dataType === DataType.UINT64
      ? increase
        ? Uint64.add(temp, bound as Uint64, Uint64.fromNumber(delta))
        : Uint64.subtract(temp, bound as Uint64, Uint64.fromNumber(delta))
      : increase
        ? (bound as number) + delta
        : (bound as number) - delta;
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)

  // Ensure the bound is within the data type's range.
  if (dataType === DataType.FLOAT32) {
    return adjustedBound;
  }
  return clampToInterval(maxDataRange, adjustedBound);
}

function decreaseBound(
<<<<<<< HEAD
  bound: number | bigint,
  dataType: DataType,
  change: number,
): number | bigint {
=======
  bound: number | Uint64,
  dataType: DataType,
  change: number,
): number | Uint64 {
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
  return adjustBound(bound, dataType, change, false);
}

function increaseBound(
<<<<<<< HEAD
  bound: number | bigint,
  dataType: DataType,
  change: number,
): number | bigint {
=======
  bound: number | Uint64,
  dataType: DataType,
  change: number,
): number | Uint64 {
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
  return adjustBound(bound, dataType, change, true);
}

export function expandRange(
  range: DataTypeInterval,
  inputDataType: DataType,
  expansionAmount: number = 0,
): DataTypeInterval {
  if (inputDataType === DataType.UINT64 && expansionAmount !== 1) {
    return range;
  }
  const lowerBound = range[0];
  const upperBound = range[1];
  const expandedRange = [
    decreaseBound(lowerBound, inputDataType, expansionAmount),
    increaseBound(upperBound, inputDataType, expansionAmount),
  ] as DataTypeInterval;
  return expandedRange;
}

export function computePercentilesFromEmpiricalHistogram(
  histogram: Float32Array,
  lowerPercentile: number = 0.05,
  upperPercentile: number = 0.95,
  histogramRange: DataTypeInterval,
  inputDataType: DataType,
): AutoRangeResult {
  // 256 bins total. First and last bin are below lower bound/above upper.
  let lowerBound = histogramRange[0];
  let upperBound = histogramRange[1];
  const cdf = calculateEmpiricalCdf(histogram);
  if (cdf === null) {
    return { range: histogramRange, window: histogramRange };
  }
<<<<<<< HEAD
  const binSize = calculateBinSize(histogram, histogramRange);
=======
  const binSize = calculateBinSize(histogram, histogramRange, inputDataType);
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)

  // Find the indices of the percentiles.
  let lowerIndex = 0;
  for (let i = 0; i < cdf.length; i++) {
    lowerIndex = i;
    if (cdf[i] > lowerPercentile) {
      break;
    }
  }
  let upperIndex = cdf.findIndex((cdfValue) => cdfValue >= upperPercentile);
  upperIndex = upperIndex === -1 ? histogram.length - 1 : upperIndex;

  // If the percentile is off the histogram to the left, the lower
  // bound will be decreased to include more data.
  if (lowerIndex === 0) {
    let shiftAmount = binSize / 2;
    if (inputDataType === DataType.FLOAT32) {
      shiftAmount = Math.max(
        shiftAmount,
        Math.max(1, Math.abs((lowerBound as number) / 2)),
      );
    }
    lowerBound = decreaseBound(lowerBound, inputDataType, shiftAmount);
  } else {
    // Otherwise, the lower bound is either exactly correct, and not moved
    // or it could be moved to the right to include less data.
    const shiftAmount = lowerIndex - 1; // Exclude the first bin.
    lowerBound = increaseBound(
      lowerBound,
      inputDataType,
      binSize * shiftAmount,
    );
  }

  // If the percentile is off the histogram to the right, the upper
  // bound will be increased to include more data.
  if (upperIndex === histogram.length - 1) {
    let shiftAmount = binSize / 2;
    if (inputDataType === DataType.FLOAT32) {
      shiftAmount = Math.max(
        shiftAmount,
        Math.max(1, Math.abs((upperBound as number) / 2)),
      );
    }
    upperBound = increaseBound(upperBound, inputDataType, shiftAmount);
  } else {
    // Otherwise, the upper bound is either exactly correct, and not moved
    // or it could be moved to the left to include less data
    const shiftAmount = histogram.length - 2 - upperIndex; // Exclude the first bin.
    upperBound = decreaseBound(
      upperBound,
      inputDataType,
      binSize * shiftAmount,
    );
  }

  const range = [lowerBound, upperBound] as DataTypeInterval;
  // Bump the window out a bit to make it easier to adjust.
  let expandAmount = binSize * BIN_SIZE_MULTIPLIER_FOR_WINDOW;
  if (inputDataType !== DataType.FLOAT32) {
    expandAmount = Math.max(1.0, expandAmount);
  }
  const window = expandRange(range, inputDataType, expandAmount);
  return { range, window };
}
