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
 * @file Displacement at scattered points (worker side): the field chunks the
 * points need are requested as dependencies of the chunk being computed,
 * then the field is interpolated linearly, nearest-neighbour outside its grid.
 */

import type { Chunk, ChunkManager } from "#src/chunk_manager/backend.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import type { FieldAccess } from "#src/sliceview/volume/warp/base.js";
import type { VolumeDependency } from "#src/sliceview/volume/warp/dependencies.js";
import {
  getDependencyData,
  getDependencyRequests,
  volumeDependency,
} from "#src/sliceview/volume/warp/dependencies.js";

// One field level (3 displaced spatial dimensions, 3 components).
export type FieldLevelAccess = FieldAccess;

export interface SampledDisplacements {
  // Displacement per point (output coordinates, x y z interleaved).
  u: Float64Array;
  // If requested: du/dp per point (output coordinates), row-major 3x3.
  jacobian?: Float64Array;
}

/**
 * Displacements (output coordinates) at `points` (output coordinates, x y z
 * interleaved), and optionally their derivative with respect to the point:
 * exact for the trilinear interpolation, zero along clamped (extrapolated)
 * axes. The field is interpolated along its 3 chunk dimensions that vary
 * with the point; along the others (size-1 dimensions) it is constant.
 */
export async function sampleDisplacements(
  chunkManager: ChunkManager,
  requester: Chunk,
  source: VolumeChunkSource,
  access: FieldLevelAccess,
  points: Float64Array,
  signal: AbortSignal,
  withJacobian = false,
): Promise<SampledDisplacements> {
  const {
    rank,
    vectorDim,
    outputToIndex: A,
    vectorToOutput: V,
    chunkDataSize: cds,
    baseVoxelOffset: base,
    lowerVoxelBound: lb,
    upperVoxelBound: ub,
  } = access;
  // Interpolated dimensions (rows that depend on the point) and constant ones.
  const sd: number[] = [];
  const constIndex = new Array<number>(rank).fill(0);
  for (let d = 0; d < rank; ++d) {
    if (d === vectorDim) continue;
    if (A[d * 4] !== 0 || A[d * 4 + 1] !== 0 || A[d * 4 + 2] !== 0) {
      sd.push(d);
    } else {
      constIndex[d] = Math.min(
        Math.max(Math.round(A[d * 4 + 3]), lb[d]),
        ub[d] - 1,
      );
    }
  }
  if (sd.length !== 3) {
    throw new Error("warp: point sampling needs 3 displaced dimensions");
  }
  const fullSize = cds.reduce((a, b) => a * b, 1);
  const n = points.length / 3;
  const base3 = new Int32Array(3 * n);
  const frac = new Float32Array(3 * n);
  // 1 where the axis is interpolated, 0 where clamped (no derivative).
  const inside = new Uint8Array(3 * n);
  const gridOf = (d: number, i: number) => Math.floor((i - base[d]) / cds[d]);
  const needed = new Map<string, number[]>();
  const grid = new Array<number>(rank);
  const addChunks = (choices: number[][]) => {
    const pos = choices.map((c) => c[0]);
    const at = new Array<number>(rank).fill(0);
    while (true) {
      const key = pos.join();
      if (!needed.has(key)) needed.set(key, pos.slice());
      let d = 0;
      while (d < rank && ++at[d] >= choices[d].length) {
        at[d] = 0;
        pos[d] = choices[d][0];
        ++d;
      }
      if (d === rank) return;
      pos[d] = choices[d][at[d]];
    }
  };
  const componentChunks = [0, 1, 2]
    .map((c) => gridOf(vectorDim, lb[vectorDim] + c))
    .filter((g, i, a) => a.indexOf(g) === i);
  for (let p = 0; p < n; ++p) {
    const x = points[3 * p];
    const y = points[3 * p + 1];
    const z = points[3 * p + 2];
    const choices: number[][] = new Array(rank);
    for (let d = 0; d < rank; ++d) {
      if (d === vectorDim) choices[d] = componentChunks;
      else if (!sd.includes(d)) choices[d] = [gridOf(d, constIndex[d])];
    }
    sd.forEach((d, a) => {
      const f0 =
        A[d * 4] * x + A[d * 4 + 1] * y + A[d * 4 + 2] * z + A[d * 4 + 3];
      const f = Math.min(Math.max(f0, lb[d]), ub[d] - 1);
      inside[3 * p + a] = f === f0 && ub[d] - lb[d] > 1 ? 1 : 0;
      let i = Math.floor(f);
      if (i > ub[d] - 2) i = Math.max(ub[d] - 2, lb[d]);
      base3[3 * p + a] = i;
      frac[3 * p + a] = f - i;
      const hi = Math.min(i + 1, ub[d] - 1);
      const g0 = gridOf(d, i);
      const g1 = gridOf(d, hi);
      choices[d] = g0 === g1 ? [g0] : [g0, g1];
    });
    addChunks(choices);
  }
  // Field chunks, as dependencies of `requester`.
  const keys = [...needed.keys()];
  const deps: VolumeDependency[] = keys.map((k) =>
    volumeDependency(source, needed.get(k)!),
  );
  const requests = getDependencyRequests(chunkManager);
  const request = requests.add(requester, deps);
  let data: (ArrayLike<number> | null)[];
  try {
    data = await Promise.all(deps.map((d) => getDependencyData(d, signal)));
  } finally {
    requests.remove(request);
  }
  const chunks = new Map<
    string,
    { d: ArrayLike<number>; strides: number[]; origin: number[] }
  >();
  keys.forEach((k, i) => {
    const d = data[i];
    if (d == null || d.length === 0) return;
    const g = needed.get(k)!;
    const origin = g.map((gi, dim) => gi * cds[dim] + base[dim]);
    // Chunks may be stored clipped at the upper bound.
    const stored =
      d.length === fullSize
        ? cds
        : origin.map((o, dim) => Math.min(cds[dim], ub[dim] - o));
    const strides = new Array<number>(rank);
    for (let dim = 0, m = 1; dim < rank; ++dim) {
      strides[dim] = m;
      m *= stored[dim];
    }
    chunks.set(k, { d, strides, origin });
  });
  const index = constIndex.slice();
  const value = (c: number, i0: number, i1: number, i2: number) => {
    index[sd[0]] = i0;
    index[sd[1]] = i1;
    index[sd[2]] = i2;
    index[vectorDim] = lb[vectorDim] + c;
    for (let d = 0; d < rank; ++d) grid[d] = gridOf(d, index[d]);
    const e = chunks.get(grid.join());
    if (e === undefined) return 0;
    let o = 0;
    for (let d = 0; d < rank; ++d) o += (index[d] - e.origin[d]) * e.strides[d];
    return e.d[o];
  };
  const hiOf = sd.map((d) => ub[d] - 1);
  const out = new Float64Array(3 * n);
  const jacobian = withJacobian ? new Float64Array(9 * n) : undefined;
  const u = [0, 0, 0];
  // du_c / d(index axis a), row-major 3x3.
  const dd = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let p = 0; p < n; ++p) {
    const i0 = base3[3 * p];
    const i1 = base3[3 * p + 1];
    const i2 = base3[3 * p + 2];
    const j0 = Math.min(i0 + 1, hiOf[0]);
    const j1 = Math.min(i1 + 1, hiOf[1]);
    const j2 = Math.min(i2 + 1, hiOf[2]);
    const t0 = frac[3 * p];
    const t1 = frac[3 * p + 1];
    const t2 = frac[3 * p + 2];
    for (let c = 0; c < 3; ++c) {
      const v000 = value(c, i0, i1, i2);
      const v001 = value(c, i0, i1, j2);
      const v010 = value(c, i0, j1, i2);
      const v011 = value(c, i0, j1, j2);
      const v100 = value(c, j0, i1, i2);
      const v101 = value(c, j0, i1, j2);
      const v110 = value(c, j0, j1, i2);
      const v111 = value(c, j0, j1, j2);
      const c00 = v000 * (1 - t2) + v001 * t2;
      const c01 = v010 * (1 - t2) + v011 * t2;
      const c10 = v100 * (1 - t2) + v101 * t2;
      const c11 = v110 * (1 - t2) + v111 * t2;
      const lo = c00 * (1 - t1) + c01 * t1;
      const hi = c10 * (1 - t1) + c11 * t1;
      u[c] = lo * (1 - t0) + hi * t0;
      if (jacobian !== undefined) {
        dd[c * 3] = inside[3 * p] ? hi - lo : 0;
        dd[c * 3 + 1] = inside[3 * p + 1]
          ? (c01 - c00) * (1 - t0) + (c11 - c10) * t0
          : 0;
        dd[c * 3 + 2] = inside[3 * p + 2]
          ? ((v001 - v000) * (1 - t1) + (v011 - v010) * t1) * (1 - t0) +
            ((v101 - v100) * (1 - t1) + (v111 - v110) * t1) * t0
          : 0;
      }
    }
    for (let o = 0; o < 3; ++o) {
      out[3 * p + o] =
        V[o * 3] * u[0] + V[o * 3 + 1] * u[1] + V[o * 3 + 2] * u[2];
    }
    if (jacobian !== undefined) {
      // du_out/dp = V (du/dindex) A, A = linear part of outputToIndex.
      for (let o = 0; o < 3; ++o) {
        for (let q = 0; q < 3; ++q) {
          let sum = 0;
          for (let c = 0; c < 3; ++c) {
            const vc = V[o * 3 + c];
            if (vc === 0) continue;
            for (let a = 0; a < 3; ++a) {
              sum += vc * dd[c * 3 + a] * A[sd[a] * 4 + q];
            }
          }
          jacobian[9 * p + o * 3 + q] = sum;
        }
      }
    }
  }
  return { u: out, jacobian };
}
