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

/**
 * @file Lists the nodes of a skeleton chunk with their parents.
 */

import type { SkeletonEdge, SkeletonNode } from "#src/skeleton/api.js";
import { inferSkeletonTopology } from "#src/skeleton/skeleton_edges.js";

export interface SkeletonChunkNodes {
  readonly nodes: readonly SkeletonNode[];
  readonly loopEdges: readonly SkeletonEdge[];
}

// Precomputed edges have no direction, so parents are inferred.
export function getSkeletonChunkNodes(
  segmentId: bigint,
  chunk: {
    readonly numVertices: number;
    readonly indices: Uint32Array;
    readonly vertexAttributes: Uint8Array;
    readonly vertexAttributeOffsets: Uint32Array;
  },
): SkeletonChunkNodes {
  const { numVertices, indices, vertexAttributes, vertexAttributeOffsets } =
    chunk;
  const positions = new Float32Array(
    vertexAttributes.buffer,
    vertexAttributes.byteOffset + vertexAttributeOffsets[0],
    numVertices * 3,
  );
  const {
    parentIndexByNode: parentVertexByVertex,
    loopEdgeIndices: loopEdgeVertices,
  } = inferSkeletonTopology(numVertices, indices);
  const nodes: SkeletonNode[] = [];
  for (let vertex = 0; vertex < numVertices; ++vertex) {
    const parentVertex = parentVertexByVertex[vertex];
    nodes.push({
      nodeId: BigInt(vertex),
      segmentId,
      position: positions.subarray(vertex * 3, vertex * 3 + 3),
      parentNodeId: parentVertex === -1 ? undefined : BigInt(parentVertex),
    });
  }
  const loopEdges: SkeletonEdge[] = [];
  for (let offset = 0; offset < loopEdgeVertices.length; offset += 2) {
    loopEdges.push({
      firstNodeId: BigInt(loopEdgeVertices[offset]),
      secondNodeId: BigInt(loopEdgeVertices[offset + 1]),
    });
  }
  return { nodes, loopEdges };
}
