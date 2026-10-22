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

import type { EditableSkeletonSource } from "#src/skeleton/api.js";
import type { SpatialSkeletonEditCommand } from "#src/skeleton/edit_commands.js";
import type { SpatialSkeletonProjectionInverseDelta } from "#src/skeleton/edit_queue/complete_skeleton_edits.js";
import type {
  SpatialSkeletonCommittedMutationAttempt,
  SpatialSkeletonIntentResource,
} from "#src/skeleton/edit_queue/edit_intent_journal.js";
import type {
  SpatialSkeletonAuthoritativeReconciliation,
  SpatialSkeletonProjectionIntentDelta,
} from "#src/skeleton/edit_queue/preview.js";
import type { SpatialSkeletonQueueInput } from "#src/skeleton/edit_queue/queue_input.js";
import type {
  SpatialSkeletonLogicalHandleMappingResolution,
  SpatialSkeletonLogicalNodeHandle,
  SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import type { SpatialSkeletonOptimisticAuthorityPresentation } from "#src/skeleton/edit_queue/types.js";

export interface SpatialSkeletonOptimisticPreparationDescriptor {
  readonly kind: "merge" | "split" | "delete" | "restore" | "reroot";
  readonly logicalNodeHandles?: readonly SpatialSkeletonLogicalNodeHandle[];
  readonly logicalSegmentHandles?: readonly SpatialSkeletonLogicalSegmentHandle[];
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
  ownsAuthoritativeReadSegment(segmentId: bigint): boolean;
  getProtectedSegmentIds(): readonly bigint[];
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

/** Why the generic queue is asking a datasource adapter to mutate authority. */
export type SpatialSkeletonMutationIntent = "execute" | "undo" | "redo";

/**
 * Context common to every datasource mutation submitted by an optimistic
 * spatial-skeleton queue.
 *
 * This deliberately does not expose transport flags or a validation bypass.
 * A datasource may choose its own consistency mechanism for queue-serialized
 * work and map this semantic context to request details inside its adapter.
 */
export interface SpatialSkeletonMutationContext {
  readonly intent: SpatialSkeletonMutationIntent;
  readonly operationId: number;
  readonly signal?: AbortSignal;
}

/** Conservative authority classification after a failed mutation request. */
export type SpatialSkeletonMutationFailureDisposition =
  | "not-started"
  | "rejected"
  | "indeterminate";

/**
 * Transport-neutral result observed by optimistic queue orchestration.
 *
 * A rejected mutation is known not to have changed authority. An
 * indeterminate mutation may have changed authority and therefore requires a
 * reload before touching work can continue.
 */
export type SpatialSkeletonMutationOutcome<TResult> =
  | {
      readonly status: "committed";
      readonly result: TResult;
    }
  | {
      readonly status: SpatialSkeletonMutationFailureDisposition;
      readonly error: unknown;
      /** Present when the adapter itself failed to classify the mutation. */
      readonly classificationError?: unknown;
    };

/**
 * Datasource boundary used by generic optimistic queue machinery.
 *
 * Mutation and result payloads are intentionally type parameters. Projection
 * deltas, logical dependencies, history, replay, and presentation are generic
 * skeleton concerns; wire payloads and result normalization belong here.
 */
export interface SpatialSkeletonOptimisticMutationAdapter<TMutation, TResult> {
  /** Stable identity of the physical mutation target across queue recreation. */
  readonly mutationScope: object;

  /** Called only with the attempt materialized under its active authority lease. */
  commit(
    mutation: TMutation,
    context: SpatialSkeletonMutationContext,
  ): Promise<TResult>;

  classifyFailure(
    error: unknown,
    mutation: TMutation,
    context: SpatialSkeletonMutationContext,
  ): SpatialSkeletonMutationFailureDisposition;
}

/**
 * Invokes an adapter and turns every provider/transport outcome into the
 * finite state space understood by datasource-neutral queue orchestration.
 *
 * Classification failures are conservatively indeterminate: once commit has
 * been invoked, generic code must never infer that authority is unchanged.
 */
export async function commitSpatialSkeletonMutation<TMutation, TResult>(
  adapter: SpatialSkeletonOptimisticMutationAdapter<TMutation, TResult>,
  mutation: TMutation,
  context: SpatialSkeletonMutationContext,
): Promise<SpatialSkeletonMutationOutcome<TResult>> {
  try {
    return {
      status: "committed",
      result: await adapter.commit(mutation, context),
    };
  } catch (error) {
    try {
      return {
        status: adapter.classifyFailure(error, mutation, context),
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

export interface SpatialSkeletonOptimisticEditingContext {
  readonly source: EditableSkeletonSource;
  /** State-owned logical identity service shared with projection reduction. */
  readonly identities: SpatialSkeletonOptimisticIdentityService;
  /** State-owned allocator facade configured from the returned registration. */
  readonly provisionalIds: SpatialSkeletonProvisionalNumericIdService;
}

/**
 * Stable, datasource-neutral logical identities.  Drivers retain handles in
 * workflow recipes and resolve their current numeric authority only at the
 * transport boundary.
 */
export interface SpatialSkeletonOptimisticIdentityService {
  getOrCreateNodeHandle(nodeId: bigint): SpatialSkeletonLogicalNodeHandle;
  getOrCreateNodeHandles(
    nodeIds: readonly bigint[],
  ): ReadonlyMap<bigint, SpatialSkeletonLogicalNodeHandle>;
  getOrCreateSegmentHandle(
    segmentId: bigint,
  ): SpatialSkeletonLogicalSegmentHandle;
  resolveNode(handle: SpatialSkeletonLogicalNodeHandle): bigint | undefined;
  resolveSegment(
    handle: SpatialSkeletonLogicalSegmentHandle,
  ): bigint | undefined;
  resolveAuthoritativeNode(
    handle: SpatialSkeletonLogicalNodeHandle,
  ): bigint | undefined;
  resolveAuthoritativeSegment(
    handle: SpatialSkeletonLogicalSegmentHandle,
  ): bigint | undefined;
  resolveNodeTarget(
    handle: SpatialSkeletonLogicalNodeHandle,
  ): SpatialSkeletonLogicalHandleMappingResolution<bigint>;
  resolveSegmentTarget(
    handle: SpatialSkeletonLogicalSegmentHandle,
  ): SpatialSkeletonLogicalHandleMappingResolution<bigint>;
}

/** Optional datasource policy for locally-presented nonzero ids. */
export interface SpatialSkeletonProvisionalNumericIdPolicy {
  allocateNodeId(intentId: number): bigint;
  allocateSegmentId(intentId: number): bigint;
}

/** Facade captured by a driver and configured by its registration. */
export interface SpatialSkeletonProvisionalNumericIdService {
  allocateNodeId(intentId: number): bigint;
  allocateSegmentId(intentId: number): bigint;
}

/**
 * The only datasource-owned pieces of optimistic editing.  Queue lifecycle,
 * history, identities, projection state, scheduling, and fatal state are
 * deliberately absent and are always constructed by SpatialSkeletonState.
 */
export interface SpatialSkeletonOptimisticDriverRegistration {
  readonly driver: SpatialSkeletonIntentDriver<
    SpatialSkeletonEditCommand,
    any,
    SpatialSkeletonProjectionIntentDelta,
    any,
    any,
    SpatialSkeletonAuthoritativeReconciliation,
    SpatialSkeletonProjectionInverseDelta
  >;
  readonly mutationAdapter: SpatialSkeletonOptimisticMutationAdapter<any, any>;
  readonly provisionalNumericIdPolicy?: SpatialSkeletonProvisionalNumericIdPolicy;
  readonly cleanup?: () => void;
}

/** Required capability exposed by every editable spatial-skeleton source. */
export interface SpatialSkeletonOptimisticEditingProvider {
  createDriver(
    context: SpatialSkeletonOptimisticEditingContext,
  ): SpatialSkeletonOptimisticDriverRegistration;
}

export class SpatialSkeletonOptimisticDatasourceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialSkeletonOptimisticDatasourceContractError";
  }
}

export function isSpatialSkeletonOptimisticEditingProvider(
  value: unknown,
): value is SpatialSkeletonOptimisticEditingProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createDriver?: unknown }).createDriver === "function"
  );
}

export function assertSpatialSkeletonOptimisticDriverRegistration(
  value: unknown,
): asserts value is SpatialSkeletonOptimisticDriverRegistration {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { driver?: unknown }).driver !== "object" ||
    (value as { driver?: unknown }).driver === null ||
    typeof (value as { mutationAdapter?: unknown }).mutationAdapter !==
      "object" ||
    (value as { mutationAdapter?: unknown }).mutationAdapter === null
  ) {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "Editable spatial skeleton datasource createDriver() must return a workflow driver and mutation adapter.",
    );
  }
  const allowedRegistrationKeys = new Set([
    "driver",
    "mutationAdapter",
    "provisionalNumericIdPolicy",
    "cleanup",
  ]);
  for (const key of Object.keys(value)) {
    if (allowedRegistrationKeys.has(key)) continue;
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      `Editable spatial skeleton datasource driver registration contains engine-owned field "${key}".`,
    );
  }
  const driver = (value as { driver: Record<string, unknown> }).driver;
  for (const method of [
    "describeIntent",
    "createLogicalIntent",
    "nextAttempt",
    "createReconciliation",
  ]) {
    if (typeof driver[method] !== "function") {
      throw new SpatialSkeletonOptimisticDatasourceContractError(
        `Editable spatial skeleton datasource driver is missing ${method}().`,
      );
    }
  }
  const adapter = (value as { mutationAdapter: Record<string, unknown> })
    .mutationAdapter;
  for (const method of ["commit", "classifyFailure"]) {
    if (typeof adapter[method] !== "function") {
      throw new SpatialSkeletonOptimisticDatasourceContractError(
        `Editable spatial skeleton datasource mutation adapter is missing ${method}().`,
      );
    }
  }
  let mutationScope: unknown;
  try {
    mutationScope = adapter.mutationScope;
  } catch {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "Editable spatial skeleton datasource mutation adapter mutationScope could not be resolved.",
    );
  }
  if (
    mutationScope === null ||
    (typeof mutationScope !== "object" && typeof mutationScope !== "function")
  ) {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "Editable spatial skeleton datasource mutation adapter must expose a stable object mutationScope.",
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
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "A provisional numeric-ID policy must implement allocateNodeId() and allocateSegmentId().",
    );
  }
  const cleanup = (value as { cleanup?: unknown }).cleanup;
  if (cleanup !== undefined && typeof cleanup !== "function") {
    throw new SpatialSkeletonOptimisticDatasourceContractError(
      "Editable spatial skeleton datasource cleanup must be a function.",
    );
  }
}
