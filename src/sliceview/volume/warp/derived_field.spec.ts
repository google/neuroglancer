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
import type {
  DerivedFieldParameters,
  FetchFieldChunks,
  StoredFieldLevel,
} from "#src/sliceview/volume/warp/derived_field.js";
import {
  assumedLevelError,
  deriveFieldChunk,
  derivedFieldDomain,
} from "#src/sliceview/volume/warp/derived_field.js";
import { invertFieldBlock } from "#src/sliceview/volume/warp/simplex_inverse.js";

type Vec = [number, number, number];

const CHUNK = 16;

/** A dense level: displacements in finest-level index units, (n0, n1, n2). */
interface Dense {
  size: Vec;
  u: Float32Array[]; // per component, Fortran (dimension 0 fastest)
}

function sample(f: (x: Vec) => Vec, size: Vec): Dense {
  const n = size[0] * size[1] * size[2];
  const u = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let k = 0;
  for (let i2 = 0; i2 < size[2]; ++i2) {
    for (let i1 = 0; i1 < size[1]; ++i1) {
      for (let i0 = 0; i0 < size[0]; ++i0, ++k) {
        const v = f([i0, i1, i2]);
        for (let c = 0; c < 3; ++c) u[c][k] = v[c];
      }
    }
  }
  return { size, u };
}

/** 2x block average (sample j at 2j + 0.5 of the finer level). */
function downsample(d: Dense): Dense {
  const size = d.size.map((s) => Math.ceil(s / 2)) as Vec;
  const n = size[0] * size[1] * size[2];
  const u = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const at = (i0: number, i1: number, i2: number) =>
    i0 + d.size[0] * (i1 + d.size[1] * i2);
  let k = 0;
  for (let j2 = 0; j2 < size[2]; ++j2) {
    for (let j1 = 0; j1 < size[1]; ++j1) {
      for (let j0 = 0; j0 < size[0]; ++j0, ++k) {
        for (let c = 0; c < 3; ++c) {
          let s = 0;
          let m = 0;
          for (let a = 0; a < 8; ++a) {
            const i0 = 2 * j0 + (a & 1);
            const i1 = 2 * j1 + ((a >> 1) & 1);
            const i2 = 2 * j2 + ((a >> 2) & 1);
            if (i0 >= d.size[0] || i1 >= d.size[1] || i2 >= d.size[2]) continue;
            s += d.u[c][at(i0, i1, i2)];
            ++m;
          }
          u[c][k] = s / m;
        }
      }
    }
  }
  return { size, u };
}

/** Trilinear (nearest outside) value of a level at continuous index x. */
function interp(d: Dense, x: number[], c: number) {
  const i = [0, 0, 0];
  const t = [0, 0, 0];
  for (let a = 0; a < 3; ++a) {
    const v = Math.min(Math.max(x[a], 0), d.size[a] - 1);
    i[a] = Math.min(Math.floor(v), Math.max(d.size[a] - 2, 0));
    t[a] = v - i[a];
  }
  let s = 0;
  for (let a = 0; a < 8; ++a) {
    const o = [a & 1, (a >> 1) & 1, (a >> 2) & 1];
    let w = 1;
    const j = [0, 0, 0];
    for (let b = 0; b < 3; ++b) {
      w *= o[b] ? t[b] : 1 - t[b];
      j[b] = Math.min(i[b] + o[b], d.size[b] - 1);
    }
    s += w * d.u[c][j[0] + d.size[0] * (j[1] + d.size[1] * j[2])];
  }
  return s;
}

/** Max |u0 - u_L| per finest-level dimension, as the writer measures it. */
function levelError(d0: Dense, dl: Dense, scale: number, offset: number) {
  const err = [0, 0, 0];
  for (let i2 = 0; i2 < d0.size[2]; ++i2) {
    for (let i1 = 0; i1 < d0.size[1]; ++i1) {
      for (let i0 = 0; i0 < d0.size[0]; ++i0) {
        const x = [i0, i1, i2].map((v) => (v - offset) / scale);
        const k = i0 + d0.size[0] * (i1 + d0.size[1] * i2);
        for (let c = 0; c < 3; ++c) {
          err[c] = Math.max(err[c], Math.abs(d0.u[c][k] - interp(dl, x, c)));
        }
      }
    }
  }
  return err;
}

/**
 * A stored field: levels as chunked rank-4 arrays (spatial dimensions 0-2,
 * components last), whose components are `componentScale` times the
 * displacement in finest-level index units.
 */
function makeStored(
  f: (x: Vec) => Vec,
  size: Vec,
  numLevels: number,
  componentScale: number,
  withErrors = true,
) {
  const dense = [sample(f, size)];
  for (let l = 1; l < numLevels; ++l) dense.push(downsample(dense[l - 1]));
  const chunks = dense.map((d) => {
    const map = new Map<string, Float32Array>();
    const grid = d.size.map((s) => Math.ceil(s / CHUNK));
    for (let g2 = 0; g2 < grid[2]; ++g2) {
      for (let g1 = 0; g1 < grid[1]; ++g1) {
        for (let g0 = 0; g0 < grid[0]; ++g0) {
          const o = [g0, g1, g2].map((g) => g * CHUNK);
          const s = o.map((v, a) => Math.min(CHUNK, d.size[a] - v));
          const data = new Float32Array(s[0] * s[1] * s[2] * 3);
          let k = 0;
          for (let c = 0; c < 3; ++c) {
            for (let i2 = 0; i2 < s[2]; ++i2) {
              for (let i1 = 0; i1 < s[1]; ++i1) {
                for (let i0 = 0; i0 < s[0]; ++i0, ++k) {
                  const j =
                    o[0] +
                    i0 +
                    d.size[0] * (o[1] + i1 + d.size[1] * (o[2] + i2));
                  data[k] = d.u[c][j] * componentScale;
                }
              }
            }
          }
          map.set([g0, g1, g2, 0].join(), data);
        }
      }
    }
    return map;
  });
  const levels: StoredFieldLevel[] = dense.map((d, l) => {
    const scale = 2 ** l;
    const offset = (scale - 1) / 2;
    return {
      rank: 4,
      chunkDataSize: [CHUNK, CHUNK, CHUNK, 3],
      baseVoxelOffset: [0, 0, 0, 0],
      lowerVoxelBound: [0, 0, 0, 0],
      upperVoxelBound: [...d.size, 3],
      scale: [scale, scale, scale],
      offset: [offset, offset, offset],
      error:
        l === 0 || !withErrors
          ? undefined
          : levelError(dense[0], d, scale, offset),
    };
  });
  const parameters: DerivedFieldParameters = {
    levels,
    vectorDim: 3,
    spatialDims: [0, 1, 2],
    numComponents: 3,
    displaced: [true, true, true],
    componentsToFine: [
      1 / componentScale,
      0,
      0,
      0,
      1 / componentScale,
      0,
      0,
      0,
      1 / componentScale,
    ],
  };
  const fetch: FetchFieldChunks = async (level, grids) =>
    grids.map((g) => chunks[level].get(g.join()) ?? null);
  const totalChunks = chunks.map((m) => m.size);
  return { dense, parameters, fetch, totalChunks };
}

/** The direct inverse of a dense level over the target box (no search). */
function direct(d: Dense, tLo: Vec, tSize: Vec) {
  const n = d.size[0] * d.size[1] * d.size[2];
  const data = new Float32Array(3 * n);
  data.set(d.u[0], 0);
  data.set(d.u[1], n);
  data.set(d.u[2], 2 * n);
  return invertFieldBlock(
    {
      data,
      size: d.size,
      strides: [1, d.size[0], d.size[0] * d.size[1]],
      componentOffsets: [0, n, 2 * n],
      origin: [0, 0, 0],
    },
    tLo,
    tSize,
  );
}

const smooth = (x: Vec): Vec => [
  4 * Math.sin(x[1] / 9) + 0.05 * x[0],
  3 * Math.cos(x[2] / 11) - 0.04 * x[1],
  3.5 * Math.sin((x[0] + x[2]) / 13),
];

describe("derived field", () => {
  const stored = makeStored(smooth, [64, 56, 48], 3, 0.5);

  it("equals the direct inverse, fetching few chunks", async () => {
    const { dense, parameters, fetch, totalChunks } = stored;
    const tSize: Vec = [16, 16, 16];
    for (const tLo of [
      [16, 16, 16],
      [0, 0, 0],
      [48, 40, 32],
      [-8, 24, 8],
    ] as Vec[]) {
      const got = await deriveFieldChunk(parameters, 0, tLo, tSize, fetch);
      const want = direct(dense[0], tLo, tSize);
      const n = 16 ** 3;
      for (let t = 0; t < n; ++t) {
        if (want.covered[t] === 0) {
          expect(got.components[t]).toBeNaN();
          continue;
        }
        for (let c = 0; c < 3; ++c) {
          // components are half the index-unit displacement
          expect(got.components[c * n + t]).toBeCloseTo(
            0.5 * want.displacement[c * n + t],
            4,
          );
        }
      }
      // A 16^3 target can need at most 8 finest chunks of 16^3, plus the
      // neighbours its cells reach into.
      expect(got.plan.fetched.get(0) ?? 0).toBeLessThanOrEqual(27);
      expect(got.plan.fetched.get(0) ?? 0).toBeLessThan(totalChunks[0]);
    }
  });

  it("leaves a chunk outside the field's image empty, without fetching it", async () => {
    const { parameters, fetch } = stored;
    const got = await deriveFieldChunk(
      parameters,
      0,
      [200, 200, 200],
      [16, 16, 16],
      fetch,
    );
    expect(got.components.every((v) => Number.isNaN(v))).toBe(true);
    expect(got.plan.fetched.get(0)).toBeUndefined();
  });

  it("covers the field's image with its domain", async () => {
    const { dense, parameters, fetch } = stored;
    const { lo, hi } = await derivedFieldDomain(parameters, fetch);
    const d = dense[0];
    const ylo = [Infinity, Infinity, Infinity];
    const yhi = [-Infinity, -Infinity, -Infinity];
    let k = 0;
    for (let i2 = 0; i2 < d.size[2]; ++i2) {
      for (let i1 = 0; i1 < d.size[1]; ++i1) {
        for (let i0 = 0; i0 < d.size[0]; ++i0, ++k) {
          const y = [i0 + d.u[0][k], i1 + d.u[1][k], i2 + d.u[2][k]];
          for (let a = 0; a < 3; ++a) {
            ylo[a] = Math.min(ylo[a], y[a]);
            yhi[a] = Math.max(yhi[a], y[a]);
          }
        }
      }
    }
    for (let a = 0; a < 3; ++a) {
      expect(ylo[a]).toBeGreaterThanOrEqual(lo[a]);
      expect(yhi[a]).toBeLessThanOrEqual(hi[a]);
      // and not far beyond it (the coarsest level's error, a few samples)
      expect(lo[a]).toBeGreaterThan(ylo[a] - 12);
      expect(hi[a]).toBeLessThan(yhi[a] + 12);
    }
  });

  it("inverts a coarser level on its own lattice", async () => {
    const { dense, parameters, fetch } = stored;
    const tLo: Vec = [4, 4, 4];
    const tSize: Vec = [12, 12, 12];
    const got = await deriveFieldChunk(parameters, 1, tLo, tSize, fetch);
    // level 1 in its own index units: displacement / 2
    const d1 = dense[1];
    const half: Dense = {
      size: d1.size,
      u: d1.u.map((u) => u.map((v) => v / 2)),
    };
    const want = direct(half, tLo, tSize);
    const n = 12 ** 3;
    for (let t = 0; t < n; ++t) {
      expect(Number.isNaN(got.components[t])).toBe(want.covered[t] === 0);
      if (want.covered[t] === 0) continue;
      for (let c = 0; c < 3; ++c) {
        // back to finest-level units (x2), then components (x0.5)
        expect(got.components[c * n + t]).toBeCloseTo(
          want.displacement[c * n + t],
          4,
        );
      }
    }
  });

  it("assumes one sample of error when the metadata gives none", async () => {
    const plain = makeStored(smooth, [64, 56, 48], 3, 1, false);
    const parameters = {
      ...plain.parameters,
      levels: plain.parameters.levels.map((level, l) =>
        l === 0
          ? level
          : {
              ...level,
              error: assumedLevelError(level.scale, [true, true, true]),
            },
      ),
    };
    const tSize: Vec = [16, 16, 16];
    for (const tLo of [
      [16, 16, 16],
      [40, 8, 24],
    ] as Vec[]) {
      const got = await deriveFieldChunk(
        parameters,
        0,
        tLo,
        tSize,
        plain.fetch,
      );
      const want = direct(plain.dense[0], tLo, tSize);
      const n = 16 ** 3;
      for (let t = 0; t < n; ++t) {
        for (let c = 0; c < 3; ++c) {
          const w = want.displacement[c * n + t];
          if (Number.isNaN(w)) expect(got.components[c * n + t]).toBeNaN();
          else expect(got.components[c * n + t]).toBeCloseTo(w, 4);
        }
      }
      expect(got.plan.fetched.get(0) ?? 0).toBeLessThan(plain.totalChunks[0]);
    }
  });

  it("reads the whole field when it has a single level", async () => {
    const single = makeStored(smooth, [40, 40, 40], 1, 1);
    const tLo: Vec = [12, 12, 12];
    const tSize: Vec = [16, 16, 16];
    const got = await deriveFieldChunk(
      single.parameters,
      0,
      tLo,
      tSize,
      single.fetch,
    );
    const want = direct(single.dense[0], tLo, tSize);
    const n = 16 ** 3;
    for (let t = 0; t < n; ++t) {
      for (let c = 0; c < 3; ++c) {
        const w = want.displacement[c * n + t];
        if (Number.isNaN(w)) expect(got.components[c * n + t]).toBeNaN();
        else expect(got.components[c * n + t]).toBeCloseTo(w, 4);
      }
    }
    expect(got.plan.fetched.get(0)).toBe(single.totalChunks[0]);
  });
});
