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

import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import {
  getFlatListNodeIds,
  type SpatiallyIndexedSkeletonNavigationGraph,
} from "#src/skeleton/navigation.js";
import {
  classifySpatialSkeletonDisplayNodeType as classifyNodeType,
  matchesSpatialSkeletonNodeFilter,
  SpatialSkeletonNodeFilterType,
  type SpatialSkeletonDisplayNodeType as SkeletonNodeType,
} from "#src/skeleton/node_types.js";

function nodeMatchesFilter(
  node: SpatiallyIndexedSkeletonNode,
  filterText: string,
  description: string | undefined,
) {
  if (filterText.length === 0) return true;
  if (String(node.nodeId).includes(filterText)) return true;
  return description?.toLowerCase().includes(filterText) ?? false;
}

function hasNonEmptyNodeDescription(description: string | undefined) {
  return (description?.trim().length ?? 0) > 0;
}

export interface SpatialSkeletonSegmentRenderRow {
  node: SpatiallyIndexedSkeletonNode;
  type: SkeletonNodeType;
  isLeaf: boolean;
}

export interface SpatialSkeletonSegmentRenderState {
  segmentId: number;
  totalNodeCount: number;
  matchedNodeCount: number;
  displayedNodeCount: number;
  branchCount: number;
  rows: readonly SpatialSkeletonSegmentRenderRow[];
}

export function buildSpatialSkeletonSegmentRenderState(
  segmentId: number,
  graph: SpatiallyIndexedSkeletonNavigationGraph,
  options: {
    filterText: string;
    nodeFilterType: SpatialSkeletonNodeFilterType;
    getNodeDescription: (
      node: SpatiallyIndexedSkeletonNode,
    ) => string | undefined;
  },
): SpatialSkeletonSegmentRenderState {
  const { nodeById, childrenByParent } = graph;
  if (nodeById.size === 0) {
    return {
      segmentId,
      totalNodeCount: 0,
      matchedNodeCount: 0,
      displayedNodeCount: 0,
      branchCount: 0,
      rows: [],
    };
  }

  const visibleMemo = new Map<number, boolean>();
  const isNodeVisible = (nodeId: number): boolean => {
    const cached = visibleMemo.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    const node = nodeById.get(nodeId);
    if (node === undefined) {
      visibleMemo.set(nodeId, false);
      return false;
    }
    const children = childrenByParent.get(nodeId) ?? [];
    const parentInTree =
      node.parentNodeId !== undefined && nodeById.has(node.parentNodeId);
    const nodeType = classifyNodeType(node, children.length, parentInTree);
    const description = options.getNodeDescription(node);
    const visible =
      (options.nodeFilterType === SpatialSkeletonNodeFilterType.NONE ||
        matchesSpatialSkeletonNodeFilter(options.nodeFilterType, {
          isLeaf: children.length === 0,
          nodeHasDescription: hasNonEmptyNodeDescription(description),
          nodeIsTrueEnd: node.isTrueEnd ?? false,
          nodeType,
        })) &&
      nodeMatchesFilter(node, options.filterText, description);
    visibleMemo.set(nodeId, visible);
    return visible;
  };

  const visibleNodeIds = getFlatListNodeIds(graph, {
    collapseRegularNodesForOrdering: true,
  }).filter((nodeId) => isNodeVisible(nodeId));
  const visibleNodeIdSet = new Set<number>(visibleNodeIds);

  let branchCount = 0;
  for (const nodeId of visibleNodeIds) {
    const node = nodeById.get(nodeId);
    if (node === undefined) continue;
    const visibleParent =
      node.parentNodeId !== undefined &&
      visibleNodeIdSet.has(node.parentNodeId);
    if (!visibleParent) {
      branchCount++;
    }
    let visibleChildCount = 0;
    for (const childNodeId of childrenByParent.get(nodeId) ?? []) {
      if (visibleNodeIdSet.has(childNodeId)) {
        visibleChildCount++;
      }
    }
    if (visibleChildCount > 1) {
      branchCount += visibleChildCount - 1;
    }
  }

  const rows: SpatialSkeletonSegmentRenderRow[] = [];
  for (const nodeId of visibleNodeIds) {
    const node = nodeById.get(nodeId);
    if (node === undefined) continue;
    const children = childrenByParent.get(nodeId) ?? [];
    const parentInTree =
      node.parentNodeId !== undefined && nodeById.has(node.parentNodeId);
    const type = classifyNodeType(node, children.length, parentInTree);
    if (type === "regular" && !(node.isTrueEnd ?? false)) {
      continue;
    }
    rows.push({ node, type, isLeaf: children.length === 0 });
  }

  return {
    segmentId,
    totalNodeCount: nodeById.size,
    matchedNodeCount: visibleNodeIds.length,
    displayedNodeCount: rows.length,
    branchCount,
    rows,
  };
}
