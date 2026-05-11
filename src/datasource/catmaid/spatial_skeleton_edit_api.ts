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
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonSourceState,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";

// CATMAID owns these payloads; the generic skeleton API only promises named edit operations.
export interface CatmaidSpatialSkeletonNodeSourceStateUpdate {
  nodeId: number;
  sourceState: SpatialSkeletonSourceState;
}

export interface CatmaidSpatialSkeletonEditResult {
  nodeSourceStateUpdates?: readonly CatmaidSpatialSkeletonNodeSourceStateUpdate[];
}

export interface CatmaidSpatialSkeletonAddNodeRequest {
  segmentId: number;
  position: SpatialSkeletonVector;
  parentNode?: SpatiallyIndexedSkeletonNode;
}

export interface CatmaidSpatialSkeletonAddNodeResult
  extends CatmaidSpatialSkeletonEditResult {
  nodeId: number;
  segmentId: number;
  sourceState?: SpatialSkeletonSourceState;
  parentSourceState?: SpatialSkeletonSourceState;
}

export interface CatmaidSpatialSkeletonInsertNodeRequest {
  segmentId: number;
  position: SpatialSkeletonVector;
  parentNode: SpatiallyIndexedSkeletonNode;
  childNodes: readonly SpatiallyIndexedSkeletonNode[];
}

export type CatmaidSpatialSkeletonInsertNodeResult =
  CatmaidSpatialSkeletonAddNodeResult;

export interface CatmaidSpatialSkeletonMoveNodeRequest {
  node: SpatiallyIndexedSkeletonNode;
  position: SpatialSkeletonVector;
}

export interface CatmaidSpatialSkeletonNodeSourceStateResult
  extends CatmaidSpatialSkeletonEditResult {
  sourceState?: SpatialSkeletonSourceState;
}

export interface CatmaidSpatialSkeletonDeleteNodeRequest {
  node: SpatiallyIndexedSkeletonNode;
  childNodes: readonly SpatiallyIndexedSkeletonNode[];
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[];
}

export type CatmaidSpatialSkeletonDeleteNodeResult =
  CatmaidSpatialSkeletonEditResult;

export interface CatmaidSpatialSkeletonSplitRequest {
  node: SpatiallyIndexedSkeletonNode;
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[];
}

export interface CatmaidSpatialSkeletonSplitResult
  extends CatmaidSpatialSkeletonEditResult {
  existingSegmentId: number | undefined;
  newSegmentId: number | undefined;
}

export interface CatmaidSpatialSkeletonMergeRequest {
  fromNode: SpatiallyIndexedSkeletonNode;
  toNode: SpatiallyIndexedSkeletonNode;
}

export interface CatmaidSpatialSkeletonMergeResult
  extends CatmaidSpatialSkeletonEditResult {
  resultSegmentId: number | undefined;
  deletedSegmentId: number | undefined;
  directionAdjusted: boolean;
}

export interface CatmaidSpatialSkeletonRerootRequest {
  node: SpatiallyIndexedSkeletonNode;
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[];
}

export type CatmaidSpatialSkeletonRerootResult =
  CatmaidSpatialSkeletonEditResult;

export interface CatmaidSpatialSkeletonDescriptionUpdateRequest {
  node: SpatiallyIndexedSkeletonNode;
  description: string;
  isTrueEnd?: boolean;
}

export interface CatmaidSpatialSkeletonDescriptionUpdateResult
  extends CatmaidSpatialSkeletonNodeSourceStateResult {
  description?: string;
}

export interface CatmaidSpatialSkeletonTrueEndUpdateRequest {
  node: SpatiallyIndexedSkeletonNode;
  isTrueEnd: boolean;
}

export interface CatmaidSpatialSkeletonRadiusUpdateRequest {
  node: SpatiallyIndexedSkeletonNode;
  radius: number;
}

export interface CatmaidSpatialSkeletonConfidenceUpdateRequest {
  node: SpatiallyIndexedSkeletonNode;
  confidence: number;
}
