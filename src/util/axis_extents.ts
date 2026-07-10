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

/**
 * Pure helper for the per-axis physical extent between two points, used for the
 * projected axis lengths of a line annotation and the edge lengths (and volume)
 * of an axis-aligned bounding box annotation.
 */

/**
 * Computes, for each dimension, the physical extent `|pointB[d] - pointA[d]| *
 * scaleNm[d]` (nanometers). A dimension whose scale is 0 (e.g. a non-length
 * axis) yields an extent of 0.
 *
 * Guarantees:
 * - Equal points -> all extents 0.
 * - Anisotropic scale -> each extent uses that axis's physical scale.
 * - Returns one entry per dimension; every entry is finite and non-negative.
 */
export function computeAxisExtentsNm(
  pointA: ArrayLike<number>,
  pointB: ArrayLike<number>,
  scaleNm: ArrayLike<number>,
): number[] {
  const rank = Math.min(pointA.length, pointB.length);
  const extents: number[] = [];
  for (let d = 0; d < rank; ++d) {
    const scale = d < scaleNm.length ? scaleNm[d] : 1;
    extents.push(Math.abs(pointB[d] - pointA[d]) * scale);
  }
  return extents;
}
