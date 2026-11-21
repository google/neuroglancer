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
 * @file Warped meshes, worker side. A single-resolution mesh source whose
 * manifests and fragments are computed from those of a multiscale mesh source
 * (requested as dependencies, so they are fetched once and cached): one level
 * of detail is dequantized, placed in the output space and inverse-warped.
 */

import { WithParameters } from "#src/chunk_manager/backend.js";
import type {
  FragmentChunk,
  ManifestChunk,
  MultiscaleFragmentChunk,
  MultiscaleManifestChunk,
  MultiscaleMeshSource,
} from "#src/mesh/backend.js";
import { MeshSource } from "#src/mesh/backend.js";
import type { EncodedMeshData } from "#src/mesh/base.js";
import { VertexPositionFormat } from "#src/mesh/base.js";
import type { MultiscaleMeshManifest } from "#src/mesh/multiscale.js";
import { WarpedMeshSourceParameters } from "#src/mesh/warp/base.js";
import { getObjectKey } from "#src/segmentation_display_state/base.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import type { Dependency } from "#src/sliceview/volume/warp/dependencies.js";
import {
  getDependencyRequests,
  waitForDependency,
} from "#src/sliceview/volume/warp/dependencies.js";
import { sampleDisplacements } from "#src/sliceview/volume/warp/field_sampler.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

function displayedElsewhere(): Promise<never> {
  return Promise.reject(
    new Error(
      "warp: the unwarped mesh is also displayed by another layer; " +
        "its data is not available to the warp",
    ),
  );
}

/** Octree rows of one level of detail, excluding empty nodes. */
function rowsAtLod(manifest: MultiscaleMeshManifest, lod: number): number[] {
  const { octree, lodScales } = manifest;
  const numRows = octree.length / 5;
  let level = [numRows - 1];
  for (let l = lodScales.length - 1; l > lod; --l) {
    const next: number[] = [];
    for (const r of level) {
      const begin = octree[5 * r + 3];
      const end = octree[5 * r + 4] & 0x7fffffff;
      for (let c = begin; c < end; ++c) next.push(c);
    }
    level = next;
  }
  return level.filter((r) => (octree[5 * r + 4] & 0x80000000) === 0);
}

/** The finest stored level of detail at or above `lod`. */
function storedLod(manifest: MultiscaleMeshManifest, lod: number) {
  const { lodScales } = manifest;
  let l = Math.min(lod, lodScales.length - 1);
  while (l > 0 && lodScales[l] === 0) --l;
  return l;
}

@registerSharedObject()
export class WarpedMeshSource extends WithParameters(
  MeshSource,
  WarpedMeshSourceParameters,
) {
  underlying: MultiscaleMeshSource;
  coarseField: VolumeChunkSource;
  fineField: VolumeChunkSource;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const { parameters } = this;
    this.underlying = rpc.get(parameters.meshSource);
    this.coarseField = rpc.get(parameters.coarse.array.source);
    this.fineField = rpc.get(parameters.fine.array.source);
  }

  // Computed from other chunks: they use the compute queue, so waiting for
  // their dependencies never blocks downloads.
  getChunk(objectId: bigint) {
    const chunk = super.getChunk(objectId);
    chunk.isComputational = true;
    return chunk;
  }

  getFragmentChunk(manifestChunk: ManifestChunk, fragmentId: string) {
    const chunk = super.getFragmentChunk(manifestChunk, fragmentId);
    chunk.isComputational = true;
    return chunk;
  }

  private manifestDependency(objectId: bigint): Dependency {
    const { underlying } = this;
    return {
      source: underlying,
      key: getObjectKey(objectId),
      get: () => underlying.getChunk(objectId),
    };
  }

  private async withDependencies<T>(
    requester: ManifestChunk | FragmentChunk,
    deps: Dependency[],
    body: () => Promise<T>,
  ): Promise<T> {
    const requests = getDependencyRequests(this.chunkManager);
    const request = requests.add(requester, deps);
    try {
      return await body();
    } finally {
      requests.remove(request);
    }
  }

  private getManifest(dep: Dependency, signal: AbortSignal) {
    return waitForDependency(
      dep,
      signal,
      (chunk) => (chunk as MultiscaleManifestChunk).manifest!,
      displayedElsewhere,
    );
  }

  async download(chunk: ManifestChunk, signal: AbortSignal) {
    const dep = this.manifestDependency(chunk.objectId);
    const manifest = await this.withDependencies(chunk, [dep], () =>
      this.getManifest(dep, signal),
    );
    const lod = storedLod(manifest, this.parameters.lod);
    chunk.fragmentIds = rowsAtLod(manifest, lod).map(String);
  }

  async downloadFragment(chunk: FragmentChunk, signal: AbortSignal) {
    const { underlying, parameters } = this;
    const objectId = chunk.manifestChunk!.objectId;
    const row = Number(chunk.fragmentId);
    const manifestDep = this.manifestDependency(objectId);
    const { manifest, meshData } = await this.withDependencies(
      chunk,
      [manifestDep],
      async () => {
        const manifest = await this.getManifest(manifestDep, signal);
        const lod = storedLod(manifest, parameters.lod);
        const fragmentDep: Dependency = {
          source: underlying.fragmentSource,
          key: `${getObjectKey(objectId)}/${lod}:${row}`,
          get: () =>
            underlying.getFragmentChunk(
              underlying.getChunk(objectId),
              lod,
              row,
            ),
        };
        const requests = getDependencyRequests(this.chunkManager);
        const request = requests.add(chunk, [manifestDep, fragmentDep]);
        try {
          const meshData = await waitForDependency(
            fragmentDep,
            signal,
            (c) => (c as MultiscaleFragmentChunk).meshData!,
            displayedElsewhere,
          );
          return { manifest, meshData };
        } finally {
          requests.remove(request);
        }
      },
    );
    const lod = storedLod(manifest, parameters.lod);
    const v = this.placeVertices(manifest, lod, row, meshData);
    const p = await this.inverseWarp(chunk, v, signal);
    chunk.meshData = {
      vertexPositions: Float32Array.from(p),
      // The warp is smooth; the original normals are kept.
      vertexNormals: meshData.vertexNormals.slice(),
      indices: meshData.indices.slice(),
      strips: meshData.strips,
    };
  }

  /** Vertices of a fragment, dequantized and in output coordinates. */
  private placeVertices(
    manifest: MultiscaleMeshManifest,
    lod: number,
    row: number,
    meshData: EncodedMeshData,
  ): Float64Array {
    const { format, storedToOutput: M } = this.parameters;
    const { octree, chunkShape, chunkGridSpatialOrigin, vertexOffsets } =
      manifest;
    const scale = 1 << lod;
    const origin = [0, 1, 2].map(
      (i) =>
        chunkGridSpatialOrigin[i] +
        octree[5 * row + i] * chunkShape[i] * scale +
        vertexOffsets[lod * 3 + i],
    );
    const shape = [0, 1, 2].map((i) => chunkShape[i] * scale);
    const positions = meshData.vertexPositions;
    const relative = format.fragmentRelativeVertices;
    let numVertices: number;
    let read: (v: number, i: number) => number;
    switch (format.vertexPositionFormat) {
      case VertexPositionFormat.uint10:
        numVertices = positions.length;
        read = (v, i) => ((positions[v] >>> (10 * i)) & 1023) / 1023;
        break;
      case VertexPositionFormat.uint16:
        numVertices = positions.length / 3;
        read = (v, i) => positions[3 * v + i] / 65535;
        break;
      default:
        numVertices = positions.length / 3;
        read = (v, i) => positions[3 * v + i];
    }
    const out = new Float64Array(3 * numVertices);
    const s = [0, 0, 0];
    for (let v = 0; v < numVertices; ++v) {
      for (let i = 0; i < 3; ++i) {
        s[i] = relative ? origin[i] + shape[i] * read(v, i) : read(v, i);
      }
      for (let o = 0; o < 3; ++o) {
        out[3 * v + o] =
          M[o * 4] * s[0] +
          M[o * 4 + 1] * s[1] +
          M[o * 4 + 2] * s[2] +
          M[o * 4 + 3];
      }
    }
    return out;
  }

  /**
   * Solves p + u(p) = v for every vertex by Newton's method,
   * (I + du/dp) dp = v - p - u(p): first on a coarse field level, to get every
   * vertex close, then on a fine one. Each phase stops when the largest step
   * is below the tolerance.
   */
  private async inverseWarp(
    requester: FragmentChunk,
    v: Float64Array,
    signal: AbortSignal,
  ): Promise<Float64Array> {
    const { parameters, chunkManager } = this;
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
}
