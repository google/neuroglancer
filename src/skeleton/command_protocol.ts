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

export const SpatialSkeletonActions = {
  inspect: "inspectSkeletons",
  addNodes: "addNodes",
  insertNodes: "insertNodes",
  moveNodes: "moveNodes",
  deleteNodes: "deleteNodes",
  reroot: "rerootSkeletons",
  editNodeDescription: "editNodeDescription",
  editNodeTrueEnd: "editNodeTrueEnd",
  editNodeRadius: "editNodeRadius",
  editNodeConfidence: "editNodeConfidence",
  mergeSkeletons: "mergeSkeletons",
  splitSkeletons: "splitSkeletons",
} as const;

export type SpatialSkeletonAction =
  (typeof SpatialSkeletonActions)[keyof typeof SpatialSkeletonActions];

export const DEFAULT_SPATIAL_SKELETON_EDIT_ACTIONS = [
  SpatialSkeletonActions.addNodes,
  SpatialSkeletonActions.moveNodes,
  SpatialSkeletonActions.deleteNodes,
] as const satisfies readonly SpatialSkeletonAction[];

export function isSpatialSkeletonEditAction(action: SpatialSkeletonAction) {
  return action !== SpatialSkeletonActions.inspect;
}

export function getSpatialSkeletonActionSupportLabel(
  action: SpatialSkeletonAction,
) {
  switch (action) {
    case SpatialSkeletonActions.inspect:
      return "full skeleton inspection";
    case SpatialSkeletonActions.addNodes:
      return "node creation";
    case SpatialSkeletonActions.insertNodes:
      return "internal node insertion";
    case SpatialSkeletonActions.moveNodes:
      return "node movement";
    case SpatialSkeletonActions.deleteNodes:
      return "node deletion";
    case SpatialSkeletonActions.reroot:
      return "skeleton rerooting";
    case SpatialSkeletonActions.editNodeDescription:
      return "node description editing";
    case SpatialSkeletonActions.editNodeTrueEnd:
      return "node true-end editing";
    case SpatialSkeletonActions.editNodeRadius:
      return "node radius editing";
    case SpatialSkeletonActions.editNodeConfidence:
      return "node confidence editing";
    case SpatialSkeletonActions.mergeSkeletons:
      return "skeleton merging";
    case SpatialSkeletonActions.splitSkeletons:
      return "skeleton splitting";
  }
}

export interface SpatialSkeletonCommandContext {
  readonly mappings: {
    resolveNodeId(nodeId: number | undefined): number | undefined;
    resolveSegmentId(segmentId: number | undefined): number | undefined;
    getStableNodeId(nodeId: number | undefined): number | undefined;
    getStableSegmentId(segmentId: number | undefined): number | undefined;
    getStableOrCurrentNodeId(nodeId: number | undefined): number | undefined;
    getStableOrCurrentSegmentId(
      segmentId: number | undefined,
    ): number | undefined;
    remapNodeId(
      originalNodeId: number | undefined,
      currentNodeId: number,
    ): boolean;
    remapSegmentId(
      originalSegmentId: number | undefined,
      currentSegmentId: number,
    ): boolean;
  };
}

export interface SpatialSkeletonCommand {
  readonly label: string;
  execute(context: SpatialSkeletonCommandContext): Promise<void>;
  undo(context: SpatialSkeletonCommandContext): Promise<void>;
  redo?(context: SpatialSkeletonCommandContext): Promise<void>;
}
