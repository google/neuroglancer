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
 * @file The inverse of a displacement field over a block of target points,
 * without iteration.
 *
 * A field sampled on an integer lattice maps a sample X to Y = X + u(X).
 * Each lattice cell is split into simplices: five tetrahedra in 3-D, two
 * triangles in 2-D. On a simplex the map is affine, so it is inverted exactly.
 * A target point t inside a warped simplex gets its barycentric coordinates
 * there, and these weight the simplex's source vertices, giving X with
 * X + u(X) = t. The result is w(t) = X - t, the displacement of the inverse
 * field.
 *
 * In 3-D the two ways of splitting a cube alternate on a checkerboard of the
 * whole lattice, so that cells on either side of a face cut it along the same
 * diagonal and the simplices tile space. That is why the block's origin in the
 * lattice matters: two blocks of one field, inverted separately, agree where
 * they meet.
 *
 * This is a splat over the field's cells, not a query at a point. It answers
 * for a whole block of targets at once. The cells it needs are found
 * elsewhere (from the field's coarser levels).
 *
 * Method: Ashburner, Andersson & Friston, NeuroImage 10 (1999) 2-D, and Human
 * Brain Mapping 9 (2000) appendix, 3-D. Suggested for Neuroglancer by Yael
 * Balbastre; written from the published method.
 */

/** A block of samples of a displacement field. */
export interface FieldBlock {
  /**
   * Displacements in index units of the lattice: component d moves along
   * spatial dimension d.
   */
  data: Float32Array;
  /** Samples along each of the 3 spatial dimensions. */
  size: ArrayLike<number>;
  /** Element stride of each spatial dimension in `data`. */
  strides: ArrayLike<number>;
  /** Element offset of each displacement component in `data`. */
  componentOffsets: ArrayLike<number>;
  /** Lattice index of the block's first sample. */
  origin: ArrayLike<number>;
}

export interface InverseBlock {
  /**
   * w = X - t at each target point, component c at
   * c * n + i0 + s0 * (i1 + s1 * i2) (n target points, dimension 0 fastest).
   * NaN where no cell reaches.
   */
  displacement: Float32Array;
  /** 1 where some cell reaches the target point. */
  covered: Uint8Array;
  /**
   * Target points reached by more than one distinct solution (the field
   * folds). The solution with the smallest |w| is kept.
   */
  folds: number;
}

/** Corner c of a cell: offset ((c >> 2) & 1, (c >> 1) & 1, c & 1). */
function splitCube(tips: number[], centre: number[]): number[][] {
  return [...tips.map((t) => [t, t ^ 4, t ^ 2, t ^ 1]), centre];
}

/**
 * The two splits of a cube into five tetrahedra (four corner tetrahedra and a
 * central one), used on cells of even and odd i0 + i1 + i2.
 */
export const CUBE_SPLITS: readonly number[][][] = [
  splitCube([0b000, 0b011, 0b101, 0b110], [0b111, 0b001, 0b010, 0b100]),
  splitCube([0b111, 0b100, 0b010, 0b001], [0b000, 0b011, 0b101, 0b110]),
];

/** The two splits of a square (corner c: offset ((c >> 1) & 1, c & 1)). */
const SQUARE_SPLITS: readonly number[][][] = [
  [
    [0b00, 0b10, 0b11],
    [0b00, 0b01, 0b11],
  ],
  [
    [0b00, 0b10, 0b01],
    [0b11, 0b10, 0b01],
  ],
];

const BARY_EPS = 1e-9;
const FOLD_TOLERANCE = 1e-4;

class Output {
  n: number;
  displacement: Float32Array;
  covered: Uint8Array;
  best: Float64Array;
  folded: Uint8Array;
  constructor(n: number) {
    this.n = n;
    this.displacement = new Float32Array(3 * n).fill(NaN);
    this.covered = new Uint8Array(n);
    this.best = new Float64Array(n);
    this.folded = new Uint8Array(n);
  }

  put(i: number, w0: number, w1: number, w2: number) {
    const { n, displacement: d } = this;
    const norm = w0 * w0 + w1 * w1 + w2 * w2;
    if (this.covered[i] === 0) {
      this.covered[i] = 1;
      this.best[i] = norm;
      d[i] = w0;
      d[n + i] = w1;
      d[2 * n + i] = w2;
      return;
    }
    if (
      Math.max(
        Math.abs(w0 - d[i]),
        Math.abs(w1 - d[n + i]),
        Math.abs(w2 - d[2 * n + i]),
      ) <= FOLD_TOLERANCE
    ) {
      return; // the same solution, from a neighbouring simplex
    }
    this.folded[i] = 1;
    if (norm < this.best[i]) {
      this.best[i] = norm;
      d[i] = w0;
      d[n + i] = w1;
      d[2 * n + i] = w2;
    }
  }

  finish(): InverseBlock {
    let folds = 0;
    for (const f of this.folded) folds += f;
    return {
      displacement: this.displacement,
      covered: this.covered,
      folds,
    };
  }
}

/**
 * Inverts the field over the target points targetOrigin + [0, targetSize)
 * (lattice indices).
 *
 * `displaced` marks the spatial dimensions the field moves; there must be 3,
 * or 2 (a stack of 2-D fields: along the other dimension a target point is
 * reached only from a sample at the same index, and w is 0 there).
 */
export function invertFieldBlock(
  field: FieldBlock,
  targetOrigin: ArrayLike<number>,
  targetSize: ArrayLike<number>,
  displaced: ArrayLike<boolean> = [true, true, true],
): InverseBlock {
  const dims = [0, 1, 2].filter((d) => displaced[d]);
  const out = new Output(targetSize[0] * targetSize[1] * targetSize[2]);
  if (dims.length === 3) {
    invert3(field, targetOrigin, targetSize, out);
  } else if (dims.length === 2) {
    invert2(field, targetOrigin, targetSize, dims, out);
  } else {
    throw new Error(
      `Inverting a field needs 2 or 3 displaced dimensions, not ${dims.length}`,
    );
  }
  return out.finish();
}

function invert3(
  field: FieldBlock,
  tOrigin: ArrayLike<number>,
  tSize: ArrayLike<number>,
  out: Output,
) {
  const { data, size, strides, componentOffsets: co, origin } = field;
  const [n0, n1, n2] = [size[0], size[1], size[2]];
  const [s0, s1, s2] = [strides[0], strides[1], strides[2]];
  const [c0, c1, c2] = [co[0], co[1], co[2]];
  const tLo = [tOrigin[0], tOrigin[1], tOrigin[2]];
  const tHi = [0, 1, 2].map((d) => tOrigin[d] + tSize[d] - 1);
  const ts0 = tSize[0];
  const ts01 = tSize[0] * tSize[1];
  const Y = new Float64Array(24); // the cell's 8 warped corners
  const X = new Float64Array(24); // and their lattice positions
  const M = new Float64Array(9);
  for (let i2 = 0; i2 + 1 < n2; ++i2) {
    for (let i1 = 0; i1 + 1 < n1; ++i1) {
      for (let i0 = 0; i0 + 1 < n0; ++i0) {
        let lo0 = Infinity,
          lo1 = Infinity,
          lo2 = Infinity,
          hi0 = -Infinity,
          hi1 = -Infinity,
          hi2 = -Infinity;
        for (let c = 0; c < 8; ++c) {
          const a = (c >> 2) & 1,
            b = (c >> 1) & 1,
            e = c & 1;
          const k = (i0 + a) * s0 + (i1 + b) * s1 + (i2 + e) * s2;
          const x0 = origin[0] + i0 + a,
            x1 = origin[1] + i1 + b,
            x2 = origin[2] + i2 + e;
          const y0 = x0 + data[k + c0],
            y1 = x1 + data[k + c1],
            y2 = x2 + data[k + c2];
          X[3 * c] = x0;
          X[3 * c + 1] = x1;
          X[3 * c + 2] = x2;
          Y[3 * c] = y0;
          Y[3 * c + 1] = y1;
          Y[3 * c + 2] = y2;
          if (y0 < lo0) lo0 = y0;
          if (y0 > hi0) hi0 = y0;
          if (y1 < lo1) lo1 = y1;
          if (y1 > hi1) hi1 = y1;
          if (y2 < lo2) lo2 = y2;
          if (y2 > hi2) hi2 = y2;
        }
        if (
          hi0 < tLo[0] ||
          lo0 > tHi[0] ||
          hi1 < tLo[1] ||
          lo1 > tHi[1] ||
          hi2 < tLo[2] ||
          lo2 > tHi[2]
        ) {
          continue;
        }
        const parity = (origin[0] + origin[1] + origin[2] + i0 + i1 + i2) & 1;
        for (const tet of CUBE_SPLITS[parity]) {
          const v0 = 3 * tet[0],
            v1 = 3 * tet[1],
            v2 = 3 * tet[2],
            v3 = 3 * tet[3];
          // lattice box of the warped tetrahedron, within the target block
          const a0 = Math.min(Y[v0], Y[v1], Y[v2], Y[v3]),
            b0 = Math.max(Y[v0], Y[v1], Y[v2], Y[v3]);
          const a1 = Math.min(Y[v0 + 1], Y[v1 + 1], Y[v2 + 1], Y[v3 + 1]),
            b1 = Math.max(Y[v0 + 1], Y[v1 + 1], Y[v2 + 1], Y[v3 + 1]);
          const a2 = Math.min(Y[v0 + 2], Y[v1 + 2], Y[v2 + 2], Y[v3 + 2]),
            b2 = Math.max(Y[v0 + 2], Y[v1 + 2], Y[v2 + 2], Y[v3 + 2]);
          const l0 = Math.max(Math.ceil(a0 - BARY_EPS), tLo[0]),
            h0 = Math.min(Math.floor(b0 + BARY_EPS), tHi[0]);
          const l1 = Math.max(Math.ceil(a1 - BARY_EPS), tLo[1]),
            h1 = Math.min(Math.floor(b1 + BARY_EPS), tHi[1]);
          const l2 = Math.max(Math.ceil(a2 - BARY_EPS), tLo[2]),
            h2 = Math.min(Math.floor(b2 + BARY_EPS), tHi[2]);
          if (l0 > h0 || l1 > h1 || l2 > h2) continue;
          // E = [Y1 - Y0, Y2 - Y0, Y3 - Y0] (columns); M = E^-1
          const e00 = Y[v1] - Y[v0],
            e10 = Y[v1 + 1] - Y[v0 + 1],
            e20 = Y[v1 + 2] - Y[v0 + 2];
          const e01 = Y[v2] - Y[v0],
            e11 = Y[v2 + 1] - Y[v0 + 1],
            e21 = Y[v2 + 2] - Y[v0 + 2];
          const e02 = Y[v3] - Y[v0],
            e12 = Y[v3 + 1] - Y[v0 + 1],
            e22 = Y[v3 + 2] - Y[v0 + 2];
          const m00 = e11 * e22 - e12 * e21,
            m01 = e02 * e21 - e01 * e22,
            m02 = e01 * e12 - e02 * e11;
          const det = e00 * m00 + e10 * m01 + e20 * m02;
          if (Math.abs(det) < 1e-12) continue;
          const inv = 1 / det;
          M[0] = m00 * inv;
          M[1] = m01 * inv;
          M[2] = m02 * inv;
          M[3] = (e12 * e20 - e10 * e22) * inv;
          M[4] = (e00 * e22 - e02 * e20) * inv;
          M[5] = (e02 * e10 - e00 * e12) * inv;
          M[6] = (e10 * e21 - e11 * e20) * inv;
          M[7] = (e01 * e20 - e00 * e21) * inv;
          M[8] = (e00 * e11 - e01 * e10) * inv;
          const dx10 = X[v1] - X[v0],
            dx11 = X[v1 + 1] - X[v0 + 1],
            dx12 = X[v1 + 2] - X[v0 + 2];
          const dx20 = X[v2] - X[v0],
            dx21 = X[v2 + 1] - X[v0 + 1],
            dx22 = X[v2 + 2] - X[v0 + 2];
          const dx30 = X[v3] - X[v0],
            dx31 = X[v3 + 1] - X[v0 + 1],
            dx32 = X[v3 + 2] - X[v0 + 2];
          for (let t2 = l2; t2 <= h2; ++t2) {
            const r2 = t2 - Y[v0 + 2];
            for (let t1 = l1; t1 <= h1; ++t1) {
              const r1 = t1 - Y[v0 + 1];
              for (let t0 = l0; t0 <= h0; ++t0) {
                const r0 = t0 - Y[v0];
                const q1 = M[0] * r0 + M[1] * r1 + M[2] * r2;
                if (q1 < -BARY_EPS) continue;
                const q2 = M[3] * r0 + M[4] * r1 + M[5] * r2;
                if (q2 < -BARY_EPS) continue;
                const q3 = M[6] * r0 + M[7] * r1 + M[8] * r2;
                if (q3 < -BARY_EPS || q1 + q2 + q3 > 1 + BARY_EPS) continue;
                out.put(
                  t0 - tLo[0] + ts0 * (t1 - tLo[1]) + ts01 * (t2 - tLo[2]),
                  X[v0] + q1 * dx10 + q2 * dx20 + q3 * dx30 - t0,
                  X[v0 + 1] + q1 * dx11 + q2 * dx21 + q3 * dx31 - t1,
                  X[v0 + 2] + q1 * dx12 + q2 * dx22 + q3 * dx32 - t2,
                );
              }
            }
          }
        }
      }
    }
  }
}

function invert2(
  field: FieldBlock,
  tOrigin: ArrayLike<number>,
  tSize: ArrayLike<number>,
  dims: number[],
  out: Output,
) {
  const { data, size, strides, componentOffsets: co, origin } = field;
  const [da, db] = dims;
  const dp = 3 - da - db; // the dimension passed through
  const tStride = [1, tSize[0], tSize[0] * tSize[1]];
  const w = [0, 0, 0];
  const Y = new Float64Array(8);
  const X = new Float64Array(8);
  const tLoA = tOrigin[da],
    tHiA = tOrigin[da] + tSize[da] - 1;
  const tLoB = tOrigin[db],
    tHiB = tOrigin[db] + tSize[db] - 1;
  for (let ip = 0; ip < size[dp]; ++ip) {
    const p = origin[dp] + ip;
    const tp = p - tOrigin[dp];
    if (tp < 0 || tp >= tSize[dp]) continue;
    for (let ib = 0; ib + 1 < size[db]; ++ib) {
      for (let ia = 0; ia + 1 < size[da]; ++ia) {
        let loA = Infinity,
          hiA = -Infinity,
          loB = Infinity,
          hiB = -Infinity;
        for (let c = 0; c < 4; ++c) {
          const a = (c >> 1) & 1,
            b = c & 1;
          const k =
            ip * strides[dp] + (ia + a) * strides[da] + (ib + b) * strides[db];
          const xa = origin[da] + ia + a,
            xb = origin[db] + ib + b;
          const ya = xa + data[k + co[da]],
            yb = xb + data[k + co[db]];
          X[2 * c] = xa;
          X[2 * c + 1] = xb;
          Y[2 * c] = ya;
          Y[2 * c + 1] = yb;
          loA = Math.min(loA, ya);
          hiA = Math.max(hiA, ya);
          loB = Math.min(loB, yb);
          hiB = Math.max(hiB, yb);
        }
        if (hiA < tLoA || loA > tHiA || hiB < tLoB || loB > tHiB) continue;
        const parity = (origin[da] + origin[db] + ia + ib) & 1;
        for (const tri of SQUARE_SPLITS[parity]) {
          const v0 = 2 * tri[0],
            v1 = 2 * tri[1],
            v2 = 2 * tri[2];
          const la = Math.max(
            Math.ceil(Math.min(Y[v0], Y[v1], Y[v2]) - BARY_EPS),
            tLoA,
          );
          const ha = Math.min(
            Math.floor(Math.max(Y[v0], Y[v1], Y[v2]) + BARY_EPS),
            tHiA,
          );
          const lb = Math.max(
            Math.ceil(Math.min(Y[v0 + 1], Y[v1 + 1], Y[v2 + 1]) - BARY_EPS),
            tLoB,
          );
          const hb = Math.min(
            Math.floor(Math.max(Y[v0 + 1], Y[v1 + 1], Y[v2 + 1]) + BARY_EPS),
            tHiB,
          );
          if (la > ha || lb > hb) continue;
          const e00 = Y[v1] - Y[v0],
            e10 = Y[v1 + 1] - Y[v0 + 1];
          const e01 = Y[v2] - Y[v0],
            e11 = Y[v2 + 1] - Y[v0 + 1];
          const det = e00 * e11 - e01 * e10;
          if (Math.abs(det) < 1e-12) continue;
          const m00 = e11 / det,
            m01 = -e01 / det,
            m10 = -e10 / det,
            m11 = e00 / det;
          for (let tb = lb; tb <= hb; ++tb) {
            const rb = tb - Y[v0 + 1];
            for (let ta = la; ta <= ha; ++ta) {
              const ra = ta - Y[v0];
              const q1 = m00 * ra + m01 * rb;
              if (q1 < -BARY_EPS) continue;
              const q2 = m10 * ra + m11 * rb;
              if (q2 < -BARY_EPS || q1 + q2 > 1 + BARY_EPS) continue;
              w[da] = X[v0] + q1 * (X[v1] - X[v0]) + q2 * (X[v2] - X[v0]) - ta;
              w[db] =
                X[v0 + 1] +
                q1 * (X[v1 + 1] - X[v0 + 1]) +
                q2 * (X[v2 + 1] - X[v0 + 1]) -
                tb;
              w[dp] = 0;
              out.put(
                (ta - tOrigin[da]) * tStride[da] +
                  (tb - tOrigin[db]) * tStride[db] +
                  tp * tStride[dp],
                w[0],
                w[1],
                w[2],
              );
            }
          }
        }
      }
    }
  }
}
