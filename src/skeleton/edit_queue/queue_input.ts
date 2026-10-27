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
 * @file Describes the complete skeletons that an Execute or Redo intent needs
 * before it is planned, with the port that acquires and pins them.
 */

import type { CompleteSkeleton } from "#src/skeleton/edit_queue/complete_skeleton.js";

/**
 * A complete-snapshot endpoint required before a new edit enters the queue.
 * The snapshot must contain nodeId when one is specified.
 *
 * Identifiers are resolved by the caller before this requirement is passed to
 * the spatial-skeleton edit session.  In particular, the edit session validates only the
 * current physical segment and node ids and has no dependency on a
 * datasource's identifier mapping strategy.
 */
export interface SpatialSkeletonQueueInputRequirement {
  readonly segmentId: bigint;
  readonly nodeId?: bigint;
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
  readonly segmentId: bigint;
  readonly snapshot: CompleteSkeleton;
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
  getProtectedSegmentIds(): readonly bigint[];

  /** Synchronous inspection gate and admission-lifetime cache retention. */
  validate(intent: "execute" | "redo"): () => void;
  acquire(
    signal: AbortSignal,
    intent: "execute" | "redo",
  ):
    | SpatialSkeletonPreparedQueueInput
    | Promise<SpatialSkeletonPreparedQueueInput>;
}
