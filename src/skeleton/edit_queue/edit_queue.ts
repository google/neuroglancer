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
 * @file Moves each Execute, Undo or Redo intent from admission through preview
 * and edit requests to settlement, rolling back its preview and history when
 * the authority rejects it.
 */

import type {
  SpatialSkeletonIntentDescription,
  SpatialSkeletonIntentPlan,
  SpatialSkeletonEditRequestOutcome,
  SpatialSkeletonPreviewIntentArtifact,
  SpatialSkeletonEditPlanner,
  SpatialSkeletonHistoryPort,
  SpatialSkeletonPendingEditPort,
  SpatialSkeletonPreviewPort,
  SpatialSkeletonPreviewHistoryRecipe,
} from "#src/skeleton/edit_queue/api.js";
import {
  SpatialSkeletonInspectionRequiredError,
  SpatialSkeletonEditQueueCapacityError,
} from "#src/skeleton/edit_queue/edit_errors.js";
import type {
  SpatialSkeletonIntentKind,
  SpatialSkeletonCommittedEditRequestAttempt,
  SpatialSkeletonIntentRecord,
} from "#src/skeleton/edit_queue/edit_intent_journal.js";
import { SpatialSkeletonIntentJournal } from "#src/skeleton/edit_queue/edit_intent_journal.js";
import {
  buildSpatialSkeletonEditQueueRows,
  buildSpatialSkeletonEditRecentActivity,
} from "#src/skeleton/edit_queue/edit_queue_rows.js";
import type {
  SpatialSkeletonPreparedQueueInput,
  SpatialSkeletonQueueInput,
  SpatialSkeletonQueueInputPreparation,
} from "#src/skeleton/edit_queue/queue_input.js";
import type {
  SpatialSkeletonEditRequestAttemptSettlement,
  SpatialSkeletonRequestScheduler,
  SpatialSkeletonEditRequestAttemptSubmission,
  SpatialSkeletonEditRequestLease,
} from "#src/skeleton/edit_queue/request_scheduler.js";
import { spatialSkeletonStableSegment } from "#src/skeleton/edit_queue/stable_id_handles.js";
import type {
  SpatialSkeletonEditExecution,
  SpatialSkeletonSessionEditQueue,
  SpatialSkeletonEditSettlement,
  SpatialSkeletonReloadRequiredDetails,
  SpatialSkeletonAuthorityLabels,
  SpatialSkeletonReloadRequiredPort,
} from "#src/skeleton/edit_queue/types.js";
import {
  committedSpatialSkeletonEditSettlement,
  freezeSpatialSkeletonReloadRequiredDetails,
  SpatialSkeletonReloadRequiredError,
  unchangedSpatialSkeletonEditSettlement,
} from "#src/skeleton/edit_queue/types.js";
import { NullarySignal } from "#src/util/signal.js";

export interface SpatialSkeletonEditQueueHistoryOptions<
  TInput,
  THistoryTicket,
  TPlan,
  TPreview,
  TEditRequest,
  TResult,
  TReconciliation,
  TInversePreview,
> {
  readonly journal: QueueIntentJournal<
    TInput,
    TPlan,
    THistoryTicket,
    TPreview,
    TInversePreview,
    TEditRequest,
    TResult
  >;
  readonly runtimes: Map<number, QueueIntentRuntime<TResult>>;
  readonly history: SpatialSkeletonHistoryPort<TInput, THistoryTicket>;
  readonly preview: SpatialSkeletonPreviewPort<
    TPreview,
    TReconciliation,
    TInversePreview
  >;
}

/** Read-only recipe and retention queries over canonical engine state. */
class SpatialSkeletonEditQueueHistory<
  TInput,
  THistoryTicket,
  TPlan,
  TPreview,
  TEditRequest,
  TResult,
  TReconciliation,
  TInversePreview,
> {
  constructor(
    private readonly options: SpatialSkeletonEditQueueHistoryOptions<
      TInput,
      THistoryTicket,
      TPlan,
      TPreview,
      TEditRequest,
      TResult,
      TReconciliation,
      TInversePreview
    >,
  ) {}

  getQueuedOppositeTarget(
    intent: SpatialSkeletonIntentKind,
    historyEntryId: string | number,
    dependencySequences: readonly number[],
  ) {
    if (intent === "execute") return undefined;
    for (const dependencyId of [...dependencySequences].reverse()) {
      const dependency = this.options.journal.get(dependencyId);
      if (
        dependency !== undefined &&
        !dependency.terminal &&
        dependency.lifecycle.authority === "queued" &&
        dependency.metadata.historyEntryId === historyEntryId &&
        dependency.kind !== intent &&
        !this.hasUnresolvedSameEntryDependency(dependency.sequence)
      ) {
        return dependency.sequence;
      }
    }
    return undefined;
  }

  getPreviewedQueuedOppositeTarget(intent: "undo" | "redo") {
    const historyEntryId = this.options.history.getPreviewedEntryId(intent);
    if (historyEntryId === undefined) return undefined;
    return this.options.journal
      .getEntries({ includeTerminal: false })
      .reverse()
      .find(
        (entry) =>
          entry.metadata.historyEntryId === historyEntryId &&
          entry.kind !== intent &&
          entry.lifecycle.authority === "queued" &&
          !this.hasUnresolvedSameEntryDependency(entry.sequence),
      )?.sequence;
  }

  private hasUnresolvedSameEntryDependency(intentId: number) {
    const entry = this.options.journal.get(intentId);
    if (entry === undefined) return false;
    return this.options.journal
      .getBlockingDependencies(intentId)
      .some(
        (dependencyId) =>
          this.options.journal.get(dependencyId)?.metadata.historyEntryId ===
          entry.metadata.historyEntryId,
      );
  }

  getActivePreviewArtifacts(excludeIntentId?: number) {
    return this.options.journal
      .getEntries({ includeTerminal: false })
      .filter(
        (entry) =>
          entry.sequence !== excludeIntentId &&
          entry.lifecycle.preview === "exact",
      )
      .flatMap((entry) => this.getPreviewArtifact(entry.sequence));
  }

  getPreviewArtifacts(intentIds: readonly number[]) {
    return intentIds.flatMap((intentId) => this.getPreviewArtifact(intentId));
  }

  private getPreviewArtifact(
    intentId: number,
  ): readonly SpatialSkeletonPreviewIntentArtifact<
    TPreview,
    TInversePreview
  >[] {
    const entry = this.options.journal.get(intentId);
    const preview = entry?.requestedResult.value;
    const inversePreview = entry?.inverseDelta.value;
    return preview === undefined || inversePreview === undefined
      ? []
      : [{ intentId, preview, inversePreview }];
  }

  getHistoryRecipeByEntryId(
    historyEntryId: string | number,
  ):
    | SpatialSkeletonPreviewHistoryRecipe<TPlan, TPreview, TInversePreview>
    | undefined {
    const candidates = this.options.journal
      .getEntries()
      .filter(
        (entry) =>
          entry.metadata.historyEntryId === historyEntryId &&
          entry.requestedResult.value !== undefined,
      );
    return this.createHistoryRecipe(
      candidates.find((candidate) => candidate.kind === "execute") ??
        candidates.at(-1),
    );
  }

  getCanonicalHistoryInput(historyEntryId: string | number) {
    const candidates = this.options.journal
      .getEntries()
      .filter((entry) => entry.metadata.historyEntryId === historyEntryId);
    return (
      candidates.find((candidate) => candidate.kind === "execute") ??
      candidates.at(-1)
    )?.metadata.input;
  }

  getCanonicalInputPreparation(historyEntryId: string | number) {
    return this.options.journal
      .getEntries()
      .find(
        (entry) =>
          entry.kind === "execute" &&
          entry.metadata.historyEntryId === historyEntryId,
      )?.metadata.inputPreparation;
  }

  private createHistoryRecipe(
    entry:
      | QueueIntentRecord<
          TInput,
          TPlan,
          THistoryTicket,
          TPreview,
          TInversePreview,
          TEditRequest,
          TResult
        >
      | undefined,
  ) {
    const preview = entry?.requestedResult.value;
    return entry === undefined ||
      preview === undefined ||
      entry.metadata.plan === undefined
      ? undefined
      : {
          plan: entry.metadata.plan,
          preview,
          inversePreview: entry.inverseDelta.value,
        };
  }

  refreshCanonicalRecipeFromRedo(
    redoEntry: QueueIntentRecord<
      TInput,
      TPlan,
      THistoryTicket,
      TPreview,
      TInversePreview,
      TEditRequest,
      TResult
    >,
    artifact: SpatialSkeletonPreviewIntentArtifact<TPreview, TInversePreview>,
  ) {
    if (redoEntry.kind !== "redo") return;
    const canonical = this.options.journal
      .getEntries()
      .find(
        (entry) =>
          entry.kind === "execute" &&
          entry.metadata.historyEntryId === redoEntry.metadata.historyEntryId,
      );
    if (canonical === undefined) {
      throw new Error(
        `History entry ${redoEntry.metadata.historyEntryId} lost its canonical Execute recipe.`,
      );
    }
    this.options.journal.refreshRetainedRecord(canonical.sequence, {
      requestedResult: { value: artifact.preview },
      inverseDelta: { value: artifact.inversePreview },
      metadata: {
        ...canonical.metadata,
        plan: redoEntry.metadata.plan,
      },
    });
  }

  syncRetainedHistoryResources() {
    const retainedEntryIds = new Set(
      this.options.history.getRetainedEntryIds(),
    );
    const previews = this.options.journal
      .getEntries()
      .filter(
        (entry) =>
          entry.kind === "execute" &&
          retainedEntryIds.has(entry.metadata.historyEntryId),
      )
      .flatMap((entry) => {
        const preview = entry.requestedResult.value;
        return preview === undefined ? [] : [preview];
      });
    this.options.preview.setRetainedHistoryPreviews(previews);
  }

  compactTerminalState() {
    const retainedEntryIds = new Set(
      this.options.history.getRetainedEntryIds(),
    );
    const canonicalSequences = this.options.journal
      .getEntries()
      .filter(
        (entry) =>
          entry.kind === "execute" &&
          retainedEntryIds.has(entry.metadata.historyEntryId),
      )
      .map(({ sequence }) => sequence);
    this.syncRetainedHistoryResources();
    this.options.journal.compactTerminalRecords({
      retainRecent: this.options.history.capacity,
      preserveSequences: canonicalSequences,
    });
    for (const [intentId, runtime] of this.options.runtimes) {
      if (runtime.settled.settled) this.options.runtimes.delete(intentId);
    }
  }
}

export interface PromiseResolver<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function createPromiseResolver<T>(): PromiseResolver<T> {
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

export class SpatialSkeletonEditQueueDisposedError extends Error {
  constructor() {
    super("The optimistic queue was disposed before the intent settled.");
    this.name = "SpatialSkeletonEditQueueDisposedError";
  }
}

export interface SpatialSkeletonEditQueueOptions<
  TInput,
  THistoryTicket,
  TPlan,
  TPreview,
  TEditRequest,
  TResult,
  TReconciliation,
  TInversePreview = TPreview,
> {
  readonly planner: SpatialSkeletonEditPlanner<
    TInput,
    TPlan,
    TPreview,
    TEditRequest,
    TResult,
    TReconciliation,
    TInversePreview
  >;
  readonly preview: SpatialSkeletonPreviewPort<
    TPreview,
    TReconciliation,
    TInversePreview
  >;
  readonly history: SpatialSkeletonHistoryPort<TInput, THistoryTicket>;
  readonly attempts: SpatialSkeletonRequestScheduler<TEditRequest, TResult>;
  readonly pendingEdit?: SpatialSkeletonPendingEditPort;
  /** Layer-scoped, first-write-wins Reload-required state owned by SpatialSkeletonEditSession. */
  readonly reloadRequired: SpatialSkeletonReloadRequiredPort;
  readonly onListenerError?: (error: unknown) => void;
}

export interface PreviewValue<T> {
  value?: T;
}

export interface QueueMetadata<TInput, TPlan, THistoryTicket> {
  readonly input: TInput;
  readonly plan?: TPlan;
  readonly inputPreparation?: SpatialSkeletonQueueInputPreparation;
  readonly historyTicket: THistoryTicket;
  readonly historyEntryId: string | number;
  readonly kind: string;
  readonly commandLabel?: string;
  readonly authorityLabels?: SpatialSkeletonAuthorityLabels;
}

type QueueIntentRecord<
  TInput,
  TPlan,
  THistoryTicket,
  TPreview,
  TInversePreview,
  TEditRequest,
  TResult,
> = SpatialSkeletonIntentRecord<
  PreviewValue<TPreview>,
  PreviewValue<TInversePreview>,
  QueueMetadata<TInput, TPlan, THistoryTicket>,
  SpatialSkeletonCommittedEditRequestAttempt<TEditRequest, TResult>
>;

type QueueIntentJournal<
  TInput,
  TPlan,
  THistoryTicket,
  TPreview,
  TInversePreview,
  TEditRequest,
  TResult,
> = SpatialSkeletonIntentJournal<
  string | number,
  PreviewValue<TPreview>,
  PreviewValue<TInversePreview>,
  QueueMetadata<TInput, TPlan, THistoryTicket>,
  SpatialSkeletonCommittedEditRequestAttempt<TEditRequest, TResult>
>;

/**
 * The only non-canonical per-intent runtime state. Semantic plan state,
 * lifecycle, attempts, dependencies, and history identity live in the journal.
 */
interface QueueIntentRuntime<TResult> {
  readonly exact: PromiseResolver<boolean>;
  readonly settled: PromiseResolver<SpatialSkeletonEditSettlement<TResult>>;
  inputAbortController?: AbortController;
  releaseAdmissionInputs?: () => void;
  lease?: SpatialSkeletonEditRequestLease;
  submission?: SpatialSkeletonEditRequestAttemptSubmission<TResult>;
}

function createSpatialSkeletonNoOpExecution<TResult>(value: boolean) {
  const promise = Promise.resolve(value) as SpatialSkeletonEditExecution<
    boolean,
    TResult
  >;
  Object.defineProperties(promise, {
    acceptedByQueue: { value: Promise.resolve() },
    settled: {
      value: Promise.resolve(unchangedSpatialSkeletonEditSettlement("no-op")),
    },
  });
  return promise;
}

function createSpatialSkeletonReloadRequiredExecution<TResult>(
  reloadRequired: SpatialSkeletonReloadRequiredDetails,
) {
  const error = new SpatialSkeletonReloadRequiredError(reloadRequired);
  const promise = Promise.reject(error) as SpatialSkeletonEditExecution<
    boolean,
    TResult
  >;
  Object.defineProperties(promise, {
    acceptedByQueue: { value: Promise.reject(error) },
    settled: {
      value: Promise.resolve(
        unchangedSpatialSkeletonEditSettlement("not-started", error),
      ),
    },
  });
  // `acceptedByQueue` may be deliberately ignored by direct callers observing the
  // main execution promise.
  void promise.acceptedByQueue.catch(() => undefined);
  return promise;
}

function createSpatialSkeletonExecution<TResult>(
  runtime: QueueIntentRuntime<TResult>,
) {
  const execution = runtime.exact.promise as SpatialSkeletonEditExecution<
    boolean,
    TResult
  >;
  Object.defineProperties(execution, {
    acceptedByQueue: { value: Promise.resolve() },
    settled: { value: runtime.settled.promise },
  });
  return execution;
}

type QueueIntentRuntimeAllowedField =
  | "exact"
  | "settled"
  | "submission"
  | "lease"
  | "inputAbortController"
  | "releaseAdmissionInputs";
const queueIntentRuntimeFieldGuard: {
  [Field in keyof QueueIntentRuntime<unknown>]-?: Field extends QueueIntentRuntimeAllowedField
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
void queueIntentRuntimeFieldGuard;
let nextSpatialSkeletonEditQueueInstanceId = 1;

/**
 * Datasource-neutral optimistic queue for logical user/history intents.
 *
 * The engine owns admission, dependency order, lifecycle, history settlement,
 * rollback closure selection, physical-attempt scheduling, and reload-required
 * lease ownership. Provider ports own opaque preview values and plan
 * details.
 */
export class SpatialSkeletonEditQueue<
  TInput,
  THistoryTicket,
  TPlan,
  TPreview,
  TEditRequest,
  TResult,
  TReconciliation,
  TInversePreview = TPreview,
> implements SpatialSkeletonSessionEditQueue
{
  private readonly journal: QueueIntentJournal<
    TInput,
    TPlan,
    THistoryTicket,
    TPreview,
    TInversePreview,
    TEditRequest,
    TResult
  >;

  private readonly runtimes = new Map<number, QueueIntentRuntime<TResult>>();
  private readonly queueInstanceId = nextSpatialSkeletonEditQueueInstanceId++;
  private readonly changed = new NullarySignal();
  private readonly historyOperations: SpatialSkeletonEditQueueHistory<
    TInput,
    THistoryTicket,
    TPlan,
    TPreview,
    TEditRequest,
    TResult,
    TReconciliation,
    TInversePreview
  >;
  private readonly options: SpatialSkeletonEditQueueOptions<
    TInput,
    THistoryTicket,
    TPlan,
    TPreview,
    TEditRequest,
    TResult,
    TReconciliation,
    TInversePreview
  >;
  private handledReloadRequired?: SpatialSkeletonReloadRequiredDetails;
  private previewArtifactSubscriptionCleanup?: () => void;
  private readonly disposalCompletionResolver = createPromiseResolver<void>();
  private activePlanCount = 0;
  private authorityGeneration = 0;
  private disposed = false;

  constructor(
    options: SpatialSkeletonEditQueueOptions<
      TInput,
      THistoryTicket,
      TPlan,
      TPreview,
      TEditRequest,
      TResult,
      TReconciliation,
      TInversePreview
    >,
  ) {
    this.options = options;
    this.journal = new SpatialSkeletonIntentJournal(options.history.capacity);
    this.historyOperations = new SpatialSkeletonEditQueueHistory({
      journal: this.journal,
      runtimes: this.runtimes,
      history: options.history,
      preview: options.preview,
    });
    this.previewArtifactSubscriptionCleanup =
      options.preview.subscribePreviewArtifacts((artifacts) =>
        this.refreshExactPreviewArtifacts(artifacts),
      );
  }

  submitExecute(
    input: TInput,
    queueInput:
      | SpatialSkeletonQueueInput
      | SpatialSkeletonQueueInputPreparation,
  ): SpatialSkeletonEditExecution<boolean, TResult> {
    return this.submitTransition(input, "execute", queueInput);
  }

  submitUndo(): SpatialSkeletonEditExecution<boolean, TResult> {
    return this.submitTransition(undefined, "undo");
  }

  submitRedo(): SpatialSkeletonEditExecution<boolean, TResult> {
    return this.submitTransition(undefined, "redo");
  }

  private submitTransition(
    input: TInput | undefined,
    intent: SpatialSkeletonIntentKind,
    queueInput?:
      | SpatialSkeletonQueueInput
      | SpatialSkeletonQueueInputPreparation,
  ): SpatialSkeletonEditExecution<boolean, TResult> {
    this.requireActive();
    this.requireEditingAllowed();
    const capacityCoalescingTarget =
      intent === "execute"
        ? undefined
        : this.historyOperations.getPreviewedQueuedOppositeTarget(intent);
    if (!this.journal.canAdmit(capacityCoalescingTarget)) {
      throw new SpatialSkeletonEditQueueCapacityError(this.journal.capacity);
    }
    let inputPreparation =
      queueInput !== undefined && "acquire" in queueInput
        ? queueInput
        : undefined;
    let releaseAdmissionInputs = inputPreparation?.validate("execute");
    const reservation = this.journal.reserveSequence();
    let historyTicket: THistoryTicket | undefined;
    try {
      historyTicket =
        intent === "execute"
          ? this.options.history.stageExecute(input!)
          : intent === "undo"
            ? this.options.history.stageUndo()
            : this.options.history.stageRedo();
    } catch (error) {
      this.journal.cancelSequenceReservation(reservation);
      releaseAdmissionInputs?.();
      throw error;
    }
    if (historyTicket === undefined) {
      this.journal.cancelSequenceReservation(reservation);
      releaseAdmissionInputs?.();
      return createSpatialSkeletonNoOpExecution<TResult>(false);
    }
    let historyTicketId: string | number;
    let historyEntryId: string | number;
    let descriptor: SpatialSkeletonIntentDescription &
      Partial<SpatialSkeletonIntentPlan<TPlan, TPreview>>;
    let historyDependencySequences: number[];
    let transitionInput: TInput;
    let coalescesSequence: number | undefined;
    try {
      historyTicketId = this.options.history.getTicketId(historyTicket);
      historyEntryId = this.options.history.getEntryId(historyTicket);
      historyDependencySequences = this.options.history
        .getSemanticDependencyTicketIds(historyTicket)
        .flatMap((ticketId) => {
          const dependency = this.journal.getByHistoryTicket(ticketId);
          return dependency === undefined ? [] : [dependency.sequence];
        });
      coalescesSequence =
        this.historyOperations.getQueuedOppositeTarget(
          intent,
          historyEntryId,
          historyDependencySequences,
        ) ?? capacityCoalescingTarget;
      transitionInput =
        intent === "execute"
          ? input!
          : this.historyOperations.getCanonicalHistoryInput(historyEntryId)!;
      if (transitionInput === undefined) {
        throw new Error("Command history lost its canonical intent.");
      }
      if (intent !== "execute") {
        inputPreparation =
          this.historyOperations.getCanonicalInputPreparation(historyEntryId);
      }
      const target =
        coalescesSequence === undefined
          ? undefined
          : this.journal.get(coalescesSequence);
      if (target !== undefined) {
        descriptor = {
          kind: target.metadata.kind,
          commandLabel: target.metadata.commandLabel,
          authorityLabels: target.metadata.authorityLabels,
          stableResources: target.resources,
          preview: target.requestedResult.value,
          plan: target.metadata.plan,
        };
      } else if (intent === "execute") {
        if (queueInput === undefined)
          throw new Error("Execute is missing its input policy.");
        descriptor =
          inputPreparation !== undefined
            ? this.options.planner.describeIntent(transitionInput)
            : this.options.planner.planIntent(transitionInput, {
                intentId: reservation.sequence,
                intent,
                queueInput: queueInput as SpatialSkeletonQueueInput,
              });
      } else {
        const recipe =
          this.historyOperations.getHistoryRecipeByEntryId(historyEntryId);
        if (
          (recipe === undefined || recipe.inversePreview === undefined) &&
          intent === "redo" &&
          inputPreparation !== undefined
        ) {
          releaseAdmissionInputs = inputPreparation.validate("redo");
          descriptor = this.options.planner.describeIntent(transitionInput);
        } else {
          if (
            recipe === undefined ||
            (intent === "undo" && recipe.inversePreview === undefined)
          ) {
            throw new Error("History is missing its exact recipe.");
          }
          descriptor = this.options.planner.planIntent(transitionInput, {
            intentId: reservation.sequence,
            intent,
            recipe,
          });
        }
      }
    } catch (error) {
      this.journal.cancelSequenceReservation(reservation);
      this.options.history.abandonLatest(historyTicket);
      releaseAdmissionInputs?.();
      throw error;
    }
    let admitted;
    try {
      admitted = this.journal.admit(
        {
          kind: intent,
          historyTicketId,
          resources: descriptor.stableResources ?? [
            {
              handle: spatialSkeletonStableSegment("queue-input-preparation"),
              access: "write" as const,
            },
          ],
          semanticDependencySequences: [
            ...historyDependencySequences,
            ...(descriptor.semanticDependencies ?? []),
            // Unknown preparation resources form a conservative layer barrier.
            // New intents acquire their inputs against the preceding exact state.
            ...this.journal
              .getEntries({ includeTerminal: false })
              .filter(
                (entry) =>
                  (intent === "execute" && inputPreparation !== undefined) ||
                  descriptor.plan === undefined ||
                  entry.metadata.plan === undefined,
              )
              .map((entry) => entry.sequence),
          ],
          requestedResult: { value: descriptor.preview },
          inverseDelta: {},
          metadata: {
            input: transitionInput,
            plan: descriptor.plan,
            inputPreparation,
            historyTicket,
            historyEntryId,
            kind: descriptor.kind,
            commandLabel: descriptor.commandLabel,
            authorityLabels: descriptor.authorityLabels,
          },
          coalescesSequence,
        },
        reservation,
      );
    } catch (error) {
      this.journal.cancelSequenceReservation(reservation);
      this.options.history.abandonLatest(historyTicket);
      releaseAdmissionInputs?.();
      throw error;
    }
    const runtime: QueueIntentRuntime<TResult> = {
      exact: createPromiseResolver<boolean>(),
      settled: createPromiseResolver<SpatialSkeletonEditSettlement<TResult>>(),
      releaseAdmissionInputs,
    };
    void runtime.exact.promise.catch(() => undefined);
    void runtime.settled.promise.catch(() => undefined);
    this.runtimes.set(admitted.sequence, runtime);
    this.historyOperations.syncRetainedHistoryResources();
    if (descriptor.pendingEdit !== undefined) {
      try {
        this.options.pendingEdit?.publish(
          admitted.sequence,
          intent,
          descriptor.pendingEdit,
        );
      } catch (error) {
        this.options.onListenerError?.(error);
      }
    }
    this.notifyChanged();
    if (coalescesSequence !== undefined) {
      this.coalesceQueuedOpposite(
        admitted.sequence,
        runtime,
        coalescesSequence,
      );
    } else {
      this.pumpPreparations();
    }
    return createSpatialSkeletonExecution(runtime);
  }

  subscribe(listener: () => void) {
    return this.changed.add(listener);
  }

  canUndo() {
    if (this.getReloadRequired() !== undefined) return false;
    return this.options.history.canStage("undo");
  }

  canRedo() {
    if (this.getReloadRequired() !== undefined) return false;
    return this.options.history.canStage("redo");
  }

  undoLatest() {
    const reloadRequired = this.getReloadRequired();
    if (reloadRequired !== undefined) {
      return createSpatialSkeletonReloadRequiredExecution<TResult>(
        reloadRequired,
      );
    }
    return this.submitHistoryTransition("undo");
  }

  redoLatest() {
    const reloadRequired = this.getReloadRequired();
    if (reloadRequired !== undefined) {
      return createSpatialSkeletonReloadRequiredExecution<TResult>(
        reloadRequired,
      );
    }
    return this.submitHistoryTransition("redo");
  }

  hasUnconfirmedActions() {
    return (
      this.getReloadRequired() !== undefined ||
      this.journal.hasUnresolvedIntents
    );
  }

  getReloadRequired() {
    return this.options.reloadRequired.get();
  }

  handleReloadRequiredLatched(
    reloadRequired: SpatialSkeletonReloadRequiredDetails,
  ) {
    this.options.reloadRequired.latch(reloadRequired);
    this.handleLatchedReloadRequired();
  }

  getProtectedPreviewSegmentIds() {
    return [
      ...new Set([
        ...this.options.preview.getProtectedSegmentIds(),
        ...this.journal
          .getEntries({ includeTerminal: false })
          .flatMap(
            (entry) =>
              entry.metadata.inputPreparation?.getProtectedSegmentIds() ?? [],
          ),
      ]),
    ];
  }

  ownsAuthoritativeReadSegment(segmentId: bigint) {
    return this.options.preview.ownsAuthoritativeReadSegment(segmentId);
  }

  getSnapshot() {
    return buildSpatialSkeletonEditQueueRows(
      this.journal.getEntries(),
      this.queueInstanceId,
    );
  }

  getRecentActivity() {
    return buildSpatialSkeletonEditRecentActivity(
      this.journal.getEntries(),
      this.options.history.capacity,
    );
  }

  dispose() {
    if (this.disposed) return this.disposalCompletionResolver.promise;
    this.disposed = true;
    this.previewArtifactSubscriptionCleanup?.();
    this.previewArtifactSubscriptionCleanup = undefined;
    this.options.attempts.dispose();
    const runtimes = [...this.runtimes.entries()];
    const disposalError = new SpatialSkeletonEditQueueDisposedError();

    const rollbackIntents = this.historyOperations.getPreviewArtifacts(
      runtimes.map(([intentId]) => intentId).sort((a, b) => b - a),
    );
    if (rollbackIntents.length !== 0) {
      try {
        this.options.preview.rollbackAndReplay({
          rollbackIntents,
          replayIntents: [],
        });
      } catch (error) {
        this.latchLocalPreviewResetFailure(rollbackIntents[0]!.intentId, error);
        this.options.onListenerError?.(error);
      }
    }

    this.options.history.reset();
    for (const [intentId, runtime] of runtimes) {
      const entry = this.journal.get(intentId);
      if (entry === undefined || entry.terminal) continue;
      this.removePendingEdit(intentId);
      runtime.exact.reject(disposalError);
      if (
        entry.lifecycle.authority === "committed" ||
        entry.lifecycle.authority === "indeterminate" ||
        entry.lifecycle.reconciliation === "blocked"
      ) {
        runtime.lease?.retain();
        continue;
      }
      if (
        entry.lifecycle.preview !== "rolled-back" &&
        entry.lifecycle.preview !== "promoted"
      ) {
        this.journal.setPreviewState(intentId, "rolled-back");
      }
      this.options.preview.discardPrepared(intentId);
      if (entry.committedEditRequestAttempts.length !== 0) {
        this.blockForReload(intentId, runtime, "committed", disposalError);
        continue;
      }
      if (runtime.submission !== undefined) {
        runtime.submission.cancelBeforeCommit(disposalError);
        continue;
      }
      this.finishDisposedUnchanged(
        intentId,
        runtime,
        "not-started",
        disposalError,
      );
    }
    this.historyOperations.syncRetainedHistoryResources();
    this.notifyChanged();
    this.resolveDisposalCompletionIfReady();
    return this.disposalCompletionResolver.promise;
  }

  private refreshExactPreviewArtifacts(
    artifacts: readonly SpatialSkeletonPreviewIntentArtifact<
      TPreview,
      TInversePreview
    >[],
  ) {
    if (this.disposed || artifacts.length === 0) return;
    try {
      this.journal.refreshExactPreviewArtifacts(
        artifacts.map(({ intentId, preview, inversePreview }) => ({
          sequence: intentId,
          requestedResult: { value: preview },
          inverseDelta: { value: inversePreview },
        })),
      );
    } catch (error) {
      // Preview adoption has already completed. A listener invariant is a
      // reporting-only fault and must never trigger preview rollback or a
      // datasource retry.
      try {
        this.options.onListenerError?.(error);
      } catch {
        // Reporting is best effort after an already-adopted publication.
      }
    }
  }

  private submitHistoryTransition(intent: "undo" | "redo") {
    return intent === "undo" ? this.submitUndo() : this.submitRedo();
  }

  private startPreparation(
    intentId: number,
    runtime: QueueIntentRuntime<TResult>,
  ) {
    this.journal.setPreviewState(intentId, "preparing");
    this.notifyChanged();
    // Admission and its truthful preparation cue are observable before any
    // potentially expensive reducer/materialization work begins. Warm exact
    // previews still publish on the next microtask and never wait for a lease.
    void Promise.resolve().then(() => this.prepareExact(intentId, runtime));
  }

  private async prepareExact(
    intentId: number,
    runtime: QueueIntentRuntime<TResult>,
  ): Promise<void> {
    try {
      let entry = this.requireJournalEntry(intentId);
      if (this.disposed || this.isTerminal(intentId)) return;
      let acquired: SpatialSkeletonPreparedQueueInput | undefined;
      const generation = this.authorityGeneration;
      try {
        const compilingInputs = entry.metadata.plan === undefined;
        if (compilingInputs) {
          const inputs = entry.metadata.inputPreparation;
          if (inputs === undefined)
            throw new Error("Preparing intent lost its input policy.");
          const controller = new AbortController();
          runtime.inputAbortController = controller;
          acquired = await inputs.acquire(
            controller.signal,
            entry.kind === "redo" ? "redo" : "execute",
          );
          if (this.disposed || this.isTerminal(intentId)) return;
          acquired.assertCurrent();
          const compiled = this.options.planner.planIntent(
            entry.metadata.input,
            {
              intentId,
              intent: "execute",
              queueInput: acquired.input,
            },
          );
          this.journal.refreshExactPreviewArtifacts([
            {
              sequence: intentId,
              requestedResult: { value: compiled.preview },
              inverseDelta: {},
              metadata: { ...entry.metadata, plan: compiled.plan },
            },
          ]);
          entry = this.requireJournalEntry(intentId);
          if (compiled.pendingEdit !== undefined) {
            this.options.pendingEdit?.publish(
              intentId,
              entry.kind,
              compiled.pendingEdit,
            );
          }
        }
        const historyRecipe =
          entry.kind === "execute" || compilingInputs
            ? undefined
            : this.historyOperations.getHistoryRecipeByEntryId(
                entry.metadata.historyEntryId,
              );
        const descriptor =
          historyRecipe === undefined || entry.kind === "execute"
            ? undefined
            : this.options.planner.planIntent(entry.metadata.input, {
                intentId,
                intent: entry.kind,
                recipe: historyRecipe,
              });
        const previewValue = descriptor?.preview ?? entry.requestedResult.value;
        if (previewValue === undefined) {
          throw new Error(
            `Optimistic intent ${intentId} has no preview recipe.`,
          );
        }
        const prepared = await this.options.preview.prepareExact(
          intentId,
          previewValue,
        );
        if (this.disposed || this.isTerminal(intentId)) {
          this.options.preview.discardPrepared(intentId);
          return;
        }
        if (historyRecipe !== undefined) {
          const latest = this.historyOperations.getHistoryRecipeByEntryId(
            entry.metadata.historyEntryId,
          );
          if (
            latest?.preview !== historyRecipe.preview ||
            latest?.inversePreview !== historyRecipe.inversePreview
          ) {
            // Authority may finish while an asynchronous history preview is
            // preparing. Discard that candidate and use the corrected recipe.
            this.options.preview.discardPrepared(intentId);
            return this.prepareExact(intentId, runtime);
          }
        }
        // Store the initially prepared pair before publication. If publication
        // rebuilds against a newer retained/read generation, its synchronous
        // artifact notification must remain the last writer of the inverse.
        this.journal.refreshExactPreviewArtifacts([
          {
            sequence: intentId,
            requestedResult: { value: prepared.preview },
            inverseDelta: { value: prepared.inversePreview },
            metadata:
              descriptor === undefined
                ? undefined
                : { ...entry.metadata, plan: descriptor.plan },
          },
        ]);
        acquired?.assertCurrent();
        this.options.preview.publishExact(intentId, prepared.preview);
        // A Redo whose Execute was canceled before input compilation publishes
        // its inspection seed once, then becomes the canonical history recipe.
        if (compilingInputs && entry.kind === "redo") {
          const published = this.requireJournalEntry(intentId);
          this.historyOperations.refreshCanonicalRecipeFromRedo(published, {
            intentId,
            preview: published.requestedResult.value!,
            inversePreview: published.inverseDelta.value!,
          });
        }
        this.historyOperations.syncRetainedHistoryResources();
        this.removePendingEdit(intentId);
        this.journal.setPreviewState(intentId, "exact");
        this.notifyChanged();
        this.pumpPreparations();
        this.pump();
        // Start any now-unblocked plan before exposing exact-preview
        // completion. The promise still means only "preview is exact", but a
        // caller that immediately observes a synchronous adapter does not race
        // the queue's own pump microtask.
        runtime.exact.resolve(true);
      } catch (error) {
        if (
          !this.disposed &&
          !this.isTerminal(intentId) &&
          generation !== this.authorityGeneration &&
          error instanceof SpatialSkeletonInspectionRequiredError &&
          (error.reason === "snapshot-changed" ||
            error.reason === "requirements-changed")
        ) {
          this.options.preview.discardPrepared(intentId);
          runtime.inputAbortController?.abort(
            new DOMException("Input versions changed.", "AbortError"),
          );
          this.journal.refreshExactPreviewArtifacts([
            {
              sequence: intentId,
              requestedResult: {},
              inverseDelta: {},
              metadata: {
                ...this.requireJournalEntry(intentId).metadata,
                plan: undefined,
              },
            },
          ]);
          acquired?.release();
          acquired = undefined;
          return this.prepareExact(intentId, runtime);
        }
        throw error;
      } finally {
        acquired?.release();
      }
    } catch (error) {
      this.options.preview.discardPrepared(intentId);
      if (this.isTerminal(intentId) || this.disposed) return;
      this.rejectBeforeAttempt(intentId, error);
    }
  }

  /**
   * Starts every independent preparation whose logical predecessors already
   * own an exact preview. Preparing work never waits for authority, but a
   * touching intent must not reduce against a workspace that is still missing
   * an earlier local delta.
   */
  private pumpPreparations() {
    if (this.disposed || this.getReloadRequired() !== undefined) return;
    for (const [intentId, runtime] of this.runtimes) {
      const entry = this.journal.get(intentId);
      if (
        entry === undefined ||
        entry.terminal ||
        entry.lifecycle.preview !== "reserved"
      ) {
        continue;
      }
      const waitsForExactPreview = entry.dependencySequences.some(
        (dependencyId) => {
          const dependency = this.journal.get(dependencyId);
          return (
            dependency !== undefined &&
            !dependency.terminal &&
            (dependency.lifecycle.preview === "reserved" ||
              dependency.lifecycle.preview === "preparing")
          );
        },
      );
      if (waitsForExactPreview) continue;
      this.startPreparation(intentId, runtime);
    }
  }

  private pump() {
    if (
      this.disposed ||
      this.getReloadRequired() !== undefined ||
      this.activePlanCount !== 0
    ) {
      return;
    }
    const entry = this.journal
      .getEntries({ includeTerminal: false })
      .sort((a, b) => a.sequence - b.sequence)[0];
    if (
      entry === undefined ||
      entry.lifecycle.preview !== "exact" ||
      entry.lifecycle.authority !== "queued" ||
      this.journal.getBlockingDependencies(entry.sequence).length !== 0
    ) {
      return;
    }
    const runtime = this.runtimes.get(entry.sequence);
    if (runtime === undefined) return;
    if (!this.journal.claimAuthorityPlan(entry.sequence)) return;
    ++this.activePlanCount;
    this.notifyChanged();
    void this.runPlan(entry.sequence, runtime);
  }

  private async runPlan(
    intentId: number,
    runtime: QueueIntentRuntime<TResult>,
  ) {
    try {
      const entry = this.requireJournalEntry(intentId);
      const context = () => this.createPlanContext(intentId);
      while (true) {
        if (
          this.isTerminal(intentId) ||
          this.getReloadRequired() !== undefined
        ) {
          return;
        }
        if (this.handleDisposedPlan(intentId, runtime)) return;
        const attempt = await this.options.planner.nextAttempt(
          this.requirePreparedPlan(entry),
          context(),
        );
        if (
          this.isTerminal(intentId) ||
          this.getReloadRequired() !== undefined
        ) {
          return;
        }
        if (this.handleDisposedPlan(intentId, runtime)) return;
        if (attempt === undefined) break;
        this.journal.setReconciliationState(intentId, "waiting");
        this.notifyChanged();
        const submission =
          runtime.lease === undefined
            ? this.options.attempts.schedule(entry.kind, {
                materializeEditRequest: attempt.materializeEditRequest,
                onLeaseAcquired: (lease) => {
                  runtime.lease = lease;
                },
                onCommitStarting: () => {
                  if (this.journal.markAuthorityCommitStarted(intentId)) {
                    this.notifyChanged();
                  }
                },
              })
            : this.options.attempts.runWithLease(runtime.lease, entry.kind, {
                materializeEditRequest: attempt.materializeEditRequest,
                onLeaseAcquired: (lease) => {
                  runtime.lease = lease;
                },
                onCommitStarting: () => {
                  if (this.journal.markAuthorityCommitStarted(intentId)) {
                    this.notifyChanged();
                  }
                },
              });
        runtime.submission = submission;
        const settlement = await submission.settled;
        runtime.submission = undefined;
        if (settlement.lease !== undefined) runtime.lease = settlement.lease;
        if (this.isTerminal(intentId)) {
          runtime.lease?.release();
          return;
        }
        if (this.disposed) {
          this.handleDisposedPlan(intentId, runtime, settlement.outcome);
          return;
        }
        if (settlement.outcome.status !== "committed") {
          this.handleAttemptFailure(intentId, runtime, settlement);
          return;
        }
        if (settlement.editRequest === undefined) {
          throw new Error(
            "A committed edit request settlement lost its request.",
          );
        }
        this.journal.recordCommittedEditRequestAttempt(
          intentId,
          Object.freeze({
            editRequest: settlement.editRequest,
            result: settlement.outcome.result,
          }),
        );
        if (this.disposed) {
          this.handleDisposedPlan(intentId, runtime);
          return;
        }
        if (this.getReloadRequired() !== undefined) {
          this.blockForReload(
            intentId,
            runtime,
            "committed",
            this.getReloadRequired(),
          );
          return;
        }
      }

      if (this.disposed) {
        this.handleDisposedPlan(intentId, runtime);
        return;
      }
      if (
        this.requireJournalEntry(intentId).committedEditRequestAttempts
          .length === 0
      ) {
        this.finishNoOp(intentId, runtime);
        return;
      }
      this.journal.markAuthorityCommitted(intentId);
      this.journal.setReconciliationState(intentId, "pending");
      this.notifyChanged();
      let reconciliation: TReconciliation;
      try {
        this.journal.setReconciliationState(intentId, "applying");
        reconciliation = await this.options.planner.createReconciliation(
          this.requirePreparedPlan(entry),
          context(),
        );
        if (this.getReloadRequired() !== undefined) {
          this.blockForReload(
            intentId,
            runtime,
            "committed",
            this.getReloadRequired(),
          );
          return;
        }
        if (this.disposed) {
          this.handleDisposedPlan(intentId, runtime);
          return;
        }
        const rebasedPlans = new Map<number, TPlan>();
        const finalizedArtifact = this.options.preview.publishAuthoritative({
          intentId,
          reconciliation,
          activePreviews:
            this.historyOperations.getActivePreviewArtifacts(intentId),
          rebaseActivePreview: (activeIntentId, precedingArtifacts) => {
            const active = this.requireJournalEntry(activeIntentId);
            if (active.kind === "execute") return undefined;
            const canonical = [...precedingArtifacts]
              .reverse()
              .find((artifact) => {
                const prior = this.requireJournalEntry(artifact.intentId);
                return (
                  prior.kind !== "undo" &&
                  prior.metadata.historyEntryId ===
                    active.metadata.historyEntryId
                );
              });
            if (canonical === undefined) return undefined;
            const prior = this.requireJournalEntry(canonical.intentId);
            const descriptor = this.options.planner.planIntent(
              active.metadata.input,
              {
                intentId: activeIntentId,
                intent: active.kind,
                recipe: {
                  plan:
                    rebasedPlans.get(canonical.intentId) ??
                    this.requirePreparedPlan(prior),
                  preview: canonical.preview,
                  inversePreview: canonical.inversePreview,
                },
              },
            );
            rebasedPlans.set(activeIntentId, descriptor.plan);
            return descriptor.preview;
          },
        });
        ++this.authorityGeneration;
        this.journal.refreshExactPreviewArtifacts([
          {
            sequence: intentId,
            requestedResult: { value: finalizedArtifact.preview },
            inverseDelta: { value: finalizedArtifact.inversePreview },
          },
          ...[...rebasedPlans].map(([sequence, plan]) => {
            const active = this.requireJournalEntry(sequence);
            return {
              sequence,
              requestedResult: active.requestedResult,
              inverseDelta: active.inverseDelta,
              metadata: { ...active.metadata, plan },
            };
          }),
        ]);
        this.historyOperations.refreshCanonicalRecipeFromRedo(
          entry,
          finalizedArtifact,
        );
        if (this.getReloadRequired() !== undefined) {
          this.blockForReload(
            intentId,
            runtime,
            "committed",
            this.getReloadRequired(),
          );
          return;
        }
        if (this.handleDisposedPlan(intentId, runtime)) return;
      } catch (error) {
        this.blockForReload(intentId, runtime, "committed", error);
        return;
      }
      this.finishCommitted(intentId, runtime);
    } catch (error) {
      const entry = this.journal.get(intentId);
      if (entry?.terminal === true) return;
      if (this.handleDisposedPlan(intentId, runtime, undefined, error)) {
        return;
      }
      if ((entry?.committedEditRequestAttempts.length ?? 0) !== 0) {
        this.blockForReload(intentId, runtime, "committed", error);
      } else this.rollbackDefinitive(intentId, "not-started", error);
    } finally {
      --this.activePlanCount;
      this.notifyChanged();
      this.resolveDisposalCompletionIfReady();
      this.pump();
    }
  }

  private resolveDisposalCompletionIfReady() {
    if (this.disposed && this.activePlanCount === 0) {
      this.disposalCompletionResolver.resolve(undefined);
    }
  }

  private createPlanContext(intentId: number) {
    const entry = this.requireJournalEntry(intentId);
    const committedAttempts = entry.committedEditRequestAttempts;
    return Object.freeze({
      intentId,
      intent: entry.kind,
      committedAttempts,
    });
  }

  /**
   * Finishes classification for transport which outlived its queue instance.
   * Source/engine replacement is not allowed to turn an unsafe authoritative
   * result into a silent detached fence.
   */
  private handleDisposedPlan(
    intentId: number,
    runtime: QueueIntentRuntime<TResult>,
    outcome?: SpatialSkeletonEditRequestOutcome<TResult>,
    cause?: unknown,
  ) {
    if (!this.disposed) return false;
    const entry = this.journal.get(intentId);
    if (entry === undefined || entry.terminal) {
      runtime.lease?.release();
      return true;
    }
    const disposedError =
      cause ??
      (outcome !== undefined && outcome.status !== "committed"
        ? outcome.error
        : new SpatialSkeletonEditQueueDisposedError());
    if (outcome?.status === "indeterminate") {
      this.enterReloadRequired(
        intentId,
        runtime,
        "indeterminate",
        outcome.error,
      );
      this.journal.markReloadRequired(intentId, "indeterminate");
      this.notifyChanged();
      return true;
    }
    if (
      outcome?.status === "committed" ||
      entry.committedEditRequestAttempts.length !== 0
    ) {
      this.blockForReload(intentId, runtime, "committed", disposedError);
      return true;
    }

    // Authority is definitively unchanged. Disposal already removed every old
    // preview, and the history store may belong to a replacement source, so
    // settle only the detached canonical records and lease.
    this.finishDisposedUnchanged(
      intentId,
      runtime,
      outcome?.status === "rejected" ? "rejected" : "not-started",
      disposedError,
    );
    return true;
  }

  private finishDisposedUnchanged(
    intentId: number,
    runtime: QueueIntentRuntime<TResult>,
    reason: "not-started" | "rejected",
    error: unknown,
  ) {
    if (runtime.settled.settled) return;
    this.removePendingEdit(intentId);
    this.options.preview.discardPrepared(intentId);
    runtime.exact.reject(error);
    this.journal.settleUnchanged(intentId, reason, error);
    runtime.settled.resolve(
      unchangedSpatialSkeletonEditSettlement(reason, error),
    );
    runtime.lease?.release();
  }

  private handleAttemptFailure(
    intentId: number,
    runtime: QueueIntentRuntime<TResult>,
    settlement: SpatialSkeletonEditRequestAttemptSettlement<TResult>,
  ) {
    const { outcome } = settlement;
    if (outcome.status === "committed") return;
    if (
      this.requireJournalEntry(intentId).committedEditRequestAttempts.length !==
      0
    ) {
      // A later plan step cannot erase a commit already observed from
      // authority. Keep the lease and require a reload instead of attempting
      // another edit request or background reconciliation.
      this.blockForReload(intentId, runtime, "committed", outcome);
      return;
    }
    if (outcome.status === "indeterminate") {
      this.rollbackUnknown(intentId, runtime, outcome);
      return;
    }
    this.rollbackDefinitive(intentId, outcome.status, outcome.error);
  }

  private rejectBeforeAttempt(intentId: number, error: unknown) {
    this.rollbackDefinitive(intentId, "not-started", error);
    this.pumpPreparations();
    this.pump();
  }

  private rollbackDefinitive(
    intentId: number,
    reason: "not-started" | "rejected",
    error: unknown,
  ) {
    const suffix = this.journal
      .getEntries({ includeTerminal: false })
      .filter((entry) => entry.sequence >= intentId)
      .sort((a, b) => a.sequence - b.sequence);
    const laterError = new Error(
      "Canceled because an earlier edit was not saved.",
    );
    for (const entry of suffix.slice(1)) {
      const laterRuntime = this.runtimes.get(entry.sequence);
      if (
        laterRuntime?.submission !== undefined &&
        !laterRuntime.submission.cancelBeforeCommit(laterError)
      ) {
        this.blockForReload(
          entry.sequence,
          laterRuntime,
          "indeterminate",
          laterError,
        );
        return;
      }
    }
    const suffixIds = suffix.map(({ sequence }) => sequence);
    const suffixIdSet = new Set(suffixIds);
    try {
      this.options.preview.rollbackAndReplay({
        rollbackIntents: this.historyOperations.getPreviewArtifacts(
          [...suffixIds].reverse(),
        ),
        replayIntents: this.historyOperations
          .getActivePreviewArtifacts()
          .filter(
            ({ intentId: activeIntentId }) => !suffixIdSet.has(activeIntentId),
          ),
      });
    } catch (publicationError) {
      // Authority is definitively unchanged, but the layer can no longer
      // prove that its adopted preview matches canonical queue state.
      // Stop this layer, settle the rejected suffix, and require a reload
      // without retaining the datasource-wide lane.
      this.latchLocalPreviewResetFailure(intentId, publicationError, true);
      this.options.onListenerError?.(publicationError);
    }
    for (const suffixIntentId of suffixIds) {
      this.removePendingEdit(suffixIntentId);
      this.options.preview.discardPrepared(suffixIntentId);
    }
    this.journal.rejectActiveSuffix(intentId, {
      rootReason: reason,
      rootError: error,
      laterError,
    });
    if (this.getReloadRequired() === undefined) {
      try {
        this.options.history.rollbackFrom(
          this.requireJournalEntry(intentId).metadata.historyTicket,
        );
      } catch (historyError) {
        this.latchLocalPreviewResetFailure(intentId, historyError, true);
        this.options.onListenerError?.(historyError);
      }
    }
    this.historyOperations.syncRetainedHistoryResources();
    for (const suffixIntentId of suffixIds) {
      const suffixRuntime = this.runtimes.get(suffixIntentId);
      if (suffixRuntime === undefined) continue;
      const isRoot = suffixIntentId === intentId;
      const settlementError = isRoot ? error : laterError;
      suffixRuntime.exact.reject(settlementError);
      suffixRuntime.settled.resolve(
        unchangedSpatialSkeletonEditSettlement(
          isRoot ? reason : "not-started",
          settlementError,
        ),
      );
      suffixRuntime.lease?.release();
    }
    this.historyOperations.compactTerminalState();
    this.notifyChanged();
    this.pumpPreparations();
  }

  private latchLocalPreviewResetFailure(
    intentId: number,
    error: unknown,
    preserveRejectedSuffix = false,
  ) {
    if (this.getReloadRequired() !== undefined) return false;
    const reloadRequired = freezeSpatialSkeletonReloadRequiredDetails({
      reason: "local-preview-reset-failed",
      authority: "unchanged",
      intentId,
      cause: error,
    });
    const latched = this.options.reloadRequired.latch(reloadRequired);
    const effectiveReloadRequired = this.options.reloadRequired.get();
    if (effectiveReloadRequired === undefined) {
      throw new Error(
        "The session-owned Reload-required latch discarded its first value.",
      );
    }
    if (latched) {
      this.handledReloadRequired = effectiveReloadRequired;
      this.cancelUnsentForReloadRequired(
        intentId,
        false,
        preserveRejectedSuffix ? intentId : undefined,
      );
    } else {
      this.handleLatchedReloadRequired(intentId);
    }
    return latched;
  }

  private rollbackUnknown(
    intentId: number,
    runtime: QueueIntentRuntime<TResult>,
    outcome: Exclude<
      SpatialSkeletonEditRequestOutcome<TResult>,
      { status: "committed" }
    >,
  ) {
    this.enterReloadRequired(
      intentId,
      runtime,
      "indeterminate",
      outcome.error,
      true,
    );
    const journalRecord = this.journal.get(intentId);
    if (
      journalRecord !== undefined &&
      (journalRecord.lifecycle.preview === "reserved" ||
        journalRecord.lifecycle.preview === "preparing" ||
        journalRecord.lifecycle.preview === "exact")
    ) {
      this.journal.setPreviewState(intentId, "rolled-back");
    }
    this.journal.markReloadRequired(intentId, "indeterminate");
    // Settlement remains intentionally pending until the page is reloaded.
    this.notifyChanged();
  }

  private blockForReload(
    intentId: number,
    runtime: QueueIntentRuntime<TResult>,
    authority: "committed" | "indeterminate",
    error: unknown,
  ) {
    this.enterReloadRequired(intentId, runtime, authority, error);
    const journalRecord = this.journal.get(intentId);
    if (journalRecord !== undefined && !journalRecord.terminal) {
      this.journal.markReloadRequired(intentId, authority);
    }
    this.notifyChanged();
  }

  /**
   * Enters the layer-scoped terminal editing state before retaining authority.
   * This ordering lets cancellation win every waiting-for-lease attempt before
   * the coordinator can hand it the source lease released by an unsafe result.
   */
  private enterReloadRequired(
    faultingIntentId: number,
    faultingRuntime: QueueIntentRuntime<TResult>,
    authority: "committed" | "indeterminate",
    error: unknown,
    rollbackFaultingPreview = false,
  ) {
    const existing = this.getReloadRequired();
    if (existing !== undefined) {
      this.handleLatchedReloadRequired(faultingIntentId);
      faultingRuntime.lease?.retain();
      return false;
    }
    const reloadRequired = freezeSpatialSkeletonReloadRequiredDetails({
      reason:
        authority === "indeterminate"
          ? "authority-indeterminate"
          : "committed-local-publication-failed",
      authority,
      intentId: faultingIntentId,
      cause: error,
    });
    const latched = this.options.reloadRequired.latch(reloadRequired);
    const effectiveReloadRequired = this.options.reloadRequired.get();
    if (effectiveReloadRequired === undefined) {
      throw new Error(
        "The session-owned Reload-required latch discarded its first value.",
      );
    }
    if (latched) {
      this.handledReloadRequired = effectiveReloadRequired;
      this.cancelUnsentForReloadRequired(
        faultingIntentId,
        rollbackFaultingPreview,
      );
    }
    faultingRuntime.lease?.retain();
    return latched;
  }

  private handleLatchedReloadRequired(faultingIntentId?: number) {
    if (this.disposed) return;
    const effectiveReloadRequired = this.options.reloadRequired.get();
    if (effectiveReloadRequired === undefined) return;
    if (this.handledReloadRequired === effectiveReloadRequired) return;
    this.handledReloadRequired = effectiveReloadRequired;
    this.cancelUnsentForReloadRequired(faultingIntentId);
    this.notifyChanged();
  }

  private cancelUnsentForReloadRequired(
    faultingIntentId?: number,
    rollbackFaultingPreview = false,
    preserveIntentSequenceAtOrAfter?: number,
  ) {
    const cancellationError = new Error(
      "Canceled because another edit requires a page reload.",
    );
    this.options.history.reset();
    const canceled: Array<readonly [number, QueueIntentRuntime<TResult>]> = [];
    for (const [intentId, runtime] of this.runtimes) {
      const entry = this.journal.get(intentId);
      if (
        intentId === faultingIntentId ||
        (preserveIntentSequenceAtOrAfter !== undefined &&
          intentId >= preserveIntentSequenceAtOrAfter) ||
        entry === undefined ||
        entry.terminal
      ) {
        continue;
      }
      const { submission } = runtime;
      const canceledBeforeCommit =
        submission === undefined ||
        submission.cancelBeforeCommit(cancellationError);
      if (entry.committedEditRequestAttempts.length !== 0) {
        // A prior physical step already committed. Cancel any current step
        // which has not crossed adapter.commit(), but keep the plan and its
        // authority fence unresolved for Reload required.
        runtime.lease?.retain();
        if (canceledBeforeCommit) {
          this.journal.markReloadRequired(intentId, "committed");
        }
        continue;
      }
      if (submission !== undefined && !canceledBeforeCommit) {
        // Transport has started. It must finish classification and is never
        // converted into an artificial cancellation.
        continue;
      }
      canceled.push([intentId, runtime]);
    }
    const canceledIds = new Set(canceled.map(([intentId]) => intentId));
    if (rollbackFaultingPreview && faultingIntentId !== undefined) {
      canceledIds.add(faultingIntentId);
    }
    const rollbackIntents = this.historyOperations.getPreviewArtifacts(
      [
        ...canceled.map(([intentId]) => intentId),
        ...(rollbackFaultingPreview && faultingIntentId !== undefined
          ? [faultingIntentId]
          : []),
      ]
        .sort((first, second) => first - second)
        .reverse(),
    );
    const replayIntents = this.historyOperations
      .getActivePreviewArtifacts()
      .filter(({ intentId }) => !canceledIds.has(intentId));
    if (rollbackIntents.length !== 0) {
      try {
        this.options.preview.rollbackAndReplay({
          rollbackIntents,
          replayIntents,
        });
      } catch (publicationError) {
        this.options.onListenerError?.(publicationError);
      }
    }

    for (const [intentId, runtime] of canceled) {
      this.removePendingEdit(intentId);
      try {
        this.options.preview.discardPrepared(intentId);
        runtime.exact.reject(cancellationError);
        this.journal.settleUnchanged(
          intentId,
          "not-started",
          cancellationError,
        );
        runtime.settled.resolve(
          unchangedSpatialSkeletonEditSettlement(
            "not-started",
            cancellationError,
          ),
        );
        runtime.lease?.release();
      } catch (journalError) {
        this.options.onListenerError?.(journalError);
      }
    }
    this.historyOperations.syncRetainedHistoryResources();
  }

  private finishCommitted(
    intentId: number,
    runtime: QueueIntentRuntime<TResult>,
  ) {
    const entry = this.requireJournalEntry(intentId);
    this.options.history.confirm(entry.metadata.historyTicket);
    this.journal.settleSuccessful(intentId, "committed");
    this.removePendingEdit(intentId);
    runtime.lease?.release();
    const lastResult = entry.committedEditRequestAttempts.at(-1)?.result;
    runtime.settled.resolve(committedSpatialSkeletonEditSettlement(lastResult));
    this.historyOperations.compactTerminalState();
  }

  private finishNoOp(intentId: number, runtime: QueueIntentRuntime<TResult>) {
    const entry = this.requireJournalEntry(intentId);
    this.options.history.confirm(entry.metadata.historyTicket);
    this.journal.settleSuccessful(intentId, "no-op");
    this.removePendingEdit(intentId);
    runtime.lease?.release();
    runtime.settled.resolve(unchangedSpatialSkeletonEditSettlement("no-op"));
    this.historyOperations.compactTerminalState();
  }

  private coalesceQueuedOpposite(
    oppositeIntentId: number,
    opposite: QueueIntentRuntime<TResult>,
    targetIntentId: number,
  ) {
    const target = this.runtimes.get(targetIntentId);
    const targetEntry = this.journal.get(targetIntentId);
    if (
      target === undefined ||
      targetEntry === undefined ||
      targetEntry.lifecycle.authority !== "queued" ||
      targetEntry.terminal
    ) {
      this.rejectBeforeAttempt(
        oppositeIntentId,
        new Error("The queued opposite is no longer coalescible."),
      );
      return;
    }
    try {
      const rollbackIntents = this.historyOperations.getPreviewArtifacts([
        targetIntentId,
      ]);
      if (rollbackIntents.length !== 0) {
        this.options.preview.rollbackAndReplay({
          rollbackIntents,
          replayIntents: [],
        });
      }
      // A preparing opposite pair has not published either preview.  It can
      // settle immediately without manufacturing an inverse merely to remove
      // state which was never visible.  The retained forward recipe is enough
      // for a later Redo; that Redo captures its inverse during preparation.
      this.options.preview.discardPrepared(targetIntentId);
      this.options.preview.discardPrepared(oppositeIntentId);
      this.removePendingEdit(targetIntentId);
      this.removePendingEdit(oppositeIntentId);
      this.journal.setPreviewState(oppositeIntentId, "exact");
      this.journal.settleQueuedCancellationPair(
        targetIntentId,
        oppositeIntentId,
      );
      const oppositeEntry = this.requireJournalEntry(oppositeIntentId);
      this.options.history.confirm(targetEntry.metadata.historyTicket);
      this.options.history.confirm(oppositeEntry.metadata.historyTicket);
      for (const runtime of [target, opposite]) {
        runtime.exact.resolve(true);
        runtime.settled.resolve(
          unchangedSpatialSkeletonEditSettlement("no-op"),
        );
      }
      this.historyOperations.compactTerminalState();
      this.notifyChanged();
      this.pumpPreparations();
      this.pump();
    } catch (error) {
      // The target is the root of this net-neutral pair. Rejecting only the
      // later opposite would leave the original queued edit eligible to start.
      this.rejectBeforeAttempt(targetIntentId, error);
    }
  }

  private requirePreparedPlan(entry: {
    readonly metadata: { readonly plan?: TPlan };
  }): TPlan {
    if (entry.metadata.plan === undefined) {
      throw new Error(
        "An unprepared intent cannot start a server edit request.",
      );
    }
    return entry.metadata.plan;
  }

  private removePendingEdit(intentId: number) {
    const runtime = this.runtimes.get(intentId);
    runtime?.inputAbortController?.abort(
      new DOMException("Intent preparation ended.", "AbortError"),
    );
    runtime?.releaseAdmissionInputs?.();
    if (runtime !== undefined) {
      runtime.inputAbortController = undefined;
      runtime.releaseAdmissionInputs = undefined;
    }
    try {
      this.options.pendingEdit?.remove(intentId);
    } catch (error) {
      this.options.onListenerError?.(error);
    }
  }

  private requireJournalEntry(intentId: number) {
    const entry = this.journal.get(intentId);
    if (entry === undefined) {
      throw new Error(`Missing optimistic intent journal entry ${intentId}.`);
    }
    return entry;
  }

  private isTerminal(intentId: number) {
    return this.journal.get(intentId)?.terminal ?? true;
  }

  private requireActive() {
    if (this.disposed) {
      throw new SpatialSkeletonEditQueueDisposedError();
    }
  }

  private requireEditingAllowed() {
    const reloadRequired = this.getReloadRequired();
    if (reloadRequired !== undefined) {
      throw new SpatialSkeletonReloadRequiredError(reloadRequired);
    }
  }

  private notifyChanged() {
    try {
      this.changed.dispatch();
    } catch (error) {
      try {
        this.options.onListenerError?.(error);
      } catch {
        // Reporting is best effort after the change is already published.
      }
    }
  }
}
