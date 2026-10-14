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

import type { CoordinateSpace } from "#src/coordinate_transform.js";
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

// One level is drawn at a time. A skeleton that a level leaves out is not drawn while that level is in use.
export interface SkeletonSpatialIndexLevel {
  // Cell `c` spans `c * chunkSize` to `(c + 1) * chunkSize`, counted from 0, not from the lower bound.
  readonly chunkSize: SkeletonVector;
  // Largest expected node count in one cell. 0 means every node and is allowed only on the finest level.
  readonly limit: number;
}

export interface SpatiallyIndexedSkeletonMetadata {
  readonly coordinateSpace: CoordinateSpace;
  // From coarsest to finest.
  readonly spatial: readonly SkeletonSpatialIndexLevel[];
}

export interface SkeletonConfidenceConfiguration {
  values: readonly number[];
}

export interface SkeletonManifest {
  // Empty when the source has no skeleton with this id.
  // Each key names one read. The source chooses how much of the skeleton one read covers.
  readonly fragmentKeys: readonly string[];
}

export interface SkeletonParentLink {
  readonly nodeId: bigint;
  readonly parentNodeId: bigint;
}

export interface SkeletonFragment {
  // Each node of a skeleton is in exactly one of its fragments.
  // A node's parentNodeId may name a node in another fragment.
  readonly nodes: readonly SkeletonNode[];
  // Parents of nodes in other fragments, for a source that stores an edge with the parent.
  readonly parentLinks?: readonly SkeletonParentLink[];
}

export interface SkeletonFragmentSource {
  readonly readonly: boolean;
  getSkeletonManifest(
    skeletonId: bigint,
    options?: { signal?: AbortSignal },
  ): Promise<SkeletonManifest>;
  getSkeletonFragment(
    skeletonId: bigint,
    fragmentKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<SkeletonFragment>;
}

export interface SpatiallyIndexedSkeletonCellSource {
  // Resolves to [] for an empty or missing cell.
  fetchCell(
    cellGridPosition: Float32Array,
    options: { signal: AbortSignal },
  ): Promise<SkeletonNodeBase[]>;
}

export interface EditableSkeletonSource extends SkeletonFragmentSource {
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
  readonly spatialSkeletonConfidenceConfiguration?: SkeletonConfidenceConfiguration;
}
