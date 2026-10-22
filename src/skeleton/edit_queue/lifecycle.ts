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

/** State of the local optimistic projection. */
export type SpatialSkeletonOptimisticPreviewLifecycle =
  | "reserved"
  | "preparing"
  | "exact"
  | "promoted"
  | "rolled-back";

/** State of the corresponding mutation at the authoritative datasource. */
export type SpatialSkeletonOptimisticAuthorityLifecycle =
  | "queued"
  /** Claimed by the engine but still waiting to cross the commit boundary. */
  | "waiting"
  | "running"
  | "committed"
  | "unchanged"
  | "indeterminate";

/** State of authoritative/local projection reconciliation. */
export type SpatialSkeletonOptimisticReconciliationLifecycle =
  | "waiting"
  | "not-required"
  | "pending"
  | "applying"
  | "complete"
  | "blocked";

/** State of the command-history transition represented by an intent. */
export type SpatialSkeletonOptimisticHistoryLifecycle =
  | "staged"
  | "advanced"
  | "rejected";

/** Why authority is known to be unchanged. */
export type SpatialSkeletonOptimisticAuthorityReason =
  | "not-started"
  | "rejected"
  | "no-op";

/**
 * Datasource-neutral lifecycle of one optimistic logical intent.
 *
 * These axes deliberately remain independent. For example, authority may be
 * committed while reconciliation is still applying.
 */
export interface SpatialSkeletonOptimisticIntentLifecycle {
  readonly preview: SpatialSkeletonOptimisticPreviewLifecycle;
  readonly authority: SpatialSkeletonOptimisticAuthorityLifecycle;
  readonly reconciliation: SpatialSkeletonOptimisticReconciliationLifecycle;
  readonly history: SpatialSkeletonOptimisticHistoryLifecycle;
  readonly authorityReason?: SpatialSkeletonOptimisticAuthorityReason;
}

/** Creates the lifecycle published when an optimistic intent is reserved. */
export function createInitialSpatialSkeletonOptimisticIntentLifecycle(): SpatialSkeletonOptimisticIntentLifecycle {
  return {
    preview: "reserved",
    authority: "queued",
    reconciliation: "waiting",
    history: "staged",
  };
}

export interface SpatialSkeletonOptimisticCommittedSettlement<TResult> {
  readonly outcome: "committed";
  readonly result?: TResult;
}

export interface SpatialSkeletonOptimisticUnchangedSettlement {
  readonly outcome: "unchanged";
  readonly reason: SpatialSkeletonOptimisticAuthorityReason;
  readonly error?: unknown;
}

/**
 * Definitive authority settlement of one optimistic logical intent.
 *
 * A reload-required mutation intentionally has no settlement. Its settlement
 * promise remains pending until the page unloads.
 */
export type SpatialSkeletonOptimisticEditSettlement<TResult = unknown> =
  | SpatialSkeletonOptimisticCommittedSettlement<TResult>
  | SpatialSkeletonOptimisticUnchangedSettlement;

export function committedSpatialSkeletonOptimisticEditSettlement<
  TResult = unknown,
>(result?: TResult): SpatialSkeletonOptimisticCommittedSettlement<TResult> {
  return result === undefined
    ? { outcome: "committed" }
    : { outcome: "committed", result };
}

export function unchangedSpatialSkeletonOptimisticEditSettlement(
  reason: SpatialSkeletonOptimisticAuthorityReason,
  error?: unknown,
): SpatialSkeletonOptimisticUnchangedSettlement {
  return error === undefined
    ? { outcome: "unchanged", reason }
    : { outcome: "unchanged", reason, error };
}
