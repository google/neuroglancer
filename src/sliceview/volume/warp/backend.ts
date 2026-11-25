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
 * computed from chunks of other sources (the displacement field and the
 * moving volume). Those dependencies are ordinary chunks of
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
import { transformBox } from "#src/sliceview/volume/warp/affine.js";
import type { FieldAccess } from "#src/sliceview/volume/warp/base.js";
import {
  WarpedVolumeChunkSourceParameters,
  WarpInterpolation,
} from "#src/sliceview/volume/warp/base.js";
import type {
  ChunkData,
  VolumeDependency,
} from "#src/sliceview/volume/warp/dependencies.js";
import {
  getDependencyData,
  volumeDependency,
  withDependencies,
} from "#src/sliceview/volume/warp/dependencies.js";
import { DATA_TYPE_ARRAY_CONSTRUCTOR } from "#src/util/data_type.js";
import type { vec3 } from "#src/util/geom.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

// --- Kernels.

function apply4(m: number[], x: number, y: number, z: number, out: number[]) {
  out[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
}

// --- Fields read through any volume chunk source (Fortran-order chunks).

/** Chunk grid positions covering the index box [lo, hi] (inclusive). */
function chunksInBox(
  source: VolumeChunkSource,
  access: FieldAccess,
  lo: number[],
  hi: number[],
): { dep: VolumeDependency; grid: number[] }[] {
  const { rank, chunkDataSize: cds, baseVoxelOffset: base } = access;
  const gLo = lo.map((v, d) => Math.floor((v - base[d]) / cds[d]));
  const gHi = hi.map((v, d) => Math.floor((v - base[d]) / cds[d]));
  const out: { dep: VolumeDependency; grid: number[] }[] = [];
  const g = gLo.slice();
  while (true) {
    out.push({ dep: volumeDependency(source, g), grid: g.slice() });
    let d = 0;
    while (d < rank && ++g[d] > gHi[d]) {
      g[d] = gLo[d];
      ++d;
    }
    if (d === rank) return out;
  }
}

/**
 * Copies the index box [lo, hi] (inclusive) of a field whose chunks have
 * been fetched into a dense Fortran-order (dimension 0 fastest)
 * Float32Array; missing chunks are 0.
 */
function assembleFieldBox(
  access: FieldAccess,
  chunks: { grid: number[] }[],
  data: ChunkData[],
  lo: number[],
  hi: number[],
): Float32Array {
  const { rank, chunkDataSize: cds, baseVoxelOffset: base } = access;
  const ub = access.upperVoxelBound;
  const extent = lo.map((l, d) => hi[d] - l + 1);
  const outStrides = new Array<number>(rank);
  for (let d = 0, m = 1; d < rank; ++d) {
    outStrides[d] = m;
    m *= extent[d];
  }
  const out = new Float32Array(extent.reduce((a, b) => a * b, 1));
  const fullSize = cds.reduce((a, b) => a * b, 1);
  chunks.forEach(({ grid }, ci) => {
    const d0 = data[ci] as ArrayLike<number> | null;
    if (d0 === null || d0.length === 0) return;
    const origin = grid.map((g, d) => g * cds[d] + base[d]);
    // Chunks may be stored clipped at the upper bound.
    const stored =
      d0.length === fullSize
        ? cds
        : origin.map((o, d) => Math.min(cds[d], ub[d] - o));
    const strides = new Array<number>(rank);
    for (let d = 0, m = 1; d < rank; ++d) {
      strides[d] = m;
      m *= stored[d];
    }
    const cLo = new Array<number>(rank);
    const cHi = new Array<number>(rank);
    for (let d = 0; d < rank; ++d) {
      cLo[d] = Math.max(lo[d], origin[d]);
      cHi[d] = Math.min(hi[d], origin[d] + stored[d] - 1);
      if (cLo[d] > cHi[d]) return;
    }
    const idx = cLo.slice();
    const w = cHi[0] - cLo[0] + 1;
    while (true) {
      let src = 0;
      let dst = 0;
      for (let d = 0; d < rank; ++d) {
        src += (idx[d] - origin[d]) * strides[d];
        dst += (idx[d] - lo[d]) * outStrides[d];
      }
      const s0 = strides[0];
      for (let k = 0; k < w; ++k) out[dst + k] = d0[src + k * s0];
      let d = 1;
      while (d < rank && ++idx[d] > cHi[d]) {
        idx[d] = cLo[d];
        ++d;
      }
      if (d >= rank) break;
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
  // Non-vector field chunk dimensions, ascending.
  fieldSpatialDims: number[];
  // Moving chunk dimensions carried whole (channels), in warped order.
  channelDims: number[];
  // The 3-d case (3 field dimensions, a rank-4 field with 3 components,
  // passthrough channels only): the original coordinate kernel.
  fast: boolean;
  // 3 moving dimensions sampled, passthrough channels only: the original
  // sampling kernels (which also read compressed segmentation).
  fastSampling: boolean;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const { parameters } = this;
    this.moving = rpc.get(parameters.movingSource);
    this.fieldSource = rpc.get(parameters.field.source);
    const { spec } = this.moving;
    const { movingSpatialDims: S, movingPassDims: P, field } = parameters;
    if (spec.rank !== S.length + P.length) {
      throw new Error("warp: unexpected moving chunk dimensions");
    }
    this.fieldSpatialDims = [...Array(field.rank).keys()].filter(
      (d) => d !== field.vectorDim,
    );
    this.channelDims = P.filter((p) => p.whole).map((p) => p.dim);
    this.fast =
      parameters.numFieldDims === 3 &&
      S.length === 3 &&
      field.rank === 4 &&
      field.numComponents === 3 &&
      P.every((p) => p.whole);
    this.fastSampling = S.length === 3 && P.every((p) => p.whole);
  }

  /** Field index box [lo, hi] (all chunk dimensions) needed for the box. */
  private fieldIndexBox(warpedLo: number[], warpedHi: number[]) {
    const { field, warpedToOutput: W, numFieldDims: F } = this.parameters;
    const [oLo, oHi] = transformBox(W, F, F, warpedLo, warpedHi);
    const [iLo, iHi] = transformBox(
      field.outputToIndex,
      field.rank,
      F,
      oLo,
      oHi,
    );
    const lb = field.lowerVoxelBound;
    const ub = field.upperVoxelBound;
    // The box starts at or below the interpolation base, which is at most
    // ub - 2 (the last two samples interpolate the last one).
    const lo = iLo.map((v, d) =>
      d === field.vectorDim
        ? lb[d]
        : Math.max(Math.min(Math.floor(v), ub[d] - 2), lb[d]),
    );
    const hi = iHi.map((v, d) =>
      d === field.vectorDim
        ? ub[d] - 1
        : Math.min(Math.max(Math.floor(v) + 1, lb[d]), ub[d] - 1),
    );
    return { lo, hi };
  }

  /**
   * Moving chunks covering the moving voxel box [lo, hi] (inclusive; in
   * movingSpatialDims order), every channel, and the warped chunk's voxel of
   * each sliced passthrough dimension.
   */
  private movingChunksInBox(lo: number[], hi: number[], origin: number[]) {
    const { spec } = this.moving;
    const { chunkDataSize, baseVoxelOffset, lowerVoxelBound, upperVoxelBound } =
      spec;
    const {
      movingSpatialDims: S,
      movingPassDims: P,
      numFieldDims: F,
    } = this.parameters;
    const rank = spec.rank;
    const gLo = new Array<number>(rank);
    const gHi = new Array<number>(rank);
    for (let d = 0; d < rank; ++d) {
      const i = S.indexOf(d);
      let l: number;
      let h: number;
      if (i !== -1) {
        l = Math.max(lo[i], lowerVoxelBound[d]);
        h = Math.min(hi[i], upperVoxelBound[d] - 1);
      } else {
        const p = P.findIndex((x) => x.dim === d);
        if (p === -1 || P[p].whole) {
          l = lowerVoxelBound[d];
          h = upperVoxelBound[d] - 1;
        } else {
          l = h = origin[F + p] + P[p].offset;
        }
      }
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

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    const origin = Array.from(computeChunkBounds(this, chunk as any));
    const size = Array.from(chunk.chunkDataSize!);
    const { field, numFieldDims: F, movingSpatialDims: S } = this.parameters;
    let n = 1;
    for (let k = 0; k < F; ++k) n *= size[k];

    // Field samples needed by the voxel centers of this chunk.
    const warpedLo = origin.slice(0, F).map((o) => o + 0.5);
    const warpedHi = origin.slice(0, F).map((o, i) => o + size[i] - 0.5);
    const { lo: fLo, hi: fHi } = this.fieldIndexBox(warpedLo, warpedHi);
    const fieldChunks = chunksInBox(this.fieldSource, field, fLo, fHi);
    const fieldDeps = fieldChunks.map((c) => c.dep);

    await withDependencies(
      this.chunkManager,
      chunk,
      fieldDeps,
      async (setDependencies) => {
        const fieldData = await Promise.all(
          fieldDeps.map((dep) => getDependencyData(dep, signal)),
        );
        const fieldBox = assembleFieldBox(
          field,
          fieldChunks,
          fieldData,
          fLo,
          fHi,
        );

        // Pass 1: moving sample coordinates of every voxel center.
        const coords = this.fast
          ? this.computeMovingCoordinates(origin, size, fLo, fHi, fieldBox)
          : this.computeMovingCoordinatesGeneric(
              origin,
              size,
              fLo,
              fHi,
              fieldBox,
            );
        const m = S.length;
        let mLo = new Array<number>(m).fill(Infinity);
        let mHi = new Array<number>(m).fill(-Infinity);
        for (let v = 0; v < n; ++v) {
          for (let i = 0; i < m; ++i) {
            const c = coords[m * v + i];
            if (c < mLo[i]) mLo[i] = c;
            if (c > mHi[i]) mHi[i] = c;
          }
        }
        mLo = mLo.map((v) => Math.floor(v));
        mHi = mHi.map((v) => Math.floor(v) + 1);

        // Pass 2: exactly the moving chunks those samples touch.
        const movingDeps =
          m === 0 || Number.isFinite(mLo[0])
            ? this.movingChunksInBox(mLo, mHi, origin)
            : [];
        setDependencies([...fieldDeps, ...movingDeps]);
        const movingData = await Promise.all(
          movingDeps.map((dep) => getDependencyData(dep, signal)),
        );

        // Pass 3: sample.
        const nearest =
          this.parameters.interpolation === WarpInterpolation.NEAREST ||
          this.spec.dataType === DataType.UINT64;
        let warped;
        if (this.fastSampling) {
          warped = nearest
            ? this.sampleNearest(coords, n, movingDeps, movingData)
            : this.resample(coords, n, movingDeps, movingData, mLo, mHi);
        } else {
          warped = this.resampleGeneric(
            coords,
            n,
            movingDeps,
            movingData,
            mLo,
            mHi,
            origin,
            nearest,
          );
        }
        if (this.spec.compressedSegmentationBlockSize !== undefined) {
          await postProcessRawData(chunk, signal, warped);
        } else {
          chunk.data = warped;
        }
      },
    );
  }

  /**
   * For each voxel center of the chunk (x fastest), the moving sample index
   * (continuous, sample n at n) of x + u(x): the 3-d kernel.
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
    const sd = this.fieldSpatialDims;
    const lb = sd.map((d) => field.lowerVoxelBound[d]);
    const ub = sd.map((d) => field.upperVoxelBound[d]);
    const lo = sd.map((d) => fLo[d]);
    const ext = sd.map((d) => fHi[d] - fLo[d] + 1);
    // fieldBox is Fortran order over the field's chunk dimensions.
    const boxStrides = new Array<number>(field.rank);
    for (let d = 0, m = 1; d < field.rank; ++d) {
      boxStrides[d] = m;
      m *= fHi[d] - fLo[d] + 1;
    }
    const cStride = boxStrides[field.vectorDim];
    const cBase = -fLo[field.vectorDim] * cStride;
    const [sx, sy, sz] = sd.map((d) => boxStrides[d]);
    // Rows of A for the spatial chunk dimensions (row-major 4x4 layout).
    const Ad = new Array<number>(12);
    sd.forEach((d, a) => {
      for (let j = 0; j < 4; ++j) Ad[a * 4 + j] = A[d * 4 + j];
    });
    const n = size[0] * size[1] * size[2];
    const coords = new Float32Array(3 * n);
    const p = [0, 0, 0];
    const f = [0, 0, 0];
    const i0 = [0, 0, 0];
    const t = [0, 0, 0];
    const u = [0, 0, 0];
    const ex = ext[0] > 1 ? sx : 0;
    const ey = ext[1] > 1 ? sy : 0;
    const ez = ext[2] > 1 ? sz : 0;
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
          apply4(Ad, p[0], p[1], p[2], f);
          // Linear inside the field grid, nearest-neighbour outside (ITK).
          for (let a = 0; a < 3; ++a) {
            const fa = Math.min(Math.max(f[a], lb[a]), ub[a] - 1);
            let ia = Math.floor(fa);
            if (ia > ub[a] - 2) ia = Math.max(ub[a] - 2, lb[a]);
            t[a] = fa - ia;
            i0[a] = ia - lo[a];
          }
          const base = cBase + i0[0] * sx + i0[1] * sy + i0[2] * sz;
          const [tx, ty, tz] = t;
          for (let c = 0; c < 3; ++c) {
            const b = base + c * cStride;
            const c00 = fieldBox[b] * (1 - tx) + fieldBox[b + ex] * tx;
            const c01 =
              fieldBox[b + ey] * (1 - tx) + fieldBox[b + ey + ex] * tx;
            const c10 =
              fieldBox[b + ez] * (1 - tx) + fieldBox[b + ez + ex] * tx;
            const c11 =
              fieldBox[b + ez + ey] * (1 - tx) +
              fieldBox[b + ez + ey + ex] * tx;
            u[c] =
              (c00 * (1 - ty) + c01 * ty) * (1 - tz) +
              (c10 * (1 - ty) + c11 * ty) * tz;
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
   * The same for any number F of field dimensions and any field layout:
   * multilinear in the field over its non-constant dimensions, then the
   * moving sample indices of movingSpatialDims (m per voxel, x fastest over
   * the F warped dimensions).
   */
  private computeMovingCoordinatesGeneric(
    origin: number[],
    size: number[],
    fLo: number[],
    fHi: number[],
    fieldBox: Float32Array,
  ): Float32Array {
    const {
      field,
      warpedToOutput: W,
      outputToMoving: M,
      numFieldDims: F,
      movingSpatialDims: S,
    } = this.parameters;
    const A = field.outputToIndex;
    const V = field.vectorToOutput;
    const K = field.numComponents;
    const R = field.rank;
    const m = S.length;
    const boxStrides = new Array<number>(R);
    for (let d = 0, s = 1; d < R; ++d) {
      boxStrides[d] = s;
      s *= fHi[d] - fLo[d] + 1;
    }
    const sd = this.fieldSpatialDims;
    const cStride = boxStrides[field.vectorDim];
    const cBase = -fLo[field.vectorDim] * cStride;
    let n = 1;
    for (let k = 0; k < F; ++k) n *= size[k];
    const coords = new Float32Array(m * n);
    const x = new Array<number>(F).fill(0);
    const p = new Array<number>(F).fill(0);
    const q = new Array<number>(F).fill(0);
    const u = new Array<number>(K).fill(0);
    // Interpolated dimensions of this voxel: offsets and weights.
    const steps = new Array<number>(sd.length);
    const fracs = new Array<number>(sd.length);
    const idx = new Array<number>(F).fill(0);
    for (let v = 0; v < n; ++v) {
      for (let k = 0; k < F; ++k) x[k] = origin[k] + idx[k] + 0.5;
      for (let i = 0; i < F; ++i) {
        let s = W[i * (F + 1) + F];
        for (let j = 0; j < F; ++j) s += W[i * (F + 1) + j] * x[j];
        p[i] = s;
      }
      let base = cBase;
      let numSteps = 0;
      for (const d of sd) {
        let f = A[d * (F + 1) + F];
        for (let j = 0; j < F; ++j) f += A[d * (F + 1) + j] * p[j];
        const lb = field.lowerVoxelBound[d];
        const ub = field.upperVoxelBound[d];
        // Linear inside the field grid, nearest-neighbour outside (ITK).
        const fa = Math.min(Math.max(f, lb), ub - 1);
        let ia = Math.floor(fa);
        if (ia > ub - 2) ia = Math.max(ub - 2, lb);
        base += (ia - fLo[d]) * boxStrides[d];
        const t = fa - ia;
        if (fHi[d] > fLo[d] && t !== 0) {
          steps[numSteps] = boxStrides[d];
          fracs[numSteps] = t;
          ++numSteps;
        }
      }
      for (let c = 0; c < K; ++c) {
        const b = base + c * cStride;
        let sum = 0;
        for (let corner = 0; corner < 1 << numSteps; ++corner) {
          let w = 1;
          let off = b;
          for (let a = 0; a < numSteps; ++a) {
            if (corner & (1 << a)) {
              w *= fracs[a];
              off += steps[a];
            } else {
              w *= 1 - fracs[a];
            }
          }
          sum += w * fieldBox[off];
        }
        u[c] = sum;
      }
      for (let i = 0; i < F; ++i) {
        let s = p[i];
        for (let c = 0; c < K; ++c) s += V[i * K + c] * u[c];
        q[i] = s;
      }
      for (let i = 0; i < m; ++i) {
        let s = M[i * (F + 1) + F];
        for (let j = 0; j < F; ++j) s += M[i * (F + 1) + j] * q[j];
        coords[m * v + i] = s - 0.5;
      }
      for (let k = 0; k < F; ++k) {
        if (++idx[k] < size[k]) break;
        idx[k] = 0;
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
    if (this.channelDims.length > 0) {
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
   * Copies the moving voxels [rlo, rhi] (inclusive, in movingSpatialDims
   * order) of every channel into `region`: one dense block per channel,
   * dimension 0 fastest; missing chunks stay 0. `fixed` gives the moving
   * voxel of each sliced passthrough dimension.
   */
  private fillRegion(
    deps: VolumeDependency[],
    data: ChunkData[],
    rlo: number[],
    rhi: number[],
    fixed: [number, number][],
    region: any,
  ) {
    const { spec } = this.moving;
    const { movingSpatialDims: S } = this.parameters;
    const Cd = this.channelDims;
    const {
      rank,
      chunkDataSize: cds,
      baseVoxelOffset: base,
      lowerVoxelBound: lb,
      upperVoxelBound: ub,
      compressedSegmentationBlockSize: csBlock,
    } = spec;
    const m = S.length;
    const rext = rlo.map((l, i) => rhi[i] - l + 1);
    const rstr = new Array<number>(m);
    let rsize = 1;
    for (let i = 0; i < m; ++i) {
      rstr[i] = rsize;
      rsize *= rext[i];
    }
    const chExtent = Cd.map((d) => ub[d] - lb[d]);
    const fullSize = cds.reduce((a: number, b: number) => a * b, 1);
    deps.forEach((dep, ci) => {
      const d = data[ci] as any;
      if (d === null || d.length === 0) return;
      const o = Array.from(
        { length: rank },
        (_, k) => dep.position[k] * cds[k] + base[k],
      );
      // Chunks may be clipped at the upper bound (zarr chunks are not).
      const clipped = o.map((ok, k) => Math.min(cds[k], ub[k] - ok));
      const cLo = S.map((k, i) => Math.max(rlo[i], o[k]));
      const cHi = S.map((k, i) => Math.min(rhi[i], o[k] + clipped[k] - 1));
      if (cLo.some((l, i) => l > cHi[i])) return;
      if (csBlock !== undefined) {
        // Compressed segmentation (rank 3, no channels): decode just the part
        // of the chunk this region needs.
        decodeCompressedSegmentationBox(
          d,
          clipped,
          csBlock,
          this.spec.dataType === DataType.UINT64,
          cLo.map((l, i) => l - o[S[i]]),
          cHi.map((h, i) => h - o[S[i]]),
          region,
          S.map((k, i) => o[k] - rlo[i]),
          rext[0],
          rext[1],
        );
        return;
      }
      // Strides of the chunk's data (stored at full size, or clipped).
      const size = d.length === fullSize ? cds : clipped;
      const stride = new Array<number>(rank);
      for (let k = 0, s = 1; k < rank; ++k) {
        stride[k] = s;
        s *= size[k];
      }
      let fixedOffset = 0;
      for (const [k, v] of fixed) {
        if (v < o[k] || v >= o[k] + clipped[k]) return;
        fixedOffset += (v - o[k]) * stride[k];
      }
      const chLo = Cd.map((k) => Math.max(o[k], lb[k]));
      const chHi = Cd.map((k) => Math.min(o[k] + clipped[k], ub[k]) - 1);
      const c = chLo.slice();
      const w = cHi[0] - cLo[0] + 1;
      const sx = stride[S[0]];
      while (true) {
        let srcBase = fixedOffset;
        let chIndex = 0;
        for (let i = Cd.length - 1; i >= 0; --i) {
          srcBase += (c[i] - o[Cd[i]]) * stride[Cd[i]];
          chIndex = chIndex * chExtent[i] + (c[i] - lb[Cd[i]]);
        }
        const dstBase = chIndex * rsize;
        const idx = cLo.slice();
        while (true) {
          let src = srcBase;
          let dst = dstBase;
          for (let i = 0; i < m; ++i) {
            src += (idx[i] - o[S[i]]) * stride[S[i]];
            dst += (idx[i] - rlo[i]) * rstr[i];
          }
          if (sx === 1) {
            for (let k = 0; k < w; ++k) region[dst + k] = d[src + k];
          } else {
            for (let k = 0; k < w; ++k) region[dst + k] = d[src + k * sx];
          }
          let i = 1;
          while (i < m && ++idx[i] > cHi[i]) {
            idx[i] = cLo[i];
            ++i;
          }
          if (i >= m) break;
        }
        let i = 0;
        while (i < Cd.length && ++c[i] > chHi[i]) {
          c[i] = chLo[i];
          ++i;
        }
        if (i === Cd.length) break;
      }
    });
  }

  /**
   * Linear resampling of the moving volume at `coords` (spatial,
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
    const { movingSpatialDims: S } = this.parameters;
    const Cd = this.channelDims;
    const { lowerVoxelBound: lb, upperVoxelBound: ub } = spec;
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
    this.fillRegion(deps, data, rlo, rhi, [], region);
    const integer = dataType !== DataType.FLOAT32;
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

  /**
   * Resampling for any number of moving dimensions sampled through the field
   * (multilinear, or nearest), with sliced passthrough dimensions at the
   * warped chunk's voxel and channels carried whole. Output: the warped
   * field dimensions (dimension 0 fastest), then the channels.
   */
  private resampleGeneric(
    coords: Float32Array,
    n: number,
    deps: VolumeDependency[],
    data: ChunkData[],
    lo: number[],
    hi: number[],
    origin: number[],
    nearest: boolean,
  ) {
    const { spec } = this.moving;
    const { dataType } = this.spec;
    const {
      movingSpatialDims: S,
      movingPassDims: P,
      numFieldDims: F,
    } = this.parameters;
    const m = S.length;
    const { lowerVoxelBound: lb, upperVoxelBound: ub } = spec;
    const Cd = this.channelDims;
    const chExtent = Cd.map((d) => ub[d] - lb[d]);
    const numChannels = chExtent.reduce((a, b) => a * b, 1);
    const Ctor = DATA_TYPE_ARRAY_CONSTRUCTOR[dataType] as any;
    const out = new Ctor(n * numChannels);
    if (deps.length === 0) return out;
    if (spec.compressedSegmentationBlockSize !== undefined) {
      throw new Error(
        "warp: compressed segmentation is supported for 3-d sources only",
      );
    }
    // Sliced passthrough dimensions: the moving voxel of this warped chunk.
    const fixed: [number, number][] = [];
    P.forEach((p, i) => {
      if (!p.whole) fixed.push([p.dim, origin[F + i] + p.offset]);
    });
    for (const [d, v] of fixed) {
      if (v < lb[d] || v >= ub[d]) return out;
    }
    const slb = S.map((d) => lb[d]);
    const sub = S.map((d) => ub[d]);
    const rlo = S.map((_, i) => Math.max(lo[i], slb[i]));
    const rhi = S.map((_, i) => Math.min(hi[i], sub[i] - 1));
    const rext = rlo.map((l, i) => rhi[i] - l + 1);
    if (rext.some((e) => e <= 0)) return out;
    const rstr = new Array<number>(m);
    let rsize = 1;
    for (let i = 0; i < m; ++i) {
      rstr[i] = rsize;
      rsize *= rext[i];
    }
    // One dense region per channel; missing chunks stay 0.
    const region = new Ctor(rsize * numChannels);
    this.fillRegion(deps, data, rlo, rhi, fixed, region);
    const integer = dataType !== DataType.FLOAT32;
    const offA = new Array<number>(m);
    const offB = new Array<number>(m);
    const frac = new Array<number>(m);
    for (let v = 0; v < n; ++v) {
      // Inside if within half a voxel of the samples (ITK); 0 outside.
      let inside = true;
      for (let i = 0; i < m; ++i) {
        const c = coords[m * v + i];
        if (!(c >= slb[i] - 0.5 && c <= sub[i] - 0.5)) {
          inside = false;
          break;
        }
      }
      if (!inside) continue;
      if (nearest) {
        let at = 0;
        for (let i = 0; i < m; ++i) {
          const r = Math.round(coords[m * v + i] - rlo[i]);
          at += Math.min(Math.max(r, 0), rext[i] - 1) * rstr[i];
        }
        for (let ch = 0; ch < numChannels; ++ch) {
          out[v + n * ch] = region[at + rsize * ch];
        }
        continue;
      }
      // Neighbours clamped to the region, which covers [lb, ub - 1]
      // wherever samples fall (mode "nearest" at borders).
      for (let i = 0; i < m; ++i) {
        const r = coords[m * v + i] - rlo[i];
        const f = Math.floor(r);
        frac[i] = r - f;
        const max = rext[i] - 1;
        offA[i] = (f < 0 ? 0 : f > max ? max : f) * rstr[i];
        offB[i] = (f + 1 > max ? max : f + 1 < 0 ? 0 : f + 1) * rstr[i];
      }
      for (let ch = 0, r = 0; ch < numChannels; ++ch, r += rsize) {
        let value = 0;
        for (let corner = 0; corner < 1 << m; ++corner) {
          let w = 1;
          let at = r;
          for (let i = 0; i < m; ++i) {
            if (corner & (1 << i)) {
              w *= frac[i];
              at += offB[i];
            } else {
              w *= 1 - frac[i];
              at += offA[i];
            }
          }
          if (w !== 0) value += w * region[at];
        }
        out[v + n * ch] = integer ? Math.round(value) : value;
      }
    }
    return out;
  }
}
WarpedVolumeChunkSource.prototype.chunkConstructor = WarpedVolumeChunk;
