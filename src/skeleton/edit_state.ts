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

export function getSpatiallyIndexedSkeletonSubtreeNodes(
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[],
  rootNodeId: number,
) {
  const childrenByParent = new Map<number, SpatiallyIndexedSkeletonNode[]>();
  let rootNode: SpatiallyIndexedSkeletonNode | undefined;
  for (const node of segmentNodes) {
    if (node.nodeId === rootNodeId) {
      rootNode = node;
    }
    const parentNodeId = node.parentNodeId;
    if (parentNodeId === undefined) {
      continue;
    }
    let children = childrenByParent.get(parentNodeId);
    if (children === undefined) {
      children = [];
      childrenByParent.set(parentNodeId, children);
    }
    children.push(node);
  }
  if (rootNode === undefined) {
    return [];
  }

  const subtreeNodes: SpatiallyIndexedSkeletonNode[] = [];
  const visitedNodeIds = new Set<number>();
  const stack = [rootNode];
  while (stack.length !== 0) {
    const node = stack.pop()!;
    if (visitedNodeIds.has(node.nodeId)) {
      continue;
    }
    visitedNodeIds.add(node.nodeId);
    subtreeNodes.push(node);

    const children = childrenByParent.get(node.nodeId);
    if (children === undefined) {
      continue;
    }
    for (let i = children.length - 1; i >= 0; --i) {
      stack.push(children[i]);
    }
  }
  return subtreeNodes;
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
