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

/**
 * @file Chunks computed from other chunks (warped volumes, meshes, skeletons
 * and annotations).
 *
 * A computed chunk's dependencies are ordinary chunks of other sources,
 * requested through the chunk manager at the computed chunk's priority and
 * kept in worker memory (`SYSTEM_MEMORY_WORKER`), so they are fetched once,
 * shared by every computed chunk that needs them, and cached and evicted under
 * the normal memory limits.
 */

import type {
  Chunk,
  ChunkManager,
  ChunkSource,
} from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import { getObjectKey } from "#src/segmentation_display_state/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";

export interface Dependency {
  source: ChunkSource;
  key: string;
  // Gets (creating if needed) the chunk in its source.
  get(): Chunk;
}

export interface VolumeDependency extends Dependency {
  position: Float32Array;
}

/** The chunk at a grid position of a volume or annotation spatial index. */
export function volumeDependency(
  source: ChunkSource & { getChunk(position: Float32Array): Chunk },
  position: ArrayLike<number>,
): VolumeDependency {
  const p = Float32Array.from(position);
  return { source, position: p, key: p.join(), get: () => source.getChunk(p) };
}

/** The chunk of an object (a mesh manifest, a skeleton, ...). */
export function objectDependency(
  source: ChunkSource & { getChunk(objectId: bigint): Chunk },
  objectId: bigint,
): Dependency {
  return {
    source,
    key: getObjectKey(objectId),
    get: () => source.getChunk(objectId),
  };
}

export interface DependencyRequest {
  requester: Chunk;
  deps: Dependency[];
}

/**
 * Re-requests, on every priority update, the dependencies of every chunk being
 * computed, at that chunk's priority.
 */
class DependencyRequests {
  private requests = new Set<DependencyRequest>();

  constructor(private chunkManager: ChunkManager) {
    chunkManager.recomputeChunkPrioritiesLate.add(() => this.update());
  }

  private update() {
    const { chunkManager } = this;
    for (const { requester, deps } of this.requests) {
      const tier = requester.newPriorityTier;
      if (tier === ChunkPriorityTier.RECENT) continue;
      // Slightly ahead of the chunks that are not yet being computed.
      const priority = requester.newPriority + 1;
      for (const dep of deps) {
        chunkManager.requestChunk(
          dep.get(),
          tier,
          priority,
          ChunkState.SYSTEM_MEMORY_WORKER,
        );
      }
    }
  }

  add(requester: Chunk, deps: Dependency[]): DependencyRequest {
    const request = { requester, deps };
    this.requests.add(request);
    this.chunkManager.scheduleUpdateChunkPriorities();
    return request;
  }

  set(request: DependencyRequest, deps: Dependency[]) {
    request.deps = deps;
    this.chunkManager.scheduleUpdateChunkPriorities();
  }

  remove(request: DependencyRequest) {
    this.requests.delete(request);
  }
}

const dependencyRequests = new WeakMap<ChunkManager, DependencyRequests>();

function getDependencyRequests(chunkManager: ChunkManager) {
  let r = dependencyRequests.get(chunkManager);
  if (r === undefined) {
    r = new DependencyRequests(chunkManager);
    dependencyRequests.set(chunkManager, r);
  }
  return r;
}

/**
 * Runs `body` while `deps` are requested at `requester`'s priority; `body`
 * may replace them with `setDependencies`.
 */
export async function withDependencies<T>(
  chunkManager: ChunkManager,
  requester: Chunk,
  deps: Dependency[],
  body: (setDependencies: (deps: Dependency[]) => void) => Promise<T>,
): Promise<T> {
  const requests = getDependencyRequests(chunkManager);
  const request = requests.add(requester, deps);
  try {
    return await body((d) => requests.set(request, d));
  } finally {
    requests.remove(request);
  }
}

/**
 * Waits until a dependency is in memory. `onWorker` reads it when the worker
 * holds it; `onFrontend` when it has been moved to the frontend (because
 * another layer displays it too).
 */
export function waitForDependency<T>(
  dep: Dependency,
  signal: AbortSignal,
  onWorker: (chunk: Chunk) => T,
  onFrontend: (chunk: Chunk) => Promise<T>,
): Promise<T> {
  const { source, key } = dep;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = () => {
      done = true;
      source.unregisterChunkListener(key, check);
      signal.removeEventListener("abort", onAbort);
    };
    function check() {
      if (done) return;
      const chunk = source.chunks.get(key);
      if (chunk === undefined) return;
      switch (chunk.state) {
        case ChunkState.SYSTEM_MEMORY_WORKER:
          finish();
          try {
            resolve(onWorker(chunk));
          } catch (e) {
            reject(e);
          }
          return;
        case ChunkState.SYSTEM_MEMORY:
        case ChunkState.GPU_MEMORY:
          finish();
          onFrontend(chunk).then(resolve, reject);
          return;
        case ChunkState.FAILED:
          finish();
          reject(chunk.error);
          return;
      }
    }
    function onAbort() {
      finish();
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort);
    source.registerChunkListener(key, check);
    check();
  });
}

export type ChunkData = ArrayLike<number> | null;

/**
 * The data of a volume chunk dependency, once it is available; null for a
 * missing chunk (fill value).
 */
export function getDependencyData(
  dep: Dependency,
  signal: AbortSignal,
): Promise<ChunkData> {
  return waitForDependency(
    dep,
    signal,
    (chunk) => (chunk as VolumeChunk).data as ChunkData,
    (chunk) =>
      chunk.queueManager
        .retrieveChunkData(chunk)
        .then((data) => data as ChunkData),
  );
}
