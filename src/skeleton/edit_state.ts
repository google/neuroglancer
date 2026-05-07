import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";

export function findSpatiallyIndexedSkeletonNode(
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[],
  nodeId: number,
) {
  return segmentNodes.find((node) => node.nodeId === nodeId);
}

export function getSpatiallyIndexedSkeletonDirectChildren(
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[],
  nodeId: number,
) {
  return segmentNodes
    .filter((node) => node.parentNodeId === nodeId)
    .sort((a, b) => a.nodeId - b.nodeId);
}

export function getSpatiallyIndexedSkeletonNodeParent(
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[],
  node: SpatiallyIndexedSkeletonNode,
) {
  if (node.parentNodeId === undefined) {
    return undefined;
  }
  return findSpatiallyIndexedSkeletonNode(segmentNodes, node.parentNodeId);
}

export function getSpatiallyIndexedSkeletonPathToRoot(
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[],
  node: SpatiallyIndexedSkeletonNode,
) {
  const path = [node];
  const visited = new Set<number>([node.nodeId]);
  let currentNode = node;
  while (true) {
    const parentNode = getSpatiallyIndexedSkeletonNodeParent(
      segmentNodes,
      currentNode,
    );
    if (parentNode === undefined || visited.has(parentNode.nodeId)) {
      return path;
    }
    path.push(parentNode);
    visited.add(parentNode.nodeId);
    currentNode = parentNode;
  }
}
