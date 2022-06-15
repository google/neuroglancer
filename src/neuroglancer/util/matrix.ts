/**
 * @license
 * Copyright 2019 Google Inc.
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

import {TypedArray} from 'neuroglancer/util/array';

/**
 * Sets the `m * k` matrix `c` to the product of `m * n` matrix `a` and `n * k` matrix `b`.
 *
 * `a`, `b` and `c` are column-major with column strides of `lda`, `ldb`, and `ldc`, respectively.
 * `c` must not overlap `a` or `b`.
 */
export function multiply<T extends TypedArray>(
    c: T, ldc: number, a: T, lda: number, b: T, ldb: number, m: number, n: number, k: number): T {
  for (let mIndex = 0; mIndex < m; ++mIndex) {
    for (let kIndex = 0; kIndex < k; ++kIndex) {
      let sum = 0;
      for (let nIndex = 0; nIndex < n; ++nIndex) {
        sum += a[mIndex + lda * nIndex] * b[nIndex + ldb * kIndex];
      }
      c[mIndex + ldc * kIndex] = sum;
    }
  }
  return c;
}

export function identity<T extends TypedArray>(a: T, lda: number, n: number): T {
  for (let i = 0; i < n; ++i) {
    const start = lda * i;
    a.fill(0, start, start + n);
    a[start + i] = 1;
  }
  return a;
}

export function createIdentity<T extends TypedArray>(
    c: {new (n: number): T}, rows: number, cols: number = rows): T {
  return identity(new c(rows * cols), rows, Math.min(rows, cols));
}


export function createHomogeneousScaleMatrix<T extends TypedArray>(
    c: {new (length: number): T}, scales: ArrayLike<number>, square = true): T {
  const rank = scales.length;
  const stride = square ? rank + 1 : rank;
  const m = new c(stride * (rank + 1));
  if (square) {
    m[m.length - 1] = 1;
  }
  for (let i = 0; i < rank; ++i) {
    m[(stride + 1) * i] = scales[i];
  }
  return m;
}

export function createHomogeneousTranslationMatrix<T extends TypedArray>(
    c: {new (length: number): T}, translation: ArrayLike<number>, square = true): T {
  const rank = translation.length;
  const stride = square ? rank + 1 : rank;
  const m = createIdentity(c, stride, rank + 1);
  for (let i = 0; i < rank; ++i) {
    m[stride * rank + i] = translation[i];
  }
  return m;
}

export function isIdentity<T extends TypedArray>(a: T, lda: number, n: number) {
  for (let i = 0; i < n; ++i) {
    for (let j = 0; j < n; ++j) {
      if (a[i * lda + j] != ((i === j) ? 1 : 0)) return false;
    }
  }
  return true;
}

export function copy<T extends TypedArray>(
    b: T, ldb: number, a: T, lda: number, m: number, n: number): T {
  for (let col = 0; col < n; ++col) {
    const aOff = col * lda;
    const bOff = col * ldb;
    for (let row = 0; row < m; ++row) {
      b[bOff + row] = a[aOff + row];
    }
  }
  return b;
}

export function extendHomogeneousTransform<T extends TypedArray>(
    b: T, bRank: number, a: T, aRank: number) {
  copy(b, bRank + 1, a, aRank + 1, aRank, aRank);
  for (let i = 0; i < aRank; ++i) {
    b[(bRank + 1) * bRank + i] = a[(aRank + 1) * aRank + i];
  }
  b[b.length - 1] = 1;
  for (let i = aRank; i < bRank; ++i) {
    b[(bRank + 1) * i + i] = 1;
  }
  return b;
}


let pivots: Uint32Array|undefined;

/**
 * Computes the inverse of a square matrix in place, and returns the determinant.
 */
export function inverseInplace<T extends TypedArray>(a: T, lda: number, n: number): number {
  let determinant = 1;
  // Use Gauss-Jordan elimination with partial pivoting to compute inverse.
  if (pivots === undefined || pivots.length < n) {
    pivots = new Uint32Array(n);
  }
  for (let i = 0; i < n; ++i) {
    pivots[i] = i;
  }
  for (let k = 0; k < n; ++k) {
    const kColOff = lda * k;
    // Find best pivot (row >= `k` with maximum-magnitude element in column `k`).
    let pivotRow = k;
    {
      let bestPivot = Math.abs(a[kColOff + k]);
      for (let row = k + 1; row < n; ++row) {
        const mag = Math.abs(a[kColOff + row]);
        if (mag > bestPivot) {
          bestPivot = mag;
          pivotRow = row;
        }
      }
    }
    // Swap rows `k` and `pivotRow`.
    if (k !== pivotRow) {
      determinant *= -1;
      for (let col = 0; col < n; ++col) {
        const off = lda * col;
        const temp = a[off + k];
        a[off + k] = a[off + pivotRow];
        a[off + pivotRow] = temp;
      }

      // Swap `pivots[k]` with `pivots[pivotRow]`.
      {
        const tempPivot = pivots[k];
        pivots[k] = pivots[pivotRow];
        pivots[pivotRow] = tempPivot;
      }
    }
    // Eliminate.
    const pivotValue = a[kColOff + k];
    const pivotInv = 1.0 / pivotValue;

    // Divide row `k` by the pivot element.
    determinant *= pivotValue;
    for (let j = 0; j < n; ++j) {
      a[lda * j + k] *= pivotInv;
    }
    // Convert `a(k, k)` to contain the inverse element.
    a[kColOff + k] = pivotInv;

    // Subtract a suitable multiple of row `k` from all other rows to ensure column `k` becomes `0`.
    for (let row = 0; row < n; ++row) {
      if (row === k) continue;
      const factor = -a[lda * k + row];
      for (let j = 0; j < n; ++j) {
        const jColOff = lda * j;
        a[jColOff + row] += factor * a[jColOff + k];
      }
      // Convert element in column `k` to contain the inverse element.
      a[lda * k + row] = factor * pivotInv;
    }
  }
  // Permute columns back to correct order.
  for (let col = 0; col < n; ++col) {
    let targetCol = pivots[col];
    while (targetCol !== col) {
      const colOff = lda * col;
      const targetColOff = lda * targetCol;
      for (let i = 0; i < n; ++i) {
        const off1 = colOff + i;
        const off2 = targetColOff + i;
        const temp = a[off1];
        a[off1] = a[off2];
        a[off2] = temp;
      }
      const temp = pivots[col] = pivots[targetCol];
      pivots[targetCol] = targetCol;
      targetCol = temp;
    }
  }
  return determinant;
}

/**
 * Computes the inverse and returns the determinant.
 */
export function inverse<T extends TypedArray>(
    b: T, ldb: number, a: T, lda: number, n: number): number {
  copy(b, ldb, a, lda, n, n);
  return inverseInplace(b, ldb, n);
}


export function equal<T extends TypedArray>(
    a: T, lda: number, b: T, ldb: number, m: number, n: number) {
  for (let j = 0; j < n; ++j) {
    const offA = lda * j;
    const offB = ldb * j;
    for (let i = 0; i < m; ++i) {
      if (a[offA + i] !== b[offB + i]) return false;
    }
  }
  return true;
}

export function transpose<T extends TypedArray>(
    b: T, ldb: number, a: T, lda: number, m: number, n: number) {
  for (let i = 0; i < m; ++i) {
    for (let j = 0; j < n; ++j) {
      b[j + i * ldb] = a[i + j * lda];
    }
  }
  return b;
}

export function
transformPoint<Out extends TypedArray, Matrix extends TypedArray, Vector extends TypedArray>(
    out: Out, mat: Matrix, matrixStride: number, vec: Vector, rank: number): Out {
  for (let i = 0; i < rank; ++i) {
    let sum = mat[matrixStride * rank + i];
    for (let j = 0; j < rank; ++j) {
      sum += mat[matrixStride * j + i] * vec[j];
    }
    out[i] = sum;
  }
  return out;
}

export function
transformVector<Out extends TypedArray, Matrix extends TypedArray, Vector extends TypedArray>(
    out: Out, mat: Matrix, matrixStride: number, vec: Vector, rank: number): Out {
  for (let i = 0; i < rank; ++i) {
    let sum = 0;
    for (let j = 0; j < rank; ++j) {
      sum += mat[matrixStride * j + i] * vec[j];
    }
    out[i] = sum;
  }
  return out;
}

export function permuteRows<Output extends TypedArray, Input extends TypedArray>(
    output: Output, outputStride: number, input: Input, inputStride: number,
    outputToInputRow: ReadonlyArray<number>, cols: number) {
  const rows = outputToInputRow.length;
  for (let outRow = 0; outRow < rows; ++outRow) {
    const inRow = outputToInputRow[outRow];
    for (let col = 0; col < cols; ++col) {
      output[col * outputStride + outRow] = input[col * inputStride + inRow];
    }
  }
  return output;
}

export function permuteCols<Output extends TypedArray, Input extends TypedArray>(
    output: Output, outputStride: number, input: Input, inputStride: number,
    outputToInputCol: ReadonlyArray<number>, rows: number) {
  const cols = outputToInputCol.length;
  for (let outCol = 0; outCol < cols; ++outCol) {
    const inCol = outputToInputCol[outCol];
    for (let row = 0; row < rows; ++row) {
      output[outCol * outputStride + row] = input[inCol * inputStride + row];
    }
  }
  return output;
}
