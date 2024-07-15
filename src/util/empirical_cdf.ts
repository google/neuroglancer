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
import type { DataTypeInterval } from "#src/util/lerp.js";

// 256 bins in total.  The first and last bin are for values below the lower bound/above the upper
// bound.
export function computeRangeForCdf(
  percentile: number,
  empiricalCdf: Float32Array,
  previousRange: DataTypeInterval,
  inputDataType: DataType,
): DataTypeInterval {
  const midPoint = Math.round((empiricalCdf.length - 1) / 2);
  const totalLeftOfMidPoint = empiricalCdf
    .subarray(0, midPoint + 1)
    .reduce((a, b) => a + b, 0);
  const totalRightOfMidPoint = empiricalCdf
    .subarray(midPoint + 1)
    .reduce((a, b) => a + b, 0);
  const total = totalLeftOfMidPoint + totalRightOfMidPoint;
  const totalOutsideRange =
    empiricalCdf[0] + empiricalCdf[empiricalCdf.length - 1];
  const desiredAmount = total * percentile;

  // TODO implement for Uint64
  if (inputDataType === DataType.UINT64) {
    throw new Error("Not implemented for UINT64");
  }
  const referenceRange = previousRange as [number, number];

  // Shrink to the left before midpoint
  if (desiredAmount < totalLeftOfMidPoint) {
    const midPoint = Math.ceil(
      referenceRange[0] + (referenceRange[1] - referenceRange[0]) / 2,
    );
    return [referenceRange[0], midPoint];
  }

  // Shrink to the right after midpoint
  if (desiredAmount < totalRightOfMidPoint) {
    const midPoint = Math.floor(
      referenceRange[0] + (referenceRange[1] - referenceRange[0]) / 2,
    );
    return [midPoint, referenceRange[1]];
  }

  const pushAmount = Math.round(referenceRange[1] - referenceRange[0] / 4);
  // Expand the range on both sides
  if (total - totalOutsideRange < desiredAmount) {
    // TODO clamp to data range when expanding - clampToInterval with defaultBounds
    return [referenceRange[0] - pushAmount, referenceRange[1] + pushAmount];
  } else {
    // See if we can shrink the range on both sides
    let totalInRange = total - totalOutsideRange;
    let leftIndex = 0;
    let rightIndex = empiricalCdf.length - 1;
    const binSize = Math.round(
      referenceRange[1] - referenceRange[0] / (empiricalCdf.length - 2),
    );
    let leftRange = referenceRange[0];
    let rightRange = referenceRange[1];
    while (totalInRange < desiredAmount) {
      totalInRange -= empiricalCdf[++leftIndex];
      totalInRange -= empiricalCdf[--rightIndex];
      if (totalInRange < desiredAmount) {
        leftRange += binSize;
        rightRange -= binSize;
      }
      if (leftIndex >= rightIndex) {
        break;
      }
    }
    return [leftRange, rightRange];
  }
}
