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
 * @file Boxes of a field read from Fortran-order chunks (dimension 0
 * fastest), of any layout: which chunks cover a box, and the box as one
 * dense array.
 */

import type { ChunkData } from "#src/sliceview/volume/warp/dependencies.js";

/** The chunk layout of one field level (as in `FieldAccess`). */
export interface ChunkLayout {
  rank: number;
  chunkDataSize: number[];
  baseVoxelOffset: number[];
  upperVoxelBound: number[];
}

/** Chunk grid positions covering the index box [lo, hi] (inclusive). */
export function chunkGridsInBox(
  access: ChunkLayout,
  lo: number[],
  hi: number[],
): number[][] {
  const { rank, chunkDataSize: cds, baseVoxelOffset: base } = access;
  const gLo = lo.map((v, d) => Math.floor((v - base[d]) / cds[d]));
  const gHi = hi.map((v, d) => Math.floor((v - base[d]) / cds[d]));
  const out: number[][] = [];
  const g = gLo.slice();
  while (true) {
    out.push(g.slice());
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
export function assembleFieldBox(
  access: ChunkLayout,
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
