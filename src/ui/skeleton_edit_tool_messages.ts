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

import type {
  SpatialSkeletonShortcut,
  SpatialSkeletonToolStatusText,
} from "#src/ui/skeleton_edit_tool_shortcuts.js";
import {
  ADD_NODE_ACTION,
  DELETE_ACTION,
  DELETE_CLICK_ACTION,
  EXIT_CREATE_ACTION,
  EXIT_DELETE_ACTION,
  EXIT_MERGE_ACTION,
  EXIT_SPLIT_ACTION,
  MERGE_ACTION,
  MOVE_ACTION,
  NEW_SKELETON_ACTION,
  PLACE_ACTION,
  SELECT_ACTION,
  SHOW_SKELETON_ACTION,
  SPATIAL_SKELETON_ROTATE_PAN_ACTION,
  SPLIT_ACTION,
} from "#src/ui/skeleton_edit_tool_shortcuts.js";

export interface SpatialSkeletonToolPointInfo {
  nodeId: number;
  segmentId?: number;
  position?: ArrayLike<number>;
}

export interface SpatialSkeletonToolSummaryField {
  label: string;
  value: string;
  highlight?: boolean;
}

export interface SpatialSkeletonToolSummaryRow {
  fields: SpatialSkeletonToolSummaryField[];
}

export interface SpatialSkeletonToolStatusField {
  label: string;
  value: string;
}

export function formatSpatialSkeletonToolPoint(
  point: SpatialSkeletonToolPointInfo,
) {
  return point.segmentId === undefined
    ? `Node ${point.nodeId}`
    : `Node ${point.nodeId}, segment ${point.segmentId}`;
}

export function getSpatialSkeletonToolPointSummaryRow(
  point: SpatialSkeletonToolPointInfo,
): SpatialSkeletonToolSummaryRow {
  const fields: SpatialSkeletonToolSummaryField[] = [
    {
      label: "Segment ID:",
      value: point.segmentId === undefined ? "-" : `${point.segmentId}`,
    },
    { label: "Node ID:", value: `${point.nodeId}` },
  ];
  const { position } = point;
  if (position !== undefined && position.length >= 3) {
    fields.push({
      label: "x",
      value: `${Math.round(Number(position[0]))}`,
      highlight: true,
    });
    fields.push({
      label: "y",
      value: `${Math.round(Number(position[1]))}`,
      highlight: true,
    });
    fields.push({
      label: "z",
      value: `${Math.round(Number(position[2]))}`,
      highlight: true,
    });
  }
  return { fields };
}

export function getSpatialSkeletonToolPointStatusFields(
  point: SpatialSkeletonToolPointInfo,
): SpatialSkeletonToolStatusField[] {
  const fields: SpatialSkeletonToolStatusField[] = [
    { label: "Node ID:", value: `${point.nodeId}` },
  ];
  if (point.segmentId !== undefined) {
    fields.push({ label: "Segment ID:", value: `${point.segmentId}` });
  }
  return fields;
}

// --- Name / status / actions message system ---
//
// The tool's status bar is split into three parts: a name (rendered by the
// caller via a fixed header, see SPATIAL_SKELETON_EDIT_TOOL_NAME), a short
// `status` describing what's currently true, and a short `actions` list
// describing what's currently doable. Keeping these separate (rather than
// one long banner string) avoids mixing state with instructions, and lets
// the no-selection default state stop advertising actions that don't apply
// yet (e.g. shift+click, which requires an existing selection).
//
// User-facing copy says "from node" rather than "merge anchor" — the
// internal name (mergeAnchorNodeId, etc.) is unaffected.

export type SpatialSkeletonDefaultSelectionState =
  | "none"
  | "selected-visible"
  | "selected-hidden";

export function getSpatialSkeletonDefaultStatusText(
  state: SpatialSkeletonDefaultSelectionState,
  shiftHeld: boolean,
): SpatialSkeletonToolStatusText {
  switch (state) {
    case "none":
      return {
        status: "No selection",
        actions: [
          SELECT_ACTION,
          MOVE_ACTION,
          MERGE_ACTION,
          SPLIT_ACTION,
          NEW_SKELETON_ACTION,
          DELETE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      };
    case "selected-visible":
      return {
        status: shiftHeld ? "Ready to place new node" : "Node selected",
        actions: [
          SELECT_ACTION,
          MOVE_ACTION,
          ADD_NODE_ACTION,
          MERGE_ACTION,
          SPLIT_ACTION,
          NEW_SKELETON_ACTION,
          DELETE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      };
    case "selected-hidden":
      return {
        status: "Node selected from non-visible skeleton",
        actions: [
          SHOW_SKELETON_ACTION,
          MERGE_ACTION,
          SPLIT_ACTION,
          NEW_SKELETON_ACTION,
          DELETE_ACTION,
          SPATIAL_SKELETON_ROTATE_PAN_ACTION,
        ],
      };
  }
}

export function getSpatialSkeletonMovingStatusText(): SpatialSkeletonToolStatusText {
  return {
    status: "Moving node",
    actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
  };
}

export type SpatialSkeletonMergeState =
  | "no-from-node"
  | "from-node-visible"
  | "from-node-hidden";

function withExitHint(
  action: SpatialSkeletonShortcut,
  canExitWithKey: boolean,
  exitAction: SpatialSkeletonShortcut,
): SpatialSkeletonShortcut[] {
  return canExitWithKey
    ? [action, exitAction, SPATIAL_SKELETON_ROTATE_PAN_ACTION]
    : [action, SPATIAL_SKELETON_ROTATE_PAN_ACTION];
}

export function getSpatialSkeletonMergeStatusText(
  state: SpatialSkeletonMergeState,
  canExitWithKey: boolean,
): SpatialSkeletonToolStatusText {
  switch (state) {
    case "no-from-node":
      return {
        status: "Merge · click a node to merge from",
        actions: withExitHint(SELECT_ACTION, canExitWithKey, EXIT_MERGE_ACTION),
      };
    case "from-node-visible":
      return {
        status: "Merge · click a node to merge to",
        actions: withExitHint(SELECT_ACTION, canExitWithKey, EXIT_MERGE_ACTION),
      };
    case "from-node-hidden":
      return {
        status: "Merge · make the from-node skeleton visible",
        actions: withExitHint(
          SHOW_SKELETON_ACTION,
          canExitWithKey,
          EXIT_MERGE_ACTION,
        ),
      };
  }
}

export function getSpatialSkeletonMergingStatusText(): SpatialSkeletonToolStatusText {
  return {
    status: "Merge · merging nodes…",
    actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
  };
}

export function getSpatialSkeletonSplitIdleStatusText(
  canExitWithKey: boolean,
): SpatialSkeletonToolStatusText {
  return {
    status: "Split · click a node to form the root of a new skeleton",
    actions: withExitHint(SELECT_ACTION, canExitWithKey, EXIT_SPLIT_ACTION),
  };
}

export function getSpatialSkeletonSplittingStatusText(): SpatialSkeletonToolStatusText {
  return {
    status: "Split · splitting node…",
    actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
  };
}

export function getSpatialSkeletonDeleteIdleStatusText(
  canExitWithKey: boolean,
): SpatialSkeletonToolStatusText {
  return {
    status: "Delete · no selected nodes",
    actions: withExitHint(
      DELETE_CLICK_ACTION,
      canExitWithKey,
      EXIT_DELETE_ACTION,
    ),
  };
}

export function getSpatialSkeletonDeletingStatusText(): SpatialSkeletonToolStatusText {
  return {
    status: "Delete · deleting node…",
    actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
  };
}

export function getSpatialSkeletonCreateIdleStatusText(
  canExitWithKey: boolean,
): SpatialSkeletonToolStatusText {
  return {
    status: "Create · ready to place",
    actions: withExitHint(PLACE_ACTION, canExitWithKey, EXIT_CREATE_ACTION),
  };
}

export function getSpatialSkeletonCreatingStatusText(): SpatialSkeletonToolStatusText {
  return {
    status: "Create · creating skeleton…",
    actions: [SPATIAL_SKELETON_ROTATE_PAN_ACTION],
  };
}
