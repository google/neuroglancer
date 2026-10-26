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
 * @file Resolves the parent of each skeleton node from edges that point either
 * way or have no direction.
 */

import {
  SkeletonEdgeDirection,
  type SkeletonEdge,
  type SkeletonFragmentNode,
  type SkeletonNode,
} from "#src/skeleton/api.js";

function getDirectedParentIndices(
  segmentId: bigint,
  nodeIndexById: ReadonlyMap<bigint, number>,
  edges: readonly SkeletonEdge[],
  edgeDirection:
    | SkeletonEdgeDirection.CHILD_TO_PARENT
    | SkeletonEdgeDirection.PARENT_TO_CHILD,
): Int32Array {
  const getNodeIndex = (nodeId: bigint) => {
    const nodeIndex = nodeIndexById.get(nodeId);
    if (nodeIndex === undefined) {
      throw new Error(
        `Skeleton ${segmentId} has an edge to node ${nodeId}, which no fragment has.`,
      );
    }
    return nodeIndex;
  };
  const parentIndexByNode = new Int32Array(nodeIndexById.size).fill(-1);
  for (const { firstNodeId, secondNodeId } of edges) {
    const [childNodeId, parentNodeId] =
      edgeDirection === SkeletonEdgeDirection.CHILD_TO_PARENT
        ? [firstNodeId, secondNodeId]
        : [secondNodeId, firstNodeId];
    const childIndex = getNodeIndex(childNodeId);
    const parentIndex = getNodeIndex(parentNodeId);
    const existingParentIndex = parentIndexByNode[childIndex];
    if (existingParentIndex !== -1 && existingParentIndex !== parentIndex) {
      throw new Error(
        `Skeleton ${segmentId} gives node ${childNodeId} two parents.`,
      );
    }
    parentIndexByNode[childIndex] = parentIndex;
  }
  return parentIndexByNode;
}

// Each pair of endpointIndices is one edge, given as node indices.
// Walks each connected part outward from its lowest node index, so an edge that closes a loop is dropped.
// An edge to an index outside the nodes is ignored.
export function inferSkeletonParentIndices(
  numNodes: number,
  endpointIndices: ArrayLike<number>,
): Int32Array {
  const isEdgeKnown = (edgeOffset: number) =>
    endpointIndices[edgeOffset] < numNodes &&
    endpointIndices[edgeOffset + 1] < numNodes;
  const neighborOffsets = new Int32Array(numNodes + 1);
  for (
    let edgeOffset = 0;
    edgeOffset + 1 < endpointIndices.length;
    edgeOffset += 2
  ) {
    if (!isEdgeKnown(edgeOffset)) continue;
    ++neighborOffsets[endpointIndices[edgeOffset] + 1];
    ++neighborOffsets[endpointIndices[edgeOffset + 1] + 1];
  }
  for (let nodeIndex = 0; nodeIndex < numNodes; ++nodeIndex) {
    neighborOffsets[nodeIndex + 1] += neighborOffsets[nodeIndex];
  }
  const neighbors = new Int32Array(neighborOffsets[numNodes]);
  const nextNeighborOffset = neighborOffsets.slice(0, numNodes);
  for (
    let edgeOffset = 0;
    edgeOffset + 1 < endpointIndices.length;
    edgeOffset += 2
  ) {
    if (!isEdgeKnown(edgeOffset)) continue;
    const firstIndex = endpointIndices[edgeOffset];
    const secondIndex = endpointIndices[edgeOffset + 1];
    neighbors[nextNeighborOffset[firstIndex]++] = secondIndex;
    neighbors[nextNeighborOffset[secondIndex]++] = firstIndex;
  }
  const parentIndexByNode = new Int32Array(numNodes).fill(-1);
  const visited = new Uint8Array(numNodes);
  const queue = new Int32Array(numNodes);
  for (let rootIndex = 0; rootIndex < numNodes; ++rootIndex) {
    if (visited[rootIndex]) continue;
    visited[rootIndex] = 1;
    let queueStart = 0;
    let queueEnd = 0;
    queue[queueEnd++] = rootIndex;
    while (queueStart < queueEnd) {
      const nodeIndex = queue[queueStart++];
      for (
        let offset = neighborOffsets[nodeIndex];
        offset < neighborOffsets[nodeIndex + 1];
        ++offset
      ) {
        const neighborIndex = neighbors[offset];
        if (visited[neighborIndex]) continue;
        visited[neighborIndex] = 1;
        parentIndexByNode[neighborIndex] = nodeIndex;
        queue[queueEnd++] = neighborIndex;
      }
    }
  }
  return parentIndexByNode;
}

function getKnownEndpointIndices(
  nodeIndexById: ReadonlyMap<bigint, number>,
  edges: readonly SkeletonEdge[],
): number[] {
  const endpointIndices: number[] = [];
  for (const { firstNodeId, secondNodeId } of edges) {
    const firstIndex = nodeIndexById.get(firstNodeId);
    const secondIndex = nodeIndexById.get(secondNodeId);
    if (firstIndex === undefined || secondIndex === undefined) continue;
    endpointIndices.push(firstIndex, secondIndex);
  }
  return endpointIndices;
}

export function resolveSkeletonParents(
  segmentId: bigint,
  nodes: readonly SkeletonFragmentNode[],
  edges: readonly SkeletonEdge[],
  edgeDirection: SkeletonEdgeDirection,
): SkeletonNode[] {
  const nodeIndexById = new Map<bigint, number>();
  nodes.forEach((node, nodeIndex) => nodeIndexById.set(node.nodeId, nodeIndex));
  const parentIndexByNode =
    edgeDirection === SkeletonEdgeDirection.UNDIRECTED
      ? inferSkeletonParentIndices(
          nodes.length,
          getKnownEndpointIndices(nodeIndexById, edges),
        )
      : getDirectedParentIndices(
          segmentId,
          nodeIndexById,
          edges,
          edgeDirection,
        );
  return nodes.map((node, nodeIndex) => {
    const parentIndex = parentIndexByNode[nodeIndex];
    return {
      ...node,
      parentNodeId: parentIndex === -1 ? undefined : nodes[parentIndex].nodeId,
    };
  });
}
