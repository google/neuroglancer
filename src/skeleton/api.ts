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

/**
 * @file Defines the contract of a skeleton datasource: nodes, edges, fragment
 * and spatial index reads, and the edit command factories of an editable
 * source.
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
} from "#src/skeleton/edit_commands.js";
import type { SpatialSkeletonEditPlannerProvider } from "#src/skeleton/edit_queue/api.js";

// One number per dimension of the model space, in its units, such as a position or a chunk size.
export type SkeletonVector = ArrayLike<number>;
// Keyed by vertex attribute id. Each value has one number per component.
export type SkeletonNodeAttributes = Readonly<
  Record<string, ArrayLike<number>>
>;

export enum KnownSkeletonNodeAttribute {
  RADIUS = "radius",
  CONFIDENCE_PERCENT = "confidence",
  // On a leaf where the branch is confirmed to end.
  IS_TRUE_END = "true_end",
}

export interface SkeletonNode {
  readonly nodeId: bigint;
  readonly segmentId: bigint;
  readonly position: SkeletonVector;
  readonly parentNodeId?: bigint;
  readonly attributes?: SkeletonNodeAttributes;
  readonly description?: string;
}

export enum SkeletonEdgeDirection {
  CHILD_TO_PARENT,
  PARENT_TO_CHILD,
  // Parents are inferred from the whole skeleton.
  UNDIRECTED,
}

export interface SkeletonEdge {
  readonly firstNodeId: bigint;
  readonly secondNodeId: bigint;
}

export interface SkeletonSpatialIndexLevel {
  // Chunk `c` spans `c * chunkSize` to `(c + 1) * chunkSize`, counted from 0, not from the lower bound.
  readonly chunkSize: SkeletonVector;
  // Largest expected node count in one chunk. 0 means every node and is allowed only on the finest level.
  readonly limit: number;
}

export interface SkeletonSpatialIndexMetadata {
  // Rank 3, with finite bounds. The bounds set the extent of the chunk grid.
  readonly modelSpace: CoordinateSpace;
  // Must be provided from coarsest to finest.
  readonly levels: readonly SkeletonSpatialIndexLevel[];
}

export interface SkeletonManifest {
  // Each key names one read. The source chooses how much of the skeleton one read covers.
  // A missing skeleton may have keys whose fragments have no nodes.
  readonly fragmentKeys: readonly string[];
}

export type SkeletonFragmentNode = Omit<SkeletonNode, "parentNodeId">;

export interface SkeletonFragment {
  // Each node of a skeleton is in exactly one of its fragments.
  readonly nodes: readonly SkeletonFragmentNode[];
  // Each edge is in exactly one fragment.
  // An edge's endpoints may be in other fragments.
  readonly edges: readonly SkeletonEdge[];
}

export interface SkeletonFragmentSource {
  readonly edgeDirection: SkeletonEdgeDirection;
  getSkeletonManifest(
    segmentId: bigint,
    signal: AbortSignal,
  ): Promise<SkeletonManifest>;
  getSkeletonFragment(
    segmentId: bigint,
    fragmentKey: string,
    signal: AbortSignal,
  ): Promise<SkeletonFragment>;
}

export interface SkeletonSpatialIndexSource {
  // Resolves to [] for an empty or missing chunk.
  downloadChunk(
    chunkGridPosition: SkeletonVector,
    signal: AbortSignal,
  ): Promise<SkeletonNode[]>;
}

export interface EditableSkeletonSource extends SkeletonFragmentSource {
  readonly editPlannerProvider: SpatialSkeletonEditPlannerProvider;
  readonly addNodesCommand: SpatialSkeletonAddNodesCommandFactory;
  readonly moveNodesCommand: SpatialSkeletonMoveNodesCommandFactory;
  readonly deleteNodesCommand: SpatialSkeletonDeleteNodesCommandFactory;
  readonly splitSkeletonsCommand: SpatialSkeletonSplitSkeletonsCommandFactory;
  readonly mergeSkeletonsCommand: SpatialSkeletonMergeSkeletonsCommandFactory;
  readonly insertNodesCommand?: SpatialSkeletonInsertNodesCommandFactory;
  readonly rerootCommand?: SpatialSkeletonRerootCommandFactory;
  readonly editNodeDescriptionCommand?: SpatialSkeletonEditNodeDescriptionCommandFactory;
  readonly editNodeTrueEndCommand?: SpatialSkeletonEditNodeTrueEndCommandFactory;
  readonly editNodeRadiusCommand?: SpatialSkeletonEditNodeRadiusCommandFactory;
  readonly editNodeConfidenceCommand?: SpatialSkeletonEditNodeConfidenceCommandFactory;
  // The only confidence values the source can store. Without it, any value from 0 to 100.
  readonly confidenceValues?: readonly number[];
}
