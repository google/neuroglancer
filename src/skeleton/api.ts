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
export type SkeletonNodeAttributes = Readonly<
  Record<string, ArrayLike<number>>
>;

/**
 * Vertex attribute ids that have a defined meaning. A source may also have attributes with other ids.
 **/
export enum SkeletonNodeAttribute {
  RADIUS = "radius",
  // As a percent, from 0 to 100.
  CONFIDENCE = "confidence",
  // Non-zero on a leaf that marks where the branch is confirmed to end
  // primarily used to track tracing review progress
  TRUE_END = "true_end",
}

export interface SkeletonNode {
  nodeId: bigint;
  segmentId: bigint;
  position: SkeletonVector;
  parentNodeId?: bigint;
  attributes?: SkeletonNodeAttributes;
  description?: string;
}

export interface SkeletonEdge {
  readonly parentNodeId: bigint;
  readonly childNodeId: bigint;
}

export interface SkeletonSpatialIndexLevel {
  // Cell `c` spans `c * chunkSize` to `(c + 1) * chunkSize`, counted from 0, not from the lower bound.
  readonly chunkSize: SkeletonVector;
  // Largest expected node count in one cell. 0 means every node and is allowed only on the finest level.
  readonly limit: number;
}

export interface SpatiallyIndexedSkeletonMetadata {
  // Its bounds must be finite. They set the extent of the cell grid.
  readonly coordinateSpace: CoordinateSpace;
  // Must be provided from coarsest to finest.
  readonly spatial: readonly SkeletonSpatialIndexLevel[];
}

export interface SkeletonManifest {
  // Empty when the source has no skeleton with this id.
  // Each key names one read. The source chooses how much of the skeleton one read covers.
  readonly fragmentKeys: readonly string[];
}

export interface SkeletonFragment {
  // Each node of a skeleton is in exactly one of its fragments.
  // A node's optional parentNodeId may name a node in another fragment.
  readonly nodes: readonly SkeletonNode[];
  readonly crossFragmentEdges?: readonly SkeletonEdge[];
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
  ): Promise<SkeletonNode[]>;
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
  // The only confidence values the source can store. Without it, any value from 0 to 100.
  readonly confidenceValues?: readonly number[];
}
