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

import type { SpatialSkeletonQueueInputPreparation } from "#src/skeleton/command_protocol.js";
import type { SpatialSkeletonMutationAuthorityLease } from "#src/skeleton/optimistic_edit/authority_lease_coordinator.js";
import {
  SpatialSkeletonOptimisticReloadRequiredError,
  type SpatialSkeletonOptimisticFatalState,
  type SpatialSkeletonOptimisticFatalStatePort,
} from "#src/skeleton/optimistic_edit/fatal.js";
import { unchangedSpatialSkeletonOptimisticEditSettlement } from "#src/skeleton/optimistic_edit/lifecycle.js";
import type {
  SpatialSkeletonIntentDriver,
  SpatialSkeletonOptimisticHistoryPort,
  SpatialSkeletonOptimisticPreparationPort,
  SpatialSkeletonOptimisticProjectionPort,
} from "#src/skeleton/optimistic_edit/ports.js";
import type {
  SpatialSkeletonMutationAttemptScheduler,
  SpatialSkeletonMutationAttemptSubmission,
} from "#src/skeleton/optimistic_edit/scheduler.js";
import type {
  SpatialSkeletonOptimisticAuthorityPresentation,
  SpatialSkeletonOptimisticEditExecution,
  SpatialSkeletonOptimisticEditSettlement,
} from "#src/skeleton/optimistic_edit/types.js";
import type {
  SpatialSkeletonCommittedMutationAttempt,
  SpatialSkeletonIntentJournal,
  SpatialSkeletonIntentRecord,
} from "#src/skeleton/spatial_skeleton_intent_journal.js";

export interface PromiseResolver<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function createPromiseResolver<T>(): PromiseResolver<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  let settled = false;
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    },
    reject(reason) {
      if (settled) return;
      settled = true;
      reject(reason);
    },
  };
}

export class SpatialSkeletonOptimisticQueueEngineDisposedError extends Error {
  constructor() {
    super("The optimistic queue was disposed before the intent settled.");
    this.name = "SpatialSkeletonOptimisticQueueEngineDisposedError";
  }
}

export interface SpatialSkeletonOptimisticQueueEngineOptions<
  TInput,
  THistoryTicket,
  TWorkflow,
  TProjection,
  TMutation,
  TResult,
  TReconciliation,
  TInverseProjection = TProjection,
> {
  readonly driver: SpatialSkeletonIntentDriver<
    TInput,
    TWorkflow,
    TProjection,
    TMutation,
    TResult,
    TReconciliation,
    TInverseProjection
  >;
  readonly projection: SpatialSkeletonOptimisticProjectionPort<
    TProjection,
    TReconciliation,
    TInverseProjection
  >;
  readonly history: SpatialSkeletonOptimisticHistoryPort<
    TInput,
    THistoryTicket
  >;
  readonly attempts: SpatialSkeletonMutationAttemptScheduler<
    TMutation,
    TResult
  >;
  readonly preparation?: SpatialSkeletonOptimisticPreparationPort;
  /** Layer-scoped, first-write-wins fatal state owned by SpatialSkeletonState. */
  readonly fatalState: SpatialSkeletonOptimisticFatalStatePort;
  readonly onListenerError?: (error: unknown) => void;
}

export interface ProjectionValue<T> {
  value?: T;
}

export interface EngineMetadata<TInput, TWorkflow, THistoryTicket> {
  readonly input: TInput;
  readonly workflow?: TWorkflow;
  readonly inputPreparation?: SpatialSkeletonQueueInputPreparation;
  readonly historyTicket: THistoryTicket;
  readonly historyEntryId: string | number;
  readonly kind: string;
  readonly commandLabel?: string;
  readonly authorityPresentation?: SpatialSkeletonOptimisticAuthorityPresentation;
}

export type EngineIntentRecord<
  TInput,
  TWorkflow,
  THistoryTicket,
  TProjection,
  TInverseProjection,
  TMutation,
  TResult,
> = SpatialSkeletonIntentRecord<
  string | number,
  ProjectionValue<TProjection>,
  ProjectionValue<TInverseProjection>,
  EngineMetadata<TInput, TWorkflow, THistoryTicket>,
  SpatialSkeletonCommittedMutationAttempt<TMutation, TResult>
>;

export type EngineIntentJournal<
  TInput,
  TWorkflow,
  THistoryTicket,
  TProjection,
  TInverseProjection,
  TMutation,
  TResult,
> = SpatialSkeletonIntentJournal<
  string | number,
  ProjectionValue<TProjection>,
  ProjectionValue<TInverseProjection>,
  EngineMetadata<TInput, TWorkflow, THistoryTicket>,
  SpatialSkeletonCommittedMutationAttempt<TMutation, TResult>
>;

/**
 * The only non-canonical per-intent runtime state. Semantic workflow state,
 * lifecycle, attempts, dependencies, and history identity live in the journal.
 */
export interface EngineIntentRuntime<TResult> {
  readonly exact: PromiseResolver<boolean>;
  readonly settled: PromiseResolver<
    SpatialSkeletonOptimisticEditSettlement<TResult>
  >;
  inputAbortController?: AbortController;
  releaseAdmissionInputs?: () => void;
  lease?: SpatialSkeletonMutationAuthorityLease;
  submission?: SpatialSkeletonMutationAttemptSubmission<TResult>;
}

export function createSpatialSkeletonNoOpExecution<TResult>(value: boolean) {
  const promise = Promise.resolve(
    value,
  ) as SpatialSkeletonOptimisticEditExecution<boolean, TResult>;
  Object.defineProperties(promise, {
    acceptedByQueue: { value: Promise.resolve() },
    settled: {
      value: Promise.resolve(
        unchangedSpatialSkeletonOptimisticEditSettlement("no-op"),
      ),
    },
  });
  return promise;
}

export function createSpatialSkeletonReloadRequiredExecution<TResult>(
  fatalState: SpatialSkeletonOptimisticFatalState,
) {
  const error = new SpatialSkeletonOptimisticReloadRequiredError(fatalState);
  const promise = Promise.reject(
    error,
  ) as SpatialSkeletonOptimisticEditExecution<boolean, TResult>;
  Object.defineProperties(promise, {
    acceptedByQueue: { value: Promise.reject(error) },
    settled: {
      value: Promise.resolve(
        unchangedSpatialSkeletonOptimisticEditSettlement("not-started", error),
      ),
    },
  });
  // `acceptedByQueue` may be deliberately ignored by direct callers observing the
  // main execution promise.
  void promise.acceptedByQueue.catch(() => undefined);
  return promise;
}

export function createSpatialSkeletonExecution<TResult>(
  runtime: EngineIntentRuntime<TResult>,
) {
  const execution = runtime.exact
    .promise as SpatialSkeletonOptimisticEditExecution<boolean, TResult>;
  Object.defineProperties(execution, {
    acceptedByQueue: { value: Promise.resolve() },
    settled: { value: runtime.settled.promise },
  });
  return execution;
}

type EngineIntentRuntimeAllowedField =
  | "exact"
  | "settled"
  | "submission"
  | "lease"
  | "inputAbortController"
  | "releaseAdmissionInputs";
const engineIntentRuntimeFieldGuard: {
  [Field in keyof EngineIntentRuntime<unknown>]-?: Field extends EngineIntentRuntimeAllowedField
    ? true
    : never;
} = {
  exact: true,
  settled: true,
  submission: true,
  lease: true,
  inputAbortController: true,
  releaseAdmissionInputs: true,
};
void engineIntentRuntimeFieldGuard;
