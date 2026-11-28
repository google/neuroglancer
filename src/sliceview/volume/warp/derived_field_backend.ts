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
 * @file A derived displacement field, worker side (see `derived_field.ts`):
 * its chunks are computed from the stored field's chunks, which are requested
 * level by level as dependencies of the chunk being computed.
 */

import type { Chunk, ChunkManager } from "#src/chunk_manager/backend.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier } from "#src/chunk_manager/base.js";
import {
  computeChunkBounds,
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/backend.js";
import type { VolumeDependency } from "#src/sliceview/volume/warp/dependencies.js";
import {
  getDependencyData,
  volumeDependency,
  withDependencies,
} from "#src/sliceview/volume/warp/dependencies.js";
import type {
  DerivedFieldParameters,
  FetchFieldChunks,
} from "#src/sliceview/volume/warp/derived_field.js";
import {
  DERIVED_FIELD_DOMAIN_RPC_ID,
  DerivedFieldChunkSourceParameters,
  deriveFieldChunk,
  derivedFieldDomain,
} from "#src/sliceview/volume/warp/derived_field.js";
import type { vec3 } from "#src/util/geom.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerPromiseRPC, registerSharedObject } from "#src/worker_rpc.js";

class DerivedFieldChunk extends VolumeChunk {
  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initializeVolumeChunk(key, chunkGridPosition);
    // Computed from other chunks (see `WarpedVolumeChunk`).
    this.isComputational = true;
  }
}

/**
 * Fetches stored chunks as dependencies of `requester`, keeping every chunk
 * requested so far requested until the computation ends.
 */
function dependencyFetcher(
  stored: VolumeChunkSource[],
  setDependencies: (deps: VolumeDependency[]) => void,
  signal: AbortSignal,
): FetchFieldChunks {
  const all: VolumeDependency[] = [];
  return (level, grids) => {
    const deps = grids.map((g) => volumeDependency(stored[level], g));
    all.push(...deps);
    setDependencies(all.slice());
    return Promise.all(deps.map((d) => getDependencyData(d, signal)));
  };
}

@registerSharedObject()
export class DerivedFieldChunkSource extends WithParameters(
  VolumeChunkSource,
  DerivedFieldChunkSourceParameters,
) {
  stored: VolumeChunkSource[];

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    // Counted references (see the frontend's `DerivedFieldChunkSource`).
    this.stored = (options.storedRefs as { id: number; gen: number }[]).map(
      (ref) => this.registerDisposer(rpc.getRef<VolumeChunkSource>(ref)),
    );
  }

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    const origin = Array.from(computeChunkBounds(this, chunk as any));
    const size = Array.from(chunk.chunkDataSize!);
    const { derived: p, level, offset } = this.parameters;
    const S = p.spatialDims;
    const tLo = S.map((d, i) => origin[d] + offset[i]);
    const tSize = S.map((d) => size[d]);
    await withDependencies(
      this.chunkManager,
      chunk,
      [],
      async (setDependencies) => {
        const { components } = await deriveFieldChunk(
          p,
          level,
          tLo,
          tSize,
          dependencyFetcher(this.stored, setDependencies, signal),
        );
        // Chunk layout: Fortran order over the chunk dimensions.
        const rank = size.length;
        const strides = new Array<number>(rank);
        for (let d = 0, m = 1; d < rank; ++d) {
          strides[d] = m;
          m *= size[d];
        }
        const out = new Float32Array(size.reduce((a, b) => a * b, 1));
        const n = tSize[0] * tSize[1] * tSize[2];
        const vector0 = origin[p.vectorDim];
        const lowerComponent = p.levels[level].lowerVoxelBound[p.vectorDim];
        for (let v = 0; v < size[p.vectorDim]; ++v) {
          const c = vector0 + v - lowerComponent;
          let t = 0;
          for (let i2 = 0; i2 < tSize[2]; ++i2) {
            for (let i1 = 0; i1 < tSize[1]; ++i1) {
              let k =
                v * strides[p.vectorDim] +
                i1 * strides[S[1]] +
                i2 * strides[S[2]];
              for (let i0 = 0; i0 < tSize[0]; ++i0, ++t) {
                out[k] = components[c * n + t];
                k += strides[S[0]];
              }
            }
          }
        }
        chunk.data = out;
      },
    );
  }
}
DerivedFieldChunkSource.prototype.chunkConstructor = DerivedFieldChunk;

registerPromiseRPC(
  DERIVED_FIELD_DOMAIN_RPC_ID,
  async function (
    this: RPC,
    x: {
      chunkManager: number;
      derived: DerivedFieldParameters;
      sources: { id: number; gen: number }[];
    },
    { signal },
  ) {
    const chunkManager: ChunkManager = this.get(x.chunkManager);
    const stored = x.sources.map((ref) => this.getRef<VolumeChunkSource>(ref));
    // Not a chunk: its stored chunks are requested as visible ones.
    const requester = {
      newPriorityTier: ChunkPriorityTier.VISIBLE,
      newPriority: Number.MAX_SAFE_INTEGER - 1,
    } as Chunk;
    try {
      const value = await withDependencies(
        chunkManager,
        requester,
        [],
        (setDependencies) =>
          derivedFieldDomain(
            x.derived,
            dependencyFetcher(stored, setDependencies, signal!),
          ),
      );
      return { value };
    } finally {
      for (const s of stored) s.dispose();
    }
  },
);
