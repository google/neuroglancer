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

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/actions.js";
import type { SpatialSkeletonCommand } from "#src/skeleton/command_history.js";

export type SpatialSkeletonCommandPayload = object;

export interface SpatialSkeletonEditCommandFactory<
  TAction extends SpatialSkeletonAction = SpatialSkeletonAction,
> {
  readonly action: TAction;
  createCommand(
    layer: SegmentationUserLayer,
    payload: SpatialSkeletonCommandPayload,
  ): SpatialSkeletonCommand;
}

type SpatialSkeletonEditCommandFactoryCandidate = {
  action?: unknown;
  createCommand?: (
    layer: SegmentationUserLayer,
    payload: SpatialSkeletonCommandPayload,
  ) => SpatialSkeletonCommand;
};

export function isSpatialSkeletonEditCommandFactory<
  TAction extends SpatialSkeletonAction,
>(
  value: unknown,
  action: TAction,
): value is SpatialSkeletonEditCommandFactory<TAction> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as SpatialSkeletonEditCommandFactoryCandidate).action === action &&
    typeof (value as SpatialSkeletonEditCommandFactoryCandidate)
      .createCommand === "function"
  );
}

export type SpatialSkeletonEditCommandProperty =
  | "addNodesCommand"
  | "insertNodesCommand"
  | "moveNodesCommand"
  | "deleteNodesCommand"
  | "rerootCommand"
  | "editNodeDescriptionCommand"
  | "editNodeTrueEndCommand"
  | "editNodeRadiusCommand"
  | "editNodeConfidenceCommand"
  | "mergeSkeletonsCommand"
  | "splitSkeletonsCommand";

export interface SpatialSkeletonEditCommandMetadata {
  readonly action: SpatialSkeletonAction;
  readonly commandProperty: SpatialSkeletonEditCommandProperty;
  readonly required: boolean;
  readonly requiresConfidenceConfiguration?: boolean;
}

export const SPATIAL_SKELETON_EDIT_COMMAND_METADATA = [
  {
    action: SpatialSkeletonActions.addNodes,
    commandProperty: "addNodesCommand",
    required: true,
  },
  {
    action: SpatialSkeletonActions.insertNodes,
    commandProperty: "insertNodesCommand",
    required: false,
  },
  {
    action: SpatialSkeletonActions.moveNodes,
    commandProperty: "moveNodesCommand",
    required: true,
  },
  {
    action: SpatialSkeletonActions.deleteNodes,
    commandProperty: "deleteNodesCommand",
    required: true,
  },
  {
    action: SpatialSkeletonActions.reroot,
    commandProperty: "rerootCommand",
    required: false,
  },
  {
    action: SpatialSkeletonActions.editNodeDescription,
    commandProperty: "editNodeDescriptionCommand",
    required: false,
  },
  {
    action: SpatialSkeletonActions.editNodeTrueEnd,
    commandProperty: "editNodeTrueEndCommand",
    required: false,
  },
  {
    action: SpatialSkeletonActions.editNodeRadius,
    commandProperty: "editNodeRadiusCommand",
    required: false,
  },
  {
    action: SpatialSkeletonActions.editNodeConfidence,
    commandProperty: "editNodeConfidenceCommand",
    required: false,
    requiresConfidenceConfiguration: true,
  },
  {
    action: SpatialSkeletonActions.mergeSkeletons,
    commandProperty: "mergeSkeletonsCommand",
    required: true,
  },
  {
    action: SpatialSkeletonActions.splitSkeletons,
    commandProperty: "splitSkeletonsCommand",
    required: true,
  },
] as const satisfies readonly SpatialSkeletonEditCommandMetadata[];

const spatialSkeletonEditCommandMetadataByAction = new Map<
  SpatialSkeletonAction,
  SpatialSkeletonEditCommandMetadata
>(
  SPATIAL_SKELETON_EDIT_COMMAND_METADATA.map((metadata) => [
    metadata.action,
    metadata,
  ]),
);

export function getSpatialSkeletonEditCommandMetadata(
  action: SpatialSkeletonAction,
): SpatialSkeletonEditCommandMetadata | undefined {
  return spatialSkeletonEditCommandMetadataByAction.get(action);
}

export function getSpatialSkeletonEditCommandFactoryFromSource(
  source: object,
  action: SpatialSkeletonAction,
): SpatialSkeletonEditCommandFactory | undefined {
  const metadata = getSpatialSkeletonEditCommandMetadata(action);
  if (metadata === undefined) return undefined;
  const commandFactory = (
    source as Record<SpatialSkeletonEditCommandProperty, unknown>
  )[metadata.commandProperty];
  return isSpatialSkeletonEditCommandFactory(commandFactory, metadata.action)
    ? commandFactory
    : undefined;
}

export type SpatialSkeletonAddNodesCommandFactory =
  SpatialSkeletonEditCommandFactory<typeof SpatialSkeletonActions.addNodes>;
export type SpatialSkeletonInsertNodesCommandFactory =
  SpatialSkeletonEditCommandFactory<typeof SpatialSkeletonActions.insertNodes>;
export type SpatialSkeletonMoveNodesCommandFactory =
  SpatialSkeletonEditCommandFactory<typeof SpatialSkeletonActions.moveNodes>;
export type SpatialSkeletonDeleteNodesCommandFactory =
  SpatialSkeletonEditCommandFactory<typeof SpatialSkeletonActions.deleteNodes>;
export type SpatialSkeletonRerootCommandFactory =
  SpatialSkeletonEditCommandFactory<typeof SpatialSkeletonActions.reroot>;
export type SpatialSkeletonEditNodeDescriptionCommandFactory =
  SpatialSkeletonEditCommandFactory<
    typeof SpatialSkeletonActions.editNodeDescription
  >;
export type SpatialSkeletonEditNodeTrueEndCommandFactory =
  SpatialSkeletonEditCommandFactory<
    typeof SpatialSkeletonActions.editNodeTrueEnd
  >;
export type SpatialSkeletonEditNodeRadiusCommandFactory =
  SpatialSkeletonEditCommandFactory<
    typeof SpatialSkeletonActions.editNodeRadius
  >;
export type SpatialSkeletonEditNodeConfidenceCommandFactory =
  SpatialSkeletonEditCommandFactory<
    typeof SpatialSkeletonActions.editNodeConfidence
  >;
export type SpatialSkeletonMergeSkeletonsCommandFactory =
  SpatialSkeletonEditCommandFactory<
    typeof SpatialSkeletonActions.mergeSkeletons
  >;
export type SpatialSkeletonSplitSkeletonsCommandFactory =
  SpatialSkeletonEditCommandFactory<
    typeof SpatialSkeletonActions.splitSkeletons
  >;
