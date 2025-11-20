import { describe, it, expect, vi, beforeEach } from "vitest";
import { mat4 } from "#src/util/geom.js";
import { VoxelEditController } from "#src/voxel_annotation/edit_backend.js";
import type { RPC } from "#src/worker_rpc.js";

const mockRpc = {
  get: vi.fn(),
  invoke: vi.fn(),
  newId: () => 0,
  register: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
} as unknown as RPC;

const resConfig = (
  lod: number,
  scale: [number, number, number],
  chunkSize: [number, number, number],
  translation: [number, number, number] = [0, 0, 0],
) => {
  const transform = new Float32Array(16);
  mat4.identity(transform as unknown as mat4);
  mat4.translate(
    transform as unknown as mat4,
    transform as unknown as mat4,
    translation as any,
  );
  mat4.scale(
    transform as unknown as mat4,
    transform as unknown as mat4,
    scale as any,
  );
  return {
    lodIndex: lod,
    transform: Array.from(transform),
    chunkSize,
    sourceRpc: 100 + lod,
  };
};

type Grid3D = (number | bigint)[][][]; // Z -> Y -> X

function flattenGrid(grid: Grid3D, Ctor: any = Uint32Array) {
  const d = grid.length;
  const h = grid[0].length;
  const w = grid[0][0].length;
  const data = new Ctor(w * h * d);

  for (let z = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        data[x + y * w + z * w * h] = grid[z][y][x];
      }
    }
  }
  return { data, size: [w, h, d] as [number, number, number] };
}

describe("VoxelEditController: _calculateParentUpdate", () => {
  let controller: VoxelEditController;
  let runDownsample: Function;

  beforeEach(() => {
    vi.resetAllMocks();
    (mockRpc.get as any).mockImplementation((id: number) => ({
      rpcId: id,
      spec: { rank: 3, chunkDataSize: new Uint32Array([2, 2, 2]), dataType: 0 },
    }));
  });

  const runScenario = (
    scale: [number, number, number],
    parentChunkSize: [number, number, number],
    inputGrid: Grid3D,
    expectedUpdates: {
      x: number;
      y: number;
      z: number;
      val: number | bigint;
    }[],
    childChunkOffset: { x: number; y: number; z: number } = {
      x: 0,
      y: 0,
      z: 0,
    },
    dataCtor: any = Uint32Array,
    translation: [number, number, number] = [0, 0, 0],
  ) => {
    const { data: childData, size: childSize } = flattenGrid(
      inputGrid,
      dataCtor,
    );

    const childRes = resConfig(0, [1, 1, 1], childSize);
    const parentRes = resConfig(1, scale, parentChunkSize, translation);
    controller = new VoxelEditController(mockRpc, {
      resolutions: [childRes, parentRes],
    });
    runDownsample = (controller as any)._calculateParentUpdate.bind(controller);

    const result = runDownsample(
      childData,
      (controller as any).resolutions.get(0),
      (controller as any).resolutions.get(1),
      childChunkOffset,
    );

    const [pw, ph, pd] = parentChunkSize;
    const actualUpdatesMap = new Map<string, bigint>();

    for (let i = 0; i < result.indices.length; i++) {
      const idx = result.indices[i];
      const val = result.values[i];
      const maxIdx = pw * ph * pd;
      expect(idx).toBeLessThan(maxIdx);
      expect(idx).toBeGreaterThanOrEqual(0);

      const pz = Math.floor(idx / (pw * ph));
      const rem = idx % (pw * ph);
      const py = Math.floor(rem / pw);
      const px = rem % pw;
      actualUpdatesMap.set(`${px},${py},${pz}`, BigInt(val));
    }

    for (const { x, y, z, val } of expectedUpdates) {
      const key = `${x},${y},${z}`;
      const actual = actualUpdatesMap.get(key);
      expect(actual, `Missing update at Parent(${x},${y},${z})`).toBeDefined();
      expect(actual, `Incorrect value at Parent(${x},${y},${z})`).toBe(
        BigInt(val),
      );
      actualUpdatesMap.delete(key);
    }

    if (actualUpdatesMap.size > 0) {
      const extras = Array.from(actualUpdatesMap.entries())
        .map(([k, v]) => `(${k}): ${v}`)
        .join(", ");
      throw new Error(`Unexpected updates at: ${extras}`);
    }
  };

  it("Standard 2x2x2 Downsampling", () => {
    runScenario(
      [2, 2, 2],
      [2, 2, 2],
      [
        [
          [1, 1, 2, 2],
          [1, 1, 2, 3],
          [4, 4, 0, 0],
          [4, 4, 0, 0],
        ],
        [
          [1, 1, 2, 2],
          [1, 1, 3, 3],
          [4, 4, 0, 0],
          [4, 4, 0, 0],
        ],
        [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ],
        [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ],
      ],
      [
        { x: 0, y: 0, z: 0, val: 1 },
        { x: 1, y: 0, z: 0, val: 2 },
        { x: 0, y: 1, z: 0, val: 4 },
        { x: 1, y: 1, z: 0, val: 0 },
        { x: 0, y: 0, z: 1, val: 0 },
        { x: 1, y: 0, z: 1, val: 0 },
        { x: 0, y: 1, z: 1, val: 0 },
        { x: 1, y: 1, z: 1, val: 0 },
      ],
    );
  });

  it("Anisotropic 1x2x1", () => {
    runScenario(
      [1, 2, 1],
      [2, 2, 2],
      [
        [
          [5, 5],
          [5, 5],
          [6, 6],
          [7, 7],
        ],
        [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ],
      ],
      [
        { x: 0, y: 0, z: 0, val: 5 },
        { x: 1, y: 0, z: 0, val: 5 },
        { x: 0, y: 1, z: 0, val: 6 },
        { x: 1, y: 1, z: 0, val: 6 },
        { x: 0, y: 0, z: 1, val: 0 },
        { x: 1, y: 0, z: 1, val: 0 },
        { x: 0, y: 1, z: 1, val: 0 },
        { x: 1, y: 1, z: 1, val: 0 },
      ],
    );
  });

  it("Odd Factors: 3x2x5", () => {
    runScenario(
      [3, 2, 5],
      [3, 3, 1],
      [
        [
          [1, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ],
        [
          [0, 0, 0, 2],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ],
        [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 3, 0, 0],
          [0, 0, 0, 0],
        ],
        [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 4, 0],
        ],
      ],
      [
        { x: 0, y: 0, z: 0, val: 1 },
        { x: 1, y: 0, z: 0, val: 2 },
        { x: 0, y: 1, z: 0, val: 3 },
        { x: 1, y: 1, z: 0, val: 0 },
      ],
    );
  });

  it("Erasure: Single non-zero pixel cleared", () => {
    runScenario(
      [2, 2, 1],
      [1, 1, 2],
      [
        [
          [0, 0],
          [0, 0],
        ],
        [
          [0, 0],
          [0, 0],
        ],
      ],
      [
        { x: 0, y: 0, z: 0, val: 0 },
        { x: 0, y: 0, z: 1, val: 0 },
      ],
    );
  });

  it("Offset Parent: Update at z=6", () => {
    runScenario(
      [2, 2, 2],
      [4, 4, 8],
      [
        [
          [99, 99],
          [99, 99],
        ],
        [
          [99, 99],
          [99, 99],
        ],
      ],
      [{ x: 2, y: 2, z: 6, val: 99 }],
      { x: 2, y: 2, z: 6 },
    );
  });

  it("BigUint64Array: Supports large integers > 2^53", () => {
    const bigVal = BigInt(Number.MAX_SAFE_INTEGER) + 50n;
    runScenario(
      [2, 2, 2],
      [2, 2, 2],
      [
        [
          [bigVal, bigVal],
          [bigVal, bigVal],
        ],
      ],
      [{ x: 0, y: 0, z: 0, val: bigVal }],
      { x: 0, y: 0, z: 0 },
      BigUint64Array,
    );
  });

  it("Uint8Array: Supports lower precision types", () => {
    runScenario(
      [2, 2, 2],
      [2, 2, 2],
      [
        [
          [255, 255],
          [255, 255],
        ],
      ],
      [{ x: 0, y: 0, z: 0, val: 255 }],
      { x: 0, y: 0, z: 0 },
      Uint8Array,
    );
  });

  it("Tie Breaking: Lowest value wins when counts are equal", () => {
    runScenario(
      [2, 2, 1],
      [2, 2, 1],
      [
        [
          [10, 10],
          [5, 5],
        ],
      ],
      [{ x: 0, y: 0, z: 0, val: 5 }],
    );
  });

  it("Non-Zero Dominance: 0 only wins if all values are 0", () => {
    runScenario(
      [2, 2, 1],
      [2, 2, 1],
      [
        [
          [0, 0],
          [0, 9],
        ],
      ],
      [{ x: 0, y: 0, z: 0, val: 9 }],
    );
  });

  it("Matrix Translation: Handles misaligned grids", () => {
    runScenario(
      [1, 1, 1],
      [4, 1, 1],
      [[[42]]],
      [{ x: 2, y: 0, z: 0, val: 42 }],
      { x: 0, y: 0, z: 0 },
      Uint32Array,
      [-2, 0, 0],
    );
  });
});
