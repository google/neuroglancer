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
  SpatialSkeletonDeleteNodesCommandFactory,
  SpatialSkeletonEditNodeDescriptionCommandFactory,
  SpatialSkeletonEditNodeConfidenceCommandFactory,
  SpatialSkeletonEditNodeRadiusCommandFactory,
  SpatialSkeletonEditNodeTrueEndCommandFactory,
  SpatialSkeletonInsertNodesCommandFactory,
  SpatialSkeletonMergeSkeletonsCommandFactory,
  SpatialSkeletonMoveNodesCommandFactory,
  SpatialSkeletonRerootCommandFactory,
  SpatialSkeletonSplitSkeletonsCommandFactory,
} from "#src/skeleton/edit_command_source.js";

export type SpatialSkeletonVector = ArrayLike<number>;

// Provider-specific node state that crosses the worker boundary must remain structured-cloneable.
export type SpatialSkeletonSourceState =
  | null
  | boolean
  | number
  | string
  | readonly SpatialSkeletonSourceState[]
  | { readonly [key: string]: SpatialSkeletonSourceState };

export interface SpatialSkeletonBounds {
  lowerBounds: SpatialSkeletonVector;
  upperBounds: SpatialSkeletonVector;
}

export interface SpatialSkeletonGridCellIndex {
  cell: SpatialSkeletonVector;
}

export interface SpatialSkeletonSpatialIndexLevel {
  chunkSize: SpatialSkeletonVector;
  gridShape: readonly number[];
  limit: number;
}

export interface SpatiallyIndexedSkeletonNodeBase {
  nodeId: number;
  segmentId: number;
  position: SpatialSkeletonVector;
  parentNodeId?: number;
  sourceState?: SpatialSkeletonSourceState;
}

export interface SpatiallyIndexedSkeletonNode
  extends SpatiallyIndexedSkeletonNodeBase {
  radius?: number;
  confidence?: number;
  description?: string;
  isTrueEnd?: boolean;
}

export interface SpatiallyIndexedSkeletonMetadata
  extends SpatialSkeletonBounds {
  spatial: readonly SpatialSkeletonSpatialIndexLevel[];
  readOnly: boolean;
}

export interface SpatialSkeletonConfidenceConfiguration {
  values: readonly number[];
}

export interface SpatiallyIndexedSkeletonSource {
  readonly readOnly: boolean;
  listSkeletons(): Promise<number[]>;
  getSkeleton(
    skeletonId: number,
    options?: { signal?: AbortSignal },
  ): Promise<SpatiallyIndexedSkeletonNode[]>;
  getSpatialIndexMetadata(): Promise<SpatiallyIndexedSkeletonMetadata | null>;
  fetchNodes(
    cellIndex: SpatialSkeletonGridCellIndex,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<SpatiallyIndexedSkeletonNodeBase[]>;
}

export interface EditableSpatiallyIndexedSkeletonSource
  extends SpatiallyIndexedSkeletonSource {
  readonly readOnly: false;
  readonly addNodesCommand: SpatialSkeletonAddNodesCommandFactory;
  readonly deleteNodesCommand: SpatialSkeletonDeleteNodesCommandFactory;
  readonly moveNodesCommand: SpatialSkeletonMoveNodesCommandFactory;
  readonly splitSkeletonsCommand: SpatialSkeletonSplitSkeletonsCommandFactory;
  readonly mergeSkeletonsCommand: SpatialSkeletonMergeSkeletonsCommandFactory;
  readonly insertNodesCommand?: SpatialSkeletonInsertNodesCommandFactory;
  readonly rerootCommand?: SpatialSkeletonRerootCommandFactory;
  readonly editNodeDescriptionCommand?: SpatialSkeletonEditNodeDescriptionCommandFactory;
  readonly editNodeTrueEndCommand?: SpatialSkeletonEditNodeTrueEndCommandFactory;
  readonly editNodeRadiusCommand?: SpatialSkeletonEditNodeRadiusCommandFactory;
  readonly editNodeConfidenceCommand?: SpatialSkeletonEditNodeConfidenceCommandFactory;
  readonly spatialSkeletonConfidenceConfiguration?: SpatialSkeletonConfidenceConfiguration;
}
