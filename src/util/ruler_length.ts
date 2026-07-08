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
 * Pure helpers for computing the total physical length of a ruler annotation
 * (a polyline geometry: an ordered list of points forming connected segments).
 *
 * The math is factored out here so it can be unit-tested without a live viewer.
 */

/**
 * Computes the total physical length, in nanometers, of a path defined by an
 * ordered list of points.
 *
 * Each point is expressed in annotation coordinates. `scaleNm[d]` gives the
 * physical length in nanometers of one unit along annotation dimension `d`, so
 * the per-segment distance is the Euclidean norm of the per-dimension deltas
 * scaled into physical space. This is exact for axis-aligned coordinate spaces
 * (the common case in Neuroglancer); for rotated/sheared spaces it is a close
 * approximation using the per-axis scale.
 *
 * Guarantees:
 * - Fewer than two points -> 0 (a single point has no segments).
 * - N points -> sum of the N-1 consecutive segment distances.
 * - A zero-length segment (duplicate consecutive point) contributes 0.
 * - Never throws for valid numeric input; returns a finite, non-negative number.
 */
export function computeRulerLengthNm(
  points: readonly ArrayLike<number>[],
  scaleNm: ArrayLike<number>,
): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i + 1 < points.length; ++i) {
    const a = points[i];
    const b = points[i + 1];
    const rank = Math.min(a.length, b.length);
    let sumSquares = 0;
    for (let d = 0; d < rank; ++d) {
      const scale = d < scaleNm.length ? scaleNm[d] : 1;
      const delta = (b[d] - a[d]) * scale;
      sumSquares += delta * delta;
    }
    total += Math.sqrt(sumSquares);
  }
  return total;
}
