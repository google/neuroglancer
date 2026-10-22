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

export type SpatialSkeletonMutationAuthorityLeaseState =
  | "active"
  | "retained"
  | "released";

export interface SpatialSkeletonMutationAuthorityLease {
  readonly mutationScope: object;
  readonly state: SpatialSkeletonMutationAuthorityLeaseState;
  /** Permanently fences the mutation scope until the lease is released. */
  retain(): boolean;
  /** Removes the scope fence and grants the next FIFO waiter, if any. */
  release(): boolean;
}

export interface SpatialSkeletonMutationAuthorityLeaseAcquireRequest {
  readonly mutationScope: object;
  readonly signal?: AbortSignal;
}

interface ScopeState {
  current?: SpatialSkeletonMutationAuthorityLeaseImpl;
  readonly pending: PendingAcquisition[];
}

interface PendingAcquisition {
  readonly scopeState: ScopeState;
  readonly mutationScope: object;
  readonly signal?: AbortSignal;
  resolve(lease: SpatialSkeletonMutationAuthorityLeaseImpl): void;
  reject(error: unknown): void;
  removeAbortListener?: () => void;
}

function abortReason(signal: AbortSignal) {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

function validateMutationScope(mutationScope: object) {
  if (
    mutationScope === null ||
    (typeof mutationScope !== "object" && typeof mutationScope !== "function")
  ) {
    throw new TypeError("A mutation authority lease requires an object scope.");
  }
}

class SpatialSkeletonMutationAuthorityLeaseImpl
  implements SpatialSkeletonMutationAuthorityLease
{
  private currentState: SpatialSkeletonMutationAuthorityLeaseState = "active";

  constructor(
    private readonly coordinator: SpatialSkeletonMutationAuthorityLeaseCoordinator,
    readonly scopeState: ScopeState,
    readonly mutationScope: object,
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
 * Global FIFO authority coordinator keyed only by datasource mutation scope.
 *
 * A scope has exactly one mutation lane.  The lease remains in that lane
 * while the engine publishes projection/history state, and compound workflow
 * steps may reuse it without reacquiring.  Distinct intents release and join
 * the FIFO again.
 */
export class SpatialSkeletonMutationAuthorityLeaseCoordinator {
  private readonly scopes = new WeakMap<object, ScopeState>();
  private operationSequence = 0;

  allocateOperationId() {
    return ++this.operationSequence;
  }

  acquire(
    request: SpatialSkeletonMutationAuthorityLeaseAcquireRequest,
  ): Promise<SpatialSkeletonMutationAuthorityLease> {
    try {
      validateMutationScope(request.mutationScope);
    } catch (error) {
      return Promise.reject(error);
    }
    if (request.signal?.aborted) {
      return Promise.reject(abortReason(request.signal));
    }
    const scopeState = this.getScopeState(request.mutationScope);
    return new Promise<SpatialSkeletonMutationAuthorityLease>(
      (resolve, reject) => {
        const pending: PendingAcquisition = {
          scopeState,
          mutationScope: request.mutationScope,
          signal: request.signal,
          resolve,
          reject,
        };
        this.installAbortListener(pending);
        scopeState.pending.push(pending);
        this.pump(scopeState);
      },
    );
  }

  onLeaseReleased(lease: SpatialSkeletonMutationAuthorityLeaseImpl) {
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
      const lease = new SpatialSkeletonMutationAuthorityLeaseImpl(
        this,
        scopeState,
        pending.mutationScope,
      );
      scopeState.current = lease;
      pending.resolve(lease);
      return;
    }
  }
}

export let globalSpatialSkeletonMutationAuthorityLeaseCoordinator =
  new SpatialSkeletonMutationAuthorityLeaseCoordinator();

/** Replaces the process-global coordinator to isolate independent unit tests. */
export function resetGlobalSpatialSkeletonMutationAuthorityLeaseCoordinatorForTesting() {
  globalSpatialSkeletonMutationAuthorityLeaseCoordinator =
    new SpatialSkeletonMutationAuthorityLeaseCoordinator();
}
