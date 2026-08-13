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

export interface SpatialSkeletonToolStatusText {
  status: string;
  actions: string;
}

export const SPATIAL_SKELETON_EDIT_TOOL_NAME = "Skeleton editing";
export const SPATIAL_SKELETON_ROTATE_PAN_HINT =
  "middle-click or ctrl+click to rotate/pan";

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
        actions: `Click to select · drag to move · hold m to merge · hold s to split · hold n for new skeleton · hold d to delete · ${SPATIAL_SKELETON_ROTATE_PAN_HINT}`,
      };
    case "selected-visible":
      return {
        status: shiftHeld ? "Ready to place new node" : "Node selected",
        actions: `Click to select · drag to move · shift+click to add node · hold m to merge · hold s to split · hold n for new skeleton · hold d to delete · ${SPATIAL_SKELETON_ROTATE_PAN_HINT}`,
      };
    case "selected-hidden":
      return {
        status: "Node selected from non-visible skeleton",
        actions: `Double-click skeleton to show it · hold m to merge · hold s to split · hold n for new skeleton · hold d to delete · ${SPATIAL_SKELETON_ROTATE_PAN_HINT}`,
      };
  }
}

export function getSpatialSkeletonMovingStatusText(): SpatialSkeletonToolStatusText {
  return { status: "Moving node", actions: SPATIAL_SKELETON_ROTATE_PAN_HINT };
}

export type SpatialSkeletonMergeState =
  | "no-from-node"
  | "from-node-visible"
  | "from-node-hidden";

function withExitHint(
  action: string,
  canExitWithKey: boolean,
  exitHint: string,
) {
  return canExitWithKey
    ? `${action} · ${exitHint} · ${SPATIAL_SKELETON_ROTATE_PAN_HINT}`
    : `${action} · ${SPATIAL_SKELETON_ROTATE_PAN_HINT}`;
}

export function getSpatialSkeletonMergeStatusText(
  state: SpatialSkeletonMergeState,
  canExitWithKey: boolean,
): SpatialSkeletonToolStatusText {
  const exitHint = "release m to exit merge";
  switch (state) {
    case "no-from-node":
      return {
        status: "Merge · click a node to merge from",
        actions: withExitHint("Click to select node", canExitWithKey, exitHint),
      };
    case "from-node-visible":
      return {
        status: "Merge · click a node to merge to",
        actions: withExitHint("Click to select node", canExitWithKey, exitHint),
      };
    case "from-node-hidden":
      return {
        status: "Merge · make the from-node skeleton visible",
        actions: withExitHint(
          "Double-click skeleton to show it",
          canExitWithKey,
          exitHint,
        ),
      };
  }
}

export function getSpatialSkeletonMergingStatusText(): SpatialSkeletonToolStatusText {
  return {
    status: "Merge · merging nodes…",
    actions: SPATIAL_SKELETON_ROTATE_PAN_HINT,
  };
}

export function getSpatialSkeletonSplitIdleStatusText(
  canExitWithKey: boolean,
): SpatialSkeletonToolStatusText {
  return {
    status: "Split · click a node to form the root of a new skeleton",
    actions: withExitHint(
      "Click to select node",
      canExitWithKey,
      "release s to exit split",
    ),
  };
}

export function getSpatialSkeletonSplittingStatusText(): SpatialSkeletonToolStatusText {
  return {
    status: "Split · splitting node…",
    actions: SPATIAL_SKELETON_ROTATE_PAN_HINT,
  };
}

export function getSpatialSkeletonDeleteIdleStatusText(
  canExitWithKey: boolean,
): SpatialSkeletonToolStatusText {
  return {
    status: "Delete · no selected nodes",
    actions: withExitHint(
      "Click a node to delete",
      canExitWithKey,
      "release d to exit delete",
    ),
  };
}

export function getSpatialSkeletonDeletingStatusText(): SpatialSkeletonToolStatusText {
  return {
    status: "Delete · deleting node…",
    actions: SPATIAL_SKELETON_ROTATE_PAN_HINT,
  };
}

export function getSpatialSkeletonCreateIdleStatusText(
  canExitWithKey: boolean,
): SpatialSkeletonToolStatusText {
  return {
    status: "Create · ready to place",
    actions: withExitHint(
      "Click to place a new skeleton",
      canExitWithKey,
      "release n to exit create",
    ),
  };
}

export function getSpatialSkeletonCreatingStatusText(): SpatialSkeletonToolStatusText {
  return {
    status: "Create · creating skeleton…",
    actions: SPATIAL_SKELETON_ROTATE_PAN_HINT,
  };
}
