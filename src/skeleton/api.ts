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
  SpatialSkeletonAddNodesCommandFactory,
  SpatialSkeletonInsertNodesCommandFactory,
  SpatialSkeletonDeleteNodesCommandFactory,
  SpatialSkeletonEditNodeDescriptionCommandFactory,
  SpatialSkeletonEditNodeConfidenceCommandFactory,
  SpatialSkeletonEditNodeRadiusCommandFactory,
  SpatialSkeletonEditNodeTrueEndCommandFactory,
  SpatialSkeletonMergeSkeletonsCommandFactory,
  SpatialSkeletonMoveNodesCommandFactory,
  SpatialSkeletonRerootCommandFactory,
  SpatialSkeletonSplitSkeletonsCommandFactory,
} from "#src/skeleton/command_factories.js";
import type { SpatialSkeletonOptimisticEditingProvider } from "#src/skeleton/optimistic_edit/api.js";

export type SkeletonVector = ArrayLike<number>;

export interface SpatialSkeletonBounds {
  lowerBounds: SkeletonVector;
  upperBounds: SkeletonVector;
}

export interface SpatialSkeletonGridCellIndex {
  cell: SkeletonVector;
}

export interface SpatialSkeletonSpatialIndexLevel {
  chunkSize: SkeletonVector;
  gridShape: readonly number[];
  limit: number;
}

export interface SkeletonNodeBase {
  nodeId: bigint;
  segmentId: bigint;
  position: SkeletonVector;
  parentNodeId?: bigint;
}

export interface SkeletonNode extends SkeletonNodeBase {
  radius?: number;
  confidence?: number;
  description?: string;
  isTrueEnd?: boolean;
}

export interface SpatiallyIndexedSkeletonMetadata
  extends SpatialSkeletonBounds {
  spatial: readonly SpatialSkeletonSpatialIndexLevel[];
  readonly readonly: boolean;
}

export interface SpatialSkeletonConfidenceConfiguration {
  values: readonly number[];
}

export interface SpatiallyIndexedSkeletonSource {
  readonly readonly: boolean;
  listSkeletons(): Promise<bigint[]>;
  getSkeleton(
    skeletonId: bigint,
    options?: { signal?: AbortSignal },
  ): Promise<SkeletonNode[]>;
  getSpatialIndexMetadata(): Promise<SpatiallyIndexedSkeletonMetadata | null>;
  fetchNodes(
    cellIndex: SpatialSkeletonGridCellIndex,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<SkeletonNodeBase[]>;
}

export interface EditableSpatiallyIndexedSkeletonSource
  extends SpatiallyIndexedSkeletonSource {
  readonly readonly: false;
  /** Required datasource adapter for the generic optimistic edit queue host. */
  readonly optimisticEditing: SpatialSkeletonOptimisticEditingProvider;
  readonly addNodesCommand: SpatialSkeletonAddNodesCommandFactory;
  readonly insertNodesCommand?: SpatialSkeletonInsertNodesCommandFactory;
  readonly deleteNodesCommand: SpatialSkeletonDeleteNodesCommandFactory;
  readonly moveNodesCommand: SpatialSkeletonMoveNodesCommandFactory;
  readonly splitSkeletonsCommand: SpatialSkeletonSplitSkeletonsCommandFactory;
  readonly mergeSkeletonsCommand: SpatialSkeletonMergeSkeletonsCommandFactory;
  readonly rerootCommand?: SpatialSkeletonRerootCommandFactory;
  readonly editNodeDescriptionCommand?: SpatialSkeletonEditNodeDescriptionCommandFactory;
  readonly editNodeTrueEndCommand?: SpatialSkeletonEditNodeTrueEndCommandFactory;
  readonly editNodeRadiusCommand?: SpatialSkeletonEditNodeRadiusCommandFactory;
  readonly editNodeConfidenceCommand?: SpatialSkeletonEditNodeConfidenceCommandFactory;
  readonly spatialSkeletonConfidenceConfiguration?: SpatialSkeletonConfidenceConfiguration;
}
