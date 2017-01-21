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

import {Chunk, ChunkManager, ChunkSourceBase, RECOMPUTE_CHUNK_PRIORITIES_LAST} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {CANCELED, CancellationToken, makeCancelablePromise} from 'neuroglancer/util/cancellation';
import {openHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {getObjectId} from 'neuroglancer/util/object_id';

export type PriorityGetter = () => {
  priorityTier: ChunkPriorityTier, priority: number
};

interface FileDataRequester<Data> {
  resolve: (data: Data) => void;
  reject: (error: any) => void;
  getPriority: PriorityGetter;
}

class GenericFileChunk<Data> extends Chunk {
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

  freeSystemMemory() { this.data = undefined; }
}

export class GenericFileSource<Data> extends ChunkSourceBase {
  chunks: Map<string, GenericFileChunk<Data>>;

  constructor(chunkManager: ChunkManager, public decodeFile: (response: ArrayBuffer) => Data) {
    super(chunkManager);
    this.registerDisposer(chunkManager);

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
          let {priorityTier, priority} = requester.getPriority();
          chunkManager.requestChunk(chunk, priorityTier, priority);
        }
      }
    }
  }

  download(chunk: GenericFileChunk<Data>, cancellationToken: CancellationToken) {
    return sendHttpRequest(openHttpRequest(chunk.key!), 'arraybuffer', cancellationToken)
        .then(response => {
          chunk.data = this.decodeFile(response);
        });
  }

  /**
   * Precondition: priorityTier <= ChunkPriorityTier.LAST_ORDERED_TIER
   */
  getData(key: string, getPriority: PriorityGetter, cancellationToken: CancellationToken) {
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(GenericFileChunk);
      chunk.initialize(key);
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

  /**
   * Reference count of chunkManager should be incremented by the caller.
   */
  static get<Data>(chunkManager: ChunkManager, decodeFile: (response: ArrayBuffer) => Data) {
    return chunkManager.memoize.get(
        `getFileSource:${getObjectId(decodeFile)}`,
        () => new GenericFileSource(chunkManager, decodeFile));
  }

  /**
   * Reference count of chunkManager should be incremented by the caller.
   */
  static getData<Data>(
      chunkManager: ChunkManager, decodeFile: (response: ArrayBuffer) => Data, key: string,
      getPriority: PriorityGetter, cancellationToken: CancellationToken) {
    const source = GenericFileSource.get(chunkManager, decodeFile);
    const result = source.getData(key, getPriority, cancellationToken);
    source.dispose();
    return result;
  }
}
