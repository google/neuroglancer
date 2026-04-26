import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChunkState } from "#src/chunk_manager/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { DATA_TYPE_ARRAY_CONSTRUCTOR, DataType } from "#src/util/data_type.js";
import { mat4 } from "#src/util/geom.js";
import { VoxelEditController } from "#src/voxel_annotation/backend.js";
import {
  makeVoxChunkKey,
  VOX_EDIT_FAILURE_RPC_ID,
  VOX_EDIT_HISTORY_UPDATE_RPC_ID,
  VoxelOperationType,
  BrushShape,
} from "#src/voxel_annotation/base.js";
import type { RPC } from "#src/worker_rpc.js";

const mockQueueManager = {
  sources: new Set(),
  adjustCapacitiesForChunk: vi.fn(),
  updateChunkState: vi.fn(),
  scheduleUpdate: vi.fn(),
  moveChunkToFrontend: vi.fn(),
  markRecentlyUsed: vi.fn(),
  gl: {},
};

const mockChunkManager = {
  queueManager: mockQueueManager,
  chunkQueueManager: mockQueueManager,
  rpc: null,
  memoize: { get: (_k: string, fn: Function) => fn() },
};

const mockRpc = {
  get: vi.fn(),
  invoke: vi.fn(),
  newId: () => 0,
  register: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
} as unknown as RPC;

const MOCK_SPEC = {
  rank: 3,
  chunkDataSize: new Uint32Array([2, 2, 2]),
  dataType: 0,
  lowerVoxelBound: new Float32Array([0, 0, 0]),
  upperVoxelBound: new Float32Array([100, 100, 100]),
  baseVoxelOffset: new Float32Array([0, 0, 0]),
  fillValue: 0,
};

class MockBackendSource extends VolumeChunkSource {
  public serverStorage = new Map<string, ArrayBuffer>();

  async download(chunk: VolumeChunk) {
    const key = chunk.chunkGridPosition.join(",");
    if (this.serverStorage.has(key)) {
      const buffer = this.serverStorage.get(key)!;
      const Ctor = DATA_TYPE_ARRAY_CONSTRUCTOR[this.spec.dataType];
      chunk.data = new Ctor(buffer.slice(0));
    }
  }

  async writeChunk(chunk: VolumeChunk) {
    const key = chunk.chunkGridPosition.join(",");
    if (chunk.data) {
      this.serverStorage.set(key, chunk.data.buffer.slice(0) as ArrayBuffer);
    }
  }
}

const createMockSource = (specOverride: any = {}) => {
  const source = new MockBackendSource(mockRpc, {
    spec: { ...MOCK_SPEC, ...specOverride },
    chunkManager: 0,
  });
  vi.spyOn(source, "getChunk");
  vi.spyOn(source, "applyEdits");
  vi.spyOn(source, "download");
  vi.spyOn(source, "writeChunk");
  return source;
};

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
    (mockRpc.get as any).mockImplementation((id: number) => {
      if (id === 0) return mockChunkManager;
      const source = createMockSource();
      source.rpcId = id;
      return source;
    });
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
      childSize,
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

  it("Fractional Scale: Aggregates across fractional boundaries (2.5x)", () => {
    runScenario(
      [2.5, 1, 1],
      [2, 1, 1],
      [[[1, 1, 2, 2, 2]]],
      [
        { x: 0, y: 0, z: 0, val: 1 },
        { x: 1, y: 0, z: 0, val: 2 },
      ],
    );
  });
});

describe("VoxelEditController: _getParentChunkInfo", () => {
  let controller: VoxelEditController;

  const setupController = (resConfigs: any[]) => {
    (mockRpc.get as any).mockImplementation((id: number) => {
      if (id === 0) return mockChunkManager;
      const source = createMockSource();
      source.rpcId = id;
      return source;
    });
    controller = new VoxelEditController(mockRpc, { resolutions: resConfigs });
    return controller;
  };

  it("Standard Alignment: 2x scaling", () => {
    const childRes = resConfig(0, [1, 1, 1], [4, 4, 4]);
    const parentRes = resConfig(1, [2, 2, 2], [4, 4, 4]);

    setupController([childRes, parentRes]);
    const getInfo = (controller as any)._getParentChunkInfo.bind(controller);

    let res = getInfo(makeVoxChunkKey("0,0,0", 0), childRes);
    expect(res.chunkKey).toBe("0,0,0");
    expect(res.parentKey).toBe(makeVoxChunkKey("0,0,0", 1));

    res = getInfo(makeVoxChunkKey("1,0,0", 0), childRes);
    expect(res.chunkKey).toBe("0,0,0");

    res = getInfo(makeVoxChunkKey("2,0,0", 0), childRes);
    expect(res.chunkKey).toBe("1,0,0");
  });

  it("Matrix Translation: Parent Origin Shift", () => {
    const childRes = resConfig(0, [1, 1, 1], [4, 4, 4]);
    const parentRes = resConfig(1, [1, 1, 1], [4, 4, 4], [-4, 0, 0]);

    setupController([childRes, parentRes]);
    const getInfo = (controller as any)._getParentChunkInfo.bind(controller);

    const res = getInfo(makeVoxChunkKey("0,0,0", 0), childRes);
    expect(res.chunkKey).toBe("1,0,0");
  });

  it("Negative Coordinates", () => {
    const childRes = resConfig(0, [1, 1, 1], [4, 4, 4]);
    const parentRes = resConfig(1, [1, 1, 1], [4, 4, 4]);

    setupController([childRes, parentRes]);
    const getInfo = (controller as any)._getParentChunkInfo.bind(controller);

    const res = getInfo(makeVoxChunkKey("-1,-1,-1", 0), childRes);
    expect(res.chunkKey).toBe("-1,-1,-1");
  });

  it("Max LOD Boundary", () => {
    const childRes = resConfig(0, [1, 1, 1], [4, 4, 4]);
    setupController([childRes]);
    const getInfo = (controller as any)._getParentChunkInfo.bind(controller);

    const res = getInfo(makeVoxChunkKey("0,0,0", 0), childRes);
    expect(res).toBeNull();
  });

  it("Odd Integer Scale (3x)", () => {
    const childRes = resConfig(0, [1, 1, 1], [2, 2, 2]);
    const parentRes = resConfig(1, [3, 3, 3], [2, 2, 2]);

    setupController([childRes, parentRes]);
    const getInfo = (controller as any)._getParentChunkInfo.bind(controller);

    const res = getInfo(makeVoxChunkKey("3,0,0", 0), childRes);
    expect(res.chunkKey).toBe("1,0,0");
  });

  it("Fractional Scale (2.5x)", () => {
    const childRes = resConfig(0, [1, 1, 1], [10, 10, 10]);
    const parentRes = resConfig(1, [2.5, 2.5, 2.5], [10, 10, 10]);

    setupController([childRes, parentRes]);
    const getInfo = (controller as any)._getParentChunkInfo.bind(controller);

    let res = getInfo(makeVoxChunkKey("2,0,0", 0), childRes);
    expect(res.chunkKey).toBe("0,0,0");

    res = getInfo(makeVoxChunkKey("3,0,0", 0), childRes);
    expect(res.chunkKey).toBe("1,0,0");
  });

  it("Anisotropic Scale (1x, 2x, 5x)", () => {
    const childRes = resConfig(0, [1, 1, 1], [10, 10, 10]);
    const parentRes = resConfig(1, [1, 2, 5], [10, 10, 10]);

    setupController([childRes, parentRes]);
    const getInfo = (controller as any)._getParentChunkInfo.bind(controller);

    const res = getInfo(makeVoxChunkKey("1,1,1", 0), childRes);
    expect(res.chunkKey).toBe("1,0,0");
  });
});

describe("VoxelEditController: Downsampling Integration", () => {
  let controller: VoxelEditController;
  let childSource: any;
  let parentSource: any;
  let grandParentSource: any;

  const setupIntegration = (numLevels: number = 2) => {
    childSource = createMockSource();
    vi.spyOn(childSource, "getChunk").mockImplementation(
      (pos: Float32Array) => ({
        data: new Uint32Array(8).fill(1),
        chunkDataSize: MOCK_SPEC.chunkDataSize,
        chunkGridPosition: pos,
        state: ChunkState.SYSTEM_MEMORY,
      }),
    );

    parentSource = createMockSource();
    vi.spyOn(parentSource, "getChunk").mockImplementation(
      (pos: Float32Array) => ({
        data: new Uint32Array(8).fill(0),
        chunkDataSize: MOCK_SPEC.chunkDataSize,
        chunkGridPosition: pos,
        state: ChunkState.SYSTEM_MEMORY,
      }),
    );

    grandParentSource = createMockSource();
    vi.spyOn(grandParentSource, "getChunk").mockImplementation(
      (pos: Float32Array) => ({
        data: new Uint32Array(8).fill(0),
        chunkDataSize: MOCK_SPEC.chunkDataSize,
        chunkGridPosition: pos,
        state: ChunkState.SYSTEM_MEMORY,
      }),
    );

    (mockRpc.get as any).mockImplementation((id: number) => {
      if (id === 0) return mockChunkManager;
      if (id === 100) return childSource;
      if (id === 101) return parentSource;
      if (id === 102) return grandParentSource;
      if (id === 999) return { value: 0 };
      return null;
    });

    const resolutions = [
      resConfig(0, [1, 1, 1], [2, 2, 2]), // Child
      resConfig(1, [2, 2, 2], [2, 2, 2]), // Parent (2x scale)
    ];

    if (numLevels > 2) {
      resolutions.push(resConfig(2, [4, 4, 4], [2, 2, 2])); // Grandparent (4x scale)
    }

    controller = new VoxelEditController(mockRpc, {
      resolutions,
      pendingOpCount: 999,
    });

    vi.spyOn(controller as any, "callChunkReload");
  };

  it("Single Step Flow: Writes to parent and notifies frontend", async () => {
    setupIntegration(2);
    const key = makeVoxChunkKey("0,0,0", 0);

    (controller as any).enqueueDownsample(key);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(childSource.getChunk).toHaveBeenCalled();

    expect(parentSource.applyEdits).toHaveBeenCalledWith(
      "0,0,0",
      expect.any(Array),
      expect.arrayContaining([1n]),
    );

    expect((controller as any).callChunkReload).toHaveBeenCalledWith([
      makeVoxChunkKey("0,0,0", 1),
    ]);

    expect((controller as any).callChunkReload).toHaveBeenCalledWith(
      [makeVoxChunkKey("0,0,0", 0), makeVoxChunkKey("0,0,0", 1)],
      true, // isForPreviewChunks
    );
  });

  it("Recursive Propagation: L0 -> L1 -> L2", async () => {
    setupIntegration(3);

    parentSource.applyEdits.mockImplementation(async () => {
      parentSource.getChunk.mockReturnValue({
        data: new Uint32Array(8).fill(1),
        chunkDataSize: MOCK_SPEC.chunkDataSize,
      });
    });

    const key = makeVoxChunkKey("0,0,0", 0);
    (controller as any).enqueueDownsample(key);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(parentSource.applyEdits).toHaveBeenCalled();

    expect(grandParentSource.applyEdits).toHaveBeenCalled();

    const reloadCalls = (controller as any).callChunkReload.mock.calls;
    const keysReloaded = reloadCalls.flatMap((c: any) => c[0]);

    expect(keysReloaded).toContain(makeVoxChunkKey("0,0,0", 1));
    expect(keysReloaded).toContain(makeVoxChunkKey("0,0,0", 2));
  });

  it("Queue Deduplication: Processes same key once per batch", async () => {
    setupIntegration(2);
    const key = makeVoxChunkKey("0,0,0", 0);

    (controller as any).enqueueDownsample(key);
    (controller as any).enqueueDownsample(key);
    (controller as any).enqueueDownsample(key);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(parentSource.applyEdits).toHaveBeenCalledTimes(1);
  });

  it("Lazy Loading: Downloads child chunk if missing", async () => {
    setupIntegration(2);

    const emptyChunk = { data: null, chunkDataSize: MOCK_SPEC.chunkDataSize };
    childSource.getChunk.mockReturnValue(emptyChunk);

    childSource.download.mockImplementation(async (chunk: any) => {
      chunk.data = new Uint32Array(8).fill(1);
    });

    const key = makeVoxChunkKey("0,0,0", 0);
    (controller as any).enqueueDownsample(key);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(childSource.download).toHaveBeenCalled();
    expect(parentSource.applyEdits).toHaveBeenCalled();
  });

  it("Error Handling: Child download failure aborts chain gracefully", async () => {
    setupIntegration(2);
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    childSource.getChunk.mockReturnValue({
      data: null,
      chunkDataSize: MOCK_SPEC.chunkDataSize,
    });
    childSource.download.mockRejectedValue(new Error("Network Error"));

    const key = makeVoxChunkKey("0,0,0", 0);
    (controller as any).enqueueDownsample(key);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(parentSource.applyEdits).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("Error Handling: Parent write failure reports error and stops recursion", async () => {
    setupIntegration(3);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    parentSource.applyEdits.mockRejectedValue(new Error("Write Failed"));

    const key = makeVoxChunkKey("0,0,0", 0);
    (controller as any).enqueueDownsample(key);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(parentSource.applyEdits).toHaveBeenCalled();

    expect(grandParentSource.applyEdits).not.toHaveBeenCalled();

    expect(mockRpc.invoke).toHaveBeenCalledWith(
      "vox.edit.failure",
      expect.objectContaining({
        voxChunkKeys: [makeVoxChunkKey("0,0,0", 1)],
      }),
    );

    consoleSpy.mockRestore();
  });
});

describe("VoxelEditController: flushPending", () => {
  let controller: VoxelEditController;
  let mockSource0: any;
  let mockSource1: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockSource0 = createMockSource();
    vi.spyOn(mockSource0, "applyEdits").mockResolvedValue({
      indices: new Uint32Array([]),
      oldValues: new BigUint64Array([]),
      newValues: new BigUint64Array([]),
    });

    mockSource1 = createMockSource();
    vi.spyOn(mockSource1, "applyEdits").mockResolvedValue({});

    (mockRpc.get as any).mockImplementation((id: number) => {
      if (id === 0) return mockChunkManager;
      if (id === 100) return mockSource0;
      if (id === 101) return mockSource1;
      if (id === 999) return { value: 0 };
      return null;
    });

    controller = new VoxelEditController(mockRpc, {
      resolutions: [
        resConfig(0, [1, 1, 1], [2, 2, 2]),
        resConfig(1, [2, 2, 2], [2, 2, 2]),
      ],
      pendingOpCount: 999,
    });

    vi.spyOn(controller as any, "enqueueDownsample").mockImplementation(
      () => {},
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Batching: Aggregates multiple edits to the same chunk into one write", async () => {
    const key = makeVoxChunkKey("0,0,0", 0);

    controller.commitVoxels([
      { key, indices: [1], value: 50n },
      { key, indices: [2], value: 60n },
    ]);

    const otherKey = makeVoxChunkKey("1,0,0", 0);
    controller.commitVoxels([{ key: otherKey, indices: [5], value: 99n }]);

    controller.commitVoxels([
      { key, indices: [1], value: 42n },
      { key, indices: [3], value: 70n },
    ]);

    await vi.runAllTimersAsync();

    expect(mockSource0.applyEdits).toHaveBeenCalledWith(
      "0,0,0",
      [1, 2, 3],
      [42n, 60n, 70n],
    );

    expect(mockSource0.applyEdits).toHaveBeenCalledWith("1,0,0", [5], [99n]);
  });

  it("History: Updates stacks and notifies frontend correctly", async () => {
    const key = makeVoxChunkKey("0,0,0", 0);

    (controller as any).redoStack.push({
      changes: new Map(),
      timestamp: 0,
      description: "dummy",
    });
    expect((controller as any).redoStack.length).toBe(1);

    controller.commitVoxels([{ key, indices: [1], value: 50n }]);
    await vi.runAllTimersAsync();

    expect((controller as any).undoStack.length).toBe(1);

    expect((controller as any).redoStack.length).toBe(0);

    expect(mockRpc.invoke).toHaveBeenCalledWith(
      VOX_EDIT_HISTORY_UPDATE_RPC_ID,
      expect.objectContaining({
        undoCount: 1,
        redoCount: 0,
      }),
    );
  });

  it("Partial Failure: Succeeds for valid chunks even if one chunk fails", async () => {
    const validKey = makeVoxChunkKey("0,0,0", 0);
    const failKey = makeVoxChunkKey("1,0,0", 0);

    mockSource0.applyEdits.mockImplementation((chunkKey: string) => {
      if (chunkKey === "1,0,0") {
        return Promise.reject(new Error("Network Error"));
      }
      return Promise.resolve({
        indices: new Uint32Array([1]),
        oldValues: new BigUint64Array([0n]),
        newValues: new BigUint64Array([50n]),
      });
    });

    controller.commitVoxels([
      { key: validKey, indices: [1], value: 50n },
      { key: failKey, indices: [1], value: 50n },
    ]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await vi.runAllTimersAsync();

    expect(mockSource0.applyEdits).toHaveBeenCalledWith(
      "0,0,0",
      expect.anything(),
      expect.anything(),
    );

    expect(mockSource0.applyEdits).toHaveBeenCalledWith(
      "1,0,0",
      expect.anything(),
      expect.anything(),
    );

    expect(mockRpc.invoke).toHaveBeenCalledWith(
      VOX_EDIT_FAILURE_RPC_ID,
      expect.objectContaining({
        voxChunkKeys: [failKey],
      }),
    );

    const undoStack = (controller as any).undoStack;
    expect(undoStack.length).toBe(1);
    expect(undoStack[0].changes.has(validKey)).toBe(true);
    expect(undoStack[0].changes.has(failKey)).toBe(false);

    errorSpy.mockRestore();
  });

  it("Invalid Data: Handles malformed keys gracefully without crashing", async () => {
    const validKey = makeVoxChunkKey("0,0,0", 0);
    const badKey = "invalid_format_key";

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    controller.commitVoxels([
      { key: validKey, indices: [1], value: 50n },
      { key: badKey, indices: [1], value: 50n },
    ]);

    await vi.runAllTimersAsync();

    expect(mockSource0.applyEdits).toHaveBeenCalledWith(
      "0,0,0",
      expect.anything(),
      expect.anything(),
    );

    expect(mockRpc.invoke).toHaveBeenCalledWith(
      VOX_EDIT_FAILURE_RPC_ID,
      expect.objectContaining({
        voxChunkKeys: [badKey],
      }),
    );

    errorSpy.mockRestore();
  });

  it("Downsample Trigger: Enqueues modified keys for processing", async () => {
    const key = makeVoxChunkKey("0,0,0", 0);
    const enqueueSpy = vi.spyOn(controller as any, "enqueueDownsample");

    controller.commitVoxels([{ key, indices: [1], value: 50n }]);
    await vi.runAllTimersAsync();

    expect(enqueueSpy).toHaveBeenCalledWith(key);
  });
});

describe("VoxelEditController: Undo/Redo", () => {
  let controller: VoxelEditController;
  let mockSource0: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSource0 = createMockSource();
    vi.spyOn(mockSource0, "applyEdits").mockResolvedValue({
      indices: new Uint32Array([]),
      oldValues: new BigUint64Array([]),
      newValues: new BigUint64Array([]),
    });

    (mockRpc.get as any).mockImplementation((id: number) => {
      if (id === 0) return mockChunkManager;
      if (id === 100) return mockSource0;
      if (id === 999) return { value: 0 };
      return null;
    });

    controller = new VoxelEditController(mockRpc, {
      resolutions: [resConfig(0, [1, 1, 1], [2, 2, 2])],
      pendingOpCount: 999,
    });

    vi.spyOn(controller as any, "callChunkReload");
    vi.spyOn(controller as any, "enqueueDownsample").mockImplementation(
      () => {},
    );
    (mockRpc.invoke as any).mockClear();
  });

  it("Successful Undo and Redo Lifecycle", async () => {
    const key = makeVoxChunkKey("0,0,0", 0);
    const editAction = {
      changes: new Map([
        [
          key,
          {
            indices: new Uint32Array([0]),
            oldValues: new BigUint64Array([10n]),
            newValues: new BigUint64Array([20n]),
          },
        ],
      ]),
      timestamp: Date.now(),
      description: "Test Action",
    };

    (controller as any).undoStack.push(editAction);

    await controller.undo();

    expect(mockSource0.applyEdits).toHaveBeenCalledWith(
      "0,0,0",
      expect.any(Uint32Array),
      expect.any(BigUint64Array),
    );
    const undoCallArgs = mockSource0.applyEdits.mock.calls[0];
    expect(undoCallArgs[2][0]).toBe(10n);

    expect((controller as any).callChunkReload).toHaveBeenCalledWith([key]);
    expect(mockRpc.invoke).toHaveBeenCalledWith(
      VOX_EDIT_HISTORY_UPDATE_RPC_ID,
      expect.objectContaining({ undoCount: 0, redoCount: 1 }),
    );

    expect((controller as any).undoStack.length).toBe(0);
    expect((controller as any).redoStack.length).toBe(1);

    mockSource0.applyEdits.mockClear();
    (mockRpc.invoke as any).mockClear();

    await controller.redo();

    expect(mockSource0.applyEdits).toHaveBeenCalledWith(
      "0,0,0",
      expect.any(Uint32Array),
      expect.any(BigUint64Array),
    );
    const redoCallArgs = mockSource0.applyEdits.mock.calls[0];
    expect(redoCallArgs[2][0]).toBe(20n);

    expect((controller as any).callChunkReload).toHaveBeenCalledWith([key]);
    expect(mockRpc.invoke).toHaveBeenCalledWith(
      VOX_EDIT_HISTORY_UPDATE_RPC_ID,
      expect.objectContaining({ undoCount: 1, redoCount: 0 }),
    );

    expect((controller as any).redoStack.length).toBe(0);
    expect((controller as any).undoStack.length).toBe(1);
  });

  it("Empty Stack Behavior", async () => {
    await expect(controller.undo()).rejects.toThrow(/Nothing to undo/);
    await expect(controller.redo()).rejects.toThrow(/Nothing to redo/);
  });

  it("Undo Failure Handling", async () => {
    const key = makeVoxChunkKey("0,0,0", 0);
    const editAction = {
      changes: new Map([
        [
          key,
          {
            indices: new Uint32Array([0]),
            oldValues: new BigUint64Array([10n]),
            newValues: new BigUint64Array([20n]),
          },
        ],
      ]),
      timestamp: Date.now(),
      description: "Test Action",
    };
    (controller as any).undoStack.push(editAction);

    mockSource0.applyEdits.mockRejectedValue(new Error("Backend Write Failed"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await controller.undo();

    expect(mockRpc.invoke).toHaveBeenCalledWith(
      VOX_EDIT_FAILURE_RPC_ID,
      expect.objectContaining({
        voxChunkKeys: [key],
        message: "Undo failed.",
      }),
    );

    expect((controller as any).undoStack.length).toBe(1);
    expect((controller as any).redoStack.length).toBe(0);

    expect((controller as any).callChunkReload).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("Redo Failure Handling", async () => {
    const key = makeVoxChunkKey("0,0,0", 0);
    const editAction = {
      changes: new Map([
        [
          key,
          {
            indices: new Uint32Array([0]),
            oldValues: new BigUint64Array([10n]),
            newValues: new BigUint64Array([20n]),
          },
        ],
      ]),
      timestamp: Date.now(),
      description: "Test Action",
    };
    (controller as any).redoStack.push(editAction);

    mockSource0.applyEdits.mockRejectedValue(new Error("Backend Write Failed"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await controller.redo();

    expect(mockRpc.invoke).toHaveBeenCalledWith(
      VOX_EDIT_FAILURE_RPC_ID,
      expect.objectContaining({
        voxChunkKeys: [key],
        message: "Redo failed.",
      }),
    );

    expect((controller as any).redoStack.length).toBe(1);
    expect((controller as any).undoStack.length).toBe(0);

    consoleSpy.mockRestore();
  });

  it("Multi-Chunk Action Consistency", async () => {
    const key1 = makeVoxChunkKey("0,0,0", 0);
    const key2 = makeVoxChunkKey("1,0,0", 0);

    const editAction = {
      changes: new Map([
        [
          key1,
          {
            indices: new Uint32Array([0]),
            oldValues: new BigUint64Array([1n]),
            newValues: new BigUint64Array([2n]),
          },
        ],
        [
          key2,
          {
            indices: new Uint32Array([0]),
            oldValues: new BigUint64Array([3n]),
            newValues: new BigUint64Array([4n]),
          },
        ],
      ]),
      timestamp: Date.now(),
      description: "Multi Chunk Action",
    };

    (controller as any).undoStack.push(editAction);

    await controller.undo();

    expect(mockSource0.applyEdits).toHaveBeenCalledTimes(2);
    expect(mockSource0.applyEdits).toHaveBeenCalledWith(
      "0,0,0",
      expect.anything(),
      expect.anything(),
    );
    expect(mockSource0.applyEdits).toHaveBeenCalledWith(
      "1,0,0",
      expect.anything(),
      expect.anything(),
    );

    expect((controller as any).callChunkReload).toHaveBeenCalledWith(
      expect.arrayContaining([key1, key2]),
    );

    expect((controller as any).undoStack.length).toBe(0);
    expect((controller as any).redoStack.length).toBe(1);
  });
});

describe("VoxelEditController: Tool Operations", () => {
  let controller: VoxelEditController;
  let mockSource: MockBackendSource;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    const spec = {
      rank: 3,
      chunkDataSize: new Uint32Array([10, 10, 10]),
      dataType: DataType.UINT64,
      lowerVoxelBound: new Float32Array([0, 0, 0]),
      upperVoxelBound: new Float32Array([100, 100, 100]),
      baseVoxelOffset: new Float32Array([0, 0, 0]),
      fillValue: 0n,
    };
    mockSource = createMockSource({ ...spec });
    vi.spyOn(mockSource, "applyEdits").mockResolvedValue({
      indices: new Uint32Array([]),
      oldValues: new BigUint64Array([]),
      newValues: new BigUint64Array([]),
    });

    (mockRpc.get as any).mockImplementation((id: number) => {
      if (id === 0) return mockChunkManager;
      if (id === 100) return mockSource;
      if (id === 999) return { value: 0 };
      return null;
    });

    controller = new VoxelEditController(mockRpc, {
      resolutions: [resConfig(0, [1, 1, 1], [10, 10, 10])],
      pendingOpCount: 999,
    });

    vi.spyOn(controller as any, "enqueueDownsample").mockImplementation(
      () => {},
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("paintBrushWithShape: 3D Sphere", async () => {
    const center = new Float32Array([5, 5, 5]);
    const radius = 3;
    const value = 5n;

    await controller.performOperation({
      type: VoxelOperationType.BRUSH,
      center,
      radius,
      value,
      shape: BrushShape.SPHERE,
      basis: { u: new Float32Array([1, 0, 0]), v: new Float32Array([0, 1, 0]) },
    });

    await vi.runAllTimersAsync();

    expect(mockSource.applyEdits).toHaveBeenCalledWith(
      "0,0,0",
      expect.any(Array),
      expect.any(Array),
    );

    const call = (mockSource.applyEdits as any).mock.calls[0];
    const indices = call[1];
    const values = call[2];
    const indexSet = new Set(indices);

    const getIdx = (x: number, y: number, z: number) => z * 100 + y * 10 + x;
    expect(indexSet.has(getIdx(5, 5, 5))).toBe(true);
    expect(indexSet.has(getIdx(7, 5, 5))).toBe(true);
    expect(indexSet.has(getIdx(8, 5, 5))).toBe(false);
    expect(values[0]).toBe(5n);
  });

  it("paintBrushWithShape: 2D Disk", async () => {
    const center = new Float32Array([5, 5, 5]);
    const radius = 3;
    const value = 3n;
    const basis = {
      u: new Float32Array([1, 0, 0]),
      v: new Float32Array([0, 1, 0]),
    };

    await controller.performOperation({
      type: VoxelOperationType.BRUSH,
      center,
      radius,
      value,
      shape: BrushShape.DISK,
      basis,
    });

    await vi.runAllTimersAsync();

    const call = (mockSource.applyEdits as any).mock.calls[0];
    const indices = call[1];
    const values = call[2];
    const indexSet = new Set(indices);
    const getIdx = (x: number, y: number, z: number) => z * 100 + y * 10 + x;

    for (const idx of indices) {
      const z = Math.floor(idx / 100);
      expect(z).toBe(5);
    }
    expect(indexSet.has(getIdx(5, 5, 5))).toBe(true);
    expect(indexSet.has(getIdx(7, 5, 5))).toBe(true);
    expect(values[0]).toBe(3n);
  });

  it("floodFillPlane2D: Bounded region (Bucket)", async () => {
    const data = new BigUint64Array(1000);
    for (let x = 3; x <= 7; x++) {
      data[0 * 100 + 3 * 10 + x] = 1n; // y=3
      data[0 * 100 + 7 * 10 + x] = 1n; // y=7
    }
    for (let y = 3; y <= 7; y++) {
      data[0 * 100 + y * 10 + 3] = 1n; // x=3
      data[0 * 100 + y * 10 + 7] = 1n; // x=7
    }
    mockSource.serverStorage.set("0,0,0", data.buffer);

    const seed = new Float32Array([5, 5, 0]);
    const fillValue = 5n;
    const maxVoxels = 100;
    const basis = {
      u: new Float32Array([1, 0, 0]),
      v: new Float32Array([0, 1, 0]),
    };

    await controller.performOperation({
      type: VoxelOperationType.FLOOD_FILL,
      seed,
      value: fillValue,
      maxVoxels,
      basis,
    });

    await vi.runAllTimersAsync();

    const call = (mockSource.applyEdits as any).mock.calls[0];
    const indices = call[1];
    expect(indices.length).toBe(9);
  });

  it("floodFillPlane2D: Plane constraint", async () => {
    const data = new BigUint64Array(1000);
    const z = 5;
    for (let x = 3; x <= 7; x++) {
      data[z * 100 + 3 * 10 + x] = 1n;
      data[z * 100 + 7 * 10 + x] = 1n;
    }
    for (let y = 3; y <= 7; y++) {
      data[z * 100 + y * 10 + 3] = 1n;
      data[z * 100 + y * 10 + 7] = 1n;
    }
    mockSource.serverStorage.set("0,0,0", data.buffer);

    const seed = new Float32Array([5, 5, 5]);
    const basis = {
      u: new Float32Array([1, 0, 0]),
      v: new Float32Array([0, 1, 0]),
    };

    await controller.performOperation({
      type: VoxelOperationType.FLOOD_FILL,
      seed,
      value: 2n,
      maxVoxels: 100,
      basis,
    });

    await vi.runAllTimersAsync();

    const call = (mockSource.applyEdits as any).mock.calls[0];
    const indices = call[1];
    expect(indices.length).toBe(9);
    for (const idx of indices) {
      const cz = Math.floor(idx / 100);
      expect(cz).toBe(5);
    }
  });

  it("floodFillPlane2D: Max voxels exceeded", async () => {
    const seed = new Float32Array([5, 5, 0]);
    const maxVoxels = 5;
    const basis = {
      u: new Float32Array([1, 0, 0]),
      v: new Float32Array([0, 1, 0]),
    };

    await expect(
      controller.performOperation({
        type: VoxelOperationType.FLOOD_FILL,
        seed,
        value: 9n,
        maxVoxels,
        basis,
      }),
    ).rejects.toThrow("Flood fill failed: too many voxels filled.");
  });

  it("floodFillPlane2D: Seed value equals fill value", async () => {
    const data = new BigUint64Array(1000);
    const seedIdx = 0 * 100 + 5 * 10 + 5;
    data[seedIdx] = 5n;
    mockSource.serverStorage.set("0,0,0", data.buffer);

    const seed = new Float32Array([5, 5, 0]);
    const basis = {
      u: new Float32Array([1, 0, 0]),
      v: new Float32Array([0, 1, 0]),
    };

    await controller.performOperation({
      type: VoxelOperationType.FLOOD_FILL,
      seed,
      value: 5n,
      maxVoxels: 100,
      basis,
    });

    await vi.runAllTimersAsync();

    expect(mockSource.applyEdits).not.toHaveBeenCalled();
  });

  it("floodFillPlane2D: Leak prevention (morphological)", async () => {
    (controller as any).morphologicalConfig = {
      growthThresholds: [{ count: 5, size: 3 }],
      maxSize: 9,
    };

    const data = new BigUint64Array(1000);
    // Box 0..9 in X, Y, at Z=0.
    for (let x = 0; x <= 9; x++) {
      if (x !== 0) data[0 * 100 + 0 * 10 + x] = 1n; // y=0
      data[0 * 100 + 9 * 10 + x] = 1n; // y=9
    }
    for (let y = 0; y <= 9; y++) {
      if (y !== 5) data[0 * 100 + y * 10 + 0] = 1n; // x=0 (hole at y=5)
      data[0 * 100 + y * 10 + 9] = 1n; // x=9
    }
    mockSource.serverStorage.set("0,0,0", data.buffer);

    const seed = new Float32Array([5, 5, 0]);
    const basis = {
      u: new Float32Array([1, 0, 0]),
      v: new Float32Array([0, 1, 0]),
    };

    await controller.performOperation({
      type: VoxelOperationType.FLOOD_FILL,
      seed,
      value: 2n,
      maxVoxels: 1000,
      basis,
    });

    await vi.runAllTimersAsync();

    expect(mockSource.applyEdits).toHaveBeenCalled();
    const indices = (mockSource.applyEdits as any).mock.calls[0][1];
    expect(indices.length).toBeLessThan(100);
    expect(indices.length).toBeGreaterThan(50);
  });
});
