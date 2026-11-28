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

import { describe, expect, it } from "vitest";
import type { FieldBlock } from "#src/sliceview/volume/warp/simplex_inverse.js";
import {
  CUBE_SPLITS,
  invertFieldBlock,
} from "#src/sliceview/volume/warp/simplex_inverse.js";

type Vec = [number, number, number];

/** A field block sampling u over origin + [0, size), component-major. */
function makeField(
  size: Vec,
  u: (x: Vec) => Vec,
  origin: Vec = [0, 0, 0],
): FieldBlock {
  const n = size[0] * size[1] * size[2];
  const data = new Float32Array(3 * n);
  for (let i2 = 0; i2 < size[2]; ++i2) {
    for (let i1 = 0; i1 < size[1]; ++i1) {
      for (let i0 = 0; i0 < size[0]; ++i0) {
        const k = i0 + size[0] * (i1 + size[1] * i2);
        const v = u([origin[0] + i0, origin[1] + i1, origin[2] + i2]);
        data[k] = v[0];
        data[n + k] = v[1];
        data[2 * n + k] = v[2];
      }
    }
  }
  return {
    data,
    size,
    strides: [1, size[0], size[0] * size[1]],
    componentOffsets: [0, n, 2 * n],
    origin,
  };
}

/** Calls f(t, k) for each target point t of the block and its index k. */
function eachTarget(origin: Vec, size: Vec, f: (t: Vec, k: number) => void) {
  let k = 0;
  for (let t2 = 0; t2 < size[2]; ++t2) {
    for (let t1 = 0; t1 < size[1]; ++t1) {
      for (let t0 = 0; t0 < size[0]; ++t0) {
        f([origin[0] + t0, origin[1] + t1, origin[2] + t2], k++);
      }
    }
  }
}

function inverseAt(w: Float32Array, n: number, k: number): Vec {
  return [w[k], w[n + k], w[2 * n + k]];
}

describe("invertFieldBlock", () => {
  it("splits a cube into tetrahedra that fill it", () => {
    const corner = (c: number) => [(c >> 2) & 1, (c >> 1) & 1, c & 1];
    for (const split of CUBE_SPLITS) {
      let volume = 0;
      for (const [a, b, c, d] of split) {
        const [p, q, r, s] = [a, b, c, d].map(corner);
        const e = [q, r, s].map((v) => v.map((x, i) => x - p[i]));
        volume +=
          Math.abs(
            e[0][0] * (e[1][1] * e[2][2] - e[1][2] * e[2][1]) -
              e[0][1] * (e[1][0] * e[2][2] - e[1][2] * e[2][0]) +
              e[0][2] * (e[1][0] * e[2][1] - e[1][1] * e[2][0]),
          ) / 6;
      }
      expect(volume).toBeCloseTo(1, 12);
    }
  });

  it("inverts an affine field exactly", () => {
    const A = [
      [1.1, 0.05, 0],
      [0.02, 0.95, 0.03],
      [0, -0.04, 1.05],
    ];
    const b = [2.3, -1.7, 0.4];
    const field = makeField([24, 24, 24], (x) => {
      const y = A.map((r, i) => r[0] * x[0] + r[1] * x[1] + r[2] * x[2] + b[i]);
      return [y[0] - x[0], y[1] - x[1], y[2] - x[2]];
    });
    const tOrigin: Vec = [6, 6, 6];
    const tSize: Vec = [12, 12, 12];
    const { displacement, covered, folds } = invertFieldBlock(
      field,
      tOrigin,
      tSize,
    );
    expect(folds).toBe(0);
    const n = 12 ** 3;
    let worst = 0;
    eachTarget(tOrigin, tSize, (t, k) => {
      expect(covered[k]).toBe(1);
      const X = t.map((v, i) => v + inverseAt(displacement, n, k)[i]);
      const y = A.map(
        (r, i) => r[0] * X[0] + r[1] * X[1] + r[2] * X[2] + b[i] - t[i],
      );
      worst = Math.max(worst, ...y.map(Math.abs));
    });
    expect(worst).toBeLessThan(1e-4);
  });

  it("inverts a curved field to within its piecewise-linear error", () => {
    const u = (x: Vec): Vec => [
      3 * Math.sin(x[1] / 7),
      3 * Math.sin(x[2] / 7),
      3 * Math.sin(x[0] / 7),
    ];
    const field = makeField([40, 40, 40], u);
    const tOrigin: Vec = [8, 8, 8];
    const tSize: Vec = [24, 24, 24];
    const { displacement, covered, folds } = invertFieldBlock(
      field,
      tOrigin,
      tSize,
    );
    expect(folds).toBe(0);
    const n = 24 ** 3;
    let worst = 0;
    eachTarget(tOrigin, tSize, (t, k) => {
      expect(covered[k]).toBe(1);
      const w = inverseAt(displacement, n, k);
      const X: Vec = [t[0] + w[0], t[1] + w[1], t[2] + w[2]];
      const r = u(X).map((v, i) => X[i] + v - t[i]);
      worst = Math.max(worst, Math.hypot(...r));
    });
    // second-order error of linear interpolation over a unit cell:
    // |u''| h^2 / 8 = 3/49/8 per component
    expect(worst).toBeLessThan(0.02);
  });

  it("leaves points no cell reaches uncovered", () => {
    const field = makeField([16, 16, 16], () => [2.5, 0, 0]);
    const tSize: Vec = [20, 4, 4];
    const { displacement, covered } = invertFieldBlock(field, [0, 4, 4], tSize);
    const n = 20 * 16;
    eachTarget([0, 4, 4], tSize, (t, k) => {
      const inside = t[0] >= 2.5 && t[0] <= 15 + 2.5;
      expect(covered[k]).toBe(inside ? 1 : 0);
      if (inside) {
        expect(displacement[k]).toBeCloseTo(-2.5, 5);
      } else {
        expect(displacement[k]).toBeNaN();
        expect(displacement[n + k]).toBeNaN();
      }
    });
  });

  it("keeps the smallest displacement where the field folds", () => {
    // X0 -> X0 + u0(X0) is not monotonic: it folds back over [8, 12].
    // u depends on X0 only, so its piecewise-linear interpolant on the
    // tetrahedra is linear interpolation along dimension 0.
    const u0 = (x: number) =>
      x < 8 ? 0 : x <= 12 ? -1.5 * (x - 8) : -6 + 0.5 * (x - 12);
    const f = (x: number) => x + u0(x);
    const field = makeField([24, 6, 6], (x) => [u0(x[0]), 0, 0]);
    const tSize: Vec = [24, 2, 2];
    const { displacement, covered, folds } = invertFieldBlock(
      field,
      [0, 2, 2],
      tSize,
    );
    expect(folds).toBeGreaterThan(0);
    eachTarget([0, 2, 2], tSize, (t, k) => {
      // all preimages of t[0] under the piecewise-linear map
      const pre: number[] = [];
      for (let i = 0; i + 1 < 24; ++i) {
        const a = f(i),
          b = f(i + 1);
        if (a === b) continue;
        const s = (t[0] - a) / (b - a);
        if (s >= 0 && s <= 1) pre.push(i + s);
      }
      if (pre.length === 0) {
        expect(covered[k]).toBe(0);
        return;
      }
      expect(covered[k]).toBe(1);
      const best = Math.min(...pre.map((x) => Math.abs(x - t[0])));
      expect(Math.abs(displacement[k])).toBeCloseTo(best, 5);
    });
  });

  it("gives the same answer from two overlapping blocks of one field", () => {
    // The tetrahedra alternate on the lattice's checkerboard, so a block
    // starting at an odd index splits its cells as the whole field does.
    const u = (x: Vec): Vec => [
      2 * Math.sin((x[1] + x[2]) / 5),
      1.5 * Math.cos(x[0] / 6),
      2 * Math.sin(x[0] / 4 + x[1] / 9),
    ];
    const whole = makeField([32, 32, 32], u);
    const part = makeField([19, 21, 17], u, [7, 5, 9]);
    const tOrigin: Vec = [13, 12, 14];
    const tSize: Vec = [6, 6, 6];
    const a = invertFieldBlock(whole, tOrigin, tSize);
    const b = invertFieldBlock(part, tOrigin, tSize);
    expect(Array.from(b.covered)).toEqual(Array.from(a.covered));
    for (let i = 0; i < a.displacement.length; ++i) {
      expect(b.displacement[i]).toBeCloseTo(a.displacement[i], 5);
    }
  });

  it("inverts a stack of 2-D fields section by section", () => {
    // dimension 2 is passed through; each section has its own shift
    const field = makeField([20, 20, 5], (x) => [
      0.3 * x[2] + 0.5 * Math.sin(x[1] / 5),
      -0.2 * x[2],
      0,
    ]);
    const tOrigin: Vec = [4, 4, 1];
    const tSize: Vec = [10, 10, 3];
    const { displacement, covered, folds } = invertFieldBlock(
      field,
      tOrigin,
      tSize,
      [true, true, false],
    );
    expect(folds).toBe(0);
    const n = 10 * 10 * 3;
    eachTarget(tOrigin, tSize, (t, k) => {
      expect(covered[k]).toBe(1);
      const w = inverseAt(displacement, n, k);
      expect(w[2]).toBe(0);
      const X0 = t[0] + w[0],
        X1 = t[1] + w[1];
      // dimension 1 moves by a constant per section: exact
      expect(X1 - 0.2 * t[2]).toBeCloseTo(t[1], 5);
      // dimension 0: within the linear interpolation error of the sine
      expect(
        Math.abs(X0 + 0.3 * t[2] + 0.5 * Math.sin(X1 / 5) - t[0]),
      ).toBeLessThan(0.01);
    });
  });
});
