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
  CatmaidAddNodeResult,
  CatmaidDeleteNodeResult,
  CatmaidDescriptionUpdateResult,
  CatmaidInsertNodeResult,
  CatmaidMergeResult,
  CatmaidNodeSourceStateResult,
  CatmaidRerootResult,
  CatmaidSkeletonEditResult,
  CatmaidSkeletonNodeSourceStateUpdate,
  CatmaidSplitResult,
} from "#src/datasource/catmaid/api.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";

// CATMAID owns these payloads; the generic skeleton API only promises named edit operations.
export type CatmaidSpatialSkeletonNodeSourceStateUpdate =
  CatmaidSkeletonNodeSourceStateUpdate;

export type CatmaidSpatialSkeletonEditResult = CatmaidSkeletonEditResult;

export interface CatmaidSpatialSkeletonAddNodeRequest {
  segmentId: number;
  position: SpatialSkeletonVector;
  parentNode?: SpatiallyIndexedSkeletonNode;
}

export type CatmaidSpatialSkeletonAddNodeResult = CatmaidAddNodeResult;

export interface CatmaidSpatialSkeletonInsertNodeRequest {
  segmentId: number;
  position: SpatialSkeletonVector;
  parentNode: SpatiallyIndexedSkeletonNode;
  childNodes: readonly SpatiallyIndexedSkeletonNode[];
}

export type CatmaidSpatialSkeletonInsertNodeResult = CatmaidInsertNodeResult;

export interface CatmaidSpatialSkeletonMoveNodeRequest {
  node: SpatiallyIndexedSkeletonNode;
  position: SpatialSkeletonVector;
}

export type CatmaidSpatialSkeletonNodeSourceStateResult =
  CatmaidNodeSourceStateResult;

export interface CatmaidSpatialSkeletonDeleteNodeRequest {
  node: SpatiallyIndexedSkeletonNode;
  childNodes: readonly SpatiallyIndexedSkeletonNode[];
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[];
}

export type CatmaidSpatialSkeletonDeleteNodeResult = CatmaidDeleteNodeResult;

export interface CatmaidSpatialSkeletonSplitRequest {
  node: SpatiallyIndexedSkeletonNode;
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[];
}

export type CatmaidSpatialSkeletonSplitResult = CatmaidSplitResult;

export interface CatmaidSpatialSkeletonMergeRequest {
  fromNode: SpatiallyIndexedSkeletonNode;
  toNode: SpatiallyIndexedSkeletonNode;
}

export type CatmaidSpatialSkeletonMergeResult = CatmaidMergeResult;

export interface CatmaidSpatialSkeletonRerootRequest {
  node: SpatiallyIndexedSkeletonNode;
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[];
}

export type CatmaidSpatialSkeletonRerootResult = CatmaidRerootResult;

export interface CatmaidSpatialSkeletonDescriptionUpdateRequest {
  node: SpatiallyIndexedSkeletonNode;
  description: string;
  isTrueEnd?: boolean;
}

export type CatmaidSpatialSkeletonDescriptionUpdateResult =
  CatmaidDescriptionUpdateResult;

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
