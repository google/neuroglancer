/**
 * Vox map configuration and registry. Central place to compute and store LOD steps.
 * No clamping is applied to the step computation: we simply multiply by `step`
 * until the per-slice chunk budget is satisfied, then generate [1, step, ..., S].
 */

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
  // Optional remote info for convenience
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
