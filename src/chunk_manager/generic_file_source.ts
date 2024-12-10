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
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import { raceWithAbort, SharedAbortController } from "#src/util/abort.js";
import type { Borrowed, Owned } from "#src/util/disposable.js";
import { stableStringify } from "#src/util/json.js";
import { getObjectId } from "#src/util/object_id.js";
import type { SpecialProtocolCredentialsProvider } from "#src/util/special_protocol_request.js";
import { fetchSpecialOk } from "#src/util/special_protocol_request.js";

export type PriorityGetter = () => {
  priorityTier: ChunkPriorityTier;
  priority: number;
};

interface FileDataRequester<Data> {
  resolve: (data: Data) => void;
  reject: (error: any) => void;
  getPriority: PriorityGetter;
  cleanup: () => void;
}

class GenericSharedDataChunk<Key, Data> extends Chunk {
  decodedKey?: Key;
  data?: Data;
  requesters?: Set<FileDataRequester<Data>>;

  initialize(key: string) {
    super.initialize(key);
    this.requesters = new Set<FileDataRequester<Data>>();
  }

  downloadSucceeded() {
    super.downloadSucceeded();
    const { requesters, data } = this;
    this.requesters = undefined;
    for (const requester of requesters!) {
      requester.resolve(data!);
    }
  }

  downloadFailed(error: any) {
    super.downloadFailed(error);
    const { requesters } = this;
    this.requesters = undefined;
    for (const requester of requesters!) {
      requester.reject(error);
    }
  }

  freeSystemMemory() {
    this.data = undefined;
  }
}

export interface GenericSharedDataSourceOptions<Key, Data> {
  encodeKey?: (key: Key) => string;
  download: (
    key: Key,
    abortSignal: AbortSignal,
  ) => Promise<{ size: number; data: Data }>;
  sourceQueueLevel?: number;
}

export class GenericSharedDataSource<Key, Data> extends ChunkSourceBase {
  declare chunks: Map<string, GenericSharedDataChunk<Key, Data>>;

  private encodeKeyFunction: (key: Key) => string;

  private downloadFunction: (
    key: Key,
    abortSignal: AbortSignal,
  ) => Promise<{ size: number; data: Data }>;

  constructor(
    chunkManager: Owned<ChunkManager>,
    options: GenericSharedDataSourceOptions<Key, Data>,
  ) {
    super(chunkManager);
    this.registerDisposer(chunkManager);
    const { encodeKey = stableStringify } = options;
    this.downloadFunction = options.download;
    this.encodeKeyFunction = encodeKey;
    const { sourceQueueLevel = 0 } = options;
    this.sourceQueueLevel = sourceQueueLevel;

    // This source is unusual in that it updates its own chunk priorities.
    this.registerDisposer(
      this.chunkManager.recomputeChunkPrioritiesLate.add(() => {
        this.updateChunkPriorities();
      }),
    );
  }

  updateChunkPriorities() {
    const { chunkManager } = this;
    for (const chunk of this.chunks.values()) {
      const { requesters } = chunk;
      if (requesters !== undefined) {
        for (const requester of requesters) {
          const { priorityTier, priority } = requester.getPriority();
          if (priorityTier === ChunkPriorityTier.RECENT) continue;
          chunkManager.requestChunk(
            chunk,
            priorityTier,
            priority,
            ChunkState.SYSTEM_MEMORY_WORKER,
          );
        }
      }
    }
  }

  async download(
    chunk: GenericSharedDataChunk<Key, Data>,
    abortSignal: AbortSignal,
  ) {
    const { size, data } = await this.downloadFunction(
      chunk.decodedKey!,
      abortSignal,
    );
    chunk.systemMemoryBytes = size;
    chunk.data = data;
  }

  /**
   * Precondition: priorityTier <= ChunkPriorityTier.LAST_ORDERED_TIER
   */
  getData(key: Key, getPriority: PriorityGetter, abortSignal: AbortSignal) {
    const encodedKey = this.encodeKeyFunction(key);
    let chunk = this.chunks.get(encodedKey);
    if (chunk === undefined) {
      chunk = this.getNewChunk_<GenericSharedDataChunk<Key, Data>>(
        GenericSharedDataChunk,
      );
      chunk.decodedKey = key;
      chunk.initialize(encodedKey);
      this.addChunk(chunk);
    }
    return new Promise<Data>((resolve, reject) => {
      // If the data is already available or the request has already failed, resolve/reject the
      // promise immediately.
      switch (chunk!.state) {
        case ChunkState.FAILED:
          reject(chunk!.error);
          return;

        case ChunkState.SYSTEM_MEMORY_WORKER:
          resolve(chunk!.data!);
          return;
      }
      function handleAbort() {
        const { requesters } = chunk!;
        if (requesters !== undefined) {
          requesters.delete(requester);
          chunk!.chunkManager!.scheduleUpdateChunkPriorities();
        }
        reject(abortSignal.reason);
      }

      const requester: FileDataRequester<Data> = {
        resolve,
        reject,
        getPriority,
        cleanup: () => abortSignal.removeEventListener("abort", handleAbort),
      };
      chunk!.requesters!.add(requester);
      abortSignal.addEventListener("abort", handleAbort, { once: true });
      this.chunkManager.scheduleUpdateChunkPriorities();
    });
  }

  static get<Key, Data>(
    chunkManager: Borrowed<ChunkManager>,
    memoizeKey: string,
    options: GenericSharedDataSourceOptions<Key, Data>,
  ) {
    return chunkManager.memoize.get(
      `getFileSource:${memoizeKey}`,
      () => new GenericSharedDataSource(chunkManager.addRef(), options),
    );
  }

  static getData<Key, Data>(
    chunkManager: Borrowed<ChunkManager>,
    memoizeKey: string,
    options: GenericSharedDataSourceOptions<Key, Data>,
    key: Key,
    getPriority: PriorityGetter,
    abortSignal: AbortSignal,
  ) {
    const source = GenericSharedDataSource.get(
      chunkManager,
      memoizeKey,
      options,
    );
    const result = source.getData(key, getPriority, abortSignal);
    source.dispose();
    return result;
  }

  static getUrl<Data>(
    chunkManager: Borrowed<ChunkManager>,
    credentialsProvider: SpecialProtocolCredentialsProvider,
    decodeFunction: (
      buffer: ArrayBuffer,
      abortSignal: AbortSignal,
    ) => Promise<{ size: number; data: Data }>,
    url: string,
    getPriority: PriorityGetter,
    abortSignal: AbortSignal,
  ) {
    return GenericSharedDataSource.getData<string, Data>(
      chunkManager,
      `${getObjectId(decodeFunction)}`,
      {
        download: (url: string, abortSignal: AbortSignal) =>
          fetchSpecialOk(credentialsProvider, url, { signal: abortSignal })
            .then((response) => response.arrayBuffer())
            .then((response) => decodeFunction(response, abortSignal)),
      },
      url,
      getPriority,
      abortSignal,
    );
  }
}

class AsyncCacheChunk<Data> extends Chunk {
  promise: Promise<Data> | undefined;
  outstandingRequests: number = 0;
  sharedAbortController: SharedAbortController | undefined;

  initialize(key: string) {
    super.initialize(key);
  }

  freeSystemMemory() {
    this.promise = undefined;
  }
}

export interface SimpleAsyncCacheOptions<Key, Value> {
  encodeKey?: (key: Key) => string;
  get: (
    key: Key,
    abortSignal: AbortSignal,
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
    abortSignal: AbortSignal,
  ) => Promise<{ size: number; data: Value }>;

  get(key: Key, abortSignal?: AbortSignal): Promise<Value> {
    const encodedKey = this.encodeKeyFunction(key);
    let chunk = this.chunks.get(encodedKey);
    if (chunk === undefined) {
      chunk = this.getNewChunk_<AsyncCacheChunk<Value>>(AsyncCacheChunk);
      chunk.initialize(encodedKey);
      this.addChunk(chunk);
    }
    if (
      chunk.promise === undefined ||
      chunk.sharedAbortController?.signal.aborted
    ) {
      let completed = false;
      const sharedAbortController = (chunk!.sharedAbortController =
        new SharedAbortController());
      sharedAbortController.signal.addEventListener("abort", () => {
        if (!completed) {
          chunk!.promise = undefined;
        }
      });
      chunk.promise = (async () => {
        try {
          const { data, size } = await this.downloadFunction(
            key,
            sharedAbortController.signal,
          );
          chunk.systemMemoryBytes = size;
          chunk!.queueManager.updateChunkState(
            chunk!,
            ChunkState.SYSTEM_MEMORY,
          );
          return data;
        } catch (e) {
          chunk!.queueManager.updateChunkState(chunk!, ChunkState.FAILED);
          throw e;
        } finally {
          completed = true;
          sharedAbortController[Symbol.dispose]();
        }
      })();
    }
    chunk!.sharedAbortController!.addConsumer(abortSignal);
    chunk!.sharedAbortController!.start();
    return raceWithAbort(chunk.promise, abortSignal);
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
