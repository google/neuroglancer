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

import type { SkeletonNode } from "#src/skeleton/api.js";

export interface SkeletonChunkTopology {
  readonly nodes: readonly SkeletonNode[];
  readonly parentsInferred: boolean;
}

// Undefined unless each vertex has at most one incoming edge and no edges form a loop.
function getStoredParentVertices(
  numVertices: number,
  indices: Uint32Array,
): Int32Array | undefined {
  const parentVertexByVertex = new Int32Array(numVertices).fill(-1);
  const treeRootByVertex = Int32Array.from(
    { length: numVertices },
    (_, i) => i,
  );
  const findTreeRoot = (vertex: number) => {
    while (treeRootByVertex[vertex] !== vertex) {
      vertex = treeRootByVertex[vertex] =
        treeRootByVertex[treeRootByVertex[vertex]];
    }
    return vertex;
  };
  for (let edgeOffset = 0; edgeOffset < indices.length; edgeOffset += 2) {
    const sourceVertex = indices[edgeOffset];
    const targetVertex = indices[edgeOffset + 1];
    if (sourceVertex === targetVertex) continue;
    if (parentVertexByVertex[targetVertex] !== -1) return undefined;
    const sourceTreeRoot = findTreeRoot(sourceVertex);
    const targetTreeRoot = findTreeRoot(targetVertex);
    if (sourceTreeRoot === targetTreeRoot) return undefined;
    parentVertexByVertex[targetVertex] = sourceVertex;
    treeRootByVertex[targetTreeRoot] = sourceTreeRoot;
  }
  return parentVertexByVertex;
}

// Walks each connected part outward from its lowest vertex, so an edge that closes a loop is dropped.
function getInferredParentVertices(
  numVertices: number,
  indices: Uint32Array,
): Int32Array {
  const neighborOffsets = new Int32Array(numVertices + 1);
  for (const vertex of indices) ++neighborOffsets[vertex + 1];
  for (let vertex = 0; vertex < numVertices; ++vertex) {
    neighborOffsets[vertex + 1] += neighborOffsets[vertex];
  }
  const neighbors = new Int32Array(indices.length);
  const nextNeighborOffset = neighborOffsets.slice(0, numVertices);
  for (let edgeOffset = 0; edgeOffset < indices.length; edgeOffset += 2) {
    const sourceVertex = indices[edgeOffset];
    const targetVertex = indices[edgeOffset + 1];
    neighbors[nextNeighborOffset[sourceVertex]++] = targetVertex;
    neighbors[nextNeighborOffset[targetVertex]++] = sourceVertex;
  }
  const parentVertexByVertex = new Int32Array(numVertices).fill(-1);
  const visited = new Uint8Array(numVertices);
  const queue = new Int32Array(numVertices);
  for (let rootVertex = 0; rootVertex < numVertices; ++rootVertex) {
    if (visited[rootVertex]) continue;
    visited[rootVertex] = 1;
    let queueStart = 0;
    let queueEnd = 0;
    queue[queueEnd++] = rootVertex;
    while (queueStart < queueEnd) {
      const vertex = queue[queueStart++];
      for (
        let offset = neighborOffsets[vertex];
        offset < neighborOffsets[vertex + 1];
        ++offset
      ) {
        const neighbor = neighbors[offset];
        if (visited[neighbor]) continue;
        visited[neighbor] = 1;
        parentVertexByVertex[neighbor] = vertex;
        queue[queueEnd++] = neighbor;
      }
    }
  }
  return parentVertexByVertex;
}

// Precomputed writers often list each edge with its lower vertex first, so edge order is not trusted unless it forms a tree.
export function getSkeletonChunkTopology(
  segmentId: bigint,
  chunk: {
    readonly numVertices: number;
    readonly indices: Uint32Array;
    readonly vertexAttributes: Uint8Array;
    readonly vertexAttributeOffsets: Uint32Array;
  },
): SkeletonChunkTopology {
  const { numVertices, indices, vertexAttributes, vertexAttributeOffsets } =
    chunk;
  const positions = new Float32Array(
    vertexAttributes.buffer,
    vertexAttributes.byteOffset + vertexAttributeOffsets[0],
    numVertices * 3,
  );
  const storedParentVertices = getStoredParentVertices(numVertices, indices);
  const parentVertexByVertex =
    storedParentVertices ?? getInferredParentVertices(numVertices, indices);
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
  return { nodes, parentsInferred: storedParentVertices === undefined };
}
