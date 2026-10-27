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
 * @file Builds the parent and child graph of one skeleton's nodes and finds
 * navigation targets in it. Orders the nodes as rows of a flat list, optionally
 * with unbranched runs collapsed.
 */

import type { SkeletonNode, SkeletonVector } from "#src/skeleton/api.js";
import { isSkeletonNodeTrueEnd } from "#src/skeleton/node_attributes.js";
import { bigintCompare } from "#src/util/bigint.js";

export interface SkeletonNavigationTarget {
  nodeId: bigint;
  position: SkeletonVector;
}

export interface SkeletonOpenLeaf extends SkeletonNavigationTarget {
  distance: number;
}

export interface SkeletonNavigationGraph {
  nodeById: Map<bigint, SkeletonNode>;
  childrenByParent: Map<bigint, bigint[]>;
  rootNodeIds: bigint[];
}

interface CollapsedChildPath {
  path: readonly bigint[];
  representativeNodeId: bigint;
}

interface CollapsedLevelContext {
  levelByNodeId: Map<bigint, number>;
  nodeIdsByLevel: Map<number, bigint[]>;
}

interface NavigationGraphDerivedState {
  sortPriorityByNodeId: Map<bigint, number>;
  orderedChildNodeIdsByNodeId: Map<bigint, readonly bigint[]>;
  collapsedPathByNodeId: Map<bigint, readonly bigint[]>;
  collapsedOrderedChildPathsByNodeId: Map<
    bigint,
    readonly CollapsedChildPath[]
  >;
  flatListNodeIds?: readonly bigint[];
  collapsedFlatListNodeIds?: readonly bigint[];
  collapsedLevelContext?: CollapsedLevelContext;
}

const navigationGraphDerivedState = new WeakMap<
  SkeletonNavigationGraph,
  NavigationGraphDerivedState
>();

function buildNavigationGraphDerivedState(
  graph: SkeletonNavigationGraph,
): NavigationGraphDerivedState {
  const sortPriorityByNodeId = new Map<bigint, number>();
  for (const [nodeId, node] of graph.nodeById) {
    const childCount = graph.childrenByParent.get(nodeId)?.length ?? 0;
    const { parentNodeId } = node;
    const parentInTree =
      parentNodeId !== undefined && graph.nodeById.has(parentNodeId);
    const sortPriority = isSkeletonNodeTrueEnd(node)
      ? 0
      : childCount === 0
        ? 0
        : !parentInTree
          ? 3
          : childCount > 1
            ? 1
            : 2;
    sortPriorityByNodeId.set(nodeId, sortPriority);
  }
  return {
    sortPriorityByNodeId,
    orderedChildNodeIdsByNodeId: new Map(),
    collapsedPathByNodeId: new Map(),
    collapsedOrderedChildPathsByNodeId: new Map(),
  };
}

function getNavigationGraphDerivedState(graph: SkeletonNavigationGraph) {
  let state = navigationGraphDerivedState.get(graph);
  if (state === undefined) {
    state = buildNavigationGraphDerivedState(graph);
    navigationGraphDerivedState.set(graph, state);
  }
  return state;
}

export function buildSkeletonNavigationGraph(
  nodes: readonly SkeletonNode[],
): SkeletonNavigationGraph {
  const nodeById = new Map<bigint, SkeletonNode>();
  for (const node of nodes) {
    if (!nodeById.has(node.nodeId)) {
      nodeById.set(node.nodeId, node);
    }
  }

  const childrenByParent = new Map<bigint, bigint[]>();
  for (const node of nodeById.values()) {
    const { parentNodeId } = node;
    if (parentNodeId === undefined || !nodeById.has(parentNodeId)) continue;
    let children = childrenByParent.get(parentNodeId);
    if (children === undefined) {
      children = [];
      childrenByParent.set(parentNodeId, children);
    }
    children.push(node.nodeId);
  }
  for (const children of childrenByParent.values()) {
    children.sort(bigintCompare);
  }

  const rootNodeIds: bigint[] = [];
  for (const node of nodeById.values()) {
    const { parentNodeId } = node;
    if (parentNodeId === undefined || !nodeById.has(parentNodeId)) {
      rootNodeIds.push(node.nodeId);
    }
  }
  rootNodeIds.sort(bigintCompare);
  if (rootNodeIds.length === 0 && nodeById.size > 0) {
    rootNodeIds.push([...nodeById.keys()].sort(bigintCompare)[0]);
  }

  const graph = {
    nodeById,
    childrenByParent,
    rootNodeIds,
  };
  navigationGraphDerivedState.set(
    graph,
    buildNavigationGraphDerivedState(graph),
  );
  return graph;
}

function getFlatListNodeSortPriority(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
) {
  const priority =
    getNavigationGraphDerivedState(graph).sortPriorityByNodeId.get(nodeId);
  if (priority === undefined) {
    throw new Error(`Node ${nodeId} is not available in the loaded skeleton.`);
  }
  return priority;
}

function compareFlatListNodeIds(
  graph: SkeletonNavigationGraph,
  a: bigint,
  b: bigint,
) {
  const priorityDelta =
    getFlatListNodeSortPriority(graph, a) -
    getFlatListNodeSortPriority(graph, b);
  return priorityDelta !== 0 ? priorityDelta : bigintCompare(a, b);
}

export function getFlatListNodeIds(
  graph: SkeletonNavigationGraph,
  options: { collapseRegularNodesForOrdering?: boolean } = {},
) {
  if (options.collapseRegularNodesForOrdering ?? false) {
    return getCollapsedOrderedFlatListNodeIds(graph);
  }
  const derivedState = getNavigationGraphDerivedState(graph);
  if (derivedState.flatListNodeIds !== undefined) {
    return derivedState.flatListNodeIds;
  }

  const orderedNodeIds: bigint[] = [];
  const visited = new Set<bigint>();

  const appendLeafFirstPreOrder = (startNodeIds: readonly bigint[]) => {
    const stack = [...startNodeIds]
      .sort((a, b) => compareFlatListNodeIds(graph, a, b))
      .reverse();
    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      orderedNodeIds.push(nodeId);
      const childNodeIds = [...getChildNodeIds(graph, nodeId)].sort((a, b) =>
        compareFlatListNodeIds(graph, a, b),
      );
      for (
        let childIndex = childNodeIds.length - 1;
        childIndex >= 0;
        --childIndex
      ) {
        const childNodeId = childNodeIds[childIndex];
        if (!visited.has(childNodeId)) {
          stack.push(childNodeId);
        }
      }
    }
  };

  appendLeafFirstPreOrder(graph.rootNodeIds);
  if (visited.size === graph.nodeById.size) {
    derivedState.flatListNodeIds = orderedNodeIds;
    return orderedNodeIds;
  }

  const remainingNodeIds = [...graph.nodeById.keys()].sort((a, b) =>
    compareFlatListNodeIds(graph, a, b),
  );
  for (const nodeId of remainingNodeIds) {
    if (!visited.has(nodeId)) {
      appendLeafFirstPreOrder([nodeId]);
    }
  }

  derivedState.flatListNodeIds = orderedNodeIds;
  return orderedNodeIds;
}

function getNodeOrThrow(graph: SkeletonNavigationGraph, nodeId: bigint) {
  const node = graph.nodeById.get(nodeId);
  if (node === undefined) {
    throw new Error(`Node ${nodeId} is not available in the loaded skeleton.`);
  }
  return node;
}

function getNodeTarget(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
): SkeletonNavigationTarget {
  const node = getNodeOrThrow(graph, nodeId);
  return {
    nodeId: node.nodeId,
    position: node.position,
  };
}

function getChildNodeIds(graph: SkeletonNavigationGraph, nodeId: bigint) {
  return graph.childrenByParent.get(nodeId) ?? [];
}

function getParentNodeId(graph: SkeletonNavigationGraph, nodeId: bigint) {
  const parentNodeId = getNodeOrThrow(graph, nodeId).parentNodeId;
  if (parentNodeId === undefined || !graph.nodeById.has(parentNodeId)) {
    return undefined;
  }
  return parentNodeId;
}

function getFlatListOrderedChildNodeIds(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
) {
  const childNodeIds = getChildNodeIds(graph, nodeId);
  if (childNodeIds.length <= 1) {
    return childNodeIds;
  }
  const derivedState = getNavigationGraphDerivedState(graph);
  const cached = derivedState.orderedChildNodeIdsByNodeId.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }
  const orderedChildNodeIds = [...childNodeIds].sort((a, b) =>
    compareFlatListNodeIds(graph, a, b),
  );
  derivedState.orderedChildNodeIdsByNodeId.set(nodeId, orderedChildNodeIds);
  return orderedChildNodeIds;
}

function getCollapsedBranchPath(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
) {
  const derivedState = getNavigationGraphDerivedState(graph);
  const cached = derivedState.collapsedPathByNodeId.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }
  const path = [nodeId];
  const visited = new Set<bigint>(path);
  let currentNodeId = nodeId;
  while (isCollapsedRegularNode(graph, currentNodeId)) {
    const nextNodeId = getChildNodeIds(graph, currentNodeId)[0];
    if (nextNodeId === undefined || visited.has(nextNodeId)) {
      break;
    }
    path.push(nextNodeId);
    visited.add(nextNodeId);
    currentNodeId = nextNodeId;
  }
  derivedState.collapsedPathByNodeId.set(nodeId, path);
  return path;
}

function getCollapsedOrderedChildPaths(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
) {
  const derivedState = getNavigationGraphDerivedState(graph);
  const cached = derivedState.collapsedOrderedChildPathsByNodeId.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }
  const childPaths = getChildNodeIds(graph, nodeId).map((childNodeId) => {
    const path = getCollapsedBranchPath(graph, childNodeId);
    return {
      path,
      representativeNodeId: path[path.length - 1],
    };
  });
  childPaths.sort((a, b) =>
    compareFlatListNodeIds(
      graph,
      a.representativeNodeId,
      b.representativeNodeId,
    ),
  );
  derivedState.collapsedOrderedChildPathsByNodeId.set(nodeId, childPaths);
  return childPaths;
}

function isCollapsedRegularNode(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
) {
  const node = getNodeOrThrow(graph, nodeId);
  return (
    getParentNodeId(graph, nodeId) !== undefined &&
    getChildNodeIds(graph, nodeId).length === 1 &&
    !isSkeletonNodeTrueEnd(node)
  );
}

function getCollapsedChildNodeIds(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
) {
  return getCollapsedOrderedChildPaths(graph, nodeId).map(
    ({ representativeNodeId }) => representativeNodeId,
  );
}

function getCollapsedOrderedFlatListNodeIds(graph: SkeletonNavigationGraph) {
  const derivedState = getNavigationGraphDerivedState(graph);
  if (derivedState.collapsedFlatListNodeIds !== undefined) {
    return derivedState.collapsedFlatListNodeIds;
  }
  const orderedNodeIds: bigint[] = [];
  const visited = new Set<bigint>();

  const appendLeafFirstPreOrder = (
    startPaths: readonly (readonly bigint[])[],
  ) => {
    const stack = [...startPaths].map((path) => [...path]).reverse();
    while (stack.length > 0) {
      const path = stack.pop()!;
      const representativeNodeId = path[path.length - 1];
      let appendedNode = false;
      for (const nodeId of path) {
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);
        orderedNodeIds.push(nodeId);
        appendedNode = true;
      }
      if (!appendedNode || !graph.nodeById.has(representativeNodeId)) {
        continue;
      }
      const childPaths = getCollapsedOrderedChildPaths(
        graph,
        representativeNodeId,
      );
      for (
        let childPathIndex = childPaths.length - 1;
        childPathIndex >= 0;
        --childPathIndex
      ) {
        const childPath = childPaths[childPathIndex];
        const firstNodeId = childPath.path[0];
        if (firstNodeId !== undefined && !visited.has(firstNodeId)) {
          stack.push([...childPath.path]);
        }
      }
    }
  };

  appendLeafFirstPreOrder(graph.rootNodeIds.map((nodeId) => [nodeId]));
  if (visited.size === graph.nodeById.size) {
    derivedState.collapsedFlatListNodeIds = orderedNodeIds;
    return orderedNodeIds;
  }

  const remainingNodeIds = [...graph.nodeById.keys()].sort((a, b) =>
    compareFlatListNodeIds(graph, a, b),
  );
  for (const nodeId of remainingNodeIds) {
    if (!visited.has(nodeId)) {
      appendLeafFirstPreOrder([[...getCollapsedBranchPath(graph, nodeId)]]);
    }
  }

  derivedState.collapsedFlatListNodeIds = orderedNodeIds;
  return orderedNodeIds;
}

function getCollapsedLevelContext(graph: SkeletonNavigationGraph) {
  const derivedState = getNavigationGraphDerivedState(graph);
  if (derivedState.collapsedLevelContext !== undefined) {
    return derivedState.collapsedLevelContext;
  }
  const levelByNodeId = new Map<bigint, number>();
  const nodeIdsByLevel = new Map<number, bigint[]>();
  const queue = graph.rootNodeIds.map((nodeId) => ({ nodeId, level: 0 }));
  const visited = new Set<bigint>();

  for (let queueIndex = 0; queueIndex < queue.length; ++queueIndex) {
    const { nodeId, level } = queue[queueIndex];
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    levelByNodeId.set(nodeId, level);
    let nodeIds = nodeIdsByLevel.get(level);
    if (nodeIds === undefined) {
      nodeIds = [];
      nodeIdsByLevel.set(level, nodeIds);
    }
    nodeIds.push(nodeId);
    for (const childNodeId of getCollapsedChildNodeIds(graph, nodeId)) {
      if (!visited.has(childNodeId)) {
        queue.push({ nodeId: childNodeId, level: level + 1 });
      }
    }
  }

  const context = { levelByNodeId, nodeIdsByLevel };
  derivedState.collapsedLevelContext = context;
  return context;
}

function getBranchEndNodeIds(graph: SkeletonNavigationGraph, nodeId: bigint) {
  getNodeOrThrow(graph, nodeId);
  const childNodeIds = getFlatListOrderedChildNodeIds(graph, nodeId);
  return childNodeIds.map((childNodeId) => {
    let branchEndNodeId = childNodeId;
    while (true) {
      const branchChildNodeIds = getChildNodeIds(graph, branchEndNodeId);
      if (branchChildNodeIds.length !== 1) {
        break;
      }
      branchEndNodeId = branchChildNodeIds[0];
    }
    return branchEndNodeId;
  });
}

export function getSkeletonRootNode(graph: SkeletonNavigationGraph) {
  const rootNodeId = graph.rootNodeIds[0];
  if (rootNodeId === undefined) {
    throw new Error("The loaded skeleton does not contain a root node.");
  }
  return getNodeTarget(graph, rootNodeId);
}

export function getBranchStart(graph: SkeletonNavigationGraph, nodeId: bigint) {
  getNodeOrThrow(graph, nodeId);
  let currentNodeId = nodeId;
  const visited = new Set<bigint>([currentNodeId]);
  while (true) {
    const parentNodeId = getParentNodeId(graph, currentNodeId);
    if (parentNodeId === undefined || visited.has(parentNodeId)) {
      return getNodeTarget(graph, currentNodeId);
    }
    currentNodeId = parentNodeId;
    visited.add(currentNodeId);
    if (getChildNodeIds(graph, currentNodeId).length > 1) {
      return getNodeTarget(graph, currentNodeId);
    }
  }
}

export function getBranchEnd(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
  options: { random?: () => number } = {},
) {
  getNodeOrThrow(graph, nodeId);
  const branchEndNodeIds = getBranchEndNodeIds(graph, nodeId);
  if (branchEndNodeIds.length === 0) {
    return getNodeTarget(graph, nodeId);
  }
  const forkNodeIds = branchEndNodeIds.filter(
    (branchEndNodeId) => getChildNodeIds(graph, branchEndNodeId).length > 1,
  );
  const preferredNodeIds =
    forkNodeIds.length > 0 ? forkNodeIds : branchEndNodeIds;
  const { random = Math.random } = options;
  const randomValue = random();
  const index = Number.isFinite(randomValue)
    ? Math.min(
        preferredNodeIds.length - 1,
        Math.max(0, Math.floor(randomValue * preferredNodeIds.length)),
      )
    : 0;
  return getNodeTarget(graph, preferredNodeIds[index]);
}

export function getParentNode(graph: SkeletonNavigationGraph, nodeId: bigint) {
  const parentNodeId = getParentNodeId(graph, nodeId);
  return parentNodeId === undefined
    ? undefined
    : getNodeTarget(graph, parentNodeId);
}

/**
 * Finds a shortest path between two nodes, treating parent/child links as
 * undirected edges.
 *
 * Neighbors are visited in ascending node ID order so that the result is
 * deterministic when multiple shortest paths exist.
 */
export function getPathBetweenNodes(
  graph: SkeletonNavigationGraph,
  sourceNodeId: bigint,
  targetNodeId: bigint,
): SkeletonNavigationTarget[] | undefined {
  if (!graph.nodeById.has(sourceNodeId) || !graph.nodeById.has(targetNodeId)) {
    return undefined;
  }
  if (sourceNodeId === targetNodeId) {
    return [getNodeTarget(graph, sourceNodeId)];
  }

  const predecessorByNodeId = new Map<bigint, bigint | undefined>([
    [sourceNodeId, undefined],
  ]);
  const queue = [sourceNodeId];
  for (let queueIndex = 0; queueIndex < queue.length; ++queueIndex) {
    const currentNodeId = queue[queueIndex];
    const neighborNodeIds = new Set<bigint>(
      getChildNodeIds(graph, currentNodeId),
    );
    const parentNodeId = getParentNodeId(graph, currentNodeId);
    if (parentNodeId !== undefined) {
      neighborNodeIds.add(parentNodeId);
    }

    for (const neighborNodeId of [...neighborNodeIds].sort(bigintCompare)) {
      if (
        !graph.nodeById.has(neighborNodeId) ||
        predecessorByNodeId.has(neighborNodeId)
      ) {
        continue;
      }
      predecessorByNodeId.set(neighborNodeId, currentNodeId);
      if (neighborNodeId === targetNodeId) {
        const pathNodeIds = [targetNodeId];
        let pathNodeId = currentNodeId;
        while (pathNodeId !== sourceNodeId) {
          pathNodeIds.push(pathNodeId);
          pathNodeId = predecessorByNodeId.get(pathNodeId)!;
        }
        pathNodeIds.push(sourceNodeId);
        pathNodeIds.reverse();
        return pathNodeIds.map((nodeId) => getNodeTarget(graph, nodeId));
      }
      queue.push(neighborNodeId);
    }
  }

  return undefined;
}

export function getRandomChildNode(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
  options: { random?: () => number } = {},
) {
  const childNodeIds = getFlatListOrderedChildNodeIds(graph, nodeId);
  if (childNodeIds.length === 0) {
    return undefined;
  }
  const { random = Math.random } = options;
  const randomValue = random();
  const childIndex = Number.isFinite(randomValue)
    ? Math.min(
        childNodeIds.length - 1,
        Math.max(0, Math.floor(randomValue * childNodeIds.length)),
      )
    : 0;
  return getNodeTarget(graph, childNodeIds[childIndex]);
}

export function getNextCollapsedLevelNode(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
) {
  getNodeOrThrow(graph, nodeId);
  if (getParentNodeId(graph, nodeId) === undefined) {
    return getNodeTarget(graph, nodeId);
  }
  if (isCollapsedRegularNode(graph, nodeId)) {
    return getNodeTarget(graph, nodeId);
  }

  const { levelByNodeId, nodeIdsByLevel } = getCollapsedLevelContext(graph);
  const level = levelByNodeId.get(nodeId);
  if (level === undefined) {
    return getNodeTarget(graph, nodeId);
  }
  const nodeIds = nodeIdsByLevel.get(level);
  if (nodeIds === undefined || nodeIds.length <= 1) {
    return getNodeTarget(graph, nodeId);
  }
  const currentIndex = nodeIds.indexOf(nodeId);
  if (currentIndex === -1) {
    return getNodeTarget(graph, nodeId);
  }
  return getNodeTarget(graph, nodeIds[(currentIndex + 1) % nodeIds.length]);
}

export function getOpenLeaves(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
): SkeletonOpenLeaf[] {
  getNodeOrThrow(graph, nodeId);
  const distances = new Map<bigint, number>([[nodeId, 0]]);
  const queue = [nodeId];
  for (let queueIndex = 0; queueIndex < queue.length; ++queueIndex) {
    const currentNodeId = queue[queueIndex];
    const nextDistance = (distances.get(currentNodeId) ?? 0) + 1;
    const childNodeIds = getChildNodeIds(graph, currentNodeId);
    const parentNodeId = getParentNodeId(graph, currentNodeId);
    let parentAdded = false;
    for (const childNodeId of childNodeIds) {
      if (
        !parentAdded &&
        parentNodeId !== undefined &&
        parentNodeId < childNodeId
      ) {
        if (!distances.has(parentNodeId)) {
          distances.set(parentNodeId, nextDistance);
          queue.push(parentNodeId);
        }
        parentAdded = true;
      }
      const neighborNodeId = childNodeId;
      if (distances.has(neighborNodeId)) continue;
      distances.set(neighborNodeId, nextDistance);
      queue.push(neighborNodeId);
    }
    if (
      !parentAdded &&
      parentNodeId !== undefined &&
      !distances.has(parentNodeId)
    ) {
      distances.set(parentNodeId, nextDistance);
      queue.push(parentNodeId);
    }
  }

  const leaves: SkeletonOpenLeaf[] = [];
  for (const candidateNodeId of queue) {
    if (getChildNodeIds(graph, candidateNodeId).length !== 0) continue;
    const candidateNode = getNodeOrThrow(graph, candidateNodeId);
    if (isSkeletonNodeTrueEnd(candidateNode)) continue;
    leaves.push({
      ...getNodeTarget(graph, candidateNodeId),
      distance: distances.get(candidateNodeId) ?? 0,
    });
  }

  leaves.sort((a, b) =>
    a.distance === b.distance
      ? bigintCompare(a.nodeId, b.nodeId)
      : a.distance - b.distance,
  );
  return leaves;
}
