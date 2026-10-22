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

export const SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON =
  "Reload the page before making more skeleton edits.";

export type SpatialSkeletonOptimisticFatalReason =
  | "authority-indeterminate"
  | "committed-local-publication-failed"
  | "local-projection-reset-failed";

/** Immutable, layer-scoped reason that optimistic editing cannot continue. */
export interface SpatialSkeletonOptimisticFatalState {
  readonly reason: SpatialSkeletonOptimisticFatalReason;
  readonly authority: "committed" | "indeterminate" | "unchanged";
  readonly intentId?: number;
  readonly cause?: unknown;
}

export function freezeSpatialSkeletonOptimisticFatalState(
  state: SpatialSkeletonOptimisticFatalState,
): SpatialSkeletonOptimisticFatalState {
  return Object.freeze({ ...state });
}

export class SpatialSkeletonOptimisticReloadRequiredError extends Error {
  constructor(readonly fatalState: SpatialSkeletonOptimisticFatalState) {
    super(SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON, {
      cause: fatalState.cause,
    });
    this.name = "SpatialSkeletonOptimisticReloadRequiredError";
  }
}

/** Generic engine boundary for a latch owned by one spatial-skeleton state. */
export interface SpatialSkeletonOptimisticFatalStatePort {
  get(): SpatialSkeletonOptimisticFatalState | undefined;
  latch(state: SpatialSkeletonOptimisticFatalState): boolean;
}

/** Promise returned by an optimistic edit transition. */
export interface SpatialSkeletonOptimisticEditExecution<
  T = boolean,
  TSettlementResult = unknown,
> extends Promise<T> {
  /**
   * Resolves when the local queue registers the action, before input loading
   * and exact-preview preparation. Admission failures reject this promise.
   */
  readonly acceptedByQueue: Promise<void>;
  /** Resolves only after authority has a definitive, reconciled outcome. */
  readonly settled: Promise<
    SpatialSkeletonOptimisticEditSettlement<TSettlementResult>
  >;
}

export interface SpatialSkeletonOptimisticEditState {
  hasUnconfirmedOptimisticEdits(): boolean;
  canUndoOptimisticEdit(): boolean;
  undoLatestOptimisticEdit(): SpatialSkeletonOptimisticEditExecution;
  canRedoOptimisticEdit(): boolean;
  redoLatestOptimisticEdit(): SpatialSkeletonOptimisticEditExecution;
}

/**
 * Immutable, datasource-supplied wording for generic authority feedback.
 *
 * The queue owns notification timing and lifecycle observation. A datasource
 * only names its authority and logical operation; it never owns a timer,
 * notification handle, or queue state.
 */
export interface SpatialSkeletonOptimisticAuthorityPresentation {
  /** User-facing authority name, for example `CATMAID`. */
  readonly authorityLabel: string;
  /** User-facing operation noun, for example `node creation`. */
  readonly operationNoun: string;
  /** Optional diagnostic warning shown while authority remains in flight. */
  readonly stalledWarning?: {
    readonly delayMs: number;
    readonly message: string;
  };
}

/** A datasource-neutral optimistic queue hosted by spatial-skeleton state. */
export interface SpatialSkeletonOptimisticEditQueue {
  canUndo(): boolean;
  canRedo(): boolean;
  /** Stops this queue and resolves after started transport is classified. */
  dispose(): Promise<void>;
  hasUnconfirmedActions(): boolean;
  /** Layer-scoped terminal editing state, independent of retained queue rows. */
  getFatalState(): SpatialSkeletonOptimisticFatalState | undefined;
  /**
   * Synchronously stops unsent work when the layer latch was won by another
   * queue instance (for example, a detached predecessor datasource).
   */
  handleFatalStateLatched(
    fatalState: SpatialSkeletonOptimisticFatalState,
  ): void;
  /** Complete projected segments that visual cache eviction must retain. */
  getProtectedProjectionSegmentIds(): readonly bigint[];
  /** True when an ordinary read must update active or retained history state. */
  ownsAuthoritativeReadSegment(segmentId: bigint): boolean;
  undoLatest(): SpatialSkeletonOptimisticEditExecution;
  redoLatest(): SpatialSkeletonOptimisticEditExecution;
  getSnapshot(): readonly SpatialSkeletonOptimisticEditQueueEntry[];
  /** Last terminal actions retained for the user-facing Queue activity list. */
  getRecentActivity(): readonly SpatialSkeletonOptimisticEditActivityEntry[];
}

/** Minimal queue information intended for the user-facing Queue tab. */
export interface SpatialSkeletonOptimisticEditQueueEntry {
  /** Distinguishes reused operation ids after a state-owned engine cutover. */
  readonly queueInstanceId?: number;
  readonly operationId?: number;
  readonly kind: string;
  readonly lifecycle: SpatialSkeletonOptimisticIntentLifecycle;
  readonly intent?: "execute" | "undo" | "redo";
  readonly commandLabel?: string;
  readonly authorityPresentation?: SpatialSkeletonOptimisticAuthorityPresentation;
  readonly reason?: string;
  /** Rejection of the failed root intent. */
  readonly error?: unknown;
  /** Defined on the failed root, including zero. */
  readonly canceledLaterIntentCount?: number;
}

export const DEFAULT_SPATIAL_SKELETON_OPTIMISTIC_EDIT_QUEUE_CAPACITY = 64;

export type SpatialSkeletonOptimisticEditActivityStatus =
  | "saved"
  | "not-saved"
  | "reverted";

/** Bounded, non-blocking terminal activity shown separately from queued work. */
export interface SpatialSkeletonOptimisticEditActivityEntry {
  readonly operationId?: number;
  readonly kind: string;
  readonly status: SpatialSkeletonOptimisticEditActivityStatus;
  readonly intent?: "execute" | "undo" | "redo";
  readonly commandLabel?: string;
  readonly authorityReason?: SpatialSkeletonOptimisticAuthorityReason;
  readonly reason?: string;
  readonly canceledLaterIntentCount?: number;
}
