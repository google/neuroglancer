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
 * @file A displacement field derived from a stored one: the field of the
 * inverse transformation, computed chunk by chunk where it is needed, so that
 * a transformation can be stored as one field.
 *
 * Indices: each level of the stored field is read through its chunk source,
 * whose index space (sample n at n) is the level's array. The derived field
 * has the same levels, each on the lattice of the stored level it inverts,
 * shifted to cover where that level maps to.
 *
 * Which stored chunks a derived chunk needs, without any bounds metadata: a
 * coarse level's cell, interpolated, maps inside the box of its extent plus
 * the range of its corner displacements; the finest samples it stands for stay
 * within the level's maximum interpolation error of that, plus the codec error
 * bounds (`attributes.warpfield`). So walking the pyramid from the coarsest
 * level down, each level narrows the source region to the cells that can still
 * reach the derived chunk, and only their chunks are fetched. The candidate
 * cells of the derived level itself are then inverted exactly
 * (`invertFieldBlock`).
 */

import type { ChunkData } from "#src/sliceview/volume/warp/dependencies.js";
import type { ChunkLayout } from "#src/sliceview/volume/warp/field_box.js";
import {
  assembleFieldBox,
  chunkGridsInBox,
} from "#src/sliceview/volume/warp/field_box.js";
import { invertFieldBlock } from "#src/sliceview/volume/warp/simplex_inverse.js";

/** One level of the stored field. */
export interface StoredFieldLevel extends ChunkLayout {
  lowerVoxelBound: number[];
  // Finest-level index of this level's sample j, per spatial dimension:
  // scale * j + offset.
  scale: number[];
  offset: number[];
  // How far (finest-level index units, per spatial dimension) the finest
  // field can be from this level's interpolation: its maximum interpolation
  // error plus the codec error bounds, or, without that metadata, an assumed
  // one sample of this level (`assumedLevelError`). Undefined: the level is
  // not used to bound.
  error?: number[];
  // The error is assumed, not given by the field's metadata.
  errorAssumed?: boolean;
}

/**
 * The error allowance of a level whose metadata gives none: one sample of the
 * level along each displaced dimension. Not a bound: a field that deviates
 * more from its coarse levels (at tears and folds) may leave small gaps near
 * the edges of derived chunks.
 */
export function assumedLevelError(
  scale: number[],
  displaced: boolean[],
): number[] {
  return scale.map((f, i) => (displaced[i] ? f : 0));
}

export interface DerivedFieldParameters {
  // Stored levels, finest first.
  levels: StoredFieldLevel[];
  // Chunk dimension holding the components.
  vectorDim: number;
  // The 3 spatial chunk dimensions, in component order.
  spatialDims: number[];
  numComponents: number;
  // Per spatial dimension: moved by the field (otherwise a stack of fields
  // along it: passed through).
  displaced: boolean[];
  // Components -> displacement in finest-level index units (row-major 3 x K).
  componentsToFine: number[];
}

/** Fetches chunks (grid positions) of a stored level. */
export type FetchFieldChunks = (
  level: number,
  grids: number[][],
) => Promise<ChunkData[]>;

/** Samples of a stored level over a box, read from its chunks. */
class LevelSamples {
  data: Float32Array;
  lo: number[];
  strides: number[];
  vectorStride: number;

  constructor(
    private p: DerivedFieldParameters,
    private level: number,
    lo: number[],
    hi: number[],
    grids: number[][],
    chunks: ChunkData[],
  ) {
    const L = p.levels[level];
    const fullLo = new Array<number>(L.rank);
    const fullHi = new Array<number>(L.rank);
    fullLo[p.vectorDim] = L.lowerVoxelBound[p.vectorDim];
    fullHi[p.vectorDim] = L.lowerVoxelBound[p.vectorDim] + p.numComponents - 1;
    p.spatialDims.forEach((d, i) => {
      fullLo[d] = lo[i];
      fullHi[d] = hi[i];
    });
    this.data = assembleFieldBox(
      L,
      grids.map((grid) => ({ grid })),
      chunks,
      fullLo,
      fullHi,
    );
    const strides = new Array<number>(L.rank);
    for (let d = 0, m = 1; d < L.rank; ++d) {
      strides[d] = m;
      m *= fullHi[d] - fullLo[d] + 1;
    }
    this.lo = lo;
    this.strides = p.spatialDims.map((d) => strides[d]);
    this.vectorStride = strides[p.vectorDim];
  }

  /** Displacement (finest-level index units) at sample j into out. */
  fine(j0: number, j1: number, j2: number, out: number[]) {
    const { p, data, lo, strides: s, vectorStride: vs } = this;
    const K = p.numComponents;
    const A = p.componentsToFine;
    const k = (j0 - lo[0]) * s[0] + (j1 - lo[1]) * s[1] + (j2 - lo[2]) * s[2];
    for (let d = 0; d < 3; ++d) {
      let v = 0;
      for (let c = 0; c < K; ++c) v += A[d * K + c] * data[k + c * vs];
      out[d] = v;
    }
  }

  get levelIndex() {
    return this.level;
  }
}

function spatialRange(p: DerivedFieldParameters, level: number) {
  const L = p.levels[level];
  const lower = p.spatialDims.map((d) => L.lowerVoxelBound[d]);
  const upper = p.spatialDims.map((d) => L.upperVoxelBound[d]);
  // Cells: between samples along displaced dimensions, samples otherwise.
  const lastCell = upper.map((u, i) =>
    p.displaced[i] ? Math.max(u - 2, lower[i]) : u - 1,
  );
  return { lower, upper, lastCell };
}

async function readLevel(
  p: DerivedFieldParameters,
  level: number,
  lo: number[],
  hi: number[],
  fetch: FetchFieldChunks,
  grids?: number[][],
): Promise<LevelSamples> {
  const L = p.levels[level];
  if (grids === undefined) {
    const fullLo = new Array<number>(L.rank);
    const fullHi = new Array<number>(L.rank);
    fullLo[p.vectorDim] = L.lowerVoxelBound[p.vectorDim];
    fullHi[p.vectorDim] = L.lowerVoxelBound[p.vectorDim] + p.numComponents - 1;
    p.spatialDims.forEach((d, i) => {
      fullLo[d] = lo[i];
      fullHi[d] = hi[i];
    });
    grids = chunkGridsInBox(L, fullLo, fullHi);
  }
  const chunks = await fetch(level, grids);
  return new LevelSamples(p, level, lo, hi, grids, chunks);
}

/**
 * Finest-level index box of cell j of a level, per spatial dimension. Cells
 * at the level's edges reach the finest level's border, which covers the
 * clamping ("nearest") interpolation uses beyond the last samples.
 */
function cellExtent(
  p: DerivedFieldParameters,
  level: number,
  j: ArrayLike<number>,
  lo: number[],
  hi: number[],
) {
  const L = p.levels[level];
  const fine = spatialRange(p, 0);
  const { lower, upper } = spatialRange(p, level);
  for (let i = 0; i < 3; ++i) {
    const f = L.scale[i];
    const o = L.offset[i];
    if (!p.displaced[i]) {
      lo[i] = hi[i] = f * j[i] + o;
      continue;
    }
    lo[i] = j[i] <= lower[i] ? fine.lower[i] : f * j[i] + o;
    hi[i] =
      j[i] + 1 >= upper[i] - 1
        ? fine.upper[i] - 1
        : f * Math.min(j[i] + 1, upper[i] - 1) + o;
  }
}

/** Kept cells of a level, as their finest-level extents. */
interface Extents {
  lo: Float64Array; // n x 3
  hi: Float64Array;
  count: number;
}

/**
 * Of the given cells of a level, those whose image box meets the target box
 * (finest-level index units), as finest-level extents.
 */
function keepCells(
  p: DerivedFieldParameters,
  samples: LevelSamples,
  cells: Int32Array,
  count: number,
  err: number[],
  tLo: number[],
  tHi: number[],
): Extents {
  const level = samples.levelIndex;
  const { upper } = spatialRange(p, level);
  const lo = new Float64Array(3 * count);
  const hi = new Float64Array(3 * count);
  let kept = 0;
  const elo = [0, 0, 0];
  const ehi = [0, 0, 0];
  const u = [0, 0, 0];
  const umin = [0, 0, 0];
  const umax = [0, 0, 0];
  const j = [0, 0, 0];
  for (let n = 0; n < count; ++n) {
    j[0] = cells[3 * n];
    j[1] = cells[3 * n + 1];
    j[2] = cells[3 * n + 2];
    cellExtent(p, level, j, elo, ehi);
    umin.fill(Infinity);
    umax.fill(-Infinity);
    for (let c = 0; c < 8; ++c) {
      const k = [0, 1, 2].map((i) =>
        p.displaced[i] && (c >> (2 - i)) & 1
          ? Math.min(j[i] + 1, upper[i] - 1)
          : j[i],
      );
      samples.fine(k[0], k[1], k[2], u);
      for (let i = 0; i < 3; ++i) {
        if (u[i] < umin[i]) umin[i] = u[i];
        if (u[i] > umax[i]) umax[i] = u[i];
      }
    }
    let meets = true;
    for (let i = 0; i < 3; ++i) {
      const a = elo[i] + umin[i] - err[i];
      const b = ehi[i] + umax[i] + err[i];
      if (b < tLo[i] || a > tHi[i]) {
        meets = false;
        break;
      }
    }
    if (!meets) continue;
    for (let i = 0; i < 3; ++i) {
      lo[3 * kept + i] = elo[i];
      hi[3 * kept + i] = ehi[i];
    }
    ++kept;
  }
  return { lo, hi, count: kept };
}

/** The cells of a level whose extent meets any of the extents. */
function cellsUnder(
  p: DerivedFieldParameters,
  level: number,
  parents: Extents,
): { cells: Int32Array; count: number; lo: number[]; hi: number[] } {
  const L = p.levels[level];
  const { lower, lastCell } = spatialRange(p, level);
  const ranges = new Int32Array(6 * parents.count);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < parents.count; ++n) {
    for (let i = 0; i < 3; ++i) {
      const a = (parents.lo[3 * n + i] - L.offset[i]) / L.scale[i];
      const b = (parents.hi[3 * n + i] - L.offset[i]) / L.scale[i];
      let j0 = p.displaced[i] ? Math.ceil(a) - 1 : Math.ceil(a);
      let j1 = Math.floor(b);
      j0 = Math.min(Math.max(j0, lower[i]), lastCell[i]);
      j1 = Math.min(Math.max(j1, lower[i]), lastCell[i]);
      ranges[6 * n + i] = j0;
      ranges[6 * n + 3 + i] = j1;
      lo[i] = Math.min(lo[i], j0);
      hi[i] = Math.max(hi[i], j1);
    }
  }
  if (parents.count === 0) {
    return { cells: new Int32Array(0), count: 0, lo, hi };
  }
  const size = [0, 1, 2].map((i) => hi[i] - lo[i] + 1);
  const mask = new Uint8Array(size[0] * size[1] * size[2]);
  for (let n = 0; n < parents.count; ++n) {
    for (let j2 = ranges[6 * n + 2]; j2 <= ranges[6 * n + 5]; ++j2) {
      for (let j1 = ranges[6 * n + 1]; j1 <= ranges[6 * n + 4]; ++j1) {
        const row = size[0] * (j1 - lo[1] + size[1] * (j2 - lo[2])) - lo[0];
        mask.fill(1, row + ranges[6 * n], row + ranges[6 * n + 3] + 1);
      }
    }
  }
  let count = 0;
  for (const m of mask) count += m;
  const cells = new Int32Array(3 * count);
  let n = 0;
  for (let k = 0; k < mask.length; ++k) {
    if (mask[k] === 0) continue;
    cells[3 * n] = lo[0] + (k % size[0]);
    cells[3 * n + 1] = lo[1] + (Math.floor(k / size[0]) % size[1]);
    cells[3 * n + 2] = lo[2] + Math.floor(k / (size[0] * size[1]));
    ++n;
  }
  return { cells, count, lo, hi };
}

/** Chunk grid positions holding the corner samples of the cells. */
function cellChunks(
  p: DerivedFieldParameters,
  level: number,
  cells: Int32Array,
  count: number,
): number[][] {
  const L = p.levels[level];
  const { upper } = spatialRange(p, level);
  const { chunkDataSize: cds, baseVoxelOffset: base } = L;
  const vLo = Math.floor(
    (L.lowerVoxelBound[p.vectorDim] - base[p.vectorDim]) / cds[p.vectorDim],
  );
  const vHi = Math.floor(
    (L.lowerVoxelBound[p.vectorDim] + p.numComponents - 1 - base[p.vectorDim]) /
      cds[p.vectorDim],
  );
  const seen = new Map<string, number[]>();
  const g0 = [0, 0, 0];
  const g1 = [0, 0, 0];
  for (let n = 0; n < count; ++n) {
    for (let i = 0; i < 3; ++i) {
      const d = p.spatialDims[i];
      const j = cells[3 * n + i];
      const k = p.displaced[i] ? Math.min(j + 1, upper[i] - 1) : j;
      g0[i] = Math.floor((j - base[d]) / cds[d]);
      g1[i] = Math.floor((k - base[d]) / cds[d]);
    }
    for (let a = g0[0]; a <= g1[0]; ++a) {
      for (let b = g0[1]; b <= g1[1]; ++b) {
        for (let c = g0[2]; c <= g1[2]; ++c) {
          for (let v = vLo; v <= vHi; ++v) {
            const grid = new Array<number>(L.rank);
            grid[p.spatialDims[0]] = a;
            grid[p.spatialDims[1]] = b;
            grid[p.spatialDims[2]] = c;
            grid[p.vectorDim] = v;
            const key = grid.join();
            if (!seen.has(key)) seen.set(key, grid);
          }
        }
      }
    }
  }
  return [...seen.values()];
}

/** The levels that bound the search: coarser than `level`, error known. */
function boundingLevels(p: DerivedFieldParameters, level: number) {
  const out: number[] = [];
  for (let m = p.levels.length - 1; m > level; --m) {
    if (p.levels[m].error !== undefined) out.push(m);
  }
  return out;
}

function allCells(p: DerivedFieldParameters, level: number) {
  const { lower, lastCell } = spatialRange(p, level);
  const size = [0, 1, 2].map((i) => lastCell[i] - lower[i] + 1);
  const count = size[0] * size[1] * size[2];
  const cells = new Int32Array(3 * count);
  let n = 0;
  for (let j2 = lower[2]; j2 <= lastCell[2]; ++j2) {
    for (let j1 = lower[1]; j1 <= lastCell[1]; ++j1) {
      for (let j0 = lower[0]; j0 <= lastCell[0]; ++j0) {
        cells[3 * n] = j0;
        cells[3 * n + 1] = j1;
        cells[3 * n + 2] = j2;
        ++n;
      }
    }
  }
  return { cells, count };
}

export interface SourceBoxPlan {
  // Sample box of the derived level's stored level, inclusive; undefined if
  // no cell reaches the target.
  lo?: number[];
  hi?: number[];
  // Stored chunks fetched to bound it, per level (for diagnostics).
  fetched: Map<number, number>;
}

/**
 * The sample box of stored level `level` that can map into the target box
 * (finest-level index units, inclusive), found by walking the coarser levels.
 */
export async function planSourceBox(
  p: DerivedFieldParameters,
  level: number,
  tLo: number[],
  tHi: number[],
  fetch: FetchFieldChunks,
): Promise<SourceBoxPlan> {
  const fetched = new Map<number, number>();
  const counted: FetchFieldChunks = (m, grids) => {
    fetched.set(m, (fetched.get(m) ?? 0) + grids.length);
    return fetch(m, grids);
  };
  const { lower, upper, lastCell } = spatialRange(p, level);
  const walk = boundingLevels(p, level);
  if (walk.length === 0) {
    // Nothing to bound with: the whole level.
    return {
      lo: lower,
      hi: upper.map((u) => u - 1),
      fetched,
    };
  }
  let parents: Extents | undefined;
  for (const m of walk) {
    let cells: Int32Array;
    let count: number;
    let samples: LevelSamples;
    if (parents === undefined) {
      ({ cells, count } = allCells(p, m));
      const r = spatialRange(p, m);
      samples = await readLevel(
        p,
        m,
        r.lower,
        r.upper.map((u) => u - 1),
        counted,
      );
    } else {
      const under = cellsUnder(p, m, parents);
      ({ cells, count } = under);
      if (count === 0) return { fetched };
      const r = spatialRange(p, m);
      const sHi = under.hi.map((h, i) =>
        p.displaced[i] ? Math.min(h + 1, r.upper[i] - 1) : h,
      );
      samples = await readLevel(
        p,
        m,
        under.lo,
        sHi,
        counted,
        cellChunks(p, m, cells, count),
      );
    }
    parents = keepCells(p, samples, cells, count, p.levels[m].error!, tLo, tHi);
    if (parents.count === 0) return { fetched };
  }
  const under = cellsUnder(p, level, parents!);
  if (under.count === 0) return { fetched };
  return {
    lo: under.lo,
    hi: under.hi.map((h, i) =>
      p.displaced[i] ? Math.min(h + 1, upper[i] - 1) : Math.min(h, lastCell[i]),
    ),
    fetched,
  };
}

/**
 * Where the stored field maps to (finest-level index units, per spatial
 * dimension): the box of every cell's image at the coarsest level that bounds,
 * grown by its error (or of the finest level, exactly).
 */
export async function derivedFieldDomain(
  p: DerivedFieldParameters,
  fetch: FetchFieldChunks,
): Promise<{ lo: number[]; hi: number[] }> {
  const walk = boundingLevels(p, 0);
  const m = walk.length > 0 ? walk[0] : 0;
  const err = m === 0 ? [0, 0, 0] : p.levels[m].error!;
  const r = spatialRange(p, m);
  const samples = await readLevel(
    p,
    m,
    r.lower,
    r.upper.map((u) => u - 1),
    fetch,
  );
  const { cells, count } = allCells(p, m);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const elo = [0, 0, 0];
  const ehi = [0, 0, 0];
  const u = [0, 0, 0];
  for (let n = 0; n < count; ++n) {
    const j = cells.subarray(3 * n, 3 * n + 3);
    cellExtent(p, m, j, elo, ehi);
    for (let c = 0; c < 8; ++c) {
      const k = [0, 1, 2].map((i) =>
        p.displaced[i] && (c >> (2 - i)) & 1
          ? Math.min(j[i] + 1, r.upper[i] - 1)
          : j[i],
      );
      samples.fine(k[0], k[1], k[2], u);
      for (let i = 0; i < 3; ++i) {
        lo[i] = Math.min(lo[i], elo[i] + u[i] - err[i]);
        hi[i] = Math.max(hi[i], ehi[i] + u[i] + err[i]);
      }
    }
  }
  return { lo, hi };
}

export interface DerivedChunk {
  // Components at each target point (component-major, then the spatial
  // dimensions in order, first fastest); NaN where no cell reaches.
  components: Float32Array;
  folds: number;
  plan: SourceBoxPlan;
}

/**
 * The derived field at the target points tLo + [0, tSize) of stored level
 * `level`'s lattice (spatial dimensions, in order).
 */
export async function deriveFieldChunk(
  p: DerivedFieldParameters,
  level: number,
  tLo: number[],
  tSize: number[],
  fetch: FetchFieldChunks,
): Promise<DerivedChunk> {
  const L = p.levels[level];
  const K = p.numComponents;
  const n = tSize[0] * tSize[1] * tSize[2];
  const fineLo = [0, 1, 2].map((i) => L.scale[i] * tLo[i] + L.offset[i]);
  const fineHi = [0, 1, 2].map(
    (i) => L.scale[i] * (tLo[i] + tSize[i] - 1) + L.offset[i],
  );
  const plan = await planSourceBox(p, level, fineLo, fineHi, fetch);
  const components = new Float32Array(K * n).fill(NaN);
  if (plan.lo === undefined) return { components, folds: 0, plan };
  const sLo = plan.lo;
  const sHi = plan.hi!;
  const samples = await readLevel(p, level, sLo, sHi, (m, grids) => {
    plan.fetched.set(m, (plan.fetched.get(m) ?? 0) + grids.length);
    return fetch(m, grids);
  });
  // The block, displacements in this level's index units.
  const size = [0, 1, 2].map((i) => sHi[i] - sLo[i] + 1);
  const count = size[0] * size[1] * size[2];
  const data = new Float32Array(3 * count);
  const u = [0, 0, 0];
  let k = 0;
  for (let j2 = sLo[2]; j2 <= sHi[2]; ++j2) {
    for (let j1 = sLo[1]; j1 <= sHi[1]; ++j1) {
      for (let j0 = sLo[0]; j0 <= sHi[0]; ++j0, ++k) {
        samples.fine(j0, j1, j2, u);
        data[k] = u[0] / L.scale[0];
        data[count + k] = u[1] / L.scale[1];
        data[2 * count + k] = u[2] / L.scale[2];
      }
    }
  }
  const inverse = invertFieldBlock(
    {
      data,
      size,
      strides: [1, size[0], size[0] * size[1]],
      componentOffsets: [0, count, 2 * count],
      origin: sLo,
    },
    tLo,
    tSize,
    p.displaced,
  );
  // Back to components: finest-level units, then the inverse of
  // componentsToFine.
  const toComponents = fineToComponents(p);
  const w = inverse.displacement;
  for (let t = 0; t < n; ++t) {
    if (inverse.covered[t] === 0) continue;
    const w0 = w[t] * L.scale[0];
    const w1 = w[n + t] * L.scale[1];
    const w2 = w[2 * n + t] * L.scale[2];
    for (let c = 0; c < K; ++c) {
      components[c * n + t] =
        toComponents[c * 3] * w0 +
        toComponents[c * 3 + 1] * w1 +
        toComponents[c * 3 + 2] * w2;
    }
  }
  return { components, folds: inverse.folds, plan };
}

/** K x 3 (row-major): the inverse of componentsToFine (K = 3). */
export function fineToComponents(p: DerivedFieldParameters): number[] {
  if (p.numComponents !== 3) {
    throw new Error(
      `warp: deriving a field needs 3 components, not ${p.numComponents}`,
    );
  }
  const a = p.componentsToFine;
  const det =
    a[0] * (a[4] * a[8] - a[5] * a[7]) -
    a[1] * (a[3] * a[8] - a[5] * a[6]) +
    a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-12) {
    throw new Error("warp: the field's components are not independent");
  }
  return [
    (a[4] * a[8] - a[5] * a[7]) / det,
    (a[2] * a[7] - a[1] * a[8]) / det,
    (a[1] * a[5] - a[2] * a[4]) / det,
    (a[5] * a[6] - a[3] * a[8]) / det,
    (a[0] * a[8] - a[2] * a[6]) / det,
    (a[2] * a[3] - a[0] * a[5]) / det,
    (a[3] * a[7] - a[4] * a[6]) / det,
    (a[1] * a[6] - a[0] * a[7]) / det,
    (a[0] * a[4] - a[1] * a[3]) / det,
  ];
}

/** A level of a derived field: chunks computed in the worker. */
export class DerivedFieldChunkSourceParameters {
  derived: DerivedFieldParameters;
  // rpcId of each stored level's volume chunk source, finest first.
  sources: number[];
  // The stored level this derived level inverts.
  level: number;
  // Per spatial dimension: stored index = derived index + offset.
  offset: number[];
  static RPC_ID = "warp/DerivedFieldChunkSource";
}

// Where a stored field maps to (`derivedFieldDomain`), computed once when the
// derived field is made.
export const DERIVED_FIELD_DOMAIN_RPC_ID = "warp/derivedFieldDomain";
