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
 * @file Worker side of warped volumes.
 *
 * A warped chunk is a computational chunk: it is never downloaded, it is
 * computed from chunks of other sources (the displacement field, its block
 * bounds, and the moving volume). Those dependencies are ordinary chunks of
 * their own sources, requested through the chunk manager and kept in worker
 * memory (`SYSTEM_MEMORY_WORKER`), so:
 *  - they are fetched once and shared by every warped chunk that needs them;
 *  - they are prioritized like the warped chunk that is waiting for them;
 *  - they stay cached (and are evicted) under the normal memory limits.
 */

import { WithParameters } from "#src/chunk_manager/backend.js";
import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import { DataType } from "#src/sliceview/base.js";
import {
  computeChunkBounds,
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/backend.js";
import type { ZarrArrayAccess } from "#src/sliceview/volume/warp/base.js";
import {
  WarpedVolumeChunkSourceParameters,
  WarpInterpolation,
} from "#src/sliceview/volume/warp/base.js";
import type {
  ChunkData,
  Dependency,
  VolumeDependency,
} from "#src/sliceview/volume/warp/dependencies.js";
import {
  getDependencyData,
  getDependencyRequests,
  isAvailable,
  volumeDependency,
} from "#src/sliceview/volume/warp/dependencies.js";
import { DATA_TYPE_ARRAY_CONSTRUCTOR } from "#src/util/data_type.js";
import type { vec3 } from "#src/util/geom.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

// Fetch moving chunks from the block bounds while the field is still loading.
const PREFETCH_FROM_BOUNDS = false;

// --- Small linear algebra on row-major matrices.

function apply4(m: number[], x: number, y: number, z: number, out: number[]) {
  out[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
}

/** Bounding box of an axis-aligned box [lo, hi] mapped through `m`. */
function transformBox(
  m: number[],
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
): [number[], number[]] {
  const outLo = [Infinity, Infinity, Infinity];
  const outHi = [-Infinity, -Infinity, -Infinity];
  const p = [0, 0, 0];
  for (let c = 0; c < 8; ++c) {
    apply4(
      m,
      c & 1 ? hi[0] : lo[0],
      c & 2 ? hi[1] : lo[1],
      c & 4 ? hi[2] : lo[2],
      p,
    );
    for (let i = 0; i < 3; ++i) {
      outLo[i] = Math.min(outLo[i], p[i]);
      outHi[i] = Math.max(outHi[i], p[i]);
    }
  }
  return [outLo, outHi];
}

// --- Zarr arrays read through volume chunk sources.

/**
 * Chunk-source grid positions covering the zarr index box [lo, hi] (inclusive,
 * zarr order). Neuroglancer's zarr chunk dimension d is zarr dimension
 * rank - 1 - d.
 */
function zarrChunksInBox(
  source: VolumeChunkSource,
  access: ZarrArrayAccess,
  lo: number[],
  hi: number[],
): { dep: VolumeDependency; grid: number[] }[] {
  const rank = access.shape.length;
  const gLo = lo.map((v, a) => Math.floor(v / access.chunkShape[a]));
  const gHi = hi.map((v, a) => Math.floor(v / access.chunkShape[a]));
  const out: { dep: VolumeDependency; grid: number[] }[] = [];
  const g = gLo.slice();
  while (true) {
    const position = new Array<number>(rank);
    for (let a = 0; a < rank; ++a) position[rank - 1 - a] = g[a];
    out.push({ dep: volumeDependency(source, position), grid: g.slice() });
    let a = rank - 1;
    while (a >= 0) {
      if (++g[a] <= gHi[a]) break;
      g[a] = gLo[a];
      --a;
    }
    if (a < 0) return out;
  }
}

function cStrides(shape: number[]) {
  const s = new Array<number>(shape.length).fill(1);
  for (let i = shape.length - 2; i >= 0; --i) s[i] = s[i + 1] * shape[i + 1];
  return s;
}

/**
 * Copies the zarr index box [lo, hi] (inclusive) of an array whose chunks
 * have been fetched into a dense C-order Float32Array; missing chunks are 0.
 */
function assembleZarrBox(
  access: ZarrArrayAccess,
  chunks: { grid: number[] }[],
  data: ChunkData[],
  lo: number[],
  hi: number[],
): Float32Array {
  const rank = lo.length;
  const extent = lo.map((l, a) => hi[a] - l + 1);
  const outStrides = cStrides(extent);
  const out = new Float32Array(extent.reduce((a, b) => a * b, 1));
  const { chunkShape } = access;
  const chunkStrides = cStrides(chunkShape);
  chunks.forEach(({ grid }, ci) => {
    const d = data[ci];
    if (d === null) return;
    // Intersection of the chunk with the box, in zarr indices.
    const cLo = new Array<number>(rank);
    const cHi = new Array<number>(rank);
    for (let a = 0; a < rank; ++a) {
      const start = grid[a] * chunkShape[a];
      cLo[a] = Math.max(lo[a], start);
      cHi[a] = Math.min(hi[a], start + chunkShape[a] - 1);
      if (cLo[a] > cHi[a]) return;
    }
    const idx = cLo.slice();
    const last = rank - 1;
    const n = cHi[last] - cLo[last] + 1;
    while (true) {
      let src = 0;
      let dst = 0;
      for (let a = 0; a < rank; ++a) {
        src += (idx[a] - grid[a] * chunkShape[a]) * chunkStrides[a];
        dst += (idx[a] - lo[a]) * outStrides[a];
      }
      for (let k = 0; k < n; ++k) out[dst + k] = d[src + k];
      let a = last - 1;
      while (a >= 0) {
        if (++idx[a] <= cHi[a]) break;
        idx[a] = cLo[a];
        --a;
      }
      if (a < 0) break;
    }
  });
  return out;
}

// --- Compressed segmentation.

/**
 * Decodes the box [lo, hi] (inclusive, chunk-local voxels) of a single-channel
 * compressed-segmentation chunk of `size` (as held in worker memory: a channel
 * offset table, then per-block headers, lookup tables and packed indices),
 * writing voxel (x, y, z) to out[(x + ox) + rx * ((y + oy) + ry * (z + oz))].
 * Only the blocks that overlap the box are decoded.
 */
function decodeCompressedSegmentationBox(
  data: Uint32Array,
  size: number[],
  blockSize: ArrayLike<number>,
  uint64: boolean,
  lo: number[],
  hi: number[],
  out: Uint32Array | BigUint64Array,
  offset: number[],
  rx: number,
  ry: number,
) {
  const [bx, by, bz] = [blockSize[0], blockSize[1], blockSize[2]];
  const gx = Math.ceil(size[0] / bx);
  const gy = Math.ceil(size[1] / by);
  const base = data[0];
  const per = uint64 ? 2 : 1;
  const [ox, oy, oz] = offset;
  for (let kz = Math.floor(lo[2] / bz); kz <= Math.floor(hi[2] / bz); ++kz) {
    for (let ky = Math.floor(lo[1] / by); ky <= Math.floor(hi[1] / by); ++ky) {
      for (
        let kx = Math.floor(lo[0] / bx);
        kx <= Math.floor(hi[0] / bx);
        ++kx
      ) {
        const h = base + ((kz * gy + ky) * gx + kx) * 2;
        const table = base + (data[h] & 0xffffff);
        const bits = data[h] >>> 24;
        const values = base + data[h + 1];
        const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
        const x0 = Math.max(kx * bx, lo[0]);
        const y0 = Math.max(ky * by, lo[1]);
        const z0 = Math.max(kz * bz, lo[2]);
        const x1 = Math.min((kx + 1) * bx - 1, hi[0]);
        const y1 = Math.min((ky + 1) * by - 1, hi[1]);
        const z1 = Math.min((kz + 1) * bz - 1, hi[2]);
        for (let z = z0; z <= z1; ++z) {
          for (let y = y0; y <= y1; ++y) {
            let o = x0 + ox + rx * (y + oy + ry * (z + oz));
            let i = x0 - kx * bx + bx * (y - ky * by + by * (z - kz * bz));
            for (let x = x0; x <= x1; ++x, ++o, ++i) {
              let index = 0;
              if (bits !== 0) {
                const bit = i * bits;
                index = (data[values + (bit >>> 5)] >>> (bit & 31)) & mask;
              }
              const t = table + per * index;
              if (uint64) {
                (out as BigUint64Array)[o] =
                  BigInt(data[t]) | (BigInt(data[t + 1]) << 32n);
              } else {
                (out as Uint32Array)[o] = data[t];
              }
            }
          }
        }
      }
    }
  }
}

// --- The warped chunk source.

class WarpedVolumeChunk extends VolumeChunk {
  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initializeVolumeChunk(key, chunkGridPosition);
    // Computed from other chunks, so it uses the compute queue rather than a
    // download slot: waiting warped chunks never block their dependencies.
    this.isComputational = true;
  }
}

@registerSharedObject()
export class WarpedVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  WarpedVolumeChunkSourceParameters,
) {
  moving: VolumeChunkSource;
  fieldSource: VolumeChunkSource;
  boundsSource: VolumeChunkSource | undefined;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const { parameters } = this;
    this.moving = rpc.get(parameters.movingSource);
    this.fieldSource = rpc.get(parameters.field.array.source);
    const { bounds } = parameters.field;
    this.boundsSource =
      bounds === undefined ? undefined : rpc.get(bounds.array.source);
    const { spec } = this.moving;
    const { movingSpatialDims: S, movingChannelDims: C } = parameters;
    if (spec.rank !== 3 + C.length || S.length !== 3) {
      throw new Error("warp: unexpected moving chunk dimensions");
    }
  }

  /** Spatial field index box [lo, hi] needed to sample the field in `out`. */
  private fieldIndexBox(warpedLo: number[], warpedHi: number[]) {
    const { field, warpedToOutput } = this.parameters;
    const [oLo, oHi] = transformBox(warpedToOutput, warpedLo, warpedHi);
    const [iLo, iHi] = transformBox(field.outputToIndex, oLo, oHi);
    const shape = this.spatialFieldShape();
    const lo = iLo.map((v, a) =>
      Math.min(Math.max(Math.floor(v), 0), shape[a] - 1),
    );
    const hi = iHi.map((v, a) =>
      Math.min(Math.max(Math.floor(v) + 1, 0), shape[a] - 1),
    );
    return { lo, hi };
  }

  private spatialFieldShape() {
    const { array, vectorAxis } = this.parameters.field;
    return array.shape.filter((_, a) => a !== vectorAxis);
  }

  private withVectorAxis(spatial: number[], vector: number) {
    const v = spatial.slice();
    v.splice(this.parameters.field.vectorAxis, 0, vector);
    return v;
  }

  /** Moving chunks covering the moving voxel box [lo, hi] (inclusive). */
  /**
   * Moving chunks covering the moving voxel box [lo, hi] (inclusive; spatial
   * dimensions, in movingSpatialDims order) and every channel.
   */
  private movingChunksInBox(lo: number[], hi: number[]) {
    const { spec } = this.moving;
    const { chunkDataSize, baseVoxelOffset, lowerVoxelBound, upperVoxelBound } =
      spec;
    const { movingSpatialDims: S } = this.parameters;
    const rank = spec.rank;
    const gLo = new Array<number>(rank);
    const gHi = new Array<number>(rank);
    for (let d = 0; d < rank; ++d) {
      const i = S.indexOf(d);
      const l =
        i === -1 ? lowerVoxelBound[d] : Math.max(lo[i], lowerVoxelBound[d]);
      const h =
        i === -1
          ? upperVoxelBound[d] - 1
          : Math.min(hi[i], upperVoxelBound[d] - 1);
      if (l > h) return [];
      gLo[d] = Math.floor((l - baseVoxelOffset[d]) / chunkDataSize[d]);
      gHi[d] = Math.floor((h - baseVoxelOffset[d]) / chunkDataSize[d]);
    }
    const out: VolumeDependency[] = [];
    const pos = gLo.slice();
    while (true) {
      out.push(volumeDependency(this.moving, pos));
      let d = 0;
      while (d < rank && ++pos[d] > gHi[d]) {
        pos[d] = gLo[d];
        ++d;
      }
      if (d === rank) break;
    }
    return out;
  }

  /**
   * Moving voxel box from the precomputed per-block bounds of x + u(x), for
   * requesting moving chunks before the field itself has arrived.
   */
  private async movingBoxFromBounds(
    warpedLo: number[],
    warpedHi: number[],
    signal: AbortSignal,
    onDeps: (deps: Dependency[]) => void,
  ): Promise<[number[], number[]] | undefined> {
    const { bounds } = this.parameters.field;
    if (bounds === undefined) return undefined;
    const { blockShape, unitToOutput, array } = bounds;
    // Finest-level field samples under the chunk, clamped (nearest outside).
    const [oLo, oHi] = transformBox(
      this.parameters.warpedToOutput,
      warpedLo,
      warpedHi,
    );
    const [iLo, iHi] = transformBox(bounds.outputToIndex, oLo, oHi);
    const fieldLo = iLo.map((v) => Math.max(Math.floor(v), 0));
    const fieldHi = iHi.map((v) => Math.max(Math.floor(v) + 1, 0));
    const bLo = fieldLo.map((v, a) =>
      Math.min(Math.floor(v / blockShape[a]), array.shape[a + 1] - 1),
    );
    // A block covers its samples and the first sample of the next block.
    const bHi = fieldHi.map((v, a) =>
      Math.min(
        Math.floor(Math.max(v - 1, 0) / blockShape[a]),
        array.shape[a + 1] - 1,
      ),
    );
    const zLo = [0, ...bLo];
    const zHi = [5, ...bHi];
    const chunks = zarrChunksInBox(this.boundsSource!, array, zLo, zHi);
    onDeps(chunks.map((c) => c.dep));
    const data = await Promise.all(
      chunks.map((c) => getDependencyData(c.dep, signal)),
    );
    const box = assembleZarrBox(array, chunks, data, zLo, zHi);
    const nBlocks = box.length / 6;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let b = 0; b < nBlocks; ++b) {
      for (let i = 0; i < 3; ++i) {
        const l = box[i * nBlocks + b] * unitToOutput[i];
        const h = box[(i + 3) * nBlocks + b] * unitToOutput[i];
        if (!Number.isFinite(l) || !Number.isFinite(h)) continue;
        lo[i] = Math.min(lo[i], l, h);
        hi[i] = Math.max(hi[i], l, h);
      }
    }
    if (!(lo[0] <= hi[0] && lo[1] <= hi[1] && lo[2] <= hi[2])) return undefined;
    const [mLo, mHi] = transformBox(this.parameters.outputToMoving, lo, hi);
    // Sample index = coordinate - 0.5; linear interpolation needs +1.
    return [
      mLo.map((v) => Math.floor(v - 0.5)),
      mHi.map((v) => Math.floor(v - 0.5) + 1),
    ];
  }

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    const origin = Array.from(computeChunkBounds(this, chunk as any));
    const size = Array.from(chunk.chunkDataSize!);
    const n = size[0] * size[1] * size[2];
    const { field } = this.parameters;

    // Field samples needed by the voxel centers of this chunk.
    const warpedLo = origin.map((o) => o + 0.5);
    const warpedHi = origin.map((o, i) => o + size[i] - 0.5);
    const { lo: fLo, hi: fHi } = this.fieldIndexBox(warpedLo, warpedHi);
    const fieldChunks = zarrChunksInBox(
      this.fieldSource,
      field.array,
      this.withVectorAxis(fLo, 0),
      this.withVectorAxis(fHi, field.array.shape[field.vectorAxis] - 1),
    );
    const fieldDeps = fieldChunks.map((c) => c.dep);

    const requests = getDependencyRequests(this.chunkManager);
    const request = requests.add(chunk, fieldDeps.slice());
    try {
      // If the field must still be fetched, use the block bounds to fetch
      // the moving chunks at the same time.
      if (
        PREFETCH_FROM_BOUNDS &&
        !fieldDeps.every(isAvailable) &&
        this.boundsSource !== undefined
      ) {
        const box = await this.movingBoxFromBounds(
          warpedLo,
          warpedHi,
          signal,
          (deps) => requests.set(request, [...fieldDeps, ...deps]),
        );
        if (box !== undefined) {
          requests.set(request, [
            ...fieldDeps,
            ...this.movingChunksInBox(box[0], box[1]),
          ]);
        }
      }
      const fieldData = await Promise.all(
        fieldDeps.map((dep) => getDependencyData(dep, signal)),
      );
      const fieldBox = assembleZarrBox(
        field.array,
        fieldChunks,
        fieldData,
        this.withVectorAxis(fLo, 0),
        this.withVectorAxis(fHi, field.array.shape[field.vectorAxis] - 1),
      );

      // Pass 1: moving sample coordinates of every voxel center.
      const coords = this.computeMovingCoordinates(
        origin,
        size,
        fLo,
        fHi,
        fieldBox,
      );
      let mLo = [Infinity, Infinity, Infinity];
      let mHi = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < n; ++v) {
        for (let i = 0; i < 3; ++i) {
          const c = coords[3 * v + i];
          if (c < mLo[i]) mLo[i] = c;
          if (c > mHi[i]) mHi[i] = c;
        }
      }
      mLo = mLo.map((v) => Math.floor(v));
      mHi = mHi.map((v) => Math.floor(v) + 1);

      // Pass 2: exactly the moving chunks those samples touch.
      const movingDeps = Number.isFinite(mLo[0])
        ? this.movingChunksInBox(mLo, mHi)
        : [];
      requests.set(request, [...fieldDeps, ...movingDeps]);
      const movingData = await Promise.all(
        movingDeps.map((dep) => getDependencyData(dep, signal)),
      );

      // Pass 3: sample.
      const nearest =
        this.parameters.interpolation === WarpInterpolation.NEAREST ||
        this.spec.dataType === DataType.UINT64;
      const warped = nearest
        ? this.sampleNearest(coords, n, movingDeps, movingData)
        : this.resample(coords, n, movingDeps, movingData, mLo, mHi);
      if (this.spec.compressedSegmentationBlockSize !== undefined) {
        await postProcessRawData(chunk, signal, warped);
      } else {
        chunk.data = warped;
      }
    } finally {
      requests.remove(request);
    }
  }

  /**
   * For each voxel center of the chunk (x fastest), the moving sample index
   * (continuous, sample n at n) of x + u(x).
   */
  private computeMovingCoordinates(
    origin: number[],
    size: number[],
    fLo: number[],
    fHi: number[],
    fieldBox: Float32Array,
  ): Float32Array {
    const { field, warpedToOutput: W, outputToMoving: M } = this.parameters;
    const A = field.outputToIndex;
    const V = field.vectorToOutput;
    const shape = this.spatialFieldShape();
    const ext = fLo.map((l, a) => fHi[a] - l + 1);
    // fieldBox is C order over the zarr axes, with the vector axis inserted.
    const boxShape = this.withVectorAxis(
      ext,
      field.array.shape[field.vectorAxis],
    );
    const boxStrides = cStrides(boxShape);
    const cStride = boxStrides[field.vectorAxis];
    const sStrides = boxStrides.filter((_, a) => a !== field.vectorAxis);
    const n = size[0] * size[1] * size[2];
    const coords = new Float32Array(3 * n);
    const p = [0, 0, 0];
    const f = [0, 0, 0];
    const i0 = [0, 0, 0];
    const t = [0, 0, 0];
    const u = [0, 0, 0];
    let v = 0;
    for (let z = 0; z < size[2]; ++z) {
      for (let y = 0; y < size[1]; ++y) {
        for (let x = 0; x < size[0]; ++x, ++v) {
          apply4(
            W,
            origin[0] + x + 0.5,
            origin[1] + y + 0.5,
            origin[2] + z + 0.5,
            p,
          );
          apply4(A, p[0], p[1], p[2], f);
          // Linear inside the field grid, nearest-neighbour outside (ITK).
          for (let a = 0; a < 3; ++a) {
            const fa = Math.min(Math.max(f[a], 0), shape[a] - 1);
            let ia = Math.floor(fa);
            if (ia > shape[a] - 2) ia = Math.max(shape[a] - 2, 0);
            t[a] = fa - ia;
            i0[a] = ia - fLo[a];
          }
          const s0 = sStrides[0];
          const s1 = sStrides[1];
          const s2 = sStrides[2];
          const e0 = ext[0] > 1 ? s0 : 0;
          const e1 = ext[1] > 1 ? s1 : 0;
          const e2 = ext[2] > 1 ? s2 : 0;
          const base = i0[0] * s0 + i0[1] * s1 + i0[2] * s2;
          const [t0, t1, t2] = t;
          for (let c = 0; c < 3; ++c) {
            const b = base + c * cStride;
            const c00 = fieldBox[b] * (1 - t2) + fieldBox[b + e2] * t2;
            const c01 =
              fieldBox[b + e1] * (1 - t2) + fieldBox[b + e1 + e2] * t2;
            const c10 =
              fieldBox[b + e0] * (1 - t2) + fieldBox[b + e0 + e2] * t2;
            const c11 =
              fieldBox[b + e0 + e1] * (1 - t2) +
              fieldBox[b + e0 + e1 + e2] * t2;
            u[c] =
              (c00 * (1 - t1) + c01 * t1) * (1 - t0) +
              (c10 * (1 - t1) + c11 * t1) * t0;
          }
          const qx = p[0] + V[0] * u[0] + V[1] * u[1] + V[2] * u[2];
          const qy = p[1] + V[3] * u[0] + V[4] * u[1] + V[5] * u[2];
          const qz = p[2] + V[6] * u[0] + V[7] * u[1] + V[8] * u[2];
          apply4(M, qx, qy, qz, f);
          coords[3 * v] = f[0] - 0.5;
          coords[3 * v + 1] = f[1] - 0.5;
          coords[3 * v + 2] = f[2] - 0.5;
        }
      }
    }
    return coords;
  }

  /**
   * Nearest-neighbour sampling straight from the moving chunks (raw or
   * compressed segmentation), one voxel per sample: no region is assembled
   * or decoded, which matters when a coarse warped chunk spans a large,
   * sparsely sampled moving region.
   */
  private sampleNearest(
    coords: Float32Array,
    n: number,
    deps: VolumeDependency[],
    data: ChunkData[],
  ) {
    const { spec } = this.moving;
    const { dataType } = this.spec;
    if (this.parameters.movingChannelDims.length > 0) {
      throw new Error("warp: labels with channel dimensions are not supported");
    }
    const out = new (DATA_TYPE_ARRAY_CONSTRUCTOR[dataType] as any)(n);
    if (deps.length === 0) return out;
    const {
      chunkDataSize: cds,
      baseVoxelOffset: base,
      lowerVoxelBound: lb,
      upperVoxelBound: ub,
    } = spec;
    const csBlock = spec.compressedSegmentationBlockSize;
    const uint64 = dataType === DataType.UINT64;
    // Dependencies on a dense grid of chunk positions.
    const gLo = [0, 1, 2].map((i) =>
      Math.min(...deps.map((d) => d.position[i])),
    );
    const gHi = [0, 1, 2].map((i) =>
      Math.max(...deps.map((d) => d.position[i])),
    );
    const gn = [0, 1, 2].map((i) => gHi[i] - gLo[i] + 1);
    interface Entry {
      d: any;
      ox: number;
      oy: number;
      oz: number;
      sx: number;
      sy: number;
      // compressed segmentation: blocks per row and per slice
      gx: number;
      gy: number;
    }
    const grid = new Array<Entry | undefined>(gn[0] * gn[1] * gn[2]);
    const fullSize = cds[0] * cds[1] * cds[2];
    deps.forEach((dep, ci) => {
      const d = data[ci] as any;
      if (d === null || d.length === 0) return;
      const o = [0, 1, 2].map((i) => dep.position[i] * cds[i] + base[i]);
      const clipped = [0, 1, 2].map((i) => Math.min(cds[i], ub[i] - o[i]));
      const raw = csBlock === undefined;
      const sx = raw && d.length === fullSize ? cds[0] : clipped[0];
      const sy = raw && d.length === fullSize ? cds[1] : clipped[1];
      const g = dep.position;
      grid[g[0] - gLo[0] + gn[0] * (g[1] - gLo[1] + gn[1] * (g[2] - gLo[2]))] =
        {
          d,
          ox: o[0],
          oy: o[1],
          oz: o[2],
          sx,
          sy,
          gx: raw ? 0 : Math.ceil(clipped[0] / csBlock[0]),
          gy: raw ? 0 : Math.ceil(clipped[1] / csBlock[1]),
        };
    });
    const [bx, by, bz] = csBlock === undefined ? [1, 1, 1] : csBlock;
    for (let v = 0; v < n; ++v) {
      const px = coords[3 * v];
      const py = coords[3 * v + 1];
      const pz = coords[3 * v + 2];
      // Inside if within half a voxel of the samples (ITK); 0 outside.
      if (
        !(
          px >= lb[0] - 0.5 &&
          px <= ub[0] - 0.5 &&
          py >= lb[1] - 0.5 &&
          py <= ub[1] - 0.5 &&
          pz >= lb[2] - 0.5 &&
          pz <= ub[2] - 0.5
        )
      ) {
        continue;
      }
      const x = Math.min(Math.max(Math.round(px), lb[0]), ub[0] - 1);
      const y = Math.min(Math.max(Math.round(py), lb[1]), ub[1] - 1);
      const z = Math.min(Math.max(Math.round(pz), lb[2]), ub[2] - 1);
      const cx = Math.floor((x - base[0]) / cds[0]) - gLo[0];
      const cy = Math.floor((y - base[1]) / cds[1]) - gLo[1];
      const cz = Math.floor((z - base[2]) / cds[2]) - gLo[2];
      if (
        cx < 0 ||
        cy < 0 ||
        cz < 0 ||
        cx >= gn[0] ||
        cy >= gn[1] ||
        cz >= gn[2]
      ) {
        continue;
      }
      const e = grid[cx + gn[0] * (cy + gn[1] * cz)];
      if (e === undefined) continue;
      const lx = x - e.ox;
      const ly = y - e.oy;
      const lz = z - e.oz;
      if (csBlock === undefined) {
        out[v] = e.d[lx + e.sx * (ly + e.sy * lz)];
        continue;
      }
      // One value of a compressed-segmentation chunk.
      const d = e.d as Uint32Array;
      const kx = Math.floor(lx / bx);
      const ky = Math.floor(ly / by);
      const kz = Math.floor(lz / bz);
      const b = d[0];
      const h = b + ((kz * e.gy + ky) * e.gx + kx) * 2;
      const bits = d[h] >>> 24;
      let index = 0;
      if (bits !== 0) {
        const i = lx - kx * bx + bx * (ly - ky * by + by * (lz - kz * bz));
        const bit = i * bits;
        const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
        index = (d[b + d[h + 1] + (bit >>> 5)] >>> (bit & 31)) & mask;
      }
      const t = b + (d[h] & 0xffffff) + (uint64 ? 2 : 1) * index;
      out[v] = uint64 ? BigInt(d[t]) | (BigInt(d[t + 1]) << 32n) : d[t];
    }
    return out;
  }

  /**
   * Linear (or nearest) resampling of the moving volume at `coords` (spatial,
   * in movingSpatialDims order), through one dense region per channel
   * assembled from the moving chunks. Output: x fastest, then y, z, then the
   * channels.
   */
  private resample(
    coords: Float32Array,
    n: number,
    deps: VolumeDependency[],
    data: ChunkData[],
    lo: number[],
    hi: number[],
  ) {
    const { spec } = this.moving;
    const { dataType } = this.spec;
    const { movingSpatialDims: S, movingChannelDims: Cd } = this.parameters;
    const rank = spec.rank;
    const {
      chunkDataSize: cds,
      baseVoxelOffset: base,
      lowerVoxelBound: lb,
      upperVoxelBound: ub,
    } = spec;
    const chExtent = Cd.map((d) => ub[d] - lb[d]);
    const numChannels = chExtent.reduce((a, b) => a * b, 1);
    const Ctor = DATA_TYPE_ARRAY_CONSTRUCTOR[dataType] as any;
    const out = new Ctor(n * numChannels);
    if (deps.length === 0) return out;
    // Spatial bounds, in movingSpatialDims order.
    const slb = S.map((d) => lb[d]);
    const sub = S.map((d) => ub[d]);
    const rlo = [0, 1, 2].map((i) => Math.max(lo[i], slb[i]));
    const rhi = [0, 1, 2].map((i) => Math.min(hi[i], sub[i] - 1));
    const rx = rhi[0] - rlo[0] + 1;
    const ry = rhi[1] - rlo[1] + 1;
    const rz = rhi[2] - rlo[2] + 1;
    if (rx <= 0 || ry <= 0 || rz <= 0) return out;
    const rsize = rx * ry * rz;
    // One dense region per channel, x fastest; missing chunks stay 0.
    const region = new Ctor(rsize * numChannels);
    const fullSize = cds.reduce((a: number, b: number) => a * b, 1);
    const csBlock = spec.compressedSegmentationBlockSize;
    deps.forEach((dep, ci) => {
      const d = data[ci] as any;
      if (d === null || d.length === 0) return;
      const o = Array.from(
        { length: rank },
        (_, k) => dep.position[k] * cds[k] + base[k],
      );
      // Chunks may be clipped at the upper bound (zarr chunks are not).
      const clipped = o.map((ok, k) => Math.min(cds[k], ub[k] - ok));
      const [s0, s1, s2] = S;
      const x0 = Math.max(rlo[0], o[s0]);
      const x1 = Math.min(rhi[0], o[s0] + clipped[s0] - 1);
      const y0 = Math.max(rlo[1], o[s1]);
      const y1 = Math.min(rhi[1], o[s1] + clipped[s1] - 1);
      const z0 = Math.max(rlo[2], o[s2]);
      const z1 = Math.min(rhi[2], o[s2] + clipped[s2] - 1);
      if (x1 < x0 || y1 < y0 || z1 < z0) return;
      if (csBlock !== undefined) {
        // Compressed segmentation (rank 3, no channels): decode just the part
        // of the chunk this region needs.
        decodeCompressedSegmentationBox(
          d,
          clipped,
          csBlock,
          dataType === DataType.UINT64,
          [x0 - o[0], y0 - o[1], z0 - o[2]],
          [x1 - o[0], y1 - o[1], z1 - o[2]],
          region,
          [o[0] - rlo[0], o[1] - rlo[1], o[2] - rlo[2]],
          rx,
          ry,
        );
        return;
      }
      // Strides of the chunk's data (stored at full size, or clipped).
      const size = d.length === fullSize ? cds : clipped;
      const stride = new Array<number>(rank);
      for (let k = 0, m = 1; k < rank; ++k) {
        stride[k] = m;
        m *= size[k];
      }
      const sx = stride[s0];
      const sy = stride[s1];
      const sz = stride[s2];
      const w = x1 - x0 + 1;
      // Each channel index of this chunk.
      const cLo = Cd.map((k) => Math.max(o[k], lb[k]));
      const cHi = Cd.map((k) => Math.min(o[k] + clipped[k], ub[k]) - 1);
      const c = cLo.slice();
      while (true) {
        let srcBase = 0;
        let chIndex = 0;
        for (let i = Cd.length - 1; i >= 0; --i) {
          srcBase += (c[i] - o[Cd[i]]) * stride[Cd[i]];
          chIndex = chIndex * chExtent[i] + (c[i] - lb[Cd[i]]);
        }
        const dstBase = chIndex * rsize;
        for (let z = z0; z <= z1; ++z) {
          for (let y = y0; y <= y1; ++y) {
            const src =
              srcBase + (x0 - o[s0]) * sx + (y - o[s1]) * sy + (z - o[s2]) * sz;
            const dst =
              dstBase + x0 - rlo[0] + rx * (y - rlo[1] + ry * (z - rlo[2]));
            if (sx === 1) {
              for (let k = 0; k < w; ++k) region[dst + k] = d[src + k];
            } else {
              for (let k = 0; k < w; ++k) region[dst + k] = d[src + k * sx];
            }
          }
        }
        let i = 0;
        while (i < Cd.length && ++c[i] > cHi[i]) {
          c[i] = cLo[i];
          ++i;
        }
        if (i === Cd.length) break;
      }
    });
    const integer = dataType !== DataType.FLOAT32;
    const nearest =
      this.parameters.interpolation === WarpInterpolation.NEAREST ||
      dataType === DataType.UINT64;
    // Inside if within half a voxel of the samples (ITK); 0 outside.
    const loX = slb[0] - 0.5;
    const loY = slb[1] - 0.5;
    const loZ = slb[2] - 0.5;
    const hiX = sub[0] - 0.5;
    const hiY = sub[1] - 0.5;
    const hiZ = sub[2] - 0.5;
    const maxX = rx - 1;
    const maxY = ry - 1;
    const maxZ = rz - 1;
    const sY = rx;
    const sZ = rx * ry;
    for (let v = 0; v < n; ++v) {
      const px = coords[3 * v];
      const py = coords[3 * v + 1];
      const pz = coords[3 * v + 2];
      if (
        !(
          px >= loX &&
          px <= hiX &&
          py >= loY &&
          py <= hiY &&
          pz >= loZ &&
          pz <= hiZ
        )
      ) {
        continue;
      }
      // Region-relative coordinates; neighbours clamped to the region, which
      // covers [lb, ub - 1] wherever samples fall (mode "nearest" at borders).
      const x = px - rlo[0];
      const y = py - rlo[1];
      const z = pz - rlo[2];
      if (nearest) {
        const ix = Math.min(Math.max(Math.round(x), 0), maxX);
        const iy = Math.min(Math.max(Math.round(y), 0), maxY);
        const iz = Math.min(Math.max(Math.round(z), 0), maxZ);
        const at = ix + sY * iy + sZ * iz;
        for (let ch = 0; ch < numChannels; ++ch) {
          out[v + n * ch] = region[at + rsize * ch];
        }
        continue;
      }
      const fx = Math.floor(x);
      const fy = Math.floor(y);
      const fz = Math.floor(z);
      const tx = x - fx;
      const ty = y - fy;
      const tz = z - fz;
      const xa = fx < 0 ? 0 : fx > maxX ? maxX : fx;
      const xb = fx + 1 > maxX ? maxX : fx + 1 < 0 ? 0 : fx + 1;
      const ya = (fy < 0 ? 0 : fy > maxY ? maxY : fy) * sY;
      const yb = (fy + 1 > maxY ? maxY : fy + 1 < 0 ? 0 : fy + 1) * sY;
      const za = (fz < 0 ? 0 : fz > maxZ ? maxZ : fz) * sZ;
      const zb = (fz + 1 > maxZ ? maxZ : fz + 1 < 0 ? 0 : fz + 1) * sZ;
      for (let ch = 0, r = 0; ch < numChannels; ++ch, r += rsize) {
        const c00 =
          region[r + xa + ya + za] * (1 - tx) + region[r + xb + ya + za] * tx;
        const c10 =
          region[r + xa + yb + za] * (1 - tx) + region[r + xb + yb + za] * tx;
        const c01 =
          region[r + xa + ya + zb] * (1 - tx) + region[r + xb + ya + zb] * tx;
        const c11 =
          region[r + xa + yb + zb] * (1 - tx) + region[r + xb + yb + zb] * tx;
        const value =
          (c00 * (1 - ty) + c10 * ty) * (1 - tz) +
          (c01 * (1 - ty) + c11 * ty) * tz;
        out[v + n * ch] = integer ? Math.round(value) : value;
      }
    }
    return out;
  }
}
WarpedVolumeChunkSource.prototype.chunkConstructor = WarpedVolumeChunk;
