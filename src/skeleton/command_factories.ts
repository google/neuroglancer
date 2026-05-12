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
import type {
  SpatialSkeletonActions,
  SpatialSkeletonAction,
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
