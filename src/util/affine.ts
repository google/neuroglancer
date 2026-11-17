/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { mat4 } from "#src/util/geom.js";
import { multiply } from "#src/util/matrix.js";

/**
  Computes the length of each basis vector after applying the given
  affine transformation matrix to that vector.

  We effectively multiply the matrix in turn by the unit vectors
  along each axis, and measure the length of the resulting vector.
  However, we can do this faster by just computing the length of
  each column of the matrix, since that is the equivalent to the above.
  */
export function extractScalesFromAffineMatrix(
  affineTransform: Float64Array | mat4,
  rank: number,
  basisVectorLengthPerAxis?: Float64Array,
): Float64Array {
  const scales = new Float64Array(rank);
  for (let i = 0; i < rank; ++i) {
    let scaleSquared = 0;
    for (let j = 0; j < rank; ++j) {
      // Column-major order
      const v = affineTransform[i * (rank + 1) + j];
      const basisVectorLength = basisVectorLengthPerAxis?.[j] ?? 1;
      scaleSquared += (v * basisVectorLength) ** 2;
    }
    scales[i] = Math.sqrt(scaleSquared);
  }
  return scales;
}

export function makeAffineRelativeToBaseTransform(
  affineTransform: Float64Array,
  baseTransformInverse: Float64Array,
  rank: number,
): Float64Array {
  const relativeTransform = new Float64Array(baseTransformInverse.length);
  multiply(
    relativeTransform,
    rank + 1,
    baseTransformInverse,
    rank + 1,
    affineTransform,
    rank + 1,
    rank + 1,
    rank + 1,
    rank + 1,
  );
  return relativeTransform;
}
