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

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Chunk,
  ChunkManager,
  ChunkQueueManager,
  ChunkSource,
} from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import { RPC } from "#src/worker_rpc.js";

class TestSource extends ChunkSource {
  download() {
    return Promise.resolve();
  }
}

describe("ChunkQueueManager.invalidateSourceCache", () => {
  let messages: any[];
  let queueManager: ChunkQueueManager;
  let source: TestSource;
  let chunk: Chunk;

  // Chunk updates sent to the frontend.
  const chunkUpdates = () =>
    messages.filter((m) => m.functionName === "Chunk.update");

  beforeEach(() => {
    messages = [];
    const rpc = new RPC(
      { postMessage: (data: any) => messages.push(data), onmessage: null },
      /*waitUntilReady=*/ false,
    );
    let nextId = 1;
    const sharedValue = (value: any) =>
      new SharedWatchableValue(rpc, { id: nextId++, value }).rpcId;
    const capacity = () => ({
      itemLimit: sharedValue(Number.POSITIVE_INFINITY),
      sizeLimit: sharedValue(Number.POSITIVE_INFINITY),
    });
    queueManager = new ChunkQueueManager(rpc, {
      id: nextId++,
      gpuMemoryCapacity: capacity(),
      systemMemoryCapacity: capacity(),
      downloadCapacity: capacity(),
      computeCapacity: capacity(),
      enablePrefetch: sharedValue(true),
    });
    // Queue processing is not under test.
    vi.spyOn(queueManager, "scheduleUpdate").mockImplementation(() => {});
    const chunkManager = new ChunkManager(rpc, {
      id: nextId++,
      chunkQueueManager: queueManager.rpcId,
    });
    source = new TestSource(rpc, {
      id: nextId++,
      chunkManager: chunkManager.rpcId,
    });
    // A chunk that has been sent to the frontend.
    chunk = source.getNewChunk_(Chunk);
    chunk.initialize("0");
    chunk.priorityTier = ChunkPriorityTier.VISIBLE;
    chunk.requestedState = ChunkState.SYSTEM_MEMORY;
    source.addChunk(chunk);
    queueManager.updateChunkState(chunk, ChunkState.SYSTEM_MEMORY);
    messages.length = 0;
  });

  it("replaces the frontend's copy when the chunk is re-downloaded", () => {
    queueManager.invalidateSourceCache(source);
    chunk.downloadSucceeded();
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY);
    expect(chunkUpdates()).toEqual([
      expect.objectContaining({ id: "0", new: true }),
    ]);
  });

  it("replaces the frontend's copy when the chunk is re-downloaded to the GPU", () => {
    // Request the chunk in GPU memory, as image layers do.
    chunk.newPriorityTier = ChunkPriorityTier.VISIBLE;
    chunk.newPriority = 0;
    chunk.newRequestedState = ChunkState.GPU_MEMORY;
    queueManager.performChunkPriorityUpdate(chunk);
    queueManager.invalidateSourceCache(source);
    chunk.downloadSucceeded();
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
    expect(chunkUpdates()).toEqual([]);
    // Run one queue pass, which copies the chunk to the GPU.
    vi.mocked(queueManager.scheduleUpdate).mockRestore();
    queueManager.scheduleUpdate();
    queueManager.process();
    expect(chunk.state).toBe(ChunkState.GPU_MEMORY);
    expect(chunkUpdates()).toEqual([
      expect.objectContaining({
        id: "0",
        new: true,
        state: ChunkState.GPU_MEMORY,
      }),
    ]);
  });

  it("expires the frontend's copy when the chunk is deleted instead", () => {
    // Demote the chunk to the RECENT tier, so that re-queueing it deletes it.
    queueManager.performChunkPriorityUpdate(chunk);
    queueManager.invalidateSourceCache(source);
    expect(source.chunks.size).toBe(0);
    expect(chunkUpdates()).toEqual([
      expect.objectContaining({ id: "0", state: ChunkState.EXPIRED }),
    ]);
  });

  it("expires the frontend's copy when the chunk is re-downloaded to worker memory only", () => {
    // Request the chunk in worker memory only, so that it is not sent to the frontend.
    chunk.newPriorityTier = ChunkPriorityTier.VISIBLE;
    chunk.newPriority = 0;
    chunk.newRequestedState = ChunkState.SYSTEM_MEMORY_WORKER;
    queueManager.performChunkPriorityUpdate(chunk);
    queueManager.invalidateSourceCache(source);
    chunk.downloadSucceeded();
    expect(chunk.state).toBe(ChunkState.SYSTEM_MEMORY_WORKER);
    expect(chunkUpdates()).toEqual([
      expect.objectContaining({ id: "0", state: ChunkState.EXPIRED }),
    ]);
  });

  it("expires the frontend's copy when the download fails", () => {
    queueManager.invalidateSourceCache(source);
    chunk.downloadFailed(new Error("test"));
    expect(chunkUpdates()).toEqual([
      expect.objectContaining({ id: "0", state: ChunkState.EXPIRED }),
    ]);
  });
});
