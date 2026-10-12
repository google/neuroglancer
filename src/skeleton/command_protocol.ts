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

import type { CompleteSkeletonSnapshotHandle } from "#src/skeleton/complete_skeleton_snapshot.js";
import type { SpatialSkeletonOptimisticIdentityService } from "#src/skeleton/optimistic_edit/api.js";

export const SpatialSkeletonActions = {
  inspect: "inspectSkeletons",
  addNodes: "addNodes",
  insertNodes: "insertNodes",
  moveNodes: "moveNodes",
  deleteNodes: "deleteNodes",
  reroot: "rerootSkeletons",
  editNodeDescription: "editNodeDescription",
  editNodeTrueEnd: "editNodeTrueEnd",
  editNodeRadius: "editNodeRadius",
  editNodeConfidence: "editNodeConfidence",
  mergeSkeletons: "mergeSkeletons",
  splitSkeletons: "splitSkeletons",
} as const;

export type SpatialSkeletonAction =
  (typeof SpatialSkeletonActions)[keyof typeof SpatialSkeletonActions];

/**
 * A complete-snapshot endpoint required before a new edit enters the queue.
 * The snapshot must contain nodeId when one is specified.
 *
 * Identifiers are resolved by the caller before this requirement is passed to
 * the spatial-skeleton state.  In particular, the state validates only the
 * current physical segment and node ids and has no dependency on a
 * datasource's identifier mapping strategy.
 */
export interface SpatialSkeletonQueueInputRequirement {
  readonly segmentId: number;
  readonly nodeId?: number;
}

/**
 * Complete-snapshot requirements for preparing a queued Execute intent.
 *
 * Inputs in `required` must already be cached. Inputs in `loadable` may be
 * fetched during Preparing. Both groups must be complete before exact preview.
 */
export interface SpatialSkeletonQueueInputRequirements {
  readonly required: readonly SpatialSkeletonQueueInputRequirement[];
  readonly loadable?: readonly SpatialSkeletonQueueInputRequirement[];
}

/** One complete, revision-fenced input acquired for an Execute intent. */
export interface SpatialSkeletonQueueSegmentInput {
  readonly segmentId: number;
  readonly snapshot: CompleteSkeletonSnapshotHandle;
  readonly cacheRevision: number;
}

/**
 * Complete snapshots and cache revisions supplied to the queue for Execute.
 * Segment records are deduplicated in the command's queue-input requirement order.
 */
export interface SpatialSkeletonQueueInput {
  readonly segments: readonly SpatialSkeletonQueueSegmentInput[];
}

/** Inputs acquired inside the queue's Preparing phase, pinned until publication. */
export interface SpatialSkeletonPreparedQueueInput {
  readonly input: SpatialSkeletonQueueInput;
  assertCurrent(): void;
  release(): void;
}

/** Reusable input policy retained with the original intent for an unprepared Redo. */
export interface SpatialSkeletonQueueInputPreparation {
  /** Current physical inputs that a live intent protects from visual eviction. */
  getProtectedSegmentIds(): readonly number[];

  /** Synchronous inspection gate and admission-lifetime cache retention. */
  validate(intent: "execute" | "redo"): () => void;
  acquire(
    signal: AbortSignal,
    intent: "execute" | "redo",
  ):
    | SpatialSkeletonPreparedQueueInput
    | Promise<SpatialSkeletonPreparedQueueInput>;
}

export const SpatialSkeletonHistoryActions = {
  undo: "undo",
  redo: "redo",
} as const;

export type SpatialSkeletonErrorAction =
  | SpatialSkeletonAction
  | (typeof SpatialSkeletonHistoryActions)[keyof typeof SpatialSkeletonHistoryActions];

export const DEFAULT_SPATIAL_SKELETON_EDIT_ACTIONS = [
  SpatialSkeletonActions.addNodes,
  SpatialSkeletonActions.moveNodes,
  SpatialSkeletonActions.deleteNodes,
] as const satisfies readonly SpatialSkeletonAction[];

export function isSpatialSkeletonEditAction(action: SpatialSkeletonAction) {
  return action !== SpatialSkeletonActions.inspect;
}

export function getSpatialSkeletonActionSupportLabel(
  action: SpatialSkeletonAction,
) {
  switch (action) {
    case SpatialSkeletonActions.inspect:
      return "full skeleton inspection";
    case SpatialSkeletonActions.addNodes:
      return "node creation";
    case SpatialSkeletonActions.insertNodes:
      return "node insertion";
    case SpatialSkeletonActions.moveNodes:
      return "node movement";
    case SpatialSkeletonActions.deleteNodes:
      return "node deletion";
    case SpatialSkeletonActions.reroot:
      return "skeleton rerooting";
    case SpatialSkeletonActions.editNodeDescription:
      return "node description editing";
    case SpatialSkeletonActions.editNodeTrueEnd:
      return "node true-end editing";
    case SpatialSkeletonActions.editNodeRadius:
      return "node radius editing";
    case SpatialSkeletonActions.editNodeConfidence:
      return "node confidence editing";
    case SpatialSkeletonActions.mergeSkeletons:
      return "skeleton merging";
    case SpatialSkeletonActions.splitSkeletons:
      return "skeleton splitting";
  }
}

export interface SpatialSkeletonCommandContext {
  readonly identities: SpatialSkeletonOptimisticIdentityService;
}

/**
 * Immutable user intent passed from a datasource command factory to the
 * state-owned queue engine.  It describes what to do; it cannot execute or
 * mutate history by itself.
 */
export interface SpatialSkeletonEditCommand<TPayload = unknown> {
  readonly action: SpatialSkeletonAction;
  readonly label: string;
  readonly payload: TPayload;
  /**
   * Declares the complete projected snapshots required before a new Execute
   * intent may be admitted. Undo and Redo use retained history state directly.
   * Return `{ required: [] }` when no existing snapshot is required.
   */
  getQueueInputRequirements(
    context: SpatialSkeletonCommandContext,
  ): SpatialSkeletonQueueInputRequirements;
}
