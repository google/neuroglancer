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

import type { SpatialSkeletonSourceState } from "#src/skeleton/api.js";
import type { TypedNumberArray } from "#src/util/array.js";

export interface SkeletonChunkData {
  vertexPositions: Float32Array | null;
  vertexAttributes: TypedNumberArray[] | null;
  indices: Uint32Array | null;
  nodeIds?: Int32Array;
  nodeSourceStates?: Array<SpatialSkeletonSourceState | undefined>;
}

/**
 * Calculates the total byte size of vertex attributes including positions.
 */
export function getVertexAttributeBytes(data: SkeletonChunkData): number {
  let total = data.vertexPositions!.byteLength;
  const { vertexAttributes } = data;
  if (vertexAttributes != null) {
    vertexAttributes.forEach((a) => {
      total += a.byteLength;
    });
  }
  return total;
}

/**
 * Serializes skeleton chunk data for transfer to frontend.
 * Packs vertex positions and attributes into a single Uint8Array for efficient transfer.
 */
export function serializeSkeletonChunkData(
  data: SkeletonChunkData,
  msg: any,
  transfers: any[],
): void {
  const vertexPositions = data.vertexPositions!;
  const indices = data.indices!;
  msg.numVertices = vertexPositions.length / 3;
  msg.indices = indices;
  transfers.push(indices.buffer);

  const { vertexAttributes } = data;
  if (vertexAttributes != null && vertexAttributes.length > 0) {
    const vertexData = new Uint8Array(getVertexAttributeBytes(data));
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

  if (data.nodeIds) {
    msg.nodeIds = data.nodeIds;
    transfers.push(data.nodeIds.buffer);
  }
  if (data.nodeSourceStates) {
    msg.nodeSourceStates = data.nodeSourceStates;
  }
}

/**
 * Clears skeleton chunk data from memory.
 */
export function freeSkeletonChunkSystemMemory(data: SkeletonChunkData): void {
  data.vertexPositions = data.indices = data.vertexAttributes = null;
  data.nodeIds = undefined;
  data.nodeSourceStates = undefined;
}
