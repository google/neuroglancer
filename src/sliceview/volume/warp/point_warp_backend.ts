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
 * @file Moving points through a displacement field, worker side (see
 * `point_warp.ts`).
 */

import type { Chunk, ChunkManager } from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier } from "#src/chunk_manager/base.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { sampleDisplacements } from "#src/sliceview/volume/warp/field_sampler.js";
import type { PointWarpParameters } from "#src/sliceview/volume/warp/point_warp.js";
import { INVERSE_WARP_POINTS_RPC_ID } from "#src/sliceview/volume/warp/point_warp.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerPromiseRPC } from "#src/worker_rpc.js";

/** Error for a dependency that another layer has moved to the frontend. */
export function displayedElsewhere(what: string): Promise<never> {
  return Promise.reject(
    new Error(
      `warp: the unwarped ${what} is also displayed by another layer; ` +
        "its data is not available to the warp",
    ),
  );
}

export class PointWarper {
  coarseField: VolumeChunkSource;
  fineField: VolumeChunkSource;
  boundsField: VolumeChunkSource;

  constructor(
    rpc: RPC,
    public parameters: PointWarpParameters,
  ) {
    this.coarseField = rpc.get(parameters.coarse.source);
    this.fineField = rpc.get(parameters.fine.source);
    this.boundsField = rpc.get(parameters.bounds.source);
  }

  /**
   * The points p (output coordinates, x y z interleaved) with p + u(p) = v.
   * The field chunks needed are requested as dependencies of `requester`.
   *
   * Without the inverse field, Newton's method, (I + du/dp) dp = v - p - u(p):
   * first on a coarse field level, to get every point close, then on a fine
   * one. Each phase stops when the largest step is below the tolerance.
   */
  async inverseWarp(
    chunkManager: ChunkManager,
    requester: Chunk,
    v: Float64Array,
    signal: AbortSignal,
  ): Promise<Float64Array> {
    const { parameters } = this;
    if (v.length === 0) return v.slice();
    if (parameters.direct) {
      const { u } = await sampleDisplacements(
        chunkManager,
        requester,
        this.fineField,
        parameters.fine,
        v,
        signal,
      );
      for (let i = 0; i < u.length; ++i) u[i] += v[i];
      return u;
    }
    const p = v.slice();
    const n = p.length / 3;
    const phases: [VolumeChunkSource, typeof parameters.coarse, number][] = [
      [this.coarseField, parameters.coarse, parameters.coarseIterations],
      [this.fineField, parameters.fine, parameters.fineIterations],
    ];
    const { tolerance } = parameters;
    for (const [source, access, maxIterations] of phases) {
      for (let it = 0; it < maxIterations; ++it) {
        const { u, jacobian } = await sampleDisplacements(
          chunkManager,
          requester,
          source,
          access,
          p,
          signal,
          true,
        );
        const J = jacobian!;
        let maxStep = 0;
        for (let k = 0; k < n; ++k) {
          const r0 = v[3 * k] - p[3 * k] - u[3 * k];
          const r1 = v[3 * k + 1] - p[3 * k + 1] - u[3 * k + 1];
          const r2 = v[3 * k + 2] - p[3 * k + 2] - u[3 * k + 2];
          // Solve (I + J) s = r by Cramer's rule.
          const j = 9 * k;
          const a = 1 + J[j];
          const b = J[j + 1];
          const c = J[j + 2];
          const d = J[j + 3];
          const e = 1 + J[j + 4];
          const f = J[j + 5];
          const g = J[j + 6];
          const h = J[j + 7];
          const i = 1 + J[j + 8];
          const det =
            a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
          let s0 = r0;
          let s1 = r1;
          let s2 = r2;
          // A degenerate (folded) cell falls back to a fixed-point step.
          if (Math.abs(det) > 1e-6) {
            s0 =
              (r0 * (e * i - f * h) -
                b * (r1 * i - f * r2) +
                c * (r1 * h - e * r2)) /
              det;
            s1 =
              (a * (r1 * i - f * r2) -
                r0 * (d * i - f * g) +
                c * (d * r2 - r1 * g)) /
              det;
            s2 =
              (a * (e * r2 - r1 * h) -
                b * (d * r2 - r1 * g) +
                r0 * (d * h - e * g)) /
              det;
          }
          p[3 * k] += s0;
          p[3 * k + 1] += s1;
          p[3 * k + 2] += s2;
          maxStep = Math.max(maxStep, Math.abs(s0), Math.abs(s1), Math.abs(s2));
        }
        if (maxStep < tolerance) break;
      }
    }
    return p;
  }

  /**
   * Where the data shown at `x` (output coordinates) is pulled from, x + u(x),
   * within `parameters.boundsError`.
   */
  async forward(
    chunkManager: ChunkManager,
    requester: Chunk,
    x: Float64Array,
    signal: AbortSignal,
  ): Promise<Float64Array> {
    const { u } = await sampleDisplacements(
      chunkManager,
      requester,
      this.boundsField,
      this.parameters.bounds,
      x,
      signal,
    );
    for (let i = 0; i < u.length; ++i) u[i] += x[i];
    return u;
  }
}

registerPromiseRPC(
  INVERSE_WARP_POINTS_RPC_ID,
  async function (
    this: RPC,
    x: { chunkManager: number; warp: PointWarpParameters; points: number[] },
    { signal },
  ) {
    const chunkManager: ChunkManager = this.get(x.chunkManager);
    const warper = new PointWarper(this, x.warp);
    // Not a chunk: its field chunks are requested as visible ones.
    const requester = {
      newPriorityTier: ChunkPriorityTier.VISIBLE,
      newPriority: Number.MAX_SAFE_INTEGER - 1,
    } as Chunk;
    const p = await warper.inverseWarp(
      chunkManager,
      requester,
      Float64Array.from(x.points),
      signal!,
    );
    return { value: Array.from(p) };
  },
);
