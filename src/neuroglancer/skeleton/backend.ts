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
import {decodeVertexPositionsAndIndices} from 'neuroglancer/mesh/backend';
import {SegmentationLayerSharedObjectCounterpart} from 'neuroglancer/segmentation_display_state/backend';
import {forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {SKELETON_LAYER_RPC_ID} from 'neuroglancer/skeleton/base';
import {TypedArray} from 'neuroglancer/util/array';
import {Endianness} from 'neuroglancer/util/endian';
import {Uint64} from 'neuroglancer/util/uint64';
import {getBasePriority, getPriorityTier} from 'neuroglancer/visibility_priority/backend';
import {registerSharedObject, RPC} from 'neuroglancer/worker_rpc';

const SKELETON_CHUNK_PRIORITY = 60;

// Chunk that contains the skeleton of a single object.
export class SkeletonChunk extends Chunk {
  objectId = new Uint64();
  vertexPositions: Float32Array|null = null;
  vertexAttributes: TypedArray[]|null = null;
  indices: Uint32Array|null = null;
  constructor() {
    super();
  }

  initializeSkeletonChunk(key: string, objectId: Uint64) {
    super.initialize(key);
    this.objectId.assign(objectId);
  }
  freeSystemMemory() {
    this.vertexPositions = this.indices = null;
  }

  private getVertexAttributeBytes() {
    let total = this.vertexPositions!.byteLength;
    const {vertexAttributes} = this;
    if (vertexAttributes != null) {
      vertexAttributes.forEach(a => {
        total += a.byteLength;
      });
    }
    return total;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    const vertexPositions = this.vertexPositions!;
    const indices = this.indices!;
    msg['indices'] = indices;
    transfers.push(indices.buffer);

    const {vertexAttributes} = this;
    if (vertexAttributes != null && vertexAttributes.length > 0) {
      const vertexData = new Uint8Array(this.getVertexAttributeBytes());
      vertexData.set(new Uint8Array(
          vertexPositions.buffer, vertexPositions.byteOffset, vertexPositions.byteLength));
      let vertexAttributeOffsets = msg['vertexAttributeOffsets'] =
          new Uint32Array(vertexAttributes.length + 1);
      vertexAttributeOffsets[0] = 0;
      let offset = vertexPositions.byteLength;
      vertexAttributes.forEach((a, i) => {
        vertexAttributeOffsets[i + 1] = offset;
        vertexData.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset);
        offset += a.byteLength;
      });
      transfers.push(vertexData.buffer);
      msg['vertexAttributes'] = vertexData;
    } else {
      msg['vertexAttributes'] = new Uint8Array(
          vertexPositions.buffer, vertexPositions.byteOffset, vertexPositions.byteLength);
      msg['vertexAttributeOffsets'] = Uint32Array.of(0);
      if (vertexPositions.buffer !== transfers[0]) {
        transfers.push(vertexPositions.buffer);
      }
    }
    this.vertexPositions = this.indices = this.vertexAttributes = null;
  }
  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes =
        this.indices!.byteLength + this.getVertexAttributeBytes();
    super.downloadSucceeded();
  }
}

export abstract class SkeletonSource extends ChunkSource {
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
}

export abstract class ParameterizedSkeletonSource<Parameters> extends SkeletonSource {
  parameters: Parameters;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options['parameters'];
  }
}

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
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    const priorityTier = getPriorityTier(visibility);
    const basePriority = getBasePriority(visibility);
    const {source, chunkManager} = this;
    forEachVisibleSegment(this, objectId => {
      const chunk = source.getChunk(objectId);
      chunkManager.requestChunk(chunk, priorityTier, basePriority + SKELETON_CHUNK_PRIORITY);
    });
  }
}

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
