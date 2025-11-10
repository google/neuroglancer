/**
 * Vox map configuration and registry. Central place to compute and store LOD steps.
 * No clamping is applied to the step computation: we simply multiply by `step`
 * until the per-slice chunk budget is satisfied, then generate [1, step, ..., S].
 */

import { DataType } from "#src/util/data_type.js";

export interface VoxMapConfig {
  id: string;
  name?: string;
  // Inclusive-exclusive bounds in voxel coordinates: [baseOffset, upperBound)
  baseVoxelOffset: Float32Array | number[];
  upperVoxelBound: Float32Array | number[];
  // Chunking and scale
  chunkDataSize: Uint32Array | number[];
  // Data type of the voxel labels (default: uint32)
  dataType: number;
  scaleMeters: Float64Array | number[]; // physical voxel size in meters
  unit: string; // convenience for UI
  // Fixed LOD steps (factors), finest → coarsest, starting at 1.
  steps: number[];
  // Optional original data source URL for on-demand import of base labels (e.g., precomputed://, zarr://, n5://)
  importUrl?: string;
  // Legacy/obsolete remote server fields retained for backward compatibility. Do not use.
  serverUrl?: string;
  token?: string;
}

/**
 * Compute LOD factors based on bounds and a per-slice chunk budget.
 * - step: multiplicative step between levels (e.g., 2)
 * - maxChunksPerSlice: approximate chunk budget for XY slice.
 *
 * Returns [1, step, ..., S] where S is the smallest factor that satisfies the budget.
 */
export function computeSteps(
  bounds: readonly number[] | Float32Array,
  chunkDataSize: readonly number[] | Uint32Array,
  step = 2,
  maxChunksPerSlice = 256,
): number[] {
  const bx = Math.max(0, Math.floor(bounds[0] ?? 0));
  const by = Math.max(0, Math.floor(bounds[1] ?? 0));
  const cx = Math.max(1, Math.floor(chunkDataSize[0] ?? 1));
  const cy = Math.max(1, Math.floor(chunkDataSize[1] ?? 1));

  const withinBudget = (factor: number) => {
    const chunksX = Math.ceil((bx / Math.max(1, factor)) / cx);
    const chunksY = Math.ceil((by / Math.max(1, factor)) / cy);
    const chunkCount2D = (chunksX || 0) * (chunksY || 0);
    return chunkCount2D <= maxChunksPerSlice;
  };

  let S = 1;
  while (!withinBudget(S)) S *= Math.max(1, step);

  const factors: number[] = [];
  for (let f = 1; f <= S; f *= Math.max(1, step)) factors.push(f);
  if (factors.length === 0) factors.push(1);
  return factors;
}

function toTripleArray(name: string, v: ArrayLike<number>): [number, number, number] {
  const a = Array.from(v).map((x) => Number(x));
  if (a.length !== 3) {
    throw new Error(`${name} must have length 3, got ${a.length}`);
  }
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(a[i])) {
      throw new Error(`${name}[${i}] must be a finite number`);
    }
  }
  return [a[0], a[1], a[2]];
}

function validateSteps(steps?: number[]): number[] | undefined {
  if (!steps) return undefined;
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  for (let i = 0; i < steps.length; i++) {
    const f = steps[i];
    if (!Number.isInteger(f) || f <= 0) {
      throw new Error(`steps[${i}] must be a positive integer`);
    }
    if (i === 0 && f !== 1) {
      throw new Error(`steps must start at 1`);
    }
    if (i > 0 && f <= steps[i - 1]) {
      throw new Error(`steps must be strictly increasing`);
    }
  }
  return steps;
}

export type VoxMapInput = {
  id: string;
  name?: string;
  baseVoxelOffset: ArrayLike<number>;
  upperVoxelBound: ArrayLike<number>;
  chunkDataSize: ArrayLike<number>;
  dataType: number;
  scaleMeters: ArrayLike<number>;
  unit: string;
  steps?: number[];
  importUrl?: string;
  serverUrl?: string;
  token?: string;
};

export function constructVoxMapConfig(input: VoxMapInput): VoxMapConfig {
  if (!input || typeof input !== "object") {
    throw new Error("constructVoxMapConfig: input is required");
  }
  const id = String(input.id || "").trim();
  if (id.length === 0) throw new Error("constructVoxMapConfig: id is required");
  const name = input.name ? String(input.name) : undefined;

  const [bx, by, bz] = toTripleArray("baseVoxelOffset", input.baseVoxelOffset);
  const [ux, uy, uz] = toTripleArray("upperVoxelBound", input.upperVoxelBound);
  if (!(ux > bx && uy > by && uz > bz)) {
    throw new Error("upperVoxelBound must be strictly greater than baseVoxelOffset in all dimensions");
  }

  const [cx, cy, cz] = toTripleArray("chunkDataSize", input.chunkDataSize);
  const cds = new Uint32Array([
    Math.max(1, Math.floor(cx)),
    Math.max(1, Math.floor(cy)),
    Math.max(1, Math.floor(cz)),
  ]);

  const scale = toTripleArray("scaleMeters", input.scaleMeters);
  if (!(scale[0] > 0 && scale[1] > 0 && scale[2] > 0)) {
    throw new Error("scaleMeters must be positive in all dimensions");
  }

  const dt = Number(input.dataType);
  if (!Number.isInteger(dt) || dt < DataType.UINT8 || dt > DataType.FLOAT32) {
    throw new Error("Invalid dataType");
  }

  const lower = new Float32Array([Math.floor(bx), Math.floor(by), Math.floor(bz)]);
  const upper = new Float32Array([Math.floor(ux), Math.floor(uy), Math.floor(uz)]);
  const bounds = [upper[0] - lower[0], upper[1] - lower[1], upper[2] - lower[2]];

  const steps = validateSteps(input.steps) ?? computeSteps(bounds, cds);

  const unit = String(input.unit);
  if (unit.length === 0) throw new Error("unit is required");

  return {
    id,
    name,
    baseVoxelOffset: lower,
    upperVoxelBound: upper,
    chunkDataSize: cds,
    dataType: dt,
    scaleMeters: new Float64Array(scale),
    unit,
    steps,
    importUrl: input.importUrl,
    serverUrl: input.serverUrl,
    token: input.token,
  };
}

export function validateVoxMapConfig(map: VoxMapConfig): VoxMapConfig {
  return constructVoxMapConfig(map as unknown as VoxMapInput);
}

/** Simple in-memory registry to hold current map selection and list. */
export class VoxMapRegistry {
  private current?: VoxMapConfig;
  private maps: VoxMapConfig[] = [];

  setCurrent(map: VoxMapConfig | undefined) {
    this.current = map;
    if (map && !this.maps.find((m) => m.id === map.id)) this.maps.push(map);
  }

  getCurrent(): VoxMapConfig | undefined {
    return this.current;
  }

  upsert(map: VoxMapConfig) {
    const idx = this.maps.findIndex((m) => m.id === map.id);
    if (idx >= 0) this.maps[idx] = map; else this.maps.push(map);
  }

  list(): VoxMapConfig[] {
    return [...this.maps];
  }
}
