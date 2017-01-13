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

import {Chunk, ChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier} from 'neuroglancer/chunk_manager/base';
import {decodeVertexPositionsAndIndices} from 'neuroglancer/mesh/backend';
import {SegmentationLayerSharedObjectCounterpart} from 'neuroglancer/segmentation_display_state/backend';
import {forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {SKELETON_LAYER_RPC_ID} from 'neuroglancer/skeleton/base';
import {Endianness} from 'neuroglancer/util/endian';
import {Uint64} from 'neuroglancer/util/uint64';
import {registerSharedObject, RPC} from 'neuroglancer/worker_rpc';

const SKELETON_CHUNK_PRIORITY = 60;

// Chunk that contains the skeleton of a single object.
export class SkeletonChunk extends Chunk {
  objectId = new Uint64();
  vertexPositions: Float32Array|null = null;
  indices: Uint32Array|null = null;
  constructor() { super(); }

  initializeSkeletonChunk(key: string, objectId: Uint64) {
    super.initialize(key);
    this.objectId.assign(objectId);
  }
  freeSystemMemory() { this.vertexPositions = this.indices = null; }
  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    let {vertexPositions, indices} = this;
    msg['vertexPositions'] = vertexPositions;
    msg['indices'] = indices;
    let vertexPositionsBuffer = vertexPositions!.buffer;
    transfers.push(vertexPositionsBuffer);
    let indicesBuffer = indices!.buffer;
    if (indicesBuffer !== vertexPositionsBuffer) {
      transfers.push(indicesBuffer);
    }
    this.vertexPositions = this.indices = null;
  }
  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes =
        this.vertexPositions!.byteLength + this.indices!.byteLength;
    super.downloadSucceeded();
  }
};

export class SkeletonSource extends ChunkSource {
  chunks: Map<string, SkeletonChunk>;
  getChunk(objectId: Uint64) {
    const key = getObjectKey(objectId);
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
export class SkeletonLayer extends SegmentationLayerSharedObjectCounterpart {
  source: SkeletonSource;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(rpc.getRef<SkeletonSource>(options['source']));
    this.registerDisposer(this.chunkManager.recomputeChunkPriorities.add(() => {
      this.updateChunkPriorities();
    }));
  }

  private updateChunkPriorities() {
    if (!this.visible) {
      return;
    }
    let {source, chunkManager} = this;
    forEachVisibleSegment(this, objectId => {
      let chunk = source.getChunk(objectId);
      chunkManager.requestChunk(chunk, ChunkPriorityTier.VISIBLE, SKELETON_CHUNK_PRIORITY);
    });
  }
};

/**
 * Extracts vertex positions and edge vertex indices of the specified endianness from `data'.
 *
 * See documentation of decodeVertexPositionsAndIndices.
 */
export function decodeSkeletonVertexPositionsAndIndices(
    chunk: SkeletonChunk, data: ArrayBuffer, endianness: Endianness, vertexByteOffset: number,
    numVertices: number, indexByteOffset?: number, numEdges?: number) {
  decodeVertexPositionsAndIndices(
      chunk, /*verticesPerPrimitive=*/2, data, endianness, vertexByteOffset, numVertices,
      indexByteOffset, numEdges);
}
