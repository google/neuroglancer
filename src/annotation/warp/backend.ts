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
 * @file Warped annotations, worker side (see `warp/base.ts`): every chunk is
 * computed from chunks of the moving annotation source (requested as
 * dependencies, so they are fetched once and cached), with the annotations'
 * points placed in the output space and inverse-warped.
 */

import type {
  AnnotationGeometryChunk,
  AnnotationMetadataChunk,
  AnnotationSubsetGeometryChunk,
} from "#src/annotation/backend.js";
import {
  AnnotationGeometryChunkSourceBackend,
  AnnotationGeometryData,
  AnnotationSource,
} from "#src/annotation/backend.js";
import type {
  Annotation,
  AnnotationPropertySerializer,
} from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  makeAnnotationPropertySerializers,
} from "#src/annotation/index.js";
import {
  WarpedAnnotationSourceParameters,
  WarpedAnnotationSpatialIndexParameters,
} from "#src/annotation/warp/base.js";
import type { WarpedAnnotation } from "#src/annotation/warp/geometry.js";
import {
  annotationPoints,
  deserializeAnnotations,
  rebuild,
} from "#src/annotation/warp/geometry.js";
import type { Chunk, ChunkSource } from "#src/chunk_manager/backend.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import {
  applyAffine3,
  inverse4,
  mul4,
  rowMajorFromColumnMajor,
  scale4,
  transformBox,
} from "#src/sliceview/volume/warp/affine.js";
import type { Dependency } from "#src/sliceview/volume/warp/dependencies.js";
import {
  objectDependency,
  volumeDependency,
  waitForDependency,
  withDependencies,
} from "#src/sliceview/volume/warp/dependencies.js";
import {
  displayedElsewhere,
  PointWarper,
} from "#src/sliceview/volume/warp/point_warp_backend.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

// At most this many moving cells feed one warped cell.
const MAX_MOVING_CELLS = 4096;
// Samples per axis of a warped cell, to find the moving cells it overlaps.
const CELL_SAMPLES = 4;

function serialize(
  annotations: Iterable<Annotation>,
  serializers: AnnotationPropertySerializer[],
): AnnotationGeometryData {
  const serializer = new AnnotationSerializer(serializers);
  for (const a of annotations) serializer.add(a);
  return Object.assign(new AnnotationGeometryData(), serializer.serialize());
}

@registerSharedObject()
export class WarpedAnnotationSourceBackend extends WithParameters(
  AnnotationSource,
  WarpedAnnotationSourceParameters,
) {
  moving: AnnotationSource;
  warper: PointWarper;
  propertySerializers: AnnotationPropertySerializer[];
  // Moved annotations of a moving chunk's data, once computed.
  private moved = new WeakMap<object, WarpedAnnotation[]>();

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const { parameters } = this;
    this.moving = rpc.get(parameters.annotationSource);
    this.warper = new PointWarper(rpc, parameters.warp);
    this.propertySerializers = makeAnnotationPropertySerializers(
      parameters.rank,
      parameters.properties,
    );
    // These chunks are computed from other chunks: they use the compute
    // queue, so waiting for their dependencies never blocks downloads.
    for (const source of [
      this.metadataChunkSource,
      ...this.segmentFilteredSources,
    ] as ChunkSource[]) {
      const getChunk = (source as any).getChunk.bind(source);
      (source as any).getChunk = (key: any) => {
        const chunk = getChunk(key) as Chunk;
        chunk.isComputational = true;
        return chunk;
      };
    }
  }

  /** Waits for chunks of the moving source, requested for `requester`. */
  async withDependencies<T>(
    requester: Chunk,
    deps: Dependency[],
    signal: AbortSignal,
    read: (chunk: Chunk) => T,
  ): Promise<T[]> {
    return withDependencies(this.chunkManager, requester, deps, () =>
      Promise.all(
        deps.map((dep) =>
          waitForDependency(dep, signal, read, () =>
            displayedElsewhere("annotations"),
          ),
        ),
      ),
    );
  }

  /** Moves annotations through the field. */
  async warpAnnotations(
    annotations: Annotation[],
    requester: Chunk,
    signal: AbortSignal,
  ): Promise<WarpedAnnotation[]> {
    const { storedToOutput } = this.parameters;
    const pointLists = annotations.map(annotationPoints);
    let n = 0;
    for (const points of pointLists) n += points.length;
    const flat = new Float64Array(3 * n);
    let k = 0;
    for (const points of pointLists) {
      for (const p of points) {
        flat[k++] = p[0];
        flat[k++] = p[1];
        flat[k++] = p[2];
      }
    }
    const moved = await this.warper.inverseWarp(
      this.chunkManager,
      requester,
      applyAffine3(storedToOutput, flat),
      signal,
    );
    k = 0;
    return annotations.map((a, i) => {
      const points = pointLists[i].map(() => {
        const p = Float32Array.of(moved[k], moved[k + 1], moved[k + 2]);
        k += 3;
        return p;
      });
      return rebuild(a, points, storedToOutput);
    });
  }

  /** The moved annotations of a moving chunk's data (cached). */
  async movedAnnotations(
    data: AnnotationGeometryData,
    requester: Chunk,
    signal: AbortSignal,
  ): Promise<WarpedAnnotation[]> {
    let moved = this.moved.get(data);
    if (moved === undefined) {
      moved = await this.warpAnnotations(
        deserializeAnnotations(data, this.propertySerializers),
        requester,
        signal,
      );
      this.moved.set(data, moved);
    }
    return moved;
  }

  async downloadMetadata(chunk: AnnotationMetadataChunk, signal: AbortSignal) {
    const id = chunk.key!;
    const source = this.moving.metadataChunkSource;
    const [annotation] = await this.withDependencies(
      chunk,
      [{ source, key: id, get: () => source.getChunk(id) }],
      signal,
      (c) => (c as AnnotationMetadataChunk).annotation,
    );
    if (annotation == null) {
      chunk.annotation = annotation;
      return;
    }
    const [moved] = await this.warpAnnotations([annotation], chunk, signal);
    chunk.annotation = moved.annotation;
  }

  async downloadSegmentFilteredGeometry(
    chunk: AnnotationSubsetGeometryChunk,
    relationshipIndex: number,
    signal: AbortSignal,
  ) {
    const source = this.moving.segmentFilteredSources[relationshipIndex];
    const { objectId } = chunk;
    const [data] = await this.withDependencies(
      chunk,
      [objectDependency(source, objectId)],
      signal,
      (c) => (c as AnnotationSubsetGeometryChunk).data,
    );
    if (data === undefined) return;
    const moved = await this.movedAnnotations(data, chunk, signal);
    chunk.data = serialize(
      moved.map((m) => m.annotation),
      this.propertySerializers,
    );
  }
}

@registerSharedObject()
export class WarpedAnnotationSpatialIndexSourceBackend extends WithParameters(
  AnnotationGeometryChunkSourceBackend,
  WarpedAnnotationSpatialIndexParameters,
) {
  declare parent: WarpedAnnotationSourceBackend;
  moving: AnnotationGeometryChunkSourceBackend;
  // Warped cell coordinates -> output, and back (row-major 4x4). The warped
  // grid is the moving grid placed in the output space, so `outputToCell`
  // also gives the moving cell of a point of the moving source placed there.
  cellToOutput: number[];
  outputToCell: number[];

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const { parameters, spec } = this;
    this.moving = rpc.get(parameters.chunkSource);
    const { storedToOutput } = this.parent.parameters;
    // Moving cell coordinates -> stored coordinates.
    const cellToStored = mul4(
      rowMajorFromColumnMajor(parameters.movingChunkToMultiscale, 3),
      scale4(spec.chunkDataSize),
    );
    this.cellToOutput = mul4(storedToOutput, cellToStored);
    this.outputToCell = inverse4(this.cellToOutput);
  }

  getChunk(chunkGridPosition: Float32Array) {
    const chunk = super.getChunk(chunkGridPosition);
    chunk.isComputational = true;
    return chunk;
  }

  /** The moving cells (same level) that a warped cell overlaps. */
  private async movingCells(
    chunk: AnnotationGeometryChunk,
    signal: AbortSignal,
  ): Promise<Float32Array[]> {
    const c = chunk.chunkGridPosition;
    const s = CELL_SAMPLES;
    const samples: number[] = [];
    for (let i = 0; i < s; ++i) {
      for (let j = 0; j < s; ++j) {
        for (let k = 0; k < s; ++k) {
          samples.push(
            c[0] + i / (s - 1),
            c[1] + j / (s - 1),
            c[2] + k / (s - 1),
          );
        }
      }
    }
    // x + u(x): where the moving data is pulled from.
    const pulled = await this.parent.warper.forward(
      this.chunkManager,
      chunk,
      applyAffine3(this.cellToOutput, samples),
      signal,
    );
    // Their bounds, widened by the field's interpolation error, in moving
    // cell coordinates.
    const { boundsError } = this.parent.parameters.warp;
    const oLo = [Infinity, Infinity, Infinity];
    const oHi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < pulled.length; v += 3) {
      for (let i = 0; i < 3; ++i) {
        oLo[i] = Math.min(oLo[i], pulled[v + i] - boundsError);
        oHi[i] = Math.max(oHi[i], pulled[v + i] + boundsError);
      }
    }
    const [cLo, cHi] = transformBox(this.outputToCell, 3, 3, oLo, oHi);
    const { lowerChunkBound, upperChunkBound } = this.moving.spec;
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    for (let i = 0; i < 3; ++i) {
      // Half a cell of margin: the warp between samples.
      lo[i] = Math.max(lowerChunkBound[i], Math.floor(cLo[i] - 0.5));
      hi[i] = Math.min(upperChunkBound[i] - 1, Math.floor(cHi[i] + 0.5));
      if (!(lo[i] <= hi[i])) return [];
    }
    const count =
      (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (count > MAX_MOVING_CELLS) {
      throw new Error(
        `warp: an annotation cell overlaps ${count} moving cells (at most ` +
          `${MAX_MOVING_CELLS})`,
      );
    }
    const out: Float32Array[] = [];
    for (let x = lo[0]; x <= hi[0]; ++x) {
      for (let y = lo[1]; y <= hi[1]; ++y) {
        for (let z = lo[2]; z <= hi[2]; ++z) out.push(Float32Array.of(x, y, z));
      }
    }
    return out;
  }

  /** Whether output bounds intersect the warped cell `c`. */
  private intersects(lo: number[], hi: number[], c: Float32Array) {
    const [cLo, cHi] = transformBox(this.outputToCell, 3, 3, lo, hi);
    for (let i = 0; i < 3; ++i) {
      if (cHi[i] < c[i] || cLo[i] >= c[i] + 1) return false;
    }
    return true;
  }

  async download(chunk: AnnotationGeometryChunk, signal: AbortSignal) {
    const { parent, moving } = this;
    const cells = await this.movingCells(chunk, signal);
    const deps = cells.map((p) => volumeDependency(moving, p));
    const data = await parent.withDependencies(
      chunk,
      deps,
      signal,
      (c) => (c as AnnotationGeometryChunk).data,
    );
    const kept = new Map<string, Annotation>();
    for (const d of data) {
      if (d === undefined) continue;
      for (const m of await parent.movedAnnotations(d, chunk, signal)) {
        const { id } = m.annotation;
        if (kept.has(id)) continue;
        if (this.intersects(m.lo, m.hi, chunk.chunkGridPosition)) {
          kept.set(id, m.annotation);
        }
      }
    }
    if (kept.size === 0) return;
    chunk.data = serialize(kept.values(), parent.propertySerializers);
  }
}
