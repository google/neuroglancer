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

import {
  commitSpatialSkeletonMutation,
  type SpatialSkeletonMutationIntent,
  type SpatialSkeletonMutationOutcome,
  type SpatialSkeletonOptimisticMutationAdapter,
} from "#src/skeleton/optimistic_edit/api.js";
import {
  globalSpatialSkeletonMutationAuthorityLeaseCoordinator,
  type SpatialSkeletonMutationAuthorityLease,
  type SpatialSkeletonMutationAuthorityLeaseCoordinator,
} from "#src/skeleton/optimistic_edit/authority_lease_coordinator.js";
import type { SpatialSkeletonMutationMaterializationContext } from "#src/skeleton/optimistic_edit/ports.js";

export interface SpatialSkeletonMutationAttemptRequest<TMutation> {
  /** Runs only after the authority lease is active. */
  readonly materializeMutation: (
    context: SpatialSkeletonMutationMaterializationContext,
  ) => TMutation | Promise<TMutation>;
  /** Cancels acquisition only; it is disconnected before `commit` starts. */
  readonly signal?: AbortSignal;
  /** Transfers the acquired workflow lease before transport is invoked. */
  readonly onLeaseAcquired?: (
    lease: SpatialSkeletonMutationAuthorityLease,
  ) => void;
  /** Called after materialization at the final adapter.commit() boundary. */
  readonly onCommitStarting?: () => void;
}

export interface SpatialSkeletonMutationAttemptSettlement<
  TResult,
  TMutation = unknown,
> {
  readonly operationId: number;
  readonly outcome: SpatialSkeletonMutationOutcome<TResult>;
  /** Exact under-lease mutation passed to adapter.commit(), when reached. */
  readonly mutation?: TMutation;
  /**
   * Present once physical authority was acquired. The workflow owns this
   * lease until projection and history are definitively done, or until a
   * reload-required fence is abandoned by page unload.
   */
  readonly lease?: SpatialSkeletonMutationAuthorityLease;
}

export type SpatialSkeletonMutationAttemptPhase =
  | "waiting-for-lease"
  | "committing"
  | "settled";

export interface SpatialSkeletonMutationAttemptSubmission<
  TResult,
  TMutation = unknown,
> {
  readonly operationId: number;
  readonly phase: SpatialSkeletonMutationAttemptPhase;
  readonly settled: Promise<
    SpatialSkeletonMutationAttemptSettlement<TResult, TMutation>
  >;
  /** Cancels this attempt if and only if adapter transport has not started. */
  cancelBeforeCommit(reason?: unknown): boolean;
}

export interface SpatialSkeletonMutationAttemptSchedulerOptions<
  TMutation,
  TResult,
> {
  readonly adapter: SpatialSkeletonOptimisticMutationAdapter<
    TMutation,
    TResult
  >;
  readonly coordinator?: SpatialSkeletonMutationAuthorityLeaseCoordinator;
}

export class SpatialSkeletonMutationAttemptSchedulerDisposedError extends Error {
  constructor() {
    super("The spatial skeleton mutation attempt scheduler is disposed.");
    this.name = "SpatialSkeletonMutationAttemptSchedulerDisposedError";
  }
}

export class SpatialSkeletonMutationAttemptNotStartedError extends Error {
  constructor(readonly reason: unknown) {
    super("The spatial skeleton mutation attempt did not start.");
    this.name = "SpatialSkeletonMutationAttemptNotStartedError";
  }
}

export class SpatialSkeletonMutationAttemptMaterializationError extends Error {
  constructor(readonly reason: unknown) {
    super(
      "The spatial skeleton mutation could not be materialized under lease.",
      {
        cause: reason,
      },
    );
    this.name = "SpatialSkeletonMutationAttemptMaterializationError";
  }
}

interface AttemptRecord {
  operationId: number;
  controller: AbortController;
  externalSignalDisposer?: () => void;
  lease?: SpatialSkeletonMutationAuthorityLease;
  leaseOwnedByCaller: boolean;
  phase: SpatialSkeletonMutationAttemptPhase;
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
) {
  if (source === undefined) return undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return undefined;
  }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

/**
 * Dispatches physical mutation attempts under global authority leases.
 *
 * It deliberately knows nothing about previews, intent capacity, history,
 * rollback/replay, or queue snapshots. Those are owned by
 * `SpatialSkeletonOptimisticQueueEngine`.
 */
export class SpatialSkeletonMutationAttemptScheduler<TMutation, TResult> {
  private readonly adapter: SpatialSkeletonOptimisticMutationAdapter<
    TMutation,
    TResult
  >;
  private readonly coordinator: SpatialSkeletonMutationAuthorityLeaseCoordinator;
  private readonly mutationScope: object;
  private readonly attempts = new Set<AttemptRecord>();
  private disposed = false;

  constructor(
    options: SpatialSkeletonMutationAttemptSchedulerOptions<TMutation, TResult>,
  ) {
    this.adapter = options.adapter;
    // Snapshot the provider's required stable scope once. Every attempt from
    // this instance belongs to that target, including compound workflow steps.
    this.mutationScope = options.adapter.mutationScope;
    this.coordinator =
      options.coordinator ??
      globalSpatialSkeletonMutationAuthorityLeaseCoordinator;
  }

  schedule(
    intent: SpatialSkeletonMutationIntent,
    request: SpatialSkeletonMutationAttemptRequest<TMutation>,
  ): SpatialSkeletonMutationAttemptSubmission<TResult, TMutation> {
    return this.startAttempt(intent, request, (signal) => {
      return this.coordinator.acquire({
        mutationScope: this.mutationScope,
        signal,
      });
    });
  }

  runWithLease(
    lease: SpatialSkeletonMutationAuthorityLease,
    intent: SpatialSkeletonMutationIntent,
    request: SpatialSkeletonMutationAttemptRequest<TMutation>,
  ): SpatialSkeletonMutationAttemptSubmission<TResult, TMutation> {
    if (lease.mutationScope !== this.mutationScope) {
      throw new Error(
        "A mutation attempt cannot reuse a lease from another mutation scope.",
      );
    }
    if (lease.state !== "active") {
      throw new Error(
        "A compound mutation attempt requires its active workflow lease.",
      );
    }
    return this.startAttempt(
      intent,
      request,
      () => Promise.resolve(lease),
      true,
    );
  }

  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    const error = new SpatialSkeletonMutationAttemptSchedulerDisposedError();
    for (const attempt of this.attempts) {
      // Once commit starts, neither disposal nor ordinary cancellation is
      // allowed to turn an authoritative result into an artificial abort.
      if (attempt.phase === "waiting-for-lease") {
        attempt.controller.abort(error);
      }
    }
    return true;
  }

  private startAttempt(
    intent: SpatialSkeletonMutationIntent,
    request: SpatialSkeletonMutationAttemptRequest<TMutation>,
    acquire: (
      signal: AbortSignal,
    ) => Promise<SpatialSkeletonMutationAuthorityLease>,
    leaseOwnedByCaller = false,
  ): SpatialSkeletonMutationAttemptSubmission<TResult, TMutation> {
    if (this.disposed) {
      throw new SpatialSkeletonMutationAttemptSchedulerDisposedError();
    }
    const operationId = this.coordinator.allocateOperationId();
    const controller = new AbortController();
    const record = {} as AttemptRecord;
    record.operationId = operationId;
    record.controller = controller;
    record.phase = "waiting-for-lease";
    record.leaseOwnedByCaller = leaseOwnedByCaller;
    record.externalSignalDisposer = linkAbortSignal(request.signal, controller);
    this.attempts.add(record);
    const settled = this.runAttempt(record, intent, request, acquire);
    const cleanup = () => {
      record.phase = "settled";
      record.externalSignalDisposer?.();
      this.attempts.delete(record);
    };
    void settled.then(cleanup, cleanup);
    return Object.freeze({
      operationId,
      get phase() {
        return record.phase;
      },
      settled,
      cancelBeforeCommit: (reason?: unknown) => {
        if (record.phase !== "waiting-for-lease" || controller.signal.aborted) {
          return false;
        }
        controller.abort(reason);
        return true;
      },
    });
  }

  private async runAttempt(
    record: AttemptRecord,
    intent: SpatialSkeletonMutationIntent,
    request: SpatialSkeletonMutationAttemptRequest<TMutation>,
    acquire: (
      signal: AbortSignal,
    ) => Promise<SpatialSkeletonMutationAuthorityLease>,
  ): Promise<SpatialSkeletonMutationAttemptSettlement<TResult, TMutation>> {
    let lease: SpatialSkeletonMutationAuthorityLease;
    try {
      lease = await acquire(record.controller.signal);
      record.lease = lease;
    } catch (error) {
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonMutationAttemptNotStartedError(error),
        },
      };
    }

    // Cancellation can win after the coordinator grants a queued lease but
    // before this continuation runs. Release that lease without exposing it
    // to the workflow or invoking provider transport.
    if (record.controller.signal.aborted) {
      if (!record.leaseOwnedByCaller) lease.release();
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonMutationAttemptNotStartedError(
            record.controller.signal.reason,
          ),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }

    try {
      request.onLeaseAcquired?.(lease);
      if (request.onLeaseAcquired !== undefined) {
        record.leaseOwnedByCaller = true;
      }
    } catch (error) {
      if (!record.leaseOwnedByCaller) lease.release();
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonMutationAttemptNotStartedError(error),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }

    if (record.controller.signal.aborted) {
      if (!record.leaseOwnedByCaller) lease.release();
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonMutationAttemptNotStartedError(
            record.controller.signal.reason,
          ),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }

    let materializedMutation: TMutation;
    try {
      materializedMutation = await request.materializeMutation({
        intent,
        operationId: record.operationId,
        signal: record.controller.signal,
      });
    } catch (error) {
      if (!record.leaseOwnedByCaller) lease.release();
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonMutationAttemptMaterializationError(error),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }

    // Cancellation remains effective throughout an asynchronous materializer.
    // This is the final fence before crossing adapter.commit().
    if (record.controller.signal.aborted) {
      if (!record.leaseOwnedByCaller) lease.release();
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonMutationAttemptNotStartedError(
            record.controller.signal.reason,
          ),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }
    try {
      request.onCommitStarting?.();
    } catch (error) {
      if (!record.leaseOwnedByCaller) lease.release();
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonMutationAttemptNotStartedError(error),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }
    // onCommitStarting may synchronously notify observers.  A fatal observer
    // is allowed to win that re-entrant boundary while the submission still
    // truthfully reports waiting-for-lease.  Honor its successful
    // cancelBeforeCommit() before changing phase or invoking the adapter.
    if (record.controller.signal.aborted) {
      if (!record.leaseOwnedByCaller) lease.release();
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonMutationAttemptNotStartedError(
            record.controller.signal.reason,
          ),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }
    record.externalSignalDisposer?.();
    record.externalSignalDisposer = undefined;
    record.phase = "committing";

    const outcome = await commitSpatialSkeletonMutation(
      this.adapter,
      materializedMutation,
      {
        intent,
        operationId: record.operationId,
        signal: record.controller.signal,
      },
    );
    // The engine decides whether to release after local publication or retain
    // a reload-required fence. The scheduler never changes an engine-owned
    // lease after transport starts.
    return {
      operationId: record.operationId,
      outcome,
      lease,
      mutation: materializedMutation,
    };
  }
}
