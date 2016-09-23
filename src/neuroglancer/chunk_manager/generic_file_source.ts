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

import {Chunk, ChunkSource, handleChunkDownloadPromise, RECOMPUTE_CHUNK_PRIORITIES_LAST} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier, ChunkState} from 'neuroglancer/chunk_manager/base';
import {openHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {makeCancellablePromise} from 'neuroglancer/util/promise';
import {RPC} from 'neuroglancer/worker_rpc';

interface FileDataRequester<Data> {
  resolve: (data: Data) => void;
  reject: (error: any) => void;
  getPriority: () => { priorityTier: ChunkPriorityTier, priority: number };
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

export abstract class GenericFileSource<Data> extends ChunkSource {
  chunks: Map<string, GenericFileChunk<Data>>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    // This source is unusual in that it updates its own chunk priorities.
    this.registerSignalBinding(this.chunkManager.recomputeChunkPriorities.add(
        this.updateChunkPriorities, this, RECOMPUTE_CHUNK_PRIORITIES_LAST));
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

  download(chunk: GenericFileChunk<Data>) {
    let xhr = openHttpRequest(chunk.key!);
    handleChunkDownloadPromise(chunk, sendHttpRequest(xhr, 'arraybuffer'), (c, response) => {
      c.data = this.decodeFile(response);
    });
  }

  abstract decodeFile(response: ArrayBuffer): Data;

  /**
   * Precondition: priorityTier <= ChunkPriorityTier.LAST_ORDERED_TIER
   */
  getData(key: string, getPriority: () => {priorityTier: ChunkPriorityTier, priority: number}) {
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(GenericFileChunk);
      chunk.initialize(key);
      this.addChunk(chunk);
    }
    return makeCancellablePromise<Data>((resolve, reject, onCancel) => {
      switch (chunk!.state) {
        case ChunkState.FAILED:
          reject(chunk!.error);
          return;

        case ChunkState.SYSTEM_MEMORY_WORKER:
          resolve(chunk!.data!);
          return;
      }

      let requester: FileDataRequester<Data> = {resolve, reject, getPriority};
      chunk!.requesters!.add(requester);
      onCancel(() => {
        let {requesters} = chunk!;
        if (requesters !== undefined) {
          requesters.delete(requester);
        }
      });
      this.chunkManager.scheduleUpdateChunkPriorities();
    });
  }
}
