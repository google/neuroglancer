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
 * way or have no direction. Lists the nodes of a precomputed chunk with the
 * parents it resolves.
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

export interface InferredSkeletonTopology {
  // -1 for the root of each connected part.
  readonly parentIndexByNode: Int32Array;
  // Each pair is one edge, lower index first.
  readonly loopEdgeIndices: readonly number[];
}

// Compressed adjacency: the neighbors of node i are neighbors[neighborOffsets[i]] up to neighbors[neighborOffsets[i + 1]], in edge order.
interface NeighborLists {
  readonly neighborOffsets: Int32Array;
  readonly neighbors: Int32Array;
}

function getNeighborLists(
  numNodes: number,
  endpointIndices: ArrayLike<number>,
): NeighborLists {
  const isEdgeKnown = (edgeOffset: number) =>
    endpointIndices[edgeOffset] < numNodes &&
    endpointIndices[edgeOffset + 1] < numNodes &&
    endpointIndices[edgeOffset] !== endpointIndices[edgeOffset + 1];
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
  return { neighborOffsets, neighbors };
}

function getDistancesFromRoots({
  neighborOffsets,
  neighbors,
}: NeighborLists): Int32Array {
  const numNodes = neighborOffsets.length - 1;
  const distanceByNode = new Int32Array(numNodes).fill(-1);
  const queue = new Int32Array(numNodes);
  for (let rootIndex = 0; rootIndex < numNodes; ++rootIndex) {
    if (distanceByNode[rootIndex] !== -1) continue;
    distanceByNode[rootIndex] = 0;
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
        if (distanceByNode[neighborIndex] !== -1) continue;
        distanceByNode[neighborIndex] = distanceByNode[nodeIndex] + 1;
        queue[queueEnd++] = neighborIndex;
      }
    }
  }
  return distanceByNode;
}

function chooseParents(
  { neighborOffsets, neighbors }: NeighborLists,
  distanceByNode: Int32Array,
): Int32Array {
  const numNodes = distanceByNode.length;
  const parentIndexByNode = new Int32Array(numNodes).fill(-1);
  for (let nodeIndex = 0; nodeIndex < numNodes; ++nodeIndex) {
    const parentDistance = distanceByNode[nodeIndex] - 1;
    for (
      let offset = neighborOffsets[nodeIndex];
      offset < neighborOffsets[nodeIndex + 1];
      ++offset
    ) {
      const neighborIndex = neighbors[offset];
      if (distanceByNode[neighborIndex] !== parentDistance) continue;
      const parentIndex = parentIndexByNode[nodeIndex];
      if (parentIndex === -1 || neighborIndex < parentIndex) {
        parentIndexByNode[nodeIndex] = neighborIndex;
      }
    }
  }
  return parentIndexByNode;
}

function getLoopEdges(
  { neighborOffsets, neighbors }: NeighborLists,
  parentIndexByNode: Int32Array,
): number[] {
  const numNodes = parentIndexByNode.length;
  const loopEdgeIndices: number[] = [];
  const lastLowerIndexByNode = new Int32Array(numNodes).fill(-1);
  for (let lowerIndex = 0; lowerIndex < numNodes; ++lowerIndex) {
    for (
      let offset = neighborOffsets[lowerIndex];
      offset < neighborOffsets[lowerIndex + 1];
      ++offset
    ) {
      const higherIndex = neighbors[offset];
      if (higherIndex < lowerIndex) continue;
      if (lastLowerIndexByNode[higherIndex] === lowerIndex) continue;
      lastLowerIndexByNode[higherIndex] = lowerIndex;
      if (
        parentIndexByNode[higherIndex] === lowerIndex ||
        parentIndexByNode[lowerIndex] === higherIndex
      ) {
        continue;
      }
      loopEdgeIndices.push(lowerIndex, higherIndex);
    }
  }
  return loopEdgeIndices;
}

// Each pair of endpointIndices is one edge, given as node indices.
// The root of each connected part is its lowest node index.
// The parent of a node is its lowest-indexed neighbor one edge nearer the root.
// Each other edge closes a loop.
// A self edge, a repeated edge, and an edge to an index outside the nodes are ignored.
export function inferSkeletonTopology(
  numNodes: number,
  endpointIndices: ArrayLike<number>,
): InferredSkeletonTopology {
  const neighborLists = getNeighborLists(numNodes, endpointIndices);
  const distanceByNode = getDistancesFromRoots(neighborLists);
  const parentIndexByNode = chooseParents(neighborLists, distanceByNode);
  const loopEdgeIndices = getLoopEdges(neighborLists, parentIndexByNode);
  return { parentIndexByNode, loopEdgeIndices };
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
      ? inferSkeletonTopology(
          nodes.length,
          getKnownEndpointIndices(nodeIndexById, edges),
        ).parentIndexByNode
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
