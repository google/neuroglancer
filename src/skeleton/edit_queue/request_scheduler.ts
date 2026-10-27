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
 * @file Sends each edit request attempt to its adapter under a lease on its
 * edit request scope. Each scope grants its lease to one intent at a time, in
 * FIFO order.
 */

import type {
  SpatialSkeletonEditRequestIntent,
  SpatialSkeletonEditRequestOutcome,
  SpatialSkeletonEditRequestAdapter,
  SpatialSkeletonEditRequestMaterializationContext,
} from "#src/skeleton/edit_queue/api.js";
import { commitSpatialSkeletonEditRequest } from "#src/skeleton/edit_queue/api.js";

export type SpatialSkeletonEditRequestLeaseStatus =
  | "active"
  | "retained"
  | "released";

export interface SpatialSkeletonEditRequestLease {
  readonly editRequestScope: object;
  readonly state: SpatialSkeletonEditRequestLeaseStatus;
  /** Permanently fences the edit request scope until the lease is released. */
  retain(): boolean;
  /** Removes the scope fence and grants the next FIFO waiter, if any. */
  release(): boolean;
}

export interface SpatialSkeletonEditRequestLeaseAcquireRequest {
  readonly editRequestScope: object;
  readonly signal?: AbortSignal;
}

interface ScopeState {
  current?: SpatialSkeletonEditRequestLeaseImpl;
  readonly pending: PendingAcquisition[];
}

interface PendingAcquisition {
  readonly scopeState: ScopeState;
  readonly editRequestScope: object;
  readonly signal?: AbortSignal;
  resolve(lease: SpatialSkeletonEditRequestLeaseImpl): void;
  reject(error: unknown): void;
  removeAbortListener?: () => void;
}

function abortReason(signal: AbortSignal) {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

function validateEditRequestScope(editRequestScope: object) {
  if (
    editRequestScope === null ||
    (typeof editRequestScope !== "object" &&
      typeof editRequestScope !== "function")
  ) {
    throw new TypeError(
      "An edit request authority lease requires an object scope.",
    );
  }
}

class SpatialSkeletonEditRequestLeaseImpl
  implements SpatialSkeletonEditRequestLease
{
  private currentState: SpatialSkeletonEditRequestLeaseStatus = "active";

  constructor(
    private readonly coordinator: SpatialSkeletonEditRequestLock,
    readonly scopeState: ScopeState,
    readonly editRequestScope: object,
  ) {}

  get state() {
    return this.currentState;
  }

  retain() {
    if (this.currentState !== "active") return false;
    this.currentState = "retained";
    return true;
  }

  release() {
    if (this.currentState === "released") return false;
    this.currentState = "released";
    this.coordinator.onLeaseReleased(this);
    return true;
  }
}

/**
 * Global FIFO authority coordinator keyed only by datasource edit request scope.
 *
 * A scope has exactly one edit request lane.  The lease remains in that lane
 * while the engine publishes preview/history state, and compound plan
 * steps may reuse it without reacquiring.  Distinct intents release and join
 * the FIFO again.
 */
export class SpatialSkeletonEditRequestLock {
  private readonly scopes = new WeakMap<object, ScopeState>();
  private operationSequence = 0;

  allocateOperationId() {
    return ++this.operationSequence;
  }

  acquire(
    request: SpatialSkeletonEditRequestLeaseAcquireRequest,
  ): Promise<SpatialSkeletonEditRequestLease> {
    try {
      validateEditRequestScope(request.editRequestScope);
    } catch (error) {
      return Promise.reject(error);
    }
    if (request.signal?.aborted) {
      return Promise.reject(abortReason(request.signal));
    }
    const scopeState = this.getScopeState(request.editRequestScope);
    return new Promise<SpatialSkeletonEditRequestLease>((resolve, reject) => {
      const pending: PendingAcquisition = {
        scopeState,
        editRequestScope: request.editRequestScope,
        signal: request.signal,
        resolve,
        reject,
      };
      this.installAbortListener(pending);
      scopeState.pending.push(pending);
      this.pump(scopeState);
    });
  }

  onLeaseReleased(lease: SpatialSkeletonEditRequestLeaseImpl) {
    if (lease.scopeState.current !== lease) return;
    lease.scopeState.current = undefined;
    this.pump(lease.scopeState);
  }

  private getScopeState(scope: object) {
    let state = this.scopes.get(scope);
    if (state === undefined) {
      state = { pending: [] };
      this.scopes.set(scope, state);
    }
    return state;
  }

  private installAbortListener(pending: PendingAcquisition) {
    const { signal } = pending;
    if (signal === undefined) return;
    const onAbort = () => {
      const index = pending.scopeState.pending.indexOf(pending);
      if (index === -1) return;
      pending.scopeState.pending.splice(index, 1);
      pending.reject(abortReason(signal));
      this.pump(pending.scopeState);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.removeAbortListener = () =>
      signal.removeEventListener("abort", onAbort);
  }

  private pump(scopeState: ScopeState) {
    if (scopeState.current !== undefined) return;
    while (scopeState.pending.length !== 0) {
      const pending = scopeState.pending.shift()!;
      pending.removeAbortListener?.();
      if (pending.signal?.aborted) {
        pending.reject(abortReason(pending.signal));
        continue;
      }
      const lease = new SpatialSkeletonEditRequestLeaseImpl(
        this,
        scopeState,
        pending.editRequestScope,
      );
      scopeState.current = lease;
      pending.resolve(lease);
      return;
    }
  }
}

let globalSpatialSkeletonEditRequestLock = new SpatialSkeletonEditRequestLock();

/** Replaces the process-global coordinator to isolate independent unit tests. */
export function resetGlobalSpatialSkeletonEditRequestLockForTesting() {
  globalSpatialSkeletonEditRequestLock = new SpatialSkeletonEditRequestLock();
}

export interface SpatialSkeletonScheduledRequest<TEditRequest> {
  /** Runs only after the authority lease is active. */
  readonly materializeEditRequest: (
    context: SpatialSkeletonEditRequestMaterializationContext,
  ) => TEditRequest | Promise<TEditRequest>;
  /** Cancels acquisition only; it is disconnected before `commit` starts. */
  readonly signal?: AbortSignal;
  /** Transfers the acquired plan lease before transport is invoked. */
  readonly onLeaseAcquired?: (lease: SpatialSkeletonEditRequestLease) => void;
  /** Called after materialization at the final adapter.commit() boundary. */
  readonly onCommitStarting?: () => void;
}

export interface SpatialSkeletonEditRequestAttemptSettlement<
  TResult,
  TEditRequest = unknown,
> {
  readonly operationId: number;
  readonly outcome: SpatialSkeletonEditRequestOutcome<TResult>;
  /** Exact under-lease edit request passed to adapter.commit(), when reached. */
  readonly editRequest?: TEditRequest;
  /**
   * Present once physical authority was acquired. The plan owns this
   * lease until preview and history are definitively done, or until a
   * reload-required fence is abandoned by page unload.
   */
  readonly lease?: SpatialSkeletonEditRequestLease;
}

export type SpatialSkeletonEditRequestAttemptPhase =
  | "waiting-for-lease"
  | "committing"
  | "settled";

export interface SpatialSkeletonEditRequestAttemptSubmission<
  TResult,
  TEditRequest = unknown,
> {
  readonly operationId: number;
  readonly phase: SpatialSkeletonEditRequestAttemptPhase;
  readonly settled: Promise<
    SpatialSkeletonEditRequestAttemptSettlement<TResult, TEditRequest>
  >;
  /** Cancels this attempt if and only if adapter transport has not started. */
  cancelBeforeCommit(reason?: unknown): boolean;
}

export interface SpatialSkeletonRequestSchedulerOptions<TEditRequest, TResult> {
  readonly adapter: SpatialSkeletonEditRequestAdapter<TEditRequest, TResult>;
  readonly coordinator?: SpatialSkeletonEditRequestLock;
}

export class SpatialSkeletonRequestSchedulerDisposedError extends Error {
  constructor() {
    super("The spatial skeleton edit request attempt scheduler is disposed.");
    this.name = "SpatialSkeletonRequestSchedulerDisposedError";
  }
}

export class SpatialSkeletonEditRequestAttemptNotStartedError extends Error {
  constructor(readonly reason: unknown) {
    super("The spatial skeleton edit request attempt did not start.");
    this.name = "SpatialSkeletonEditRequestAttemptNotStartedError";
  }
}

export class SpatialSkeletonEditRequestAttemptMaterializationError extends Error {
  constructor(readonly reason: unknown) {
    super(
      "The spatial skeleton edit request could not be materialized under lease.",
      {
        cause: reason,
      },
    );
    this.name = "SpatialSkeletonEditRequestAttemptMaterializationError";
  }
}

interface AttemptRecord {
  operationId: number;
  controller: AbortController;
  externalSignalDisposer?: () => void;
  lease?: SpatialSkeletonEditRequestLease;
  leaseOwnedByCaller: boolean;
  phase: SpatialSkeletonEditRequestAttemptPhase;
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
 * Dispatches physical edit request attempts under global authority leases.
 *
 * It deliberately knows nothing about previews, intent capacity, history,
 * rollback/replay, or queue snapshots. Those are owned by
 * `SpatialSkeletonEditQueue`.
 */
export class SpatialSkeletonRequestScheduler<TEditRequest, TResult> {
  private readonly adapter: SpatialSkeletonEditRequestAdapter<
    TEditRequest,
    TResult
  >;
  private readonly coordinator: SpatialSkeletonEditRequestLock;
  private readonly editRequestScope: object;
  private readonly attempts = new Set<AttemptRecord>();
  private disposed = false;

  constructor(
    options: SpatialSkeletonRequestSchedulerOptions<TEditRequest, TResult>,
  ) {
    this.adapter = options.adapter;
    // Snapshot the provider's required stable scope once. Every attempt from
    // this instance belongs to that target, including compound plan steps.
    this.editRequestScope = options.adapter.editRequestScope;
    this.coordinator =
      options.coordinator ?? globalSpatialSkeletonEditRequestLock;
  }

  schedule(
    intent: SpatialSkeletonEditRequestIntent,
    request: SpatialSkeletonScheduledRequest<TEditRequest>,
  ): SpatialSkeletonEditRequestAttemptSubmission<TResult, TEditRequest> {
    return this.startAttempt(intent, request, (signal) => {
      return this.coordinator.acquire({
        editRequestScope: this.editRequestScope,
        signal,
      });
    });
  }

  runWithLease(
    lease: SpatialSkeletonEditRequestLease,
    intent: SpatialSkeletonEditRequestIntent,
    request: SpatialSkeletonScheduledRequest<TEditRequest>,
  ): SpatialSkeletonEditRequestAttemptSubmission<TResult, TEditRequest> {
    if (lease.editRequestScope !== this.editRequestScope) {
      throw new Error(
        "An edit request attempt cannot reuse a lease from another edit request scope.",
      );
    }
    if (lease.state !== "active") {
      throw new Error(
        "A compound edit request attempt requires its active plan lease.",
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
    const error = new SpatialSkeletonRequestSchedulerDisposedError();
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
    intent: SpatialSkeletonEditRequestIntent,
    request: SpatialSkeletonScheduledRequest<TEditRequest>,
    acquire: (signal: AbortSignal) => Promise<SpatialSkeletonEditRequestLease>,
    leaseOwnedByCaller = false,
  ): SpatialSkeletonEditRequestAttemptSubmission<TResult, TEditRequest> {
    if (this.disposed) {
      throw new SpatialSkeletonRequestSchedulerDisposedError();
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
    intent: SpatialSkeletonEditRequestIntent,
    request: SpatialSkeletonScheduledRequest<TEditRequest>,
    acquire: (signal: AbortSignal) => Promise<SpatialSkeletonEditRequestLease>,
  ): Promise<
    SpatialSkeletonEditRequestAttemptSettlement<TResult, TEditRequest>
  > {
    let lease: SpatialSkeletonEditRequestLease;
    try {
      lease = await acquire(record.controller.signal);
      record.lease = lease;
    } catch (error) {
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonEditRequestAttemptNotStartedError(error),
        },
      };
    }

    // Cancellation can win after the coordinator grants a queued lease but
    // before this continuation runs. Release that lease without exposing it
    // to the plan or invoking provider transport.
    if (record.controller.signal.aborted) {
      if (!record.leaseOwnedByCaller) lease.release();
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonEditRequestAttemptNotStartedError(
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
          error: new SpatialSkeletonEditRequestAttemptNotStartedError(error),
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
          error: new SpatialSkeletonEditRequestAttemptNotStartedError(
            record.controller.signal.reason,
          ),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }

    let materializedEditRequest: TEditRequest;
    try {
      materializedEditRequest = await request.materializeEditRequest({
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
          error: new SpatialSkeletonEditRequestAttemptMaterializationError(
            error,
          ),
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
          error: new SpatialSkeletonEditRequestAttemptNotStartedError(
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
          error: new SpatialSkeletonEditRequestAttemptNotStartedError(error),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }
    // onCommitStarting may synchronously notify observers.  A Reload-required observer
    // is allowed to win that re-entrant boundary while the submission still
    // truthfully reports waiting-for-lease.  Honor its successful
    // cancelBeforeCommit() before changing phase or invoking the adapter.
    if (record.controller.signal.aborted) {
      if (!record.leaseOwnedByCaller) lease.release();
      return {
        operationId: record.operationId,
        outcome: {
          status: "not-started",
          error: new SpatialSkeletonEditRequestAttemptNotStartedError(
            record.controller.signal.reason,
          ),
        },
        ...(record.leaseOwnedByCaller ? { lease } : {}),
      };
    }
    record.externalSignalDisposer?.();
    record.externalSignalDisposer = undefined;
    record.phase = "committing";

    const outcome = await commitSpatialSkeletonEditRequest(
      this.adapter,
      materializedEditRequest,
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
      editRequest: materializedEditRequest,
    };
  }
}
