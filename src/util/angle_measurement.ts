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
 * Pure helper for computing the interior angles of an angle annotation (a
 * polyline geometry: an ordered list of points forming connected segments).
 *
 * The math is factored out here so it can be unit-tested without a live viewer.
 */

/**
 * Computes the unsigned interior angle, in degrees, at each interior vertex of a
 * path defined by an ordered list of points.
 *
 * For interior vertex `i` (points `P[i-1]`, `P[i]`, `P[i+1]`), the angle is the
 * angle between the two segments meeting at `P[i]`, measured in physical space:
 * each per-dimension delta is scaled by `scaleNm[d]` before the angle is taken,
 * so anisotropic coordinate scales yield the geometrically correct angle. The
 * common case of exactly three points yields a single angle.
 *
 * Guarantees:
 * - Fewer than three points -> empty array (no interior vertex).
 * - N points -> an array of length N-2 (one entry per interior vertex).
 * - A vertex adjoining a zero-length segment -> NaN for that entry.
 * - Every non-NaN entry is within [0, 180]; never throws for valid numeric input.
 */
export function computeVertexAnglesDegrees(
  points: readonly ArrayLike<number>[],
  scaleNm: ArrayLike<number>,
): number[] {
  const result: number[] = [];
  for (let i = 1; i + 1 < points.length; ++i) {
    const prev = points[i - 1];
    const vertex = points[i];
    const next = points[i + 1];
    const rank = Math.min(prev.length, vertex.length, next.length);
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let d = 0; d < rank; ++d) {
      const scale = d < scaleNm.length ? scaleNm[d] : 1;
      const a = (prev[d] - vertex[d]) * scale;
      const b = (next[d] - vertex[d]) * scale;
      dot += a * b;
      magA += a * a;
      magB += b * b;
    }
    if (magA === 0 || magB === 0) {
      result.push(NaN);
      continue;
    }
    const cos = dot / (Math.sqrt(magA) * Math.sqrt(magB));
    const clamped = Math.min(1, Math.max(-1, cos));
    result.push((Math.acos(clamped) * 180) / Math.PI);
  }
  return result;
}
