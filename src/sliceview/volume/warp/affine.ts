/**
 * @license
 * Copyright 2026 Google Inc.
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
 * @file Affine helpers for the warp code (frontend and worker), in two
 * row-major forms: rows of [linear | translation] (`number[][]`), and flat
 * arrays (`number[]`, e.g. a 4x4 for the 3-d case). Neuroglancer's own
 * transforms are column-major homogeneous matrices; `fullRowMajor` and
 * `rowMajorFromColumnMajor` convert them.
 */

import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import * as matrix from "#src/util/matrix.js";

/** a ∘ b, as rows of [linear | translation]; b's input rank may differ. */
export function composeAffine(a: number[][], b: number[][]): number[][] {
  const n = b.length;
  const cols = b[0]?.length ?? 1;
  return a.map((row) =>
    Array.from({ length: cols }, (_, j) => {
      let s = j === cols - 1 ? row[n] : 0;
      for (let k = 0; k < n; ++k) s += row[k] * b[k][j];
      return s;
    }),
  );
}

/** Inverse of a square affine given as rows of [linear | translation]. */
export function invertAffine(rows: number[][]): number[][] {
  const n = rows.length;
  const m = new Float64Array((n + 1) ** 2);
  for (let i = 0; i < n; ++i) {
    for (let j = 0; j <= n; ++j) m[j * (n + 1) + i] = rows[i][j];
  }
  m[(n + 1) ** 2 - 1] = 1;
  const inv = new Float64Array((n + 1) ** 2);
  const det = matrix.inverse(inv, n + 1, m, n + 1, n + 1);
  if (det === 0 || !Number.isFinite(det)) {
    throw new Error("warp: singular transform");
  }
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => inv[j * (n + 1) + i]),
  );
}

/** The 3 rows of a row-major 4x4. */
export function rowsOf4(m: ArrayLike<number>): number[][] {
  return [0, 1, 2].map((i) =>
    Array.from({ length: 4 }, (_, j) => m[i * 4 + j]),
  );
}

/** Row-major 4x4 of 3 rows of [linear | translation]. */
export function flat4(rows: number[][]): number[] {
  return [...rows.flat(), 0, 0, 0, 1];
}

/** a b, row-major 4x4. */
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const c = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; ++i) {
    for (let j = 0; j < 4; ++j) {
      for (let k = 0; k < 4; ++k) c[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
    }
  }
  return c;
}

/** Inverse of an affine row-major 4x4. */
export function inverse4(m: ArrayLike<number>): number[] {
  return flat4(invertAffine(rowsOf4(m)));
}

/** Row-major 4x4 scaling by d[0], d[1], d[2]. */
export function scale4(d: ArrayLike<number>): number[] {
  return [d[0], 0, 0, 0, 0, d[1], 0, 0, 0, 0, d[2], 0, 0, 0, 0, 1];
}

/** Row-major 4x4 from a column-major (rank + 1)^2 homogeneous matrix. */
export function rowMajorFromColumnMajor(
  m: ArrayLike<number>,
  rank: number,
): number[] {
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; ++i) {
    for (let j = 0; j < 4; ++j) {
      const ii = i === 3 ? rank : i;
      const jj = j === 3 ? rank : j;
      out[i * 4 + j] = m[jj * (rank + 1) + ii];
    }
  }
  return out;
}

/** Column-major 4x4 (Float32Array) of a row-major 4x4. */
export function columnMajor4(m: ArrayLike<number>) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; ++i) {
    for (let j = 0; j < 4; ++j) out[j * 4 + i] = m[i * 4 + j];
  }
  return out;
}

/**
 * Row-major (rank + 1) x (sourceRank + 1) matrix of a column-major
 * CoordinateSpaceTransform-style homogeneous matrix (rank + 1)^2: the source
 * dimensions' columns, then the translation.
 */
export function fullRowMajor(
  m: ArrayLike<number>,
  rank: number,
  sourceRank = rank,
): number[] {
  const out = new Array<number>((rank + 1) * (sourceRank + 1)).fill(0);
  for (let i = 0; i <= rank; ++i) {
    for (let j = 0; j <= sourceRank; ++j) {
      const jj = j === sourceRank ? rank : j;
      out[i * (sourceRank + 1) + j] = m[jj * (rank + 1) + i];
    }
  }
  return out;
}

/**
 * Row-major 4x4 of the rows `rows` and columns `cols` (and the translation)
 * of a row-major (rank + 1) x (sourceRank + 1) matrix.
 */
export function spatialSubmatrix(
  full: number[],
  sourceRank: number,
  rows: number[],
  cols: number[],
): number[] {
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 3; ++i) {
    for (let j = 0; j < 3; ++j) {
      out[i * 4 + j] = full[rows[i] * (sourceRank + 1) + cols[j]];
    }
    out[i * 4 + 3] = full[rows[i] * (sourceRank + 1) + sourceRank];
  }
  out[15] = 1;
  return out;
}

/**
 * Coordinate matrix of a coordinate space transform: output coordinates per
 * input coordinate (row-major, rank x (sourceRank + 1), last column the
 * translation). Linear coefficients of a transform relate physical units, so
 * in coordinates they scale by input scale / output scale.
 */
export function coordinateMatrix(t: CoordinateSpaceTransform): number[][] {
  const { rank, sourceRank, transform, inputSpace, outputSpace } = t;
  return Array.from({ length: rank }, (_, i) => [
    ...Array.from(
      { length: sourceRank },
      (_, j) =>
        (transform[j * (rank + 1) + i] * inputSpace.scales[j]) /
        outputSpace.scales[i],
    ),
    transform[rank * (rank + 1) + i],
  ]);
}

/** Applies a row-major 3x4 (or 4x4) affine to points, x y z interleaved. */
export function applyAffine3(
  M: ArrayLike<number>,
  points: ArrayLike<number>,
): Float64Array {
  const n = points.length / 3;
  const out = new Float64Array(3 * n);
  for (let v = 0; v < n; ++v) {
    const x = points[3 * v];
    const y = points[3 * v + 1];
    const z = points[3 * v + 2];
    for (let o = 0; o < 3; ++o) {
      out[3 * v + o] =
        M[o * 4] * x + M[o * 4 + 1] * y + M[o * 4 + 2] * z + M[o * 4 + 3];
    }
  }
  return out;
}

/**
 * Bounding box of the axis-aligned box [lo, hi] (n dims) mapped through the
 * flat row-major affine `m` of `rows` rows and n + 1 columns (a 4x4 for
 * rows = n = 3).
 */
export function transformBox(
  m: ArrayLike<number>,
  rows: number,
  n: number,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
): [number[], number[]] {
  const outLo = new Array<number>(rows);
  const outHi = new Array<number>(rows);
  for (let i = 0; i < rows; ++i) {
    let l = m[i * (n + 1) + n];
    let h = l;
    for (let j = 0; j < n; ++j) {
      const c = m[i * (n + 1) + j];
      if (c >= 0) {
        l += c * lo[j];
        h += c * hi[j];
      } else {
        l += c * hi[j];
        h += c * lo[j];
      }
    }
    outLo[i] = l;
    outHi[i] = h;
  }
  return [outLo, outHi];
}
