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

import {
  Chunk,
  ChunkRenderLayerBackend,
  ChunkSource,
  withChunkManager,
} from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import { decodeVertexPositionsAndIndices } from "#src/mesh/backend.js";
import { withSegmentationLayerBackendState } from "#src/segmentation_display_state/backend.js";
import {
  forEachVisibleSegment,
  getObjectKey,
} from "#src/segmentation_display_state/base.js";
import { SKELETON_LAYER_RPC_ID } from "#src/skeleton/base.js";
import type { TypedNumberArray } from "#src/util/array.js";
import type { Endianness } from "#src/util/endian.js";
import {
  getBasePriority,
  getPriorityTier,
  withSharedVisibility,
} from "#src/visibility_priority/backend.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

const SKELETON_CHUNK_PRIORITY = 60;

// Chunk that contains the skeleton of a single object.
export class SkeletonChunk extends Chunk {
  objectId: bigint = 0n;
  vertexPositions: Float32Array | null = null;
  vertexAttributes: TypedNumberArray[] | null = null;
  indices: Uint32Array | null = null;

  initializeSkeletonChunk(key: string, objectId: bigint) {
    super.initialize(key);
    this.objectId = objectId;
  }
  freeSystemMemory() {
    this.vertexPositions = this.indices = null;
  }

  private getVertexAttributeBytes() {
    let total = this.vertexPositions!.byteLength;
    const { vertexAttributes } = this;
    if (vertexAttributes != null) {
      vertexAttributes.forEach((a) => {
        total += a.byteLength;
      });
    }
    return total;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    const vertexPositions = this.vertexPositions!;
    const indices = this.indices!;
    msg.numVertices = vertexPositions.length / 3;
    msg.indices = indices;
    transfers.push(indices.buffer);

    const { vertexAttributes } = this;
    if (vertexAttributes != null && vertexAttributes.length > 0) {
      const vertexData = new Uint8Array(this.getVertexAttributeBytes());
      vertexData.set(
        new Uint8Array(
          vertexPositions.buffer,
          vertexPositions.byteOffset,
          vertexPositions.byteLength,
        ),
      );
      const vertexAttributeOffsets = (msg.vertexAttributeOffsets =
        new Uint32Array(vertexAttributes.length + 1));
      vertexAttributeOffsets[0] = 0;
      let offset = vertexPositions.byteLength;
      vertexAttributes.forEach((a, i) => {
        vertexAttributeOffsets[i + 1] = offset;
        vertexData.set(
          new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
          offset,
        );
        offset += a.byteLength;
      });
      transfers.push(vertexData.buffer);
      msg.vertexAttributes = vertexData;
    } else {
      msg.vertexAttributes = new Uint8Array(
        vertexPositions.buffer,
        vertexPositions.byteOffset,
        vertexPositions.byteLength,
      );
      msg.vertexAttributeOffsets = Uint32Array.of(0);
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

export class SkeletonSource extends ChunkSource {
  declare chunks: Map<string, SkeletonChunk>;
  getChunk(objectId: bigint) {
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

@registerSharedObject(SKELETON_LAYER_RPC_ID)
export class SkeletonLayer extends withSegmentationLayerBackendState(
  withSharedVisibility(withChunkManager(ChunkRenderLayerBackend)),
) {
  source: SkeletonSource;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(
      rpc.getRef<SkeletonSource>(options.source),
    );
    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() => {
        this.updateChunkPriorities();
      }),
    );
  }

  private updateChunkPriorities() {
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    this.chunkManager.registerLayer(this);
    const priorityTier = getPriorityTier(visibility);
    const basePriority = getBasePriority(visibility);
    const { source, chunkManager } = this;
    forEachVisibleSegment(this, (objectId) => {
      const chunk = source.getChunk(objectId);
      ++this.numVisibleChunksNeeded;
      if (chunk.state === ChunkState.GPU_MEMORY) {
        ++this.numVisibleChunksAvailable;
      }
      chunkManager.requestChunk(
        chunk,
        priorityTier,
        basePriority + SKELETON_CHUNK_PRIORITY,
      );
    });
  }
}

/**
 * Extracts vertex positions and edge vertex indices of the specified endianness from `data'.
 *
 * See documentation of decodeVertexPositionsAndIndices.
 */
export function decodeSkeletonVertexPositionsAndIndices(
  chunk: SkeletonChunk,
  data: ArrayBuffer,
  endianness: Endianness,
  vertexByteOffset: number,
  numVertices: number,
  indexByteOffset?: number,
  numEdges?: number,
) {
  const meshData = decodeVertexPositionsAndIndices(
    /*verticesPerPrimitive=*/ 2,
    data,
    endianness,
    vertexByteOffset,
    numVertices,
    indexByteOffset,
    numEdges,
  );
  chunk.vertexPositions = meshData.vertexPositions as Float32Array;
  chunk.indices = meshData.indices as Uint32Array;
}
