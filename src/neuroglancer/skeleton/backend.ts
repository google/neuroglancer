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

import 'neuroglancer/uint64_set'; // Import for side effects.

import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier} from 'neuroglancer/chunk_manager/base';
import {SKELETON_LAYER_RPC_ID} from 'neuroglancer/skeleton/base';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {Uint64} from 'neuroglancer/util/uint64';
import {RPC, SharedObjectCounterpart, registerSharedObject} from 'neuroglancer/worker_rpc';

const SKELETON_CHUNK_PRIORITY = 60;

// Chunk that contains the skeleton of a single object.
export class SkeletonChunk extends Chunk {
  objectId = new Uint64();
  data: Uint8Array|null = null;
  constructor() { super(); }

  initializeSkeletonChunk(key: string, objectId: Uint64) {
    super.initialize(key);
    this.objectId.assign(objectId);
  }
  freeSystemMemory() { this.data = null; }
  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    let data = msg['data'] = this.data!;
    transfers.push(data.buffer);
    this.data = null;
  }
  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.data!.byteLength;
    super.downloadSucceeded();
  }
};

export class SkeletonSource extends ChunkSource {
  chunks: Map<string, SkeletonChunk>;
  getChunk(objectId: Uint64) {
    let key = `${objectId.low}:${objectId.high}`;
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(SkeletonChunk);
      chunk.initializeSkeletonChunk(key, objectId);
      this.addChunk(chunk);
    }
    return chunk;
  }
};

export class ParameterizedSkeletonSource<Parameters> extends SkeletonSource {
  parameters: Parameters;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }
};

@registerSharedObject(SKELETON_LAYER_RPC_ID)
export class SkeletonLayer extends SharedObjectCounterpart {
  chunkManager: ChunkManager;
  source: SkeletonSource;
  visibleSegmentSet: Uint64Set;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    // No need to increase reference count of chunkManager and visibleSegmentSet since our owner
    // counterpart will hold a reference to the owner counterparts of them.
    this.chunkManager = <ChunkManager>rpc.get(options['chunkManager']);
    this.visibleSegmentSet = <Uint64Set>rpc.get(options['visibleSegmentSet']);
    this.source = this.registerDisposer(rpc.getRef<SkeletonSource>(options['source']));
    this.registerSignalBinding(
        this.chunkManager.recomputeChunkPriorities.add(this.updateChunkPriorities, this));
    this.registerSignalBinding(
        this.visibleSegmentSet.changed.add(this.handleVisibleSegmentSetChanged, this));
  }

  private handleVisibleSegmentSetChanged() { this.chunkManager.scheduleUpdateChunkPriorities(); }

  private updateChunkPriorities() {
    let source = this.source;
    let chunkManager = this.chunkManager;
    for (let segment of this.visibleSegmentSet) {
      let chunk = source.getChunk(segment);
      chunkManager.requestChunk(chunk, ChunkPriorityTier.VISIBLE, SKELETON_CHUNK_PRIORITY);
    }
  }
};

/**
 * Assigns chunk.data based on the received skeleton.
 *
 * Currently just directly stores the skeleton data as a Uint8Array.
 */
export function decodeSkeletonChunk(chunk: SkeletonChunk, response: any) {
  chunk.data = new Uint8Array(response);
}
