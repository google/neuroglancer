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
 * @file Defines the planner, edit request adapter, preview, history and
 * identity contracts that connect the generic edit queue to a datasource.
 */

import type { EditableSkeletonSource } from "#src/skeleton/api.js";
import type { SpatialSkeletonEditCommand } from "#src/skeleton/edit_commands.js";
import type { SpatialSkeletonEditInverseDelta } from "#src/skeleton/edit_queue/complete_skeleton_edits.js";
import type {
  SpatialSkeletonCommittedEditRequestAttempt,
  SpatialSkeletonIntentResource,
} from "#src/skeleton/edit_queue/edit_intent_journal.js";
import type {
  SpatialSkeletonAuthoritativeReconciliation,
  SpatialSkeletonPreviewIntentDelta,
} from "#src/skeleton/edit_queue/preview.js";
import type { SpatialSkeletonQueueInput } from "#src/skeleton/edit_queue/queue_input.js";
import type {
  SpatialSkeletonStableIdMappingResolution,
  SpatialSkeletonStableNodeHandle,
  SpatialSkeletonStableSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import type { SpatialSkeletonAuthorityLabels } from "#src/skeleton/edit_queue/types.js";

export interface SpatialSkeletonPendingEditDescriptor {
  readonly kind: "merge" | "split" | "delete" | "restore" | "reroot";
  readonly stableNodeHandles?: readonly SpatialSkeletonStableNodeHandle[];
  readonly stableSegmentHandles?: readonly SpatialSkeletonStableSegmentHandle[];
  readonly segmentIds?: readonly bigint[];
  readonly nodeId?: bigint;
  readonly endpointNodeIds?: readonly bigint[];
  readonly cutNodeId?: bigint;
  readonly cutParentNodeId?: bigint;
  readonly rootNodeId?: bigint;
  readonly pathNodeIds?: readonly bigint[];
  readonly lastKnownPositions?: readonly {
    readonly nodeId: bigint;
    readonly position: ArrayLike<number>;
  }[];
}

/** Session-owned preparation presentation; datasource planners only describe it. */
export interface SpatialSkeletonPendingEditPort {
  publish(
    intentId: number,
    intent: "execute" | "undo" | "redo",
    descriptor: SpatialSkeletonPendingEditDescriptor,
  ): void;
  remove(intentId: number): void;
}

/** Immutable intent presentation available before complete inputs are acquired. */
export interface SpatialSkeletonIntentDescription {
  readonly kind: string;
  readonly commandLabel?: string;
  /** Immutable wording only; generic queue/UI code owns all feedback state. */
  readonly authorityLabels?: SpatialSkeletonAuthorityLabels;
  readonly pendingEdit?: SpatialSkeletonPendingEditDescriptor;
}

export interface SpatialSkeletonIntentPlan<TPlan, TPreview>
  extends SpatialSkeletonIntentDescription {
  readonly stableResources: readonly SpatialSkeletonIntentResource[];
  readonly semanticDependencies?: readonly number[];
  /**
   * Immutable exact-preview recipe derived only from complete ordered inputs.  It is engine-owned alongside the datasource plan rather
   * than embedded in provider plan state.
   */
  readonly preview: TPreview;
  readonly plan: TPlan;
}

export interface SpatialSkeletonEditPlannerContext {
  readonly intentId: number;
  readonly intent: SpatialSkeletonEditRequestIntent;
}

/**
 * Exact preview recipe retained by the engine for the lifetime of the
 * corresponding command-history entry.  Undo/redo planners can use this
 * without maintaining a datasource-owned mirror of optimistic history.
 */
export interface SpatialSkeletonPreviewHistoryRecipe<
  TPlan,
  TPreview,
  TInversePreview = TPreview,
> {
  /** Datasource recipe retained by the canonical engine intent record. */
  readonly plan: TPlan;
  readonly preview: TPreview;
  /** May be absent only for a coalesced Execute/Undo before exact reduction. */
  readonly inversePreview?: TInversePreview;
}

export interface SpatialSkeletonExecuteIntentCreationContext {
  readonly intentId: number;
  readonly intent: "execute";
  /** Exact, generic snapshots pinned through exact-preview preparation. */
  readonly queueInput: SpatialSkeletonQueueInput;
}

export interface SpatialSkeletonHistoryIntentCreationContext<
  TPlan,
  TPreview,
  TInversePreview = TPreview,
> {
  readonly intentId: number;
  readonly intent: "undo" | "redo";
  /** One exact recipe selected and resolved by the generic engine. */
  readonly recipe: SpatialSkeletonPreviewHistoryRecipe<
    TPlan,
    TPreview,
    TInversePreview
  >;
}

/** Context available while a planner describes a logical intent. */
export type SpatialSkeletonIntentCreationContext<
  TPlan,
  TPreview,
  TInversePreview = TPreview,
> =
  | SpatialSkeletonExecuteIntentCreationContext
  | SpatialSkeletonHistoryIntentCreationContext<
      TPlan,
      TPreview,
      TInversePreview
    >;

export interface SpatialSkeletonEditPlanContext<
  TEditRequest = unknown,
  TResult = unknown,
> extends SpatialSkeletonEditPlannerContext {
  /** Frozen journal snapshot of every authority-confirmed physical step. */
  readonly committedAttempts: readonly Readonly<
    SpatialSkeletonCommittedEditRequestAttempt<TEditRequest, TResult>
  >[];
}

export interface SpatialSkeletonEditRequestAttempt<TEditRequest> {
  /**
   * Materializes authoritative identities after the scheduler owns the lease
   * and immediately before the adapter transport boundary.
   */
  readonly materializeEditRequest: (
    context: SpatialSkeletonEditRequestMaterializationContext,
  ) => TEditRequest | Promise<TEditRequest>;
}

export type SpatialSkeletonEditRequestMaterializationContext =
  SpatialSkeletonEditRequestContext;

/** Provider plan boundary for one logical optimistic intent. */
export interface SpatialSkeletonEditPlanner<
  TInput,
  TPlan,
  TPreview,
  TEditRequest,
  TResult,
  TReconciliation,
  TInversePreview = TPreview,
> {
  /** Describes a complete user intent without fetching or reading topology. */
  describeIntent(input: TInput): SpatialSkeletonIntentDescription;

  /** Creates the exact recipe from complete inputs acquired inside the queue. */
  planIntent(
    input: TInput,
    context: SpatialSkeletonIntentCreationContext<
      TPlan,
      TPreview,
      TInversePreview
    >,
  ): SpatialSkeletonIntentPlan<TPlan, TPreview>;

  /**
   * Produces the next immutable physical-attempt recipe. Authoritative identity
   * resolution belongs exclusively in the returned under-lease materializer.
   * Every returned step must succeed before the exact preview can be confirmed.
   */
  nextAttempt(
    plan: TPlan,
    context: SpatialSkeletonEditPlanContext<TEditRequest, TResult>,
  ):
    | SpatialSkeletonEditRequestAttempt<TEditRequest>
    | undefined
    | Promise<SpatialSkeletonEditRequestAttempt<TEditRequest> | undefined>;

  /** Creates the provider's opaque authoritative publication value. */
  createReconciliation(
    plan: TPlan,
    context: SpatialSkeletonEditPlanContext<TEditRequest, TResult>,
  ): TReconciliation | Promise<TReconciliation>;
}

export interface SpatialSkeletonPreviewIntentArtifact<
  TPreview,
  TInversePreview = TPreview,
> {
  readonly intentId: number;
  readonly preview: TPreview;
  readonly inversePreview: TInversePreview;
}

/**
 * Complete exact artifacts for the active intents after one preview
 * publication has been adopted.  A refold may retain the forward preview
 * while deriving a different inverse against newer retained history state.
 */
export type SpatialSkeletonPreviewArtifactsListener<
  TPreview,
  TInversePreview = TPreview,
> = (
  artifacts: readonly SpatialSkeletonPreviewIntentArtifact<
    TPreview,
    TInversePreview
  >[],
) => void;

export interface SpatialSkeletonPreparedPreview<
  TPreview,
  TInversePreview = TPreview,
> {
  readonly preview: TPreview;
  readonly inversePreview: TInversePreview;
}

export interface SpatialSkeletonPreviewRollbackReplayRequest<
  TPreview,
  TInversePreview = TPreview,
> {
  readonly rollbackIntents: readonly SpatialSkeletonPreviewIntentArtifact<
    TPreview,
    TInversePreview
  >[];
  readonly replayIntents: readonly SpatialSkeletonPreviewIntentArtifact<
    TPreview,
    TInversePreview
  >[];
}

export interface SpatialSkeletonAuthoritativePublication<
  TPreview,
  TReconciliation,
  TInversePreview = TPreview,
> {
  readonly intentId: number;
  readonly reconciliation: TReconciliation;
  readonly activePreviews: readonly SpatialSkeletonPreviewIntentArtifact<
    TPreview,
    TInversePreview
  >[];
  /**
   * Rebuilds queued history from the finalized action and earlier refolded
   * artifacts, before reducing its preview. Must not publish or mutate history.
   */
  readonly rebaseActivePreview?: (
    intentId: number,
    precedingArtifacts: readonly SpatialSkeletonPreviewIntentArtifact<
      TPreview,
      TInversePreview
    >[],
  ) => TPreview | undefined;
}

/** Failure-atomic provider preview boundary. */
export interface SpatialSkeletonPreviewPort<
  TPreview,
  TReconciliation,
  TInversePreview = TPreview,
> {
  /**
   * Observes the exact active artifacts after each successful adoption.
   * Listener failures are reporting-only and must never roll back adoption.
   */
  subscribePreviewArtifacts(
    listener: SpatialSkeletonPreviewArtifactsListener<
      TPreview,
      TInversePreview
    >,
  ): () => void;
  /**
   * Applies/finalizes the planner's opaque preview and captures its exact
   * inverse against the pre-publication state.
   */
  prepareExact(
    intentId: number,
    preview: TPreview,
  ):
    | SpatialSkeletonPreparedPreview<TPreview, TInversePreview>
    | Promise<SpatialSkeletonPreparedPreview<TPreview, TInversePreview>>;
  /** Drops an off-screen candidate that will never be adopted. */
  discardPrepared(intentId: number): void;
  /** Synchronously publishes the exact preview returned by `prepareExact`. */
  publishExact(intentId: number, preview: TPreview): void;
  /** Atomically removes a closure and replays the explicitly listed survivors. */
  rollbackAndReplay(
    request: SpatialSkeletonPreviewRollbackReplayRequest<
      TPreview,
      TInversePreview
    >,
  ): void;
  /** Atomically publishes authority, mappings/baselines, and active previews. */
  publishAuthoritative(
    publication: SpatialSkeletonAuthoritativePublication<
      TPreview,
      TReconciliation,
      TInversePreview
    >,
  ): SpatialSkeletonPreviewIntentArtifact<TPreview, TInversePreview>;
  /** Updates the bounded history-owned baseline after history replay changes. */
  setRetainedHistoryPreviews(previews: readonly TPreview[]): void;
  /** True when an ordinary read must be folded into active/history state. */
  ownsAuthoritativeReadSegment(segmentId: bigint): boolean;
  getProtectedSegmentIds(): readonly bigint[];
}

/** Narrow command-history boundary; datasource planners never receive it. */
export interface SpatialSkeletonHistoryPort<TInput, THistoryTicket> {
  readonly capacity: number;
  stageExecute(input: TInput): THistoryTicket;
  stageUndo(): THistoryTicket | undefined;
  stageRedo(): THistoryTicket | undefined;
  getTicketId(ticket: THistoryTicket): string | number;
  getEntryId(ticket: THistoryTicket): string | number;
  /** Transition-ticket dependencies computed by previewed history replay. */
  getSemanticDependencyTicketIds(
    ticket: THistoryTicket,
  ): readonly (string | number)[];
  /** Advances the confirmed prefix. A discarded ticket is a no-op. */
  confirm(ticket: THistoryTicket): void;
  /** Abandons only the latest transition after synchronous admission failure. */
  abandonLatest(ticket: THistoryTicket): void;
  /** Restores history before this staged ticket, discarding its whole suffix. */
  rollbackFrom(ticket: THistoryTicket): void;
  /** Drops the complete layer Undo/Redo state on Reload-required recovery or source change. */
  reset(): void;
  canStage(intent: "undo" | "redo"): boolean;
  /** History exposes only the selected canonical entry id, never its recipe. */
  getPreviewedEntryId(intent: "undo" | "redo"): string | number | undefined;
  /** Canonical entry ids retained across confirmed, previewed, and staged state. */
  getRetainedEntryIds(): readonly (string | number)[];
}

/** Why the generic queue is asking a datasource adapter to mutate authority. */
export type SpatialSkeletonEditRequestIntent = "execute" | "undo" | "redo";

/**
 * Context common to every datasource edit request submitted by an optimistic
 * spatial-skeleton queue.
 *
 * This deliberately does not expose transport flags or a validation bypass.
 * A datasource may choose its own consistency mechanism for queue-serialized
 * work and map this semantic context to request details inside its adapter.
 */
export interface SpatialSkeletonEditRequestContext {
  readonly intent: SpatialSkeletonEditRequestIntent;
  readonly operationId: number;
  readonly signal?: AbortSignal;
}

/** Conservative authority classification after a failed edit request. */
export type SpatialSkeletonEditRequestFailureDisposition =
  | "not-started"
  | "rejected"
  | "indeterminate";

/**
 * Transport-neutral result observed by optimistic queue orchestration.
 *
 * A rejected edit request is known not to have changed authority. An
 * indeterminate edit request may have changed authority and therefore requires a
 * reload before touching work can continue.
 */
export type SpatialSkeletonEditRequestOutcome<TResult> =
  | {
      readonly status: "committed";
      readonly result: TResult;
    }
  | {
      readonly status: SpatialSkeletonEditRequestFailureDisposition;
      readonly error: unknown;
      /** Present when the adapter itself failed to classify the edit request. */
      readonly classificationError?: unknown;
    };

/**
 * Datasource boundary used by generic optimistic queue machinery.
 *
 * Edit request and result payloads are intentionally type parameters. Preview
 * deltas, logical dependencies, history, replay, and presentation are generic
 * skeleton concerns; wire payloads and result normalization belong here.
 */
export interface SpatialSkeletonEditRequestAdapter<TEditRequest, TResult> {
  /** Stable identity of the physical edit request target across queue recreation. */
  readonly editRequestScope: object;

  /** Called only with the attempt materialized under its active authority lease. */
  commit(
    editRequest: TEditRequest,
    context: SpatialSkeletonEditRequestContext,
  ): Promise<TResult>;

  classifyFailure(
    error: unknown,
    editRequest: TEditRequest,
    context: SpatialSkeletonEditRequestContext,
  ): SpatialSkeletonEditRequestFailureDisposition;
}

/**
 * Invokes an adapter and turns every provider/transport outcome into the
 * finite state space understood by datasource-neutral queue orchestration.
 *
 * Classification failures are conservatively indeterminate: once commit has
 * been invoked, generic code must never infer that authority is unchanged.
 */
export async function commitSpatialSkeletonEditRequest<TEditRequest, TResult>(
  adapter: SpatialSkeletonEditRequestAdapter<TEditRequest, TResult>,
  editRequest: TEditRequest,
  context: SpatialSkeletonEditRequestContext,
): Promise<SpatialSkeletonEditRequestOutcome<TResult>> {
  try {
    return {
      status: "committed",
      result: await adapter.commit(editRequest, context),
    };
  } catch (error) {
    try {
      return {
        status: adapter.classifyFailure(error, editRequest, context),
        error,
      };
    } catch (classificationError) {
      return {
        status: "indeterminate",
        error,
        classificationError,
      };
    }
  }
}

export interface SpatialSkeletonEditPlannerSetupContext {
  readonly source: EditableSkeletonSource;
  /** Session-owned logical identity service shared with preview reduction. */
  readonly identities: SpatialSkeletonIdentityService;
  /** Session-owned allocator facade configured from the returned registration. */
  readonly provisionalIds: SpatialSkeletonProvisionalNumericIdService;
}

/**
 * Stable, datasource-neutral logical identities.  Planners retain handles in
 * plan recipes and resolve their current numeric authority only at the
 * transport boundary.
 */
export interface SpatialSkeletonIdentityService {
  getOrCreateNodeHandle(nodeId: bigint): SpatialSkeletonStableNodeHandle;
  getOrCreateNodeHandles(
    nodeIds: readonly bigint[],
  ): ReadonlyMap<bigint, SpatialSkeletonStableNodeHandle>;
  getOrCreateSegmentHandle(
    segmentId: bigint,
  ): SpatialSkeletonStableSegmentHandle;
  resolveNode(handle: SpatialSkeletonStableNodeHandle): bigint | undefined;
  resolveSegment(
    handle: SpatialSkeletonStableSegmentHandle,
  ): bigint | undefined;
  resolveAuthoritativeNode(
    handle: SpatialSkeletonStableNodeHandle,
  ): bigint | undefined;
  resolveAuthoritativeSegment(
    handle: SpatialSkeletonStableSegmentHandle,
  ): bigint | undefined;
  resolveNodeTarget(
    handle: SpatialSkeletonStableNodeHandle,
  ): SpatialSkeletonStableIdMappingResolution<bigint>;
  resolveSegmentTarget(
    handle: SpatialSkeletonStableSegmentHandle,
  ): SpatialSkeletonStableIdMappingResolution<bigint>;
}

/** Optional datasource policy for locally-presented nonzero ids. */
export interface SpatialSkeletonProvisionalNumericIdPolicy {
  allocateNodeId(intentId: number): bigint;
  allocateSegmentId(intentId: number): bigint;
}

/** Facade captured by a planner and configured by its registration. */
export interface SpatialSkeletonProvisionalNumericIdService {
  allocateNodeId(intentId: number): bigint;
  allocateSegmentId(intentId: number): bigint;
}

/**
 * The only datasource-owned pieces of optimistic editing.  Queue lifecycle,
 * history, identities, preview state, scheduling, and Reload-required state are
 * deliberately absent and are always constructed by SpatialSkeletonEditSession.
 */
export interface SpatialSkeletonEditPlannerRegistration {
  readonly planner: SpatialSkeletonEditPlanner<
    SpatialSkeletonEditCommand,
    any,
    SpatialSkeletonPreviewIntentDelta,
    any,
    any,
    SpatialSkeletonAuthoritativeReconciliation,
    SpatialSkeletonEditInverseDelta
  >;
  readonly editRequestAdapter: SpatialSkeletonEditRequestAdapter<any, any>;
  readonly provisionalNumericIdPolicy?: SpatialSkeletonProvisionalNumericIdPolicy;
  readonly cleanup?: () => void;
}

/** Required capability exposed by every editable spatial-skeleton source. */
export interface SpatialSkeletonEditPlannerProvider {
  createPlanner(
    context: SpatialSkeletonEditPlannerSetupContext,
  ): SpatialSkeletonEditPlannerRegistration;
}

export class SpatialSkeletonDatasourceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialSkeletonDatasourceContractError";
  }
}

export function isSpatialSkeletonEditPlannerProvider(
  value: unknown,
): value is SpatialSkeletonEditPlannerProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createPlanner?: unknown }).createPlanner === "function"
  );
}

export function assertSpatialSkeletonEditPlannerRegistration(
  value: unknown,
): asserts value is SpatialSkeletonEditPlannerRegistration {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { planner?: unknown }).planner !== "object" ||
    (value as { planner?: unknown }).planner === null ||
    typeof (value as { editRequestAdapter?: unknown }).editRequestAdapter !==
      "object" ||
    (value as { editRequestAdapter?: unknown }).editRequestAdapter === null
  ) {
    throw new SpatialSkeletonDatasourceContractError(
      "Editable spatial skeleton datasource createPlanner() must return a edit planner and edit request adapter.",
    );
  }
  const allowedRegistrationKeys = new Set([
    "planner",
    "editRequestAdapter",
    "provisionalNumericIdPolicy",
    "cleanup",
  ]);
  for (const key of Object.keys(value)) {
    if (allowedRegistrationKeys.has(key)) continue;
    throw new SpatialSkeletonDatasourceContractError(
      `Editable spatial skeleton datasource planner registration contains engine-owned field "${key}".`,
    );
  }
  const planner = (value as { planner: Record<string, unknown> }).planner;
  for (const method of [
    "describeIntent",
    "planIntent",
    "nextAttempt",
    "createReconciliation",
  ]) {
    if (typeof planner[method] !== "function") {
      throw new SpatialSkeletonDatasourceContractError(
        `Editable spatial skeleton datasource planner is missing ${method}().`,
      );
    }
  }
  const adapter = (value as { editRequestAdapter: Record<string, unknown> })
    .editRequestAdapter;
  for (const method of ["commit", "classifyFailure"]) {
    if (typeof adapter[method] !== "function") {
      throw new SpatialSkeletonDatasourceContractError(
        `Editable spatial skeleton datasource edit request adapter is missing ${method}().`,
      );
    }
  }
  let editRequestScope: unknown;
  try {
    editRequestScope = adapter.editRequestScope;
  } catch {
    throw new SpatialSkeletonDatasourceContractError(
      "Editable spatial skeleton datasource edit request adapter editRequestScope could not be resolved.",
    );
  }
  if (
    editRequestScope === null ||
    (typeof editRequestScope !== "object" &&
      typeof editRequestScope !== "function")
  ) {
    throw new SpatialSkeletonDatasourceContractError(
      "Editable spatial skeleton datasource edit request adapter must expose a stable object editRequestScope.",
    );
  }
  const policy = (
    value as { provisionalNumericIdPolicy?: Record<string, unknown> }
  ).provisionalNumericIdPolicy;
  if (
    policy !== undefined &&
    (typeof policy !== "object" ||
      policy === null ||
      typeof policy.allocateNodeId !== "function" ||
      typeof policy.allocateSegmentId !== "function")
  ) {
    throw new SpatialSkeletonDatasourceContractError(
      "A provisional numeric-ID policy must implement allocateNodeId() and allocateSegmentId().",
    );
  }
  const cleanup = (value as { cleanup?: unknown }).cleanup;
  if (cleanup !== undefined && typeof cleanup !== "function") {
    throw new SpatialSkeletonDatasourceContractError(
      "Editable spatial skeleton datasource cleanup must be a function.",
    );
  }
}
