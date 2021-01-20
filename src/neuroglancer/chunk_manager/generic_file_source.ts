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

import {Chunk, ChunkManager, ChunkSourceBase} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {CANCELED, CancellationToken, makeCancelablePromise} from 'neuroglancer/util/cancellation';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {responseArrayBuffer} from 'neuroglancer/util/http_request';
import {stableStringify} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {cancellableFetchSpecialOk, SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';

export type PriorityGetter = () => {
  priorityTier: ChunkPriorityTier, priority: number
};

interface FileDataRequester<Data> {
  resolve: (data: Data) => void;
  reject: (error: any) => void;
  getPriority: PriorityGetter;
}

class GenericSharedDataChunk<Key, Data> extends Chunk {
  decodedKey?: Key;
  data?: Data;
  requesters?: Set<FileDataRequester<Data>>;
  backendOnly = true;

  initialize(key: string) {
    super.initialize(key);
    this.requesters = new Set<FileDataRequester<Data>>();
  }

  downloadSucceeded() {
    super.downloadSucceeded();
    let {requesters, data} = this;
    this.requesters = undefined;
    for (let requester of requesters!) {
      requester.resolve(data!);
    }
  }

  downloadFailed(error: any) {
    super.downloadFailed(error);
    let {requesters} = this;
    this.requesters = undefined;
    for (let requester of requesters!) {
      requester.reject(error);
    }
  }

  freeSystemMemory() {
    this.data = undefined;
  }
}

export interface GenericSharedDataSourceOptions<Key, Data> {
  encodeKey?: (key: Key) => string;
  download: (key: Key, cancellationToken: CancellationToken) => Promise<{size: number, data: Data}>;
  sourceQueueLevel?: number;
}

export class GenericSharedDataSource<Key, Data> extends ChunkSourceBase {
  chunks: Map<string, GenericSharedDataChunk<Key, Data>>;

  private encodeKeyFunction: (key: Key) => string;

  private downloadFunction:
      (key: Key, cancellationToken: CancellationToken) => Promise<{size: number, data: Data}>;

  constructor(
      chunkManager: Owned<ChunkManager>, options: GenericSharedDataSourceOptions<Key, Data>) {
    super(chunkManager);
    this.registerDisposer(chunkManager);
    const {encodeKey = stableStringify} = options;
    this.downloadFunction = options.download;
    this.encodeKeyFunction = encodeKey;
    const {sourceQueueLevel = 0} = options;
    this.sourceQueueLevel = sourceQueueLevel;

    // This source is unusual in that it updates its own chunk priorities.
    this.registerDisposer(this.chunkManager.recomputeChunkPrioritiesLate.add(() => {
      this.updateChunkPriorities();
    }));
  }

  updateChunkPriorities() {
    let {chunkManager} = this;
    for (let chunk of this.chunks.values()) {
      let {requesters} = chunk;
      if (requesters !== undefined) {
        for (let requester of requesters) {
          const {priorityTier, priority} = requester.getPriority();
          if (priorityTier === ChunkPriorityTier.RECENT) continue;
          chunkManager.requestChunk(chunk, priorityTier, priority);
        }
      }
    }
  }

  async download(chunk: GenericSharedDataChunk<Key, Data>, cancellationToken: CancellationToken) {
    const {size, data} = await this.downloadFunction(chunk.decodedKey!, cancellationToken);
    chunk.systemMemoryBytes = size;
    chunk.data = data;
  }

  /**
   * Precondition: priorityTier <= ChunkPriorityTier.LAST_ORDERED_TIER
   */
  getData(key: Key, getPriority: PriorityGetter, cancellationToken: CancellationToken) {
    const encodedKey = this.encodeKeyFunction(key);
    let chunk = this.chunks.get(encodedKey);
    if (chunk === undefined) {
      chunk = this.getNewChunk_<GenericSharedDataChunk<Key, Data>>(GenericSharedDataChunk);
      chunk.decodedKey = key;
      chunk.initialize(encodedKey);
      this.addChunk(chunk);
    }
    return makeCancelablePromise<Data>(cancellationToken, (resolve, reject, token) => {
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
      const requester: FileDataRequester<Data> = {resolve, reject, getPriority};
      chunk!.requesters!.add(requester);
      token.add(() => {
        let {requesters} = chunk!;
        if (requesters !== undefined) {
          requesters.delete(requester);
          this.chunkManager.scheduleUpdateChunkPriorities();
        }
        reject(CANCELED);
      });
      this.chunkManager.scheduleUpdateChunkPriorities();
    });
  }

  static get<Key, Data>(
      chunkManager: Borrowed<ChunkManager>, memoizeKey: string,
      options: GenericSharedDataSourceOptions<Key, Data>) {
    return chunkManager.memoize.get(
        `getFileSource:${memoizeKey}`,
        () => new GenericSharedDataSource(chunkManager.addRef(), options));
  }

  static getData<Key, Data>(
      chunkManager: Borrowed<ChunkManager>, memoizeKey: string,
      options: GenericSharedDataSourceOptions<Key, Data>, key: Key, getPriority: PriorityGetter,
      cancellationToken: CancellationToken) {
    const source = GenericSharedDataSource.get(chunkManager, memoizeKey, options);
    const result = source.getData(key, getPriority, cancellationToken);
    source.dispose();
    return result;
  }

  static getUrl<Data>(
      chunkManager: Borrowed<ChunkManager>, credentialsProvider: SpecialProtocolCredentialsProvider,
      decodeFunction: (buffer: ArrayBuffer, cancellationToken: CancellationToken) =>
          Promise<{size: number, data: Data}>,
      url: string, getPriority: PriorityGetter, cancellationToken: CancellationToken) {
    return GenericSharedDataSource.getData<string, Data>(
        chunkManager, `${getObjectId(decodeFunction)}`, {
          download: (url: string, cancellationToken: CancellationToken) =>
              cancellableFetchSpecialOk(
                  credentialsProvider, url, {}, responseArrayBuffer, cancellationToken)
                  .then(response => decodeFunction(response, cancellationToken))
        },
        url, getPriority, cancellationToken);
  }
}
