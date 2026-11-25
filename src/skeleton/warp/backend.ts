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
 * @file Warped skeletons, worker side: each object's skeleton is computed
 * from the moving source's skeleton of that object (requested as a
 * dependency, so it is fetched once and cached), with its vertices placed in
 * the output space and inverse-warped.
 */

import { WithParameters } from "#src/chunk_manager/backend.js";
import type { SkeletonChunk } from "#src/skeleton/backend.js";
import { SkeletonSource } from "#src/skeleton/backend.js";
import { WarpedSkeletonSourceParameters } from "#src/skeleton/warp/base.js";
import { applyAffine3 } from "#src/sliceview/volume/warp/affine.js";
import {
  objectDependency,
  waitForDependency,
  withDependencies,
} from "#src/sliceview/volume/warp/dependencies.js";
import {
  displayedElsewhere,
  PointWarper,
} from "#src/sliceview/volume/warp/point_warp_backend.js";
import type { TypedNumberArray } from "#src/util/array.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

interface SkeletonData {
  vertexPositions: Float32Array;
  indices: Uint32Array;
  vertexAttributes: TypedNumberArray[] | null;
}

@registerSharedObject()
export class WarpedSkeletonSource extends WithParameters(
  SkeletonSource,
  WarpedSkeletonSourceParameters,
) {
  underlying: SkeletonSource;
  warper: PointWarper;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const { parameters } = this;
    this.underlying = rpc.get(parameters.skeletonSource);
    this.warper = new PointWarper(rpc, parameters.warp);
  }

  // Computed from other chunks: they use the compute queue, so waiting for
  // their dependencies never blocks downloads.
  getChunk(objectId: bigint) {
    const chunk = super.getChunk(objectId);
    chunk.isComputational = true;
    return chunk;
  }

  async download(chunk: SkeletonChunk, signal: AbortSignal) {
    const dep = objectDependency(this.underlying, chunk.objectId);
    // Copied: the moving chunk may be freed while this one is computed.
    const data = await withDependencies(this.chunkManager, chunk, [dep], () =>
      waitForDependency<SkeletonData>(
        dep,
        signal,
        (c) => {
          const s = c as SkeletonChunk;
          return {
            vertexPositions: s.vertexPositions!.slice(),
            indices: s.indices!.slice(),
            vertexAttributes: s.vertexAttributes?.map((a) => a.slice()) ?? null,
          };
        },
        () => displayedElsewhere("skeleton"),
      ),
    );
    const v = applyAffine3(
      this.parameters.storedToOutput,
      data.vertexPositions,
    );
    const p = await this.warper.inverseWarp(
      this.chunkManager,
      chunk,
      v,
      signal,
    );
    chunk.vertexPositions = Float32Array.from(p);
    chunk.indices = data.indices;
    chunk.vertexAttributes = data.vertexAttributes;
  }
}
