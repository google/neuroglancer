import { describe, expect, it, vi } from "vitest";

import { ChunkQueueManager } from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import { getChunkKey } from "#src/sliceview/base.js";

describe("ChunkQueueManager targeted source invalidation", () => {
  function makeChunk(key: string, state: ChunkState) {
    return { key, state, freeSystemMemory: vi.fn() };
  }

  function makeQueueManager() {
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
    return { rpc, queueManager };
  }

  it("requeues only the identified chunks", () => {
    const workerChunk = makeChunk(
      getChunkKey([13, 9, 5]),
      ChunkState.SYSTEM_MEMORY_WORKER,
    );
    const systemChunk = makeChunk(
      getChunkKey([13, 9, 6]),
      ChunkState.SYSTEM_MEMORY,
    );
    // Would have been caught by a bare `startsWith` test against key "13,9,5".
    const untouchedChunk = makeChunk(
      getChunkKey([13, 9, 50]),
      ChunkState.SYSTEM_MEMORY,
    );
    const { rpc, queueManager } = makeQueueManager();
    const source = {
      rpcId: 7,
      chunks: new Map([
        [workerChunk.key, workerChunk],
        [systemChunk.key, systemChunk],
        [untouchedChunk.key, untouchedChunk],
      ]),
    };

    queueManager.invalidateSourceCacheKeys(source, [
      workerChunk.key,
      systemChunk.key,
    ]);

    expect(workerChunk.freeSystemMemory).toHaveBeenCalledTimes(1);
    expect(queueManager.updateChunkState).toHaveBeenCalledWith(
      workerChunk,
      ChunkState.QUEUED,
    );
    expect(queueManager.updateChunkState).toHaveBeenCalledWith(
      systemChunk,
      ChunkState.QUEUED,
    );
    expect(queueManager.updateChunkState).not.toHaveBeenCalledWith(
      untouchedChunk,
      ChunkState.QUEUED,
    );
    expect(rpc.invoke).toHaveBeenCalledWith("Chunk.update", {
      source: 7,
      keys: [workerChunk.key, systemChunk.key],
    });
    // Marking chunks QUEUED only takes effect once the queue is processed.
    expect(queueManager.scheduleUpdate).toHaveBeenCalledTimes(1);
  });

  it("tells the frontend only about the keys it actually invalidated", () => {
    const chunk = makeChunk(getChunkKey([13, 9, 5]), ChunkState.SYSTEM_MEMORY);
    const { rpc, queueManager } = makeQueueManager();
    const source = { rpcId: 7, chunks: new Map([[chunk.key, chunk]]) };

    queueManager.invalidateSourceCacheKeys(source, [
      chunk.key,
      getChunkKey([99, 99, 99]),
    ]);

    expect(rpc.invoke).toHaveBeenCalledWith("Chunk.update", {
      source: 7,
      keys: [chunk.key],
    });
  });

  it("does not notify the frontend when no key matched", () => {
    const chunk = makeChunk(getChunkKey([13, 9, 6]), ChunkState.SYSTEM_MEMORY);
    const { rpc, queueManager } = makeQueueManager();
    const source = { rpcId: 7, chunks: new Map([[chunk.key, chunk]]) };

    queueManager.invalidateSourceCacheKeys(source, [getChunkKey([13, 9, 5])]);

    expect(queueManager.updateChunkState).not.toHaveBeenCalled();
    expect(rpc.invoke).not.toHaveBeenCalled();
    expect(queueManager.scheduleUpdate).not.toHaveBeenCalled();
  });
});
