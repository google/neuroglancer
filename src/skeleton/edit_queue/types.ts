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

/** State of the local optimistic preview. */
export type SpatialSkeletonPreviewLifecycle =
  | "reserved"
  | "preparing"
  | "exact"
  | "promoted"
  | "rolled-back";

/** State of the corresponding edit request at the authoritative datasource. */
export type SpatialSkeletonAuthorityLifecycle =
  | "queued"
  /** Claimed by the engine but still waiting to cross the commit boundary. */
  | "waiting"
  | "running"
  | "committed"
  | "unchanged"
  | "indeterminate";

/** State of authoritative/local preview reconciliation. */
export type SpatialSkeletonReconciliationLifecycle =
  | "waiting"
  | "not-required"
  | "pending"
  | "applying"
  | "complete"
  | "blocked";

/** State of the command-history transition represented by an intent. */
export type SpatialSkeletonHistoryLifecycle =
  | "staged"
  | "advanced"
  | "rejected";

/** Why authority is known to be unchanged. */
export type SpatialSkeletonAuthorityReason =
  | "not-started"
  | "rejected"
  | "no-op";

/**
 * Datasource-neutral lifecycle of one optimistic logical intent.
 *
 * These axes deliberately remain independent. For example, authority may be
 * committed while reconciliation is still applying.
 */
export interface SpatialSkeletonIntentLifecycle {
  readonly preview: SpatialSkeletonPreviewLifecycle;
  readonly authority: SpatialSkeletonAuthorityLifecycle;
  readonly reconciliation: SpatialSkeletonReconciliationLifecycle;
  readonly history: SpatialSkeletonHistoryLifecycle;
  readonly authorityReason?: SpatialSkeletonAuthorityReason;
}

/** Creates the lifecycle published when an optimistic intent is reserved. */
export function createInitialSpatialSkeletonIntentLifecycle(): SpatialSkeletonIntentLifecycle {
  return {
    preview: "reserved",
    authority: "queued",
    reconciliation: "waiting",
    history: "staged",
  };
}

export interface SpatialSkeletonCommittedSettlement<TResult> {
  readonly outcome: "committed";
  readonly result?: TResult;
}

export interface SpatialSkeletonUnchangedSettlement {
  readonly outcome: "unchanged";
  readonly reason: SpatialSkeletonAuthorityReason;
  readonly error?: unknown;
}

/**
 * Definitive authority settlement of one optimistic logical intent.
 *
 * A reload-required edit request intentionally has no settlement. Its settlement
 * promise remains pending until the page unloads.
 */
export type SpatialSkeletonEditSettlement<TResult = unknown> =
  | SpatialSkeletonCommittedSettlement<TResult>
  | SpatialSkeletonUnchangedSettlement;

export function committedSpatialSkeletonEditSettlement<TResult = unknown>(
  result?: TResult,
): SpatialSkeletonCommittedSettlement<TResult> {
  return result === undefined
    ? { outcome: "committed" }
    : { outcome: "committed", result };
}

export function unchangedSpatialSkeletonEditSettlement(
  reason: SpatialSkeletonAuthorityReason,
  error?: unknown,
): SpatialSkeletonUnchangedSettlement {
  return error === undefined
    ? { outcome: "unchanged", reason }
    : { outcome: "unchanged", reason, error };
}

export const SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON =
  "Reload the page before making more skeleton edits.";

export type SpatialSkeletonReloadRequiredReason =
  | "authority-indeterminate"
  | "committed-local-publication-failed"
  | "local-preview-reset-failed";

/** Immutable, layer-scoped reason that optimistic editing cannot continue. */
export interface SpatialSkeletonReloadRequiredDetails {
  readonly reason: SpatialSkeletonReloadRequiredReason;
  readonly authority: "committed" | "indeterminate" | "unchanged";
  readonly intentId?: number;
  readonly cause?: unknown;
}

export function freezeSpatialSkeletonReloadRequiredDetails(
  state: SpatialSkeletonReloadRequiredDetails,
): SpatialSkeletonReloadRequiredDetails {
  return Object.freeze({ ...state });
}

export class SpatialSkeletonReloadRequiredError extends Error {
  constructor(readonly reloadRequired: SpatialSkeletonReloadRequiredDetails) {
    super(SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON, {
      cause: reloadRequired.cause,
    });
    this.name = "SpatialSkeletonReloadRequiredError";
  }
}

/** Generic engine boundary for a latch owned by one spatial-skeleton edit session. */
export interface SpatialSkeletonReloadRequiredPort {
  get(): SpatialSkeletonReloadRequiredDetails | undefined;
  latch(state: SpatialSkeletonReloadRequiredDetails): boolean;
}

/** Promise returned by an optimistic edit transition. */
export interface SpatialSkeletonEditExecution<
  T = boolean,
  TSettlementResult = unknown,
> extends Promise<T> {
  /**
   * Resolves when the local queue registers the action, before input loading
   * and exact-preview preparation. Admission failures reject this promise.
   */
  readonly acceptedByQueue: Promise<void>;
  /** Resolves only after authority has a definitive, reconciled outcome. */
  readonly settled: Promise<SpatialSkeletonEditSettlement<TSettlementResult>>;
}

export interface SpatialSkeletonUndoRedoControls {
  hasUnconfirmedEdits(): boolean;
  canUndoEdit(): boolean;
  undoLatestEdit(): SpatialSkeletonEditExecution;
  canRedoEdit(): boolean;
  redoLatestEdit(): SpatialSkeletonEditExecution;
}

/**
 * Immutable, datasource-supplied wording for generic authority feedback.
 *
 * The queue owns notification timing and lifecycle observation. A datasource
 * only names its authority and logical operation; it never owns a timer,
 * notification handle, or queue state.
 */
export interface SpatialSkeletonAuthorityLabels {
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

/** A datasource-neutral optimistic queue hosted by a spatial-skeleton edit session. */
export interface SpatialSkeletonSessionEditQueue {
  canUndo(): boolean;
  canRedo(): boolean;
  /** Stops this queue and resolves after started transport is classified. */
  dispose(): Promise<void>;
  hasUnconfirmedActions(): boolean;
  /** Layer-scoped terminal editing state, independent of retained queue rows. */
  getReloadRequired(): SpatialSkeletonReloadRequiredDetails | undefined;
  /**
   * Synchronously stops unsent work when the layer latch was won by another
   * queue instance (for example, a detached predecessor datasource).
   */
  handleReloadRequiredLatched(
    reloadRequired: SpatialSkeletonReloadRequiredDetails,
  ): void;
  /** Complete previewed segments that visual cache eviction must retain. */
  getProtectedPreviewSegmentIds(): readonly bigint[];
  /** True when an ordinary read must update active or retained history state. */
  ownsAuthoritativeReadSegment(segmentId: bigint): boolean;
  undoLatest(): SpatialSkeletonEditExecution;
  redoLatest(): SpatialSkeletonEditExecution;
  getSnapshot(): readonly SpatialSkeletonEditQueueEntry[];
  /** Last terminal actions retained for the user-facing Queue activity list. */
  getRecentActivity(): readonly SpatialSkeletonEditActivityEntry[];
}

/** Minimal queue information intended for the user-facing Queue tab. */
export interface SpatialSkeletonEditQueueEntry {
  /** Distinguishes reused operation ids after a session-owned engine cutover. */
  readonly queueInstanceId?: number;
  readonly operationId?: number;
  readonly kind: string;
  readonly lifecycle: SpatialSkeletonIntentLifecycle;
  readonly intent?: "execute" | "undo" | "redo";
  readonly commandLabel?: string;
  readonly authorityLabels?: SpatialSkeletonAuthorityLabels;
  readonly reason?: string;
  /** Rejection of the failed root intent. */
  readonly error?: unknown;
  /** Defined on the failed root, including zero. */
  readonly canceledLaterIntentCount?: number;
}

export const DEFAULT_SPATIAL_SKELETON_EDIT_QUEUE_CAPACITY = 64;

export type SpatialSkeletonEditActivityStatus =
  | "saved"
  | "not-saved"
  | "reverted";

/** Bounded, non-blocking terminal activity shown separately from queued work. */
export interface SpatialSkeletonEditActivityEntry {
  readonly operationId?: number;
  readonly kind: string;
  readonly status: SpatialSkeletonEditActivityStatus;
  readonly intent?: "execute" | "undo" | "redo";
  readonly commandLabel?: string;
  readonly authorityReason?: SpatialSkeletonAuthorityReason;
  readonly reason?: string;
  readonly canceledLaterIntentCount?: number;
}
