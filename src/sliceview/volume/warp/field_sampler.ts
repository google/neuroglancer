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
import type { ZarrArrayAccess } from "#src/sliceview/volume/warp/base.js";
import type { VolumeDependency } from "#src/sliceview/volume/warp/dependencies.js";
import {
  getDependencyData,
  getDependencyRequests,
  volumeDependency,
} from "#src/sliceview/volume/warp/dependencies.js";

export interface FieldLevelAccess {
  array: ZarrArrayAccess;
  // Array axis that holds the vector components.
  vectorAxis: number;
  // output coordinates -> field index (row-major 4x4).
  outputToIndex: number[];
  // vector components -> displacement in output coordinates (row-major 3x3).
  vectorToOutput: number[];
}

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
 * axes.
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
  const { array, vectorAxis, outputToIndex: A, vectorToOutput: V } = access;
  const rank = array.shape.length;
  const spatialAxes = [...Array(rank).keys()].filter((a) => a !== vectorAxis);
  const shape = spatialAxes.map((a) => array.shape[a]);
  const cshape = spatialAxes.map((a) => array.chunkShape[a]);
  const grid = shape.map((n, i) => Math.ceil(n / cshape[i]));
  const n = points.length / 3;
  const base = new Int32Array(3 * n);
  const frac = new Float32Array(3 * n);
  // 1 where the axis is interpolated, 0 where clamped (no derivative).
  const inside = new Uint8Array(3 * n);
  const needed = new Set<number>();
  const chunkKey = (g0: number, g1: number, g2: number) =>
    (g0 * grid[1] + g1) * grid[2] + g2;
  for (let p = 0; p < n; ++p) {
    const x = points[3 * p];
    const y = points[3 * p + 1];
    const z = points[3 * p + 2];
    const corner: number[][] = [];
    for (let a = 0; a < 3; ++a) {
      const f0 =
        A[a * 4] * x + A[a * 4 + 1] * y + A[a * 4 + 2] * z + A[a * 4 + 3];
      const f = Math.min(Math.max(f0, 0), shape[a] - 1);
      inside[3 * p + a] = f === f0 && shape[a] > 1 ? 1 : 0;
      let i = Math.floor(f);
      if (i > shape[a] - 2) i = Math.max(shape[a] - 2, 0);
      base[3 * p + a] = i;
      frac[3 * p + a] = f - i;
      const hi = Math.min(i + 1, shape[a] - 1);
      const g0 = Math.floor(i / cshape[a]);
      const g1 = Math.floor(hi / cshape[a]);
      corner.push(g0 === g1 ? [g0] : [g0, g1]);
    }
    for (const g0 of corner[0]) {
      for (const g1 of corner[1]) {
        for (const g2 of corner[2]) needed.add(chunkKey(g0, g1, g2));
      }
    }
  }
  // Field chunks, as dependencies of `requester`.
  const keys = [...needed];
  const deps: VolumeDependency[] = keys.map((k) => {
    const g = [
      Math.floor(k / (grid[1] * grid[2])),
      Math.floor(k / grid[2]) % grid[1],
      k % grid[2],
    ];
    const zarrIndex = new Array<number>(rank);
    spatialAxes.forEach((a, i) => {
      zarrIndex[a] = g[i];
    });
    zarrIndex[vectorAxis] = 0;
    // Neuroglancer's zarr chunk dimension d is zarr dimension rank - 1 - d.
    return volumeDependency(source, zarrIndex.slice().reverse());
  });
  const requests = getDependencyRequests(chunkManager);
  const request = requests.add(requester, deps);
  let data: (ArrayLike<number> | null)[];
  try {
    data = await Promise.all(deps.map((d) => getDependencyData(d, signal)));
  } finally {
    requests.remove(request);
  }
  const chunks = new Map<number, ArrayLike<number> | null>();
  keys.forEach((k, i) => chunks.set(k, data[i]));
  // C-order strides of a field chunk: spatial strides and the component stride.
  const strides = new Array<number>(rank).fill(1);
  for (let a = rank - 2; a >= 0; --a) {
    strides[a] = strides[a + 1] * array.chunkShape[a + 1];
  }
  const s = spatialAxes.map((a) => strides[a]);
  const sc = strides[vectorAxis];
  const value = (c: number, i0: number, i1: number, i2: number) => {
    const g0 = Math.floor(i0 / cshape[0]);
    const g1 = Math.floor(i1 / cshape[1]);
    const g2 = Math.floor(i2 / cshape[2]);
    const d = chunks.get(chunkKey(g0, g1, g2));
    if (d == null) return 0;
    return d[
      c * sc +
        (i0 - g0 * cshape[0]) * s[0] +
        (i1 - g1 * cshape[1]) * s[1] +
        (i2 - g2 * cshape[2]) * s[2]
    ];
  };
  const out = new Float64Array(3 * n);
  const jacobian = withJacobian ? new Float64Array(9 * n) : undefined;
  const u = [0, 0, 0];
  // du_c / d(index axis a), row-major 3x3.
  const d = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let p = 0; p < n; ++p) {
    const i0 = base[3 * p];
    const i1 = base[3 * p + 1];
    const i2 = base[3 * p + 2];
    const j0 = Math.min(i0 + 1, shape[0] - 1);
    const j1 = Math.min(i1 + 1, shape[1] - 1);
    const j2 = Math.min(i2 + 1, shape[2] - 1);
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
        d[c * 3] = inside[3 * p] ? hi - lo : 0;
        d[c * 3 + 1] = inside[3 * p + 1]
          ? (c01 - c00) * (1 - t0) + (c11 - c10) * t0
          : 0;
        d[c * 3 + 2] = inside[3 * p + 2]
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
              sum += vc * d[c * 3 + a] * A[a * 4 + q];
            }
          }
          jacobian[9 * p + o * 3 + q] = sum;
        }
      }
    }
  }
  return { u: out, jacobian };
}
