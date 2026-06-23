import { describe, expect, it, vi } from "vitest";

import { ChunkQueueManager } from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";

describe("ChunkQueueManager targeted source invalidation", () => {
  it("invalidates only chunks whose keys match requested cell prefixes", () => {
    const matchingWorkerChunk = {
      key: "13,9,5:0",
      state: ChunkState.SYSTEM_MEMORY_WORKER,
      freeSystemMemory: vi.fn(),
    };
    const matchingSystemChunk = {
      key: "13,9,5:1",
      state: ChunkState.SYSTEM_MEMORY,
      freeSystemMemory: vi.fn(),
    };
    const adjacentCellChunk = {
      key: "13,9,50:0",
      state: ChunkState.SYSTEM_MEMORY,
      freeSystemMemory: vi.fn(),
    };
    const otherCellChunk = {
      key: "13,9,6:0",
      state: ChunkState.SYSTEM_MEMORY,
      freeSystemMemory: vi.fn(),
    };
    const rpc = { invoke: vi.fn() };
    const queueManager = Object.assign(
      Object.create(ChunkQueueManager.prototype),
      {
        rpc,
        scheduleUpdate: vi.fn(),
        updateChunkState: vi.fn(
          (chunk: { state: ChunkState }, state: ChunkState) => {
            chunk.state = state;
          },
        ),
      },
    );
    const source = {
      rpcId: 7,
      chunks: new Map([
        [matchingWorkerChunk.key, matchingWorkerChunk],
        [matchingSystemChunk.key, matchingSystemChunk],
        [adjacentCellChunk.key, adjacentCellChunk],
        [otherCellChunk.key, otherCellChunk],
      ]),
    };

    queueManager.invalidateSourceCacheKeyPrefixes(source, ["13,9,5:"]);

    expect(matchingWorkerChunk.freeSystemMemory).toHaveBeenCalledTimes(1);
    expect(queueManager.updateChunkState).toHaveBeenCalledWith(
      matchingWorkerChunk,
      ChunkState.QUEUED,
    );
    expect(queueManager.updateChunkState).toHaveBeenCalledWith(
      matchingSystemChunk,
      ChunkState.QUEUED,
    );
    expect(queueManager.updateChunkState).not.toHaveBeenCalledWith(
      adjacentCellChunk,
      ChunkState.QUEUED,
    );
    expect(queueManager.updateChunkState).not.toHaveBeenCalledWith(
      otherCellChunk,
      ChunkState.QUEUED,
    );
    expect(rpc.invoke).toHaveBeenCalledWith("Chunk.update", {
      source: 7,
      keyPrefixes: ["13,9,5:"],
    });
    expect(queueManager.scheduleUpdate).toHaveBeenCalledTimes(1);
  });
});
