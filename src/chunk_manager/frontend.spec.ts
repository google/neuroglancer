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

import { describe, expect, it, vi } from "vitest";
import { ChunkState } from "#src/chunk_manager/base.js";
import {
  CapacitySpecification,
  Chunk,
  ChunkManager,
  ChunkQueueManager,
  ChunkSource,
} from "#src/chunk_manager/frontend.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";
import { RPC } from "#src/worker_rpc.js";

class TestSource extends ChunkSource {
  getChunk() {
    return new Chunk(this);
  }
}

describe("ChunkQueueManager.applyChunkUpdate", () => {
  it("replaces a chunk the source already holds", () => {
    const rpc = new RPC(
      { postMessage: () => {}, onmessage: null },
      /*waitUntilReady=*/ false,
    );
    const queueManager = new ChunkQueueManager(
      rpc,
      {} as GL,
      { frameNumber: 0, changed: new NullarySignal() },
      {
        gpuMemory: new CapacitySpecification(),
        systemMemory: new CapacitySpecification(),
        download: new CapacitySpecification(),
        compute: new CapacitySpecification(),
      },
    );
    const source = new TestSource(new ChunkManager(queueManager));
    source.initializeCounterpart(rpc, {});
    const update = { source: source.rpcId, id: "0", new: true };

    queueManager.applyChunkUpdate({ ...update, state: ChunkState.GPU_MEMORY });
    const held = source.chunks.get("0")!;
    expect(held.state).toBe(ChunkState.GPU_MEMORY);
    const freeGPUMemory = vi.spyOn(held, "freeGPUMemory");

    queueManager.applyChunkUpdate({
      ...update,
      state: ChunkState.SYSTEM_MEMORY,
    });
    expect(freeGPUMemory).toHaveBeenCalledOnce();
    const replacement = source.chunks.get("0")!;
    expect(replacement).not.toBe(held);
    expect(replacement.state).toBe(ChunkState.SYSTEM_MEMORY);
  });
});
