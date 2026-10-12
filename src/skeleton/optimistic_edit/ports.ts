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

import type { SpatialSkeletonQueueInput } from "#src/skeleton/command_protocol.js";
import type {
  SpatialSkeletonLogicalNodeHandle,
  SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import type {
  SpatialSkeletonMutationContext,
  SpatialSkeletonMutationIntent,
} from "#src/skeleton/optimistic_edit/api.js";
import type { SpatialSkeletonOptimisticAuthorityPresentation } from "#src/skeleton/optimistic_edit/types.js";
import type {
  SpatialSkeletonCommittedMutationAttempt,
  SpatialSkeletonIntentResource,
} from "#src/skeleton/spatial_skeleton_intent_journal.js";

export interface SpatialSkeletonOptimisticPreparationDescriptor {
  readonly kind: "merge" | "split" | "delete" | "restore" | "reroot";
  readonly logicalNodeHandles?: readonly SpatialSkeletonLogicalNodeHandle[];
  readonly logicalSegmentHandles?: readonly SpatialSkeletonLogicalSegmentHandle[];
  readonly segmentIds?: readonly number[];
  readonly nodeId?: number;
  readonly endpointNodeIds?: readonly number[];
  readonly cutNodeId?: number;
  readonly cutParentNodeId?: number;
  readonly rootNodeId?: number;
  readonly pathNodeIds?: readonly number[];
  readonly lastKnownPositions?: readonly {
    readonly nodeId: number;
    readonly position: ArrayLike<number>;
  }[];
}

/** State-owned preparation presentation; datasource drivers only describe it. */
export interface SpatialSkeletonOptimisticPreparationPort {
  publish(
    intentId: number,
    intent: "execute" | "undo" | "redo",
    descriptor: SpatialSkeletonOptimisticPreparationDescriptor,
  ): void;
  remove(intentId: number): void;
}

/** Immutable intent presentation available before complete inputs are acquired. */
export interface SpatialSkeletonIntentDescription {
  readonly kind: string;
  readonly commandLabel?: string;
  /** Immutable wording only; generic queue/UI code owns all feedback state. */
  readonly authorityPresentation?: SpatialSkeletonOptimisticAuthorityPresentation;
  readonly preparation?: SpatialSkeletonOptimisticPreparationDescriptor;
}

export interface SpatialSkeletonLogicalIntent<TWorkflow, TProjection>
  extends SpatialSkeletonIntentDescription {
  readonly logicalResources: readonly SpatialSkeletonIntentResource[];
  readonly semanticDependencies?: readonly number[];
  /**
   * Immutable exact-preview recipe derived only from complete ordered inputs.  It is engine-owned alongside the datasource workflow rather
   * than embedded in provider workflow state.
   */
  readonly projection: TProjection;
  readonly workflow: TWorkflow;
}

export interface SpatialSkeletonIntentDriverContext {
  readonly intentId: number;
  readonly intent: SpatialSkeletonMutationIntent;
}

/**
 * Exact projection recipe retained by the engine for the lifetime of the
 * corresponding command-history entry.  Undo/redo drivers can use this
 * without maintaining a datasource-owned mirror of optimistic history.
 */
export interface SpatialSkeletonProjectionHistoryRecipe<
  TWorkflow,
  TProjection,
  TInverseProjection = TProjection,
> {
  /** Datasource recipe retained by the canonical engine intent record. */
  readonly workflow: TWorkflow;
  readonly projection: TProjection;
  /** May be absent only for a coalesced Execute/Undo before exact reduction. */
  readonly inverseProjection?: TInverseProjection;
}

export interface SpatialSkeletonExecuteIntentCreationContext {
  readonly intentId: number;
  readonly intent: "execute";
  /** Exact, generic snapshots pinned through exact-preview preparation. */
  readonly queueInput: SpatialSkeletonQueueInput;
}

export interface SpatialSkeletonHistoryIntentCreationContext<
  TWorkflow,
  TProjection,
  TInverseProjection = TProjection,
> {
  readonly intentId: number;
  readonly intent: "undo" | "redo";
  /** One exact recipe selected and resolved by the generic engine. */
  readonly recipe: SpatialSkeletonProjectionHistoryRecipe<
    TWorkflow,
    TProjection,
    TInverseProjection
  >;
}

/** Context available while a driver describes a logical intent. */
export type SpatialSkeletonIntentCreationContext<
  TWorkflow,
  TProjection,
  TInverseProjection = TProjection,
> =
  | SpatialSkeletonExecuteIntentCreationContext
  | SpatialSkeletonHistoryIntentCreationContext<
      TWorkflow,
      TProjection,
      TInverseProjection
    >;

export interface SpatialSkeletonMutationWorkflowContext<
  TMutation = unknown,
  TResult = unknown,
> extends SpatialSkeletonIntentDriverContext {
  /** Frozen journal snapshot of every authority-confirmed physical step. */
  readonly committedAttempts: readonly Readonly<
    SpatialSkeletonCommittedMutationAttempt<TMutation, TResult>
  >[];
}

export interface SpatialSkeletonMutationAttempt<TMutation> {
  /**
   * Materializes authoritative identities after the scheduler owns the lease
   * and immediately before the adapter transport boundary.
   */
  readonly materializeMutation: (
    context: SpatialSkeletonMutationMaterializationContext,
  ) => TMutation | Promise<TMutation>;
}

export type SpatialSkeletonMutationMaterializationContext =
  SpatialSkeletonMutationContext;

/** Provider workflow boundary for one logical optimistic intent. */
export interface SpatialSkeletonIntentDriver<
  TInput,
  TWorkflow,
  TProjection,
  TMutation,
  TResult,
  TReconciliation,
  TInverseProjection = TProjection,
> {
  /** Describes a complete user intent without fetching or reading topology. */
  describeIntent(input: TInput): SpatialSkeletonIntentDescription;

  /** Creates the exact recipe from complete inputs acquired inside the queue. */
  createLogicalIntent(
    input: TInput,
    context: SpatialSkeletonIntentCreationContext<
      TWorkflow,
      TProjection,
      TInverseProjection
    >,
  ): SpatialSkeletonLogicalIntent<TWorkflow, TProjection>;

  /**
   * Produces the next immutable physical-attempt recipe. Authoritative identity
   * resolution belongs exclusively in the returned under-lease materializer.
   * Every returned step must succeed before the exact preview can be confirmed.
   */
  nextAttempt(
    workflow: TWorkflow,
    context: SpatialSkeletonMutationWorkflowContext<TMutation, TResult>,
  ):
    | SpatialSkeletonMutationAttempt<TMutation>
    | undefined
    | Promise<SpatialSkeletonMutationAttempt<TMutation> | undefined>;

  /** Creates the provider's opaque authoritative publication value. */
  createReconciliation(
    workflow: TWorkflow,
    context: SpatialSkeletonMutationWorkflowContext<TMutation, TResult>,
  ): TReconciliation | Promise<TReconciliation>;
}

export interface SpatialSkeletonProjectionIntentArtifact<
  TProjection,
  TInverseProjection = TProjection,
> {
  readonly intentId: number;
  readonly projection: TProjection;
  readonly inverseProjection: TInverseProjection;
}

/**
 * Complete exact artifacts for the active intents after one projection
 * publication has been adopted.  A refold may retain the forward projection
 * while deriving a different inverse against newer retained history state.
 */
export type SpatialSkeletonProjectionArtifactsListener<
  TProjection,
  TInverseProjection = TProjection,
> = (
  artifacts: readonly SpatialSkeletonProjectionIntentArtifact<
    TProjection,
    TInverseProjection
  >[],
) => void;

export interface SpatialSkeletonPreparedProjection<
  TProjection,
  TInverseProjection = TProjection,
> {
  readonly projection: TProjection;
  readonly inverseProjection: TInverseProjection;
}

export interface SpatialSkeletonProjectionRollbackReplayRequest<
  TProjection,
  TInverseProjection = TProjection,
> {
  readonly rollbackIntents: readonly SpatialSkeletonProjectionIntentArtifact<
    TProjection,
    TInverseProjection
  >[];
  readonly replayIntents: readonly SpatialSkeletonProjectionIntentArtifact<
    TProjection,
    TInverseProjection
  >[];
}

export interface SpatialSkeletonAuthoritativePublication<
  TProjection,
  TReconciliation,
  TInverseProjection = TProjection,
> {
  readonly intentId: number;
  readonly reconciliation: TReconciliation;
  readonly activePreviews: readonly SpatialSkeletonProjectionIntentArtifact<
    TProjection,
    TInverseProjection
  >[];
  /**
   * Rebuilds queued history from the finalized action and earlier refolded
   * artifacts, before reducing its preview. Must not publish or mutate history.
   */
  readonly rebaseActivePreview?: (
    intentId: number,
    precedingArtifacts: readonly SpatialSkeletonProjectionIntentArtifact<
      TProjection,
      TInverseProjection
    >[],
  ) => TProjection | undefined;
}

/** Failure-atomic provider projection boundary. */
export interface SpatialSkeletonOptimisticProjectionPort<
  TProjection,
  TReconciliation,
  TInverseProjection = TProjection,
> {
  /**
   * Observes the exact active artifacts after each successful adoption.
   * Listener failures are reporting-only and must never roll back adoption.
   */
  subscribeProjectionArtifacts(
    listener: SpatialSkeletonProjectionArtifactsListener<
      TProjection,
      TInverseProjection
    >,
  ): () => void;
  /**
   * Applies/finalizes the driver's opaque projection and captures its exact
   * inverse against the pre-publication state.
   */
  prepareExact(
    intentId: number,
    projection: TProjection,
  ):
    | SpatialSkeletonPreparedProjection<TProjection, TInverseProjection>
    | Promise<
        SpatialSkeletonPreparedProjection<TProjection, TInverseProjection>
      >;
  /** Drops an off-screen candidate that will never be adopted. */
  discardPrepared(intentId: number): void;
  /** Synchronously publishes the exact projection returned by `prepareExact`. */
  publishExact(intentId: number, projection: TProjection): void;
  /** Atomically removes a closure and replays the explicitly listed survivors. */
  rollbackAndReplay(
    request: SpatialSkeletonProjectionRollbackReplayRequest<
      TProjection,
      TInverseProjection
    >,
  ): void;
  /** Atomically publishes authority, mappings/baselines, and active previews. */
  publishAuthoritative(
    publication: SpatialSkeletonAuthoritativePublication<
      TProjection,
      TReconciliation,
      TInverseProjection
    >,
  ): SpatialSkeletonProjectionIntentArtifact<TProjection, TInverseProjection>;
  /** Updates the bounded history-owned baseline after history replay changes. */
  setRetainedHistoryProjections(projections: readonly TProjection[]): void;
  /** True when an ordinary read must be folded into active/history state. */
  ownsAuthoritativeReadSegment(segmentId: number): boolean;
  getProtectedSegmentIds(): readonly number[];
}

/** Narrow command-history boundary; datasource drivers never receive it. */
export interface SpatialSkeletonOptimisticHistoryPort<TInput, THistoryTicket> {
  readonly capacity: number;
  stageExecute(input: TInput): THistoryTicket;
  stageUndo(): THistoryTicket | undefined;
  stageRedo(): THistoryTicket | undefined;
  getTicketId(ticket: THistoryTicket): string | number;
  getEntryId(ticket: THistoryTicket): string | number;
  /** Transition-ticket dependencies computed by projected history replay. */
  getSemanticDependencyTicketIds(
    ticket: THistoryTicket,
  ): readonly (string | number)[];
  /** Advances the confirmed prefix. A discarded ticket is a no-op. */
  confirm(ticket: THistoryTicket): void;
  /** Abandons only the latest transition after synchronous admission failure. */
  abandonLatest(ticket: THistoryTicket): void;
  /** Restores history before this staged ticket, discarding its whole suffix. */
  rollbackFrom(ticket: THistoryTicket): void;
  /** Drops the complete layer Undo/Redo state on fatal recovery or source change. */
  reset(): void;
  canStage(intent: "undo" | "redo"): boolean;
  /** History exposes only the selected canonical entry id, never its recipe. */
  getProjectedEntryId(intent: "undo" | "redo"): string | number | undefined;
  /** Canonical entry ids retained across confirmed, projected, and staged state. */
  getRetainedEntryIds(): readonly (string | number)[];
}
