import { describe, it, expect, vi, beforeEach } from "vitest";
import { vec3 } from "#src/util/geom.js";
import {
  BrushShape,
  VOX_EDIT_COMMIT_VOXELS_RPC_ID,
} from "#src/voxel_annotation/base.js";
import { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";
import type { RPC } from "#src/worker_rpc.js";

const mockRpc = {
  invoke: vi.fn(),
  newId: () => 0,
  register: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
} as unknown as RPC;

class MockVolumeSource {
  rpcId = 100;
  spec = {
    chunkDataSize: new Uint32Array([100, 100, 100]),
    rank: 3,
  };

  dataMap = new Map<string, bigint>();

  getEnsuredValueAt = vi.fn(async (pos: Float32Array) => {
    const key = `${Math.round(pos[0])},${Math.round(pos[1])},${Math.round(pos[2])}`;
    return this.dataMap.get(key) ?? 0n;
  });

  computeChunkIndices(voxelCoord: Float32Array) {
    return {
      chunkGridPosition: new Float32Array([0, 0, 0]),
      positionWithinChunk: new Uint32Array([
        voxelCoord[0],
        voxelCoord[1],
        voxelCoord[2],
      ]),
    };
  }

  chunkToMultiscaleTransform = new Float32Array(16).fill(0);

  applyLocalEdits = vi.fn();
}

describe("VoxelEditController", () => {
  let controller: VoxelEditController;
  let mockPrimarySource: MockVolumeSource;
  let mockPreviewSource: MockVolumeSource;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrimarySource = new MockVolumeSource();
    mockPreviewSource = new MockVolumeSource();

    mockPrimarySource.chunkToMultiscaleTransform[0] = 1;
    mockPrimarySource.chunkToMultiscaleTransform[5] = 1;
    mockPrimarySource.chunkToMultiscaleTransform[10] = 1;
    mockPrimarySource.chunkToMultiscaleTransform[15] = 1;

    const host = {
      rpc: mockRpc,
      primarySource: {
        rank: 3,
        getSources: () => [
          [
            {
              chunkSource: mockPrimarySource,
              chunkToMultiscaleTransform:
                mockPrimarySource.chunkToMultiscaleTransform,
            },
          ],
        ],
      } as any,
      previewSource: {
        getSources: () => [
          [
            {
              chunkSource: mockPreviewSource,
              chunkToMultiscaleTransform:
                mockPrimarySource.chunkToMultiscaleTransform,
            },
          ],
        ],
      } as any,
    };

    controller = new VoxelEditController(host);
    (mockRpc.invoke as any).mockClear();
  });

  describe("paintBrushWithShape", () => {
    it("paints a 3D Sphere correctly", () => {
      const center = new Float32Array([10, 10, 10]);
      const radius = 2;
      const value = 5n;

      controller.paintBrushWithShape(
        center,
        radius,
        value,
        BrushShape.SPHERE,
        undefined,
      );

      expect(mockRpc.invoke).toHaveBeenCalledWith(
        VOX_EDIT_COMMIT_VOXELS_RPC_ID,
        expect.objectContaining({
          edits: expect.any(Array),
        }),
      );

      const calls = (mockRpc.invoke as any).mock.calls;
      const commitCall = calls.find(
        (c: any[]) => c[0] === VOX_EDIT_COMMIT_VOXELS_RPC_ID,
      );
      expect(commitCall).toBeDefined();

      const args = commitCall[1];
      const edits = args.edits;

      expect(edits.length).toBeGreaterThan(0);
      const indicesSet = new Set(edits[0].indices);

      const getIdx = (x: number, y: number, z: number) =>
        z * 10000 + y * 100 + x;

      expect(indicesSet.has(getIdx(10, 10, 10))).toBe(true);
      expect(indicesSet.has(getIdx(12, 10, 10))).toBe(true);
      expect(indicesSet.has(getIdx(11, 11, 10))).toBe(true);
      expect(indicesSet.has(getIdx(12, 11, 10))).toBe(false);
    });

    it("paints a 2D Disk aligned to basis vectors", () => {
      const center = new Float32Array([10, 10, 5]);
      const radius = 2;
      const value = 3n;
      const basis = {
        u: new Float32Array([1, 0, 0]),
        v: new Float32Array([0, 1, 0]),
      };

      controller.paintBrushWithShape(
        center,
        radius,
        value,
        BrushShape.DISK,
        basis,
      );

      const calls = (mockRpc.invoke as any).mock.calls;
      const commitCall = calls.find(
        (c: any[]) => c[0] === VOX_EDIT_COMMIT_VOXELS_RPC_ID,
      );
      expect(commitCall).toBeDefined();

      const args = commitCall[1];
      const edits = args.edits;
      const indices = edits[0].indices;

      for (const idx of indices) {
        const z = Math.floor(idx / 10000);
        expect(z).toBe(5);
      }

      expect(indices.length).toBeGreaterThan(0);
    });
  });

  describe("floodFillPlane2D", () => {
    it("fills a bounded region (The Bucket)", async () => {
      mockPrimarySource.dataMap.clear();

      for (let x = 1; x <= 5; x++) {
        mockPrimarySource.dataMap.set(`${x},1,0`, 1n);
        mockPrimarySource.dataMap.set(`${x},5,0`, 1n);
      }
      for (let y = 1; y <= 5; y++) {
        mockPrimarySource.dataMap.set(`1,${y},0`, 1n);
        mockPrimarySource.dataMap.set(`5,${y},0`, 1n);
      }

      const seed = new Float32Array([3, 3, 0]);
      const fillValue = 5n;
      const maxVoxels = 100;
      const planeNormal = vec3.fromValues(0, 0, 1);

      const result = await controller.floodFillPlane2D(
        seed,
        fillValue,
        maxVoxels,
        planeNormal,
      );

      expect(result.filledCount).toBe(9);

      expect(mockRpc.invoke).toHaveBeenCalledWith(
        VOX_EDIT_COMMIT_VOXELS_RPC_ID,
        expect.anything(),
      );
    });

    it("respects the plane constraint", async () => {
      const seed = new Float32Array([50, 50, 5]);
      const maxVoxels = 20;
      const planeNormal = vec3.fromValues(0, 0, 1);

      await expect(
        controller.floodFillPlane2D(seed, 2n, maxVoxels, planeNormal),
      ).rejects.toThrow(/exceeds the limit/);

      mockPrimarySource.dataMap.set("51,50,5", 1n);
      mockPrimarySource.dataMap.set("49,50,5", 1n);
      mockPrimarySource.dataMap.set("50,51,5", 1n);
      mockPrimarySource.dataMap.set("50,49,5", 1n);

      const result = await controller.floodFillPlane2D(
        seed,
        2n,
        100,
        planeNormal,
      );

      expect(result.filledCount).toBe(1);
      expect(result.edits[0].indices.length).toBe(1);

      const idx = result.edits[0].indices[0];
      const z = Math.floor(idx / 10000);
      expect(z).toBe(5);
    });

    it("throws when max voxels exceeded", async () => {
      const seed = new Float32Array([10, 10, 0]);
      const maxVoxels = 10;

      await expect(
        controller.floodFillPlane2D(
          seed,
          9n,
          maxVoxels,
          vec3.fromValues(0, 0, 1),
        ),
      ).rejects.toThrow("Flood fill region exceeds the limit");
    });

    it("does nothing if seed value equals fill value", async () => {
      mockPrimarySource.dataMap.set("10,10,0", 5n);
      const seed = new Float32Array([10, 10, 0]);

      const result = await controller.floodFillPlane2D(
        seed,
        5n,
        100,
        vec3.fromValues(0, 0, 1),
      );

      expect(result.filledCount).toBe(0);
      expect(result.edits.length).toBe(0);
      expect(mockRpc.invoke).not.toHaveBeenCalledWith(
        VOX_EDIT_COMMIT_VOXELS_RPC_ID,
        expect.anything(),
      );
    });

    it("prevents leak through small gaps using morphological thickening", async () => {
      // Override config to trigger thickening early
      (controller as any).morphologicalConfig = {
        growthThresholds: [{ count: 10, size: 3 }],
        maxSize: 9,
      };

      mockPrimarySource.dataMap.clear();

      const size = 20;
      for (let i = 0; i <= size; i++) {
        mockPrimarySource.dataMap.set(`${i},0,0`, 1n);
        mockPrimarySource.dataMap.set(`${i},${size},0`, 1n);
        mockPrimarySource.dataMap.set(`0,${i},0`, 1n);
        if (i !== 10) {
          mockPrimarySource.dataMap.set(`${size},${i},0`, 1n);
        }
      }

      const seed = new Float32Array([10, 10, 0]);
      const fillValue = 2n;
      const maxVoxels = 2000;
      const planeNormal = vec3.fromValues(0, 0, 1);

      const result = await controller.floodFillPlane2D(
        seed,
        fillValue,
        maxVoxels,
        planeNormal,
      );

      expect(result.filledCount).toBeLessThan(1000);
      expect(result.filledCount).toBeGreaterThan(300);

      expect(mockRpc.invoke).toHaveBeenCalledWith(
        VOX_EDIT_COMMIT_VOXELS_RPC_ID,
        expect.anything(),
      );
    });
  });
});
