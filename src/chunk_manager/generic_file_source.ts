/**
 * @license
 * Copyright 2016 Google Inc.
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
 * @file
 * Provides a simple way to request a file on the backend with priority integration.
 */

import type { ChunkManager } from "#src/chunk_manager/backend.js";
import { Chunk, ChunkSourceBase } from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { ReadResponse } from "#src/kvstore/index.js";
import type { Owned } from "#src/util/disposable.js";
import { stableStringify } from "#src/util/json.js";
import type { AsyncMemoize } from "#src/util/memoize.js";
import { asyncMemoizeWithProgress } from "#src/util/memoize.js";
import { getObjectId } from "#src/util/object_id.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

class AsyncCacheChunk<Data> extends Chunk {
  asyncMemoize: AsyncMemoize<Data> | undefined;

  initialize(key: string) {
    super.initialize(key);
  }

  freeSystemMemory() {
    this.asyncMemoize = undefined;
  }
}

export interface SimpleAsyncCacheOptions<Key, Value> {
  encodeKey?: (key: Key) => string;
  get: (
    key: Key,
    progressOptions: ProgressOptions,
  ) => Promise<{ size: number; data: Value }>;
}

export class SimpleAsyncCache<Key, Value> extends ChunkSourceBase {
  declare chunks: Map<string, AsyncCacheChunk<Value>>;

  constructor(
    chunkManager: Owned<ChunkManager>,
    options: SimpleAsyncCacheOptions<Key, Value>,
  ) {
    super(chunkManager);
    this.registerDisposer(chunkManager);
    this.downloadFunction = options.get;
    this.encodeKeyFunction = options.encodeKey ?? stableStringify;
  }
  encodeKeyFunction: (key: Key) => string;
  downloadFunction: (
    key: Key,
    progressOptions: ProgressOptions,
  ) => Promise<{ size: number; data: Value }>;

  get(key: Key, options: Partial<ProgressOptions>): Promise<Value> {
    const encodedKey = this.encodeKeyFunction(key);
    let chunk = this.chunks.get(encodedKey);
    if (chunk === undefined) {
      chunk = this.getNewChunk_<AsyncCacheChunk<Value>>(AsyncCacheChunk);
      chunk.initialize(encodedKey);
      this.addChunk(chunk);
    }
    if (chunk.asyncMemoize === undefined) {
      chunk.asyncMemoize = asyncMemoizeWithProgress(async (progressOptions) => {
        try {
          const { data, size } = await this.downloadFunction(
            key,
            progressOptions,
          );
          chunk.systemMemoryBytes = size;
          chunk!.queueManager.updateChunkState(
            chunk!,
            ChunkState.SYSTEM_MEMORY_WORKER,
          );
          return data;
        } catch (e) {
          chunk!.queueManager.updateChunkState(chunk!, ChunkState.FAILED);
          throw e;
        }
      });
    }
    if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER) {
      chunk.chunkManager.queueManager.markRecentlyUsed(chunk);
    }
    return chunk.asyncMemoize(options);
  }
}

export function makeSimpleAsyncCache<Key, Data>(
  chunkManager: ChunkManager,
  memoizeKey: string,
  options: SimpleAsyncCacheOptions<Key, Data>,
) {
  return chunkManager.memoize.get(
    `simpleAsyncCache:${memoizeKey}`,
    () => new SimpleAsyncCache(chunkManager.addRef(), options),
  );
}

export function getCachedDecodedUrl<Data>(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  url: string,
  decodeFunction: (
    readResponse: ReadResponse,
    options: ProgressOptions,
  ) => Promise<{ size: number; data: Data }>,
  options: Partial<ProgressOptions>,
): Promise<Data> {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    `getCachedDecodedUrl:${getObjectId(decodeFunction)}`,
    () => {
      const cache = new SimpleAsyncCache(
        sharedKvStoreContext.chunkManager.addRef(),
        {
          get: async (url: string, progressOptions: ProgressOptions) => {
            const readResponse = await sharedKvStoreContext.kvStoreContext.read(
              url,
              { ...progressOptions, throwIfMissing: true },
            );
            try {
              return decodeFunction(readResponse, progressOptions);
            } catch (e) {
              throw new Error("Error reading ${url}", { cause: e });
            }
          },
        },
      );
      cache.registerDisposer(sharedKvStoreContext.addRef());
      return cache;
    },
  );
  return cache.get(url, options);
}
