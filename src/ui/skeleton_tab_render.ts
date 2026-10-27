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
 * @file Derives the rows, counts and messages of the Skeleton tab node list
 * from a navigation graph and the pending edits, without touching the DOM.
 */

import type { SkeletonNode } from "#src/skeleton/api.js";
import type { SpatialSkeletonPendingEdit } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  getFlatListNodeIds,
  type SkeletonNavigationGraph,
} from "#src/skeleton/navigation_graph.js";
import { isSkeletonNodeTrueEnd } from "#src/skeleton/node_attributes.js";
import {
  classifySkeletonDisplayNodeType as classifyNodeType,
  matchesSkeletonNodeFilter,
  SkeletonDisplayNodeType,
  SkeletonNodeFilterType,
} from "#src/skeleton/node_types.js";

type SkeletonNodeType = SkeletonDisplayNodeType;

function nodeMatchesFilter(
  node: SkeletonNode,
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

export interface SkeletonSegmentRenderRow {
  node: SkeletonNode;
  type: SkeletonNodeType;
  isLeaf: boolean;
}

export interface SkeletonSegmentRenderState {
  segmentId: bigint;
  totalNodeCount: number;
  matchedNodeCount: number;
  displayedNodeCount: number;
  branchCount: number;
  rows: readonly SkeletonSegmentRenderRow[];
}

interface NodeClassification {
  node: SkeletonNode;
  type: SkeletonNodeType;
  isLeaf: boolean;
  description: string | undefined;
}

export function buildSkeletonSegmentRenderState(
  segmentId: bigint,
  graph: SkeletonNavigationGraph,
  options: {
    filterText: string;
    nodeFilterType: SkeletonNodeFilterType;
    getNodeDescription: (node: SkeletonNode) => string | undefined;
  },
): SkeletonSegmentRenderState {
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
  const classificationById = new Map<bigint, NodeClassification>();
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
  const matchesSearchFilter = (nodeId: bigint): boolean => {
    const info = classificationById.get(nodeId);
    if (info === undefined) return false;
    const { node, type, isLeaf, description } = info;
    return (
      matchesSkeletonNodeFilter(options.nodeFilterType, {
        isLeaf,
        nodeHasDescription: hasNonEmptyNodeDescription(description),
        nodeIsTrueEnd: isSkeletonNodeTrueEnd(node),
        nodeType: type,
      }) && nodeMatchesFilter(node, options.filterText, description)
    );
  };

  const matchedNodeIds = getFlatListNodeIds(graph, {
    collapseRegularNodesForOrdering: true,
  }).filter(matchesSearchFilter);
  const matchedNodeIdSet = new Set<bigint>(matchedNodeIds);

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
    options.nodeFilterType !== SkeletonNodeFilterType.DEFAULT;

  const isCollapsedFromDisplay = (nodeId: bigint): boolean => {
    if (hasActiveFilter) return false;
    const info = classificationById.get(nodeId);
    if (info === undefined) return true;
    return (
      info.type === SkeletonDisplayNodeType.REGULAR &&
      !isSkeletonNodeTrueEnd(info.node)
    );
  };

  const rows: SkeletonSegmentRenderRow[] = [];
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

const PROVISIONAL_NODE_ID_TOOLTIP =
  "Preview node. The skeleton source has not yet confirmed its permanent node ID.";
const SKELETON_DETAILS_UNAVAILABLE_LIST_MESSAGE =
  "To view this skeleton's nodes, show it in Seg, then allow it to finish loading.";
const PICKABLE_SKELETON_DETAILS_UNAVAILABLE_LIST_MESSAGE =
  "To view this skeleton's nodes, show it in Seg or double-click one of its nodes, then allow its details to finish loading.";
export const PREPARATION_PENDING_LIST_MESSAGE =
  "Preparing the complete skeleton preview…";

export function getSkeletonNodeIdPresentation(
  nodeId: bigint,
  provisionalNodeIds: readonly bigint[],
) {
  return provisionalNodeIds.includes(nodeId)
    ? {
        label: "Preview",
        tooltip: PROVISIONAL_NODE_ID_TOOLTIP,
        provisional: true,
      }
    : { label: String(nodeId), tooltip: undefined, provisional: false };
}

const PREPARATION_ACTION_LABELS: Record<
  SpatialSkeletonPendingEdit["kind"],
  string
> = {
  merge: "merge",
  split: "split",
  delete: "node deletion",
  restore: "node restoration",
  reroot: "reroot",
};

export interface SpatialSkeletonDetailsPreparationState {
  readonly preparation: SpatialSkeletonPendingEdit;
  readonly statusText: string;
  readonly detailText: string;
  readonly controlsDisabledReason: string;
  readonly laterEditCount: number;
}

function getPreparationStatusText(preparation: SpatialSkeletonPendingEdit) {
  const action = PREPARATION_ACTION_LABELS[preparation.kind];
  switch (preparation.direction) {
    case "undo":
      return `Preparing Undo preview for ${action}…`;
    case "redo":
      return `Preparing Redo preview for ${action}…`;
    default:
      return `Preparing ${action} preview…`;
  }
}

function getPreparationControlsDisabledReason(
  preparation: SpatialSkeletonPendingEdit,
) {
  const action = PREPARATION_ACTION_LABELS[preparation.kind];
  return `Available after the exact ${action} preview finishes preparing.`;
}

// Status text names no segment ID, because IDs may be temporary during remapping.
export function getSpatialSkeletonDetailsPreparationState(options: {
  preparations: readonly SpatialSkeletonPendingEdit[];
  selectedSegmentId: bigint | undefined;
  selectedSegmentStableId?: string;
  hasExactTopology: boolean;
}): SpatialSkeletonDetailsPreparationState | undefined {
  const { selectedSegmentId, selectedSegmentStableId, hasExactTopology } =
    options;
  if (selectedSegmentId === undefined) return undefined;
  const overlapping = options.preparations
    .filter(
      (preparation) =>
        preparation.segmentIds.includes(selectedSegmentId) ||
        (selectedSegmentStableId !== undefined &&
          preparation.stableSegmentHandles?.some(
            (handle) => handle.stableId === selectedSegmentStableId,
          )),
    )
    .sort((a, b) => a.sequence - b.sequence);
  const preparation = overlapping[0];
  if (preparation === undefined) return undefined;
  return {
    preparation,
    statusText: getPreparationStatusText(preparation),
    detailText: hasExactTopology
      ? "The last complete skeleton is shown below while the requested preview is prepared."
      : PREPARATION_PENDING_LIST_MESSAGE,
    controlsDisabledReason: getPreparationControlsDisabledReason(preparation),
    laterEditCount: overlapping.length - 1,
  };
}

export type SegmentDisplayState = SkeletonSegmentRenderState & {
  segmentLabel: string | undefined;
};

export type SkeletonListItem =
  | { kind: "segment"; segmentState: SegmentDisplayState }
  | { kind: "node"; row: SkeletonSegmentRenderRow }
  | { kind: "empty"; text: string };

export function buildSkeletonVirtualListItems(
  segmentState: SegmentDisplayState | undefined,
  emptyText: string,
) {
  const items: SkeletonListItem[] = [];
  const listIndexByNodeId = new Map<bigint, number>();
  if (segmentState !== undefined && segmentState.displayedNodeCount > 0) {
    items.push({ kind: "segment", segmentState });
    for (const row of segmentState.rows) {
      listIndexByNodeId.set(row.node.nodeId, items.length);
      items.push({ kind: "node", row });
    }
  } else {
    items.push({ kind: "empty", text: emptyText });
  }
  return { items, listIndexByNodeId };
}

export function getSkeletonEmptyListText(options: {
  activeSegmentId: bigint | undefined;
  selectedSegmentDetailsUnavailable: boolean;
  segmentState: SegmentDisplayState | undefined;
  filterText: string;
  nodeFilterType: SkeletonNodeFilterType;
  preparationActive?: boolean;
  hasPickableNodes: boolean;
}): string {
  const {
    activeSegmentId,
    selectedSegmentDetailsUnavailable,
    segmentState,
    filterText,
    nodeFilterType,
    preparationActive = false,
    hasPickableNodes,
  } = options;
  if (preparationActive && segmentState === undefined) {
    return PREPARATION_PENDING_LIST_MESSAGE;
  }
  if (activeSegmentId === undefined) {
    if (selectedSegmentDetailsUnavailable) {
      return hasPickableNodes
        ? PICKABLE_SKELETON_DETAILS_UNAVAILABLE_LIST_MESSAGE
        : SKELETON_DETAILS_UNAVAILABLE_LIST_MESSAGE;
    }
    return hasPickableNodes
      ? "Hover over or select a skeleton node to view its skeleton's nodes."
      : "Select a skeleton to view its nodes.";
  }
  if (
    segmentState === undefined ||
    segmentState.totalNodeCount === 0 ||
    (filterText.length === 0 &&
      (nodeFilterType === SkeletonNodeFilterType.DEFAULT ||
        nodeFilterType === SkeletonNodeFilterType.NONE))
  ) {
    return "No loaded nodes.";
  }
  return "No matching nodes.";
}
