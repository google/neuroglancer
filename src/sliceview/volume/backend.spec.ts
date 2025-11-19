import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChunkState } from "#src/chunk_manager/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { DataType } from "#src/util/data_type.js";
import { HttpError } from "#src/util/http_request.js";
import type { RPC } from "#src/worker_rpc.js";

vi.mock("#src/sliceview/compressed_segmentation/decode_uint64.js", () => ({
  decodeChannel: vi.fn((out) => out.fill(5n)),
}));
vi.mock("#src/sliceview/compressed_segmentation/encode_uint64.js", () => ({
  encodeChannel: vi.fn((builder) => {
    builder.data = new Uint32Array([888]);
  }),
}));
vi.mock("#src/sliceview/compressed_segmentation/decode_uint32.js", () => ({
  decodeChannel: vi.fn((out) => out.fill(5)),
}));
vi.mock("#src/sliceview/compressed_segmentation/encode_uint32.js", () => ({
  encodeChannel: vi.fn((builder) => {
    builder.data = new Uint32Array([444]);
  }),
}));

vi.mock("#src/sliceview/volume/registry.js", () => ({
  getChunkFormatHandler: vi.fn().mockReturnValue({
    chunkFormat: { dataType: 0 },
    dispose: vi.fn(),
    getChunk: (source: any, x: any) => new source.chunkConstructor(source, x),
  }),
}));

class MockBackendSource extends VolumeChunkSource {
  public serverStorage = new Map<string, ArrayBuffer>();

  async download(chunk: VolumeChunk) {
    const key = chunk.chunkGridPosition.join(",");
    if (this.serverStorage.has(key)) {
      chunk.data = new Uint8Array(this.serverStorage.get(key)!.slice(0));
    }
  }

  async writeChunk(chunk: VolumeChunk) {
    const key = chunk.chunkGridPosition.join(",");
    this.serverStorage.set(key, chunk.data!.buffer.slice(0) as ArrayBuffer);
  }
}

describe("VolumeChunkSource: applyEdits", () => {
  let mockRpc: RPC;
  let source: MockBackendSource;

  const BASE_SPEC = {
    rank: 3,
    dataType: DataType.UINT64,
    chunkDataSize: Uint32Array.from([2, 2, 2]),
    upperVoxelBound: Float32Array.from([10, 10, 10]),
    baseVoxelOffset: Float32Array.from([0, 0, 0]),
    compressedSegmentationBlockSize: undefined,
  };

  beforeEach(() => {
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

    mockRpc = {
      newId: () => 0,
      set: vi.fn(),
      get: vi.fn().mockReturnValue(mockChunkManager),
      invoke: vi.fn(),
      promiseInvoke: vi.fn(),
    } as unknown as RPC;

    source = new MockBackendSource(mockRpc, {
      spec: { ...BASE_SPEC },
      chunkManager: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Input Validation", () => {
    it("should throw if indices and values lengths mismatch", async () => {
      await expect(source.applyEdits("0,0,0", [1], [1n, 2n])).rejects.toThrow(
        /length mismatch/,
      );
    });

    it("should throw for invalid chunk keys (wrong rank)", async () => {
      await expect(source.applyEdits("0,0", [0], [1n])).rejects.toThrow(
        /invalid chunk key/,
      );
    });

    it("should throw for invalid chunk keys (NaN)", async () => {
      await expect(source.applyEdits("0,NaN,0", [0], [1n])).rejects.toThrow(
        /invalid chunk key/,
      );
    });
  });

  describe("Uncompressed Data (UINT64)", () => {
    it("should initialize data if missing", async () => {
      const writeSpy = vi.spyOn(source, "writeChunk");
      const result = await source.applyEdits("0,0,0", [0], [100n]);

      const chunk = source.chunks.get("0,0,0")! as VolumeChunk;

      expect(chunk.data).toBeInstanceOf(BigUint64Array);
      expect((chunk.data as BigUint64Array)[0]).toBe(100n);
      expect(writeSpy).toHaveBeenCalled();
      expect(result.newValues[0]).toBe(100n);
    });

    it("should update existing data", async () => {
      const chunk = source.getChunk(new Float32Array([0, 0, 0])) as VolumeChunk;
      chunk.data = new BigUint64Array(8);
      chunk.state = ChunkState.SYSTEM_MEMORY;
      (chunk.data as BigUint64Array)[0] = 50n;

      const result = await source.applyEdits("0,0,0", [0], [100n]);

      expect(result.oldValues[0]).toBe(50n);
      expect(result.newValues[0]).toBe(100n);
    });

    it("should throw on out-of-bounds index", async () => {
      await expect(source.applyEdits("0,0,0", [9], [1n])).rejects.toThrow(
        /index 9 out of bounds/,
      );
    });
  });

  describe("Uncompressed Data (UINT32)", () => {
    it("should handle edits correctly", async () => {
      const uint32Spec = { ...BASE_SPEC, dataType: DataType.UINT32 };
      const uint32Source = new MockBackendSource(mockRpc, {
        spec: uint32Spec,
        chunkManager: 0,
      });

      const result = await uint32Source.applyEdits("0,0,0", [0], [123]);

      const chunk = uint32Source.chunks.get("0,0,0")! as VolumeChunk;
      expect(chunk.data).toBeInstanceOf(Uint32Array);
      expect((chunk.data as Uint32Array)[0]).toBe(123);
      expect(result.newValues[0]).toBe(123);
    });
  });

  describe("Compressed Segmentation", () => {
    it("should handle UINT64 compressed segmentation", async () => {
      const compressedSpec = {
        ...BASE_SPEC,
        compressedSegmentationBlockSize: Uint32Array.from([2, 2, 1]),
      };
      const compressedSource = new MockBackendSource(mockRpc, {
        spec: compressedSpec,
        chunkManager: 0,
      });

      const chunk = compressedSource.getChunk(
        new Float32Array([0, 0, 0]),
      ) as VolumeChunk;
      chunk.data = new Uint32Array([123]);

      const result = await compressedSource.applyEdits("0,0,0", [0], [99n]);

      expect(result.oldValues[0]).toBe(5n);
      expect((chunk.data as Uint32Array)[0]).toBe(888);
    });

    it("should handle UINT32 compressed segmentation", async () => {
      const compressedSpec = {
        ...BASE_SPEC,
        dataType: DataType.UINT32,
        compressedSegmentationBlockSize: Uint32Array.from([2, 2, 1]),
      };
      const compressedSource = new MockBackendSource(mockRpc, {
        spec: compressedSpec,
        chunkManager: 0,
      });

      const chunk = compressedSource.getChunk(
        new Float32Array([0, 0, 0]),
      ) as VolumeChunk;
      chunk.data = new Uint32Array([123]);

      const result = await compressedSource.applyEdits("0,0,0", [0], [77]);

      expect(result.oldValues[0]).toBe(5);
      expect(result.newValues[0]).toBe(77);
      expect((chunk.data as Uint32Array)[0]).toBe(444);
    });

    it("should handle zero-offset compressed data (empty/new)", async () => {
      const compressedSpec = {
        ...BASE_SPEC,
        compressedSegmentationBlockSize: Uint32Array.from([2, 2, 1]),
      };
      const compressedSource = new MockBackendSource(mockRpc, {
        spec: compressedSpec,
        chunkManager: 0,
      });

      const chunk = compressedSource.getChunk(
        new Float32Array([0, 0, 0]),
      ) as VolumeChunk;
      chunk.data = new Uint32Array([]);

      await compressedSource.applyEdits("0,0,0", [0], [50n]);
      expect((chunk.data as Uint32Array)[0]).toBe(888);
    });

    it("should handle zero-offset compressed data for UINT32", async () => {
      const compressedSpec = {
        ...BASE_SPEC,
        dataType: DataType.UINT32,
        compressedSegmentationBlockSize: Uint32Array.from([2, 2, 1]),
      };
      const compressedSource = new MockBackendSource(mockRpc, {
        spec: compressedSpec,
        chunkManager: 0,
      });

      const chunk = compressedSource.getChunk(
        new Float32Array([0, 0, 0]),
      ) as VolumeChunk;
      chunk.data = new Uint32Array([]);

      await compressedSource.applyEdits("0,0,0", [0], [50]);
      expect((chunk.data as Uint32Array)[0]).toBe(444);
    });
  });

  describe("Error Handling & Bounds", () => {
    it("should throw if chunk size cannot be determined", async () => {
      const computeSpy = vi
        .spyOn(source, "computeChunkBounds")
        .mockImplementation(() => new Float32Array());

      const chunk = source.getChunk(new Float32Array([0, 0, 0])) as VolumeChunk;
      chunk.chunkDataSize = null;

      await expect(source.applyEdits("0,0,0", [0], [1n])).rejects.toThrow(
        /size is unknown/,
      );

      computeSpy.mockRestore();
    });

    it("should retry on 500 errors and eventually succeed", async () => {
      vi.useFakeTimers();
      const writeSpy = vi
        .spyOn(source, "writeChunk")
        .mockRejectedValueOnce(new HttpError("", 500, ""))
        .mockRejectedValueOnce(new HttpError("", 503, ""))
        .mockResolvedValue(undefined);

      const promise = source.applyEdits("0,0,0", [0], [1n]);
      await vi.runAllTimersAsync();
      await promise;

      expect(writeSpy).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it("should stop retrying at one point", async () => {
      vi.useFakeTimers();

      vi.spyOn(source, "writeChunk").mockRejectedValue(
        new Error("Fatal DB Error"),
      );

      const promise = source.applyEdits("0,0,0", [0], [1n]);

      const assertRejection = expect(promise).rejects.toThrow(
        /Failed to write chunk/,
      );

      await vi.runAllTimersAsync();
      await assertRejection;

      vi.useRealTimers();
    });

    it("should NOT retry on 400 errors", async () => {
      vi.useFakeTimers();
      const writeSpy = vi
        .spyOn(source, "writeChunk")
        .mockRejectedValue(new HttpError("Bad Request", 400, ""));

      const promise = source.applyEdits("0,0,0", [0], [1n]);

      await expect(promise).rejects.toThrow(/Failed to write chunk/);

      expect(writeSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });
});
