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
} from "#src/skeleton/navigation_graph.js";
import {
  classifySpatialSkeletonDisplayNodeType as classifyNodeType,
  matchesSpatialSkeletonNodeFilter,
  SpatialSkeletonDisplayNodeType,
  SpatialSkeletonNodeFilterType,
} from "#src/skeleton/node_types.js";

type SkeletonNodeType = SpatialSkeletonDisplayNodeType;

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

interface NodeClassification {
  node: SpatiallyIndexedSkeletonNode;
  type: SkeletonNodeType;
  isLeaf: boolean;
  description: string | undefined;
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

  // Classify each node once; reused for filter matching and row building.
  const classificationById = new Map<number, NodeClassification>();
  for (const [nodeId, node] of nodeById) {
    const children = childrenByParent.get(nodeId) ?? [];
    const parentInTree =
      node.parentNodeId !== undefined && nodeById.has(node.parentNodeId);
    const type = classifyNodeType(node, children.length, parentInTree);
    const description = options.getNodeDescription(node);
    classificationById.set(nodeId, {
      node,
      type,
      isLeaf: children.length === 0,
      description,
    });
  }

  // Stage 1: does this node match the user's text and type filters?
  const matchesSearchFilter = (nodeId: number): boolean => {
    const info = classificationById.get(nodeId);
    if (info === undefined) return false;
    const { node, type, isLeaf, description } = info;
    return (
      matchesSpatialSkeletonNodeFilter(options.nodeFilterType, {
        isLeaf,
        nodeHasDescription: hasNonEmptyNodeDescription(description),
        nodeIsTrueEnd: node.isTrueEnd ?? false,
        nodeType: type,
      }) && nodeMatchesFilter(node, options.filterText, description)
    );
  };

  const matchedNodeIds = getFlatListNodeIds(graph, {
    collapseRegularNodesForOrdering: true,
  }).filter(matchesSearchFilter);
  const matchedNodeIdSet = new Set<number>(matchedNodeIds);

  // branchCount uses all matched nodes (including collapsed ones) for correct topology.
  let branchCount = 0;
  for (const nodeId of matchedNodeIds) {
    const node = nodeById.get(nodeId)!;
    const visibleParent =
      node.parentNodeId !== undefined &&
      matchedNodeIdSet.has(node.parentNodeId);
    if (!visibleParent) {
      branchCount++;
    }
    let visibleChildCount = 0;
    for (const childNodeId of childrenByParent.get(nodeId) ?? []) {
      if (matchedNodeIdSet.has(childNodeId)) {
        visibleChildCount++;
      }
    }
    if (visibleChildCount > 1) {
      branchCount += visibleChildCount - 1;
    }
  }

  // Stage 2: among matched nodes, plain regular chain nodes are collapsed from the
  // display list under the Default filter with no search text. Any other filter
  // or active search text means the user explicitly narrowed the view, so every
  // match is shown including regular chain nodes.
  const hasActiveFilter =
    options.filterText.length > 0 ||
    options.nodeFilterType !== SpatialSkeletonNodeFilterType.DEFAULT;

  const isCollapsedFromDisplay = (nodeId: number): boolean => {
    if (hasActiveFilter) return false;
    const info = classificationById.get(nodeId);
    if (info === undefined) return true;
    return (
      info.type === SpatialSkeletonDisplayNodeType.REGULAR &&
      !(info.node.isTrueEnd ?? false)
    );
  };

  const rows: SpatialSkeletonSegmentRenderRow[] = [];
  for (const nodeId of matchedNodeIds) {
    if (isCollapsedFromDisplay(nodeId)) continue;
    const { node, type, isLeaf } = classificationById.get(nodeId)!;
    rows.push({ node, type, isLeaf });
  }

  return {
    segmentId,
    totalNodeCount: nodeById.size,
    matchedNodeCount: matchedNodeIds.length,
    displayedNodeCount: rows.length,
    branchCount,
    rows,
  };
}
