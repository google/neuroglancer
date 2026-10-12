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
  CatmaidDescriptionUpdateResult,
  CatmaidInsertNodeResult,
  CatmaidMergeResult,
  CatmaidSplitResult,
} from "#src/datasource/catmaid/api.js";
import type { SpatialSkeletonVector } from "#src/skeleton/api.js";

// CATMAID owns these payloads; the generic skeleton API only promises named edit operations.
export interface CatmaidSpatialSkeletonAddNodeRequest {
  position: SpatialSkeletonVector;
  parentNodeId?: number;
}

export type CatmaidSpatialSkeletonAddNodeResult = CatmaidAddNodeResult;

export interface CatmaidSpatialSkeletonInsertNodeRequest {
  position: SpatialSkeletonVector;
  parentNodeId: number;
  childNodeIds: readonly number[];
}

export type CatmaidSpatialSkeletonInsertNodeResult = CatmaidInsertNodeResult;

export interface CatmaidSpatialSkeletonMoveNodeRequest {
  nodeId: number;
  position: SpatialSkeletonVector;
}

export interface CatmaidSpatialSkeletonDeleteNodeRequest {
  nodeId: number;
}

export interface CatmaidSpatialSkeletonSplitRequest {
  nodeId: number;
}

export type CatmaidSpatialSkeletonSplitResult = CatmaidSplitResult;

export interface CatmaidSpatialSkeletonMergeRequest {
  fromNodeId: number;
  toNodeId: number;
}

export type CatmaidSpatialSkeletonMergeResult = CatmaidMergeResult;

export interface CatmaidSpatialSkeletonRerootRequest {
  nodeId: number;
}

export interface CatmaidSpatialSkeletonDescriptionUpdateRequest {
  nodeId: number;
  description: string;
  isTrueEnd: boolean;
}

export type CatmaidSpatialSkeletonDescriptionUpdateResult =
  CatmaidDescriptionUpdateResult;

export interface CatmaidSpatialSkeletonTrueEndUpdateRequest {
  nodeId: number;
  isTrueEnd: boolean;
}

export interface CatmaidSpatialSkeletonRadiusUpdateRequest {
  nodeId: number;
  radius: number;
}

export interface CatmaidSpatialSkeletonConfidenceUpdateRequest {
  nodeId: number;
  confidence: number;
}
