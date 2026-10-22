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
import type { SkeletonVector } from "#src/skeleton/api.js";

export interface CatmaidSpatialSkeletonEditOperations {
  /** Stable identity of the physical CATMAID edit request target. */
  readonly editRequestScope: object;
  commitAddNode(
    request: CatmaidSpatialSkeletonAddNodeRequest,
  ): Promise<CatmaidSpatialSkeletonAddNodeResult>;
  commitInsertNode(
    request: CatmaidSpatialSkeletonInsertNodeRequest,
  ): Promise<CatmaidSpatialSkeletonInsertNodeResult>;
  commitMoveNode(request: CatmaidSpatialSkeletonMoveNodeRequest): Promise<void>;
  commitDeleteNode(
    request: CatmaidSpatialSkeletonDeleteNodeRequest,
  ): Promise<void>;
  commitReroot(request: CatmaidSpatialSkeletonRerootRequest): Promise<void>;
  commitDescription(
    request: CatmaidSpatialSkeletonDescriptionUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonDescriptionUpdateResult>;
  commitTrueEnd(
    request: CatmaidSpatialSkeletonTrueEndUpdateRequest,
  ): Promise<void>;
  commitRadius(
    request: CatmaidSpatialSkeletonRadiusUpdateRequest,
  ): Promise<void>;
  commitConfidence(
    request: CatmaidSpatialSkeletonConfidenceUpdateRequest,
  ): Promise<void>;
  commitMerge(
    request: CatmaidSpatialSkeletonMergeRequest,
  ): Promise<CatmaidSpatialSkeletonMergeResult>;
  commitSplit(
    request: CatmaidSpatialSkeletonSplitRequest,
  ): Promise<CatmaidSpatialSkeletonSplitResult>;
}

// CATMAID owns these payloads; the generic skeleton API only promises named edit operations.
export interface CatmaidSpatialSkeletonAddNodeRequest {
  position: SkeletonVector;
  parentNodeId?: bigint;
}

export type CatmaidSpatialSkeletonAddNodeResult = CatmaidAddNodeResult;

export interface CatmaidSpatialSkeletonInsertNodeRequest {
  position: SkeletonVector;
  parentNodeId: bigint;
  childNodeIds: readonly bigint[];
}

export type CatmaidSpatialSkeletonInsertNodeResult = CatmaidInsertNodeResult;

export interface CatmaidSpatialSkeletonMoveNodeRequest {
  nodeId: bigint;
  position: SkeletonVector;
}

export interface CatmaidSpatialSkeletonDeleteNodeRequest {
  nodeId: bigint;
}

export interface CatmaidSpatialSkeletonSplitRequest {
  nodeId: bigint;
}

export type CatmaidSpatialSkeletonSplitResult = CatmaidSplitResult;

export interface CatmaidSpatialSkeletonMergeRequest {
  fromNodeId: bigint;
  toNodeId: bigint;
}

export type CatmaidSpatialSkeletonMergeResult = CatmaidMergeResult;

export interface CatmaidSpatialSkeletonRerootRequest {
  nodeId: bigint;
}

export interface CatmaidSpatialSkeletonDescriptionUpdateRequest {
  nodeId: bigint;
  description: string;
  isTrueEnd: boolean;
}

export type CatmaidSpatialSkeletonDescriptionUpdateResult =
  CatmaidDescriptionUpdateResult;

export interface CatmaidSpatialSkeletonTrueEndUpdateRequest {
  nodeId: bigint;
  isTrueEnd: boolean;
}

export interface CatmaidSpatialSkeletonRadiusUpdateRequest {
  nodeId: bigint;
  radius: number;
}

export interface CatmaidSpatialSkeletonConfidenceUpdateRequest {
  nodeId: bigint;
  confidence: number;
}
