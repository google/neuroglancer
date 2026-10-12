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

import type {
  SpatialSkeletonQueueInput,
  SpatialSkeletonQueueInputPreparation,
  SpatialSkeletonPreparedQueueInput,
} from "#src/skeleton/command_protocol.js";
import {
  SpatialSkeletonOptimisticQueueCapacityError,
  SpatialSkeletonInspectionRequiredError,
} from "#src/skeleton/edit_errors.js";
import { spatialSkeletonLogicalSegment } from "#src/skeleton/logical_identity.js";
import type { SpatialSkeletonMutationOutcome } from "#src/skeleton/optimistic_edit/api.js";
import { SpatialSkeletonOptimisticEngineHistory } from "#src/skeleton/optimistic_edit/engine_history.js";
import {
  projectSpatialSkeletonOptimisticQueueSnapshot,
  projectSpatialSkeletonOptimisticRecentActivity,
} from "#src/skeleton/optimistic_edit/engine_read_model.js";
import {
  createPromiseResolver,
  createSpatialSkeletonExecution,
  createSpatialSkeletonNoOpExecution,
  createSpatialSkeletonReloadRequiredExecution,
  SpatialSkeletonOptimisticQueueEngineDisposedError,
  type EngineIntentJournal,
  type EngineIntentRuntime,
  type SpatialSkeletonOptimisticQueueEngineOptions,
} from "#src/skeleton/optimistic_edit/engine_runtime.js";
import {
  freezeSpatialSkeletonOptimisticFatalState,
  SpatialSkeletonOptimisticReloadRequiredError,
  type SpatialSkeletonOptimisticFatalState,
} from "#src/skeleton/optimistic_edit/fatal.js";
import {
  committedSpatialSkeletonOptimisticEditSettlement,
  unchangedSpatialSkeletonOptimisticEditSettlement,
} from "#src/skeleton/optimistic_edit/lifecycle.js";
import type {
  SpatialSkeletonLogicalIntent,
  SpatialSkeletonIntentDescription,
  SpatialSkeletonProjectionIntentArtifact,
} from "#src/skeleton/optimistic_edit/ports.js";
import type { SpatialSkeletonMutationAttemptSettlement } from "#src/skeleton/optimistic_edit/scheduler.js";
import type {
  SpatialSkeletonOptimisticEditExecution,
  SpatialSkeletonOptimisticEditQueue,
  SpatialSkeletonOptimisticEditSettlement,
} from "#src/skeleton/optimistic_edit/types.js";
import {
  SpatialSkeletonIntentJournal,
  type SpatialSkeletonIntentKind,
} from "#src/skeleton/spatial_skeleton_intent_journal.js";
import { NullarySignal } from "#src/util/signal.js";

export {
  SpatialSkeletonOptimisticQueueEngineDisposedError,
  type SpatialSkeletonOptimisticQueueEngineOptions,
} from "#src/skeleton/optimistic_edit/engine_runtime.js";

let nextSpatialSkeletonOptimisticQueueInstanceId = 1;

/**
 * Datasource-neutral optimistic queue for logical user/history intents.
 *
 * The engine owns admission, dependency order, lifecycle, history settlement,
 * rollback closure selection, physical-attempt scheduling, and reload-required
 * lease ownership. Provider ports own opaque projection values and workflow
 * details.
 */
export class SpatialSkeletonOptimisticQueueEngine<
  TInput,
  THistoryTicket,
  TWorkflow,
  TProjection,
  TMutation,
  TResult,
  TReconciliation,
  TInverseProjection = TProjection,
> implements SpatialSkeletonOptimisticEditQueue
{
  private readonly journal: EngineIntentJournal<
    TInput,
    TWorkflow,
    THistoryTicket,
    TProjection,
    TInverseProjection,
    TMutation,
    TResult
  >;

  private readonly runtimes = new Map<number, EngineIntentRuntime<TResult>>();
  private readonly queueInstanceId =
    nextSpatialSkeletonOptimisticQueueInstanceId++;
  private readonly changed = new NullarySignal();
  private readonly historyOperations: SpatialSkeletonOptimisticEngineHistory<
    TInput,
    THistoryTicket,
    TWorkflow,
    TProjection,
    TMutation,
    TResult,
    TReconciliation,
    TInverseProjection
  >;
  private readonly options: SpatialSkeletonOptimisticQueueEngineOptions<
    TInput,
    THistoryTicket,
    TWorkflow,
    TProjection,
    TMutation,
    TResult,
    TReconciliation,
    TInverseProjection
  >;
  private handledFatalState?: SpatialSkeletonOptimisticFatalState;
  private projectionArtifactSubscriptionCleanup?: () => void;
  private readonly disposalCompletionResolver = createPromiseResolver<void>();
  private activeWorkflowCount = 0;
  private authorityGeneration = 0;
  private disposed = false;

  constructor(
    options: SpatialSkeletonOptimisticQueueEngineOptions<
      TInput,
      THistoryTicket,
      TWorkflow,
      TProjection,
      TMutation,
      TResult,
      TReconciliation,
      TInverseProjection
    >,
  ) {
    this.options = options;
    this.journal = new SpatialSkeletonIntentJournal(options.history.capacity);
    this.historyOperations = new SpatialSkeletonOptimisticEngineHistory({
      journal: this.journal,
      runtimes: this.runtimes,
      history: options.history,
      projection: options.projection,
    });
    this.projectionArtifactSubscriptionCleanup =
      options.projection.subscribeProjectionArtifacts((artifacts) =>
        this.refreshExactProjectionArtifacts(artifacts),
      );
  }

  submitExecute(
    input: TInput,
    queueInput:
      | SpatialSkeletonQueueInput
      | SpatialSkeletonQueueInputPreparation,
  ): SpatialSkeletonOptimisticEditExecution<boolean, TResult> {
    return this.submitTransition(input, "execute", queueInput);
  }

  submitUndo(): SpatialSkeletonOptimisticEditExecution<boolean, TResult> {
    return this.submitTransition(undefined, "undo");
  }

  submitRedo(): SpatialSkeletonOptimisticEditExecution<boolean, TResult> {
    return this.submitTransition(undefined, "redo");
  }

  private submitTransition(
    input: TInput | undefined,
    intent: SpatialSkeletonIntentKind,
    queueInput?:
      | SpatialSkeletonQueueInput
      | SpatialSkeletonQueueInputPreparation,
  ): SpatialSkeletonOptimisticEditExecution<boolean, TResult> {
    this.requireActive();
    this.requireEditingAllowed();
    const capacityCoalescingTarget =
      intent === "execute"
        ? undefined
        : this.historyOperations.getProjectedQueuedOppositeTarget(intent);
    if (!this.journal.canAdmit(capacityCoalescingTarget)) {
      throw new SpatialSkeletonOptimisticQueueCapacityError(
        this.journal.capacity,
      );
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
      Partial<SpatialSkeletonLogicalIntent<TWorkflow, TProjection>>;
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
          authorityPresentation: target.metadata.authorityPresentation,
          logicalResources: target.resources,
          projection: target.requestedResult.value,
          workflow: target.metadata.workflow,
        };
      } else if (intent === "execute") {
        if (queueInput === undefined)
          throw new Error("Execute is missing its input policy.");
        descriptor =
          inputPreparation !== undefined
            ? this.options.driver.describeIntent(transitionInput)
            : this.options.driver.createLogicalIntent(transitionInput, {
                intentId: reservation.sequence,
                intent,
                queueInput: queueInput as SpatialSkeletonQueueInput,
              });
      } else {
        const recipe =
          this.historyOperations.getHistoryRecipeByEntryId(historyEntryId);
        if (
          (recipe === undefined || recipe.inverseProjection === undefined) &&
          intent === "redo" &&
          inputPreparation !== undefined
        ) {
          releaseAdmissionInputs = inputPreparation.validate("redo");
          descriptor = this.options.driver.describeIntent(transitionInput);
        } else {
          if (
            recipe === undefined ||
            (intent === "undo" && recipe.inverseProjection === undefined)
          ) {
            throw new Error("History is missing its exact recipe.");
          }
          descriptor = this.options.driver.createLogicalIntent(
            transitionInput,
            {
              intentId: reservation.sequence,
              intent,
              recipe,
            },
          );
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
          resources: descriptor.logicalResources ?? [
            {
              handle: spatialSkeletonLogicalSegment("queue-input-preparation"),
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
                  descriptor.workflow === undefined ||
                  entry.metadata.workflow === undefined,
              )
              .map((entry) => entry.sequence),
          ],
          requestedResult: { value: descriptor.projection },
          inverseDelta: {},
          metadata: {
            input: transitionInput,
            workflow: descriptor.workflow,
            inputPreparation,
            historyTicket,
            historyEntryId,
            kind: descriptor.kind,
            commandLabel: descriptor.commandLabel,
            authorityPresentation: descriptor.authorityPresentation,
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
    const runtime: EngineIntentRuntime<TResult> = {
      exact: createPromiseResolver<boolean>(),
      settled:
        createPromiseResolver<
          SpatialSkeletonOptimisticEditSettlement<TResult>
        >(),
      releaseAdmissionInputs,
    };
    void runtime.exact.promise.catch(() => undefined);
    void runtime.settled.promise.catch(() => undefined);
    this.runtimes.set(admitted.sequence, runtime);
    this.historyOperations.syncRetainedHistoryResources();
    if (descriptor.preparation !== undefined) {
      try {
        this.options.preparation?.publish(
          admitted.sequence,
          intent,
          descriptor.preparation,
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
    if (this.getFatalState() !== undefined) return false;
    return this.options.history.canStage("undo");
  }

  canRedo() {
    if (this.getFatalState() !== undefined) return false;
    return this.options.history.canStage("redo");
  }

  undoLatest() {
    const fatalState = this.getFatalState();
    if (fatalState !== undefined) {
      return createSpatialSkeletonReloadRequiredExecution<TResult>(fatalState);
    }
    return this.submitHistoryTransition("undo");
  }

  redoLatest() {
    const fatalState = this.getFatalState();
    if (fatalState !== undefined) {
      return createSpatialSkeletonReloadRequiredExecution<TResult>(fatalState);
    }
    return this.submitHistoryTransition("redo");
  }

  hasUnconfirmedActions() {
    return (
      this.getFatalState() !== undefined || this.journal.hasUnresolvedIntents
    );
  }

  getFatalState() {
    return this.options.fatalState.get();
  }

  handleFatalStateLatched(fatalState: SpatialSkeletonOptimisticFatalState) {
    this.options.fatalState.latch(fatalState);
    this.handleLatchedFatalState();
  }

  getProtectedProjectionSegmentIds() {
    return [
      ...new Set([
        ...this.options.projection.getProtectedSegmentIds(),
        ...this.journal
          .getEntries({ includeTerminal: false })
          .flatMap(
            (entry) =>
              entry.metadata.inputPreparation?.getProtectedSegmentIds() ?? [],
          ),
      ]),
    ];
  }

  ownsAuthoritativeReadSegment(segmentId: number) {
    return this.options.projection.ownsAuthoritativeReadSegment(segmentId);
  }

  getSnapshot() {
    return projectSpatialSkeletonOptimisticQueueSnapshot(
      this.journal.getEntries(),
      this.queueInstanceId,
    );
  }

  getRecentActivity() {
    return projectSpatialSkeletonOptimisticRecentActivity(
      this.journal.getEntries(),
      this.queueInstanceId,
      this.options.history.capacity,
    );
  }

  dispose() {
    if (this.disposed) return this.disposalCompletionResolver.promise;
    this.disposed = true;
    this.projectionArtifactSubscriptionCleanup?.();
    this.projectionArtifactSubscriptionCleanup = undefined;
    this.options.attempts.dispose();
    const runtimes = [...this.runtimes.entries()];
    const disposalError =
      new SpatialSkeletonOptimisticQueueEngineDisposedError();

    const rollbackIntents = this.historyOperations.getProjectionArtifacts(
      runtimes.map(([intentId]) => intentId).sort((a, b) => b - a),
    );
    if (rollbackIntents.length !== 0) {
      try {
        this.options.projection.rollbackAndReplay({
          rollbackIntents,
          replayIntents: [],
        });
      } catch (error) {
        this.latchLocalProjectionResetFailure(
          rollbackIntents[0]!.intentId,
          error,
        );
        this.options.onListenerError?.(error);
      }
    }

    this.options.history.reset();
    for (const [intentId, runtime] of runtimes) {
      const entry = this.journal.get(intentId);
      if (entry === undefined || entry.terminal) continue;
      this.removePreparation(intentId);
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
      this.options.projection.discardPrepared(intentId);
      if (entry.committedMutationAttempts.length !== 0) {
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

  private refreshExactProjectionArtifacts(
    artifacts: readonly SpatialSkeletonProjectionIntentArtifact<
      TProjection,
      TInverseProjection
    >[],
  ) {
    if (this.disposed || artifacts.length === 0) return;
    try {
      this.journal.refreshExactProjectionArtifacts(
        artifacts.map(({ intentId, projection, inverseProjection }) => ({
          sequence: intentId,
          requestedResult: { value: projection },
          inverseDelta: { value: inverseProjection },
        })),
      );
    } catch (error) {
      // Projection adoption has already completed. A listener invariant is a
      // reporting-only fault and must never trigger projection rollback or a
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
    runtime: EngineIntentRuntime<TResult>,
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
    runtime: EngineIntentRuntime<TResult>,
  ): Promise<void> {
    try {
      let entry = this.requireJournalEntry(intentId);
      if (this.disposed || this.isTerminal(intentId)) return;
      let acquired: SpatialSkeletonPreparedQueueInput | undefined;
      const generation = this.authorityGeneration;
      try {
        const compilingInputs = entry.metadata.workflow === undefined;
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
          const compiled = this.options.driver.createLogicalIntent(
            entry.metadata.input,
            {
              intentId,
              intent: "execute",
              queueInput: acquired.input,
            },
          );
          this.journal.refreshExactProjectionArtifacts([
            {
              sequence: intentId,
              requestedResult: { value: compiled.projection },
              inverseDelta: {},
              metadata: { ...entry.metadata, workflow: compiled.workflow },
            },
          ]);
          entry = this.requireJournalEntry(intentId);
          if (compiled.preparation !== undefined) {
            this.options.preparation?.publish(
              intentId,
              entry.kind,
              compiled.preparation,
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
            : this.options.driver.createLogicalIntent(entry.metadata.input, {
                intentId,
                intent: entry.kind,
                recipe: historyRecipe,
              });
        const projectionValue =
          descriptor?.projection ?? entry.requestedResult.value;
        if (projectionValue === undefined) {
          throw new Error(
            `Optimistic intent ${intentId} has no projection recipe.`,
          );
        }
        const prepared = await this.options.projection.prepareExact(
          intentId,
          projectionValue,
        );
        if (this.disposed || this.isTerminal(intentId)) {
          this.options.projection.discardPrepared(intentId);
          return;
        }
        if (historyRecipe !== undefined) {
          const latest = this.historyOperations.getHistoryRecipeByEntryId(
            entry.metadata.historyEntryId,
          );
          if (
            latest?.projection !== historyRecipe.projection ||
            latest?.inverseProjection !== historyRecipe.inverseProjection
          ) {
            // Authority may finish while an asynchronous history preview is
            // preparing. Discard that candidate and use the corrected recipe.
            this.options.projection.discardPrepared(intentId);
            return this.prepareExact(intentId, runtime);
          }
        }
        // Store the initially prepared pair before publication. If publication
        // rebuilds against a newer retained/read generation, its synchronous
        // artifact notification must remain the last writer of the inverse.
        this.journal.refreshExactProjectionArtifacts([
          {
            sequence: intentId,
            requestedResult: { value: prepared.projection },
            inverseDelta: { value: prepared.inverseProjection },
            metadata:
              descriptor === undefined
                ? undefined
                : { ...entry.metadata, workflow: descriptor.workflow },
          },
        ]);
        acquired?.assertCurrent();
        this.options.projection.publishExact(intentId, prepared.projection);
        // A Redo whose Execute was canceled before input compilation publishes
        // its inspection seed once, then becomes the canonical history recipe.
        if (compilingInputs && entry.kind === "redo") {
          const published = this.requireJournalEntry(intentId);
          this.historyOperations.refreshCanonicalRecipeFromRedo(published, {
            intentId,
            projection: published.requestedResult.value!,
            inverseProjection: published.inverseDelta.value!,
          });
        }
        this.historyOperations.syncRetainedHistoryResources();
        this.removePreparation(intentId);
        this.journal.setPreviewState(intentId, "exact");
        this.notifyChanged();
        this.pumpPreparations();
        this.pump();
        // Start any now-unblocked workflow before exposing exact-preview
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
          this.options.projection.discardPrepared(intentId);
          runtime.inputAbortController?.abort(
            new DOMException("Input versions changed.", "AbortError"),
          );
          this.journal.refreshExactProjectionArtifacts([
            {
              sequence: intentId,
              requestedResult: {},
              inverseDelta: {},
              metadata: {
                ...this.requireJournalEntry(intentId).metadata,
                workflow: undefined,
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
      this.options.projection.discardPrepared(intentId);
      if (this.isTerminal(intentId) || this.disposed) return;
      this.rejectBeforeAttempt(intentId, error);
    }
  }

  /**
   * Starts every independent preparation whose logical predecessors already
   * own an exact projection. Preparing work never waits for authority, but a
   * touching intent must not reduce against a workspace that is still missing
   * an earlier local delta.
   */
  private pumpPreparations() {
    if (this.disposed || this.getFatalState() !== undefined) return;
    for (const [intentId, runtime] of this.runtimes) {
      const entry = this.journal.get(intentId);
      if (
        entry === undefined ||
        entry.terminal ||
        entry.lifecycle.preview !== "reserved"
      ) {
        continue;
      }
      const waitsForExactProjection = entry.dependencySequences.some(
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
      if (waitsForExactProjection) continue;
      this.startPreparation(intentId, runtime);
    }
  }

  private pump() {
    if (
      this.disposed ||
      this.getFatalState() !== undefined ||
      this.activeWorkflowCount !== 0
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
    if (!this.journal.claimAuthorityWorkflow(entry.sequence)) return;
    ++this.activeWorkflowCount;
    this.notifyChanged();
    void this.runWorkflow(entry.sequence, runtime);
  }

  private async runWorkflow(
    intentId: number,
    runtime: EngineIntentRuntime<TResult>,
  ) {
    try {
      const entry = this.requireJournalEntry(intentId);
      const context = () => this.createWorkflowContext(intentId);
      while (true) {
        if (this.isTerminal(intentId) || this.getFatalState() !== undefined) {
          return;
        }
        if (this.handleDisposedWorkflow(intentId, runtime)) return;
        const attempt = await this.options.driver.nextAttempt(
          this.requirePreparedWorkflow(entry),
          context(),
        );
        if (this.isTerminal(intentId) || this.getFatalState() !== undefined) {
          return;
        }
        if (this.handleDisposedWorkflow(intentId, runtime)) return;
        if (attempt === undefined) break;
        this.journal.setReconciliationState(intentId, "waiting");
        this.notifyChanged();
        const submission =
          runtime.lease === undefined
            ? this.options.attempts.schedule(entry.kind, {
                materializeMutation: attempt.materializeMutation,
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
                materializeMutation: attempt.materializeMutation,
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
          this.handleDisposedWorkflow(intentId, runtime, settlement.outcome);
          return;
        }
        if (settlement.outcome.status !== "committed") {
          this.handleAttemptFailure(intentId, runtime, settlement);
          return;
        }
        if (settlement.mutation === undefined) {
          throw new Error("A committed mutation settlement lost its request.");
        }
        this.journal.recordCommittedMutationAttempt(
          intentId,
          Object.freeze({
            mutation: settlement.mutation,
            result: settlement.outcome.result,
          }),
        );
        if (this.disposed) {
          this.handleDisposedWorkflow(intentId, runtime);
          return;
        }
        if (this.getFatalState() !== undefined) {
          this.blockForReload(
            intentId,
            runtime,
            "committed",
            this.getFatalState(),
          );
          return;
        }
      }

      if (this.disposed) {
        this.handleDisposedWorkflow(intentId, runtime);
        return;
      }
      if (
        this.requireJournalEntry(intentId).committedMutationAttempts.length ===
        0
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
        reconciliation = await this.options.driver.createReconciliation(
          this.requirePreparedWorkflow(entry),
          context(),
        );
        if (this.getFatalState() !== undefined) {
          this.blockForReload(
            intentId,
            runtime,
            "committed",
            this.getFatalState(),
          );
          return;
        }
        if (this.disposed) {
          this.handleDisposedWorkflow(intentId, runtime);
          return;
        }
        const rebasedWorkflows = new Map<number, TWorkflow>();
        const finalizedArtifact = this.options.projection.publishAuthoritative({
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
            const descriptor = this.options.driver.createLogicalIntent(
              active.metadata.input,
              {
                intentId: activeIntentId,
                intent: active.kind,
                recipe: {
                  workflow:
                    rebasedWorkflows.get(canonical.intentId) ??
                    this.requirePreparedWorkflow(prior),
                  projection: canonical.projection,
                  inverseProjection: canonical.inverseProjection,
                },
              },
            );
            rebasedWorkflows.set(activeIntentId, descriptor.workflow);
            return descriptor.projection;
          },
        });
        ++this.authorityGeneration;
        this.journal.refreshExactProjectionArtifacts([
          {
            sequence: intentId,
            requestedResult: { value: finalizedArtifact.projection },
            inverseDelta: { value: finalizedArtifact.inverseProjection },
          },
          ...[...rebasedWorkflows].map(([sequence, workflow]) => {
            const active = this.requireJournalEntry(sequence);
            return {
              sequence,
              requestedResult: active.requestedResult,
              inverseDelta: active.inverseDelta,
              metadata: { ...active.metadata, workflow },
            };
          }),
        ]);
        this.historyOperations.refreshCanonicalRecipeFromRedo(
          entry,
          finalizedArtifact,
        );
        if (this.getFatalState() !== undefined) {
          this.blockForReload(
            intentId,
            runtime,
            "committed",
            this.getFatalState(),
          );
          return;
        }
        if (this.handleDisposedWorkflow(intentId, runtime)) return;
      } catch (error) {
        this.blockForReload(intentId, runtime, "committed", error);
        return;
      }
      this.finishCommitted(intentId, runtime);
    } catch (error) {
      const entry = this.journal.get(intentId);
      if (entry?.terminal === true) return;
      if (this.handleDisposedWorkflow(intentId, runtime, undefined, error)) {
        return;
      }
      if ((entry?.committedMutationAttempts.length ?? 0) !== 0) {
        this.blockForReload(intentId, runtime, "committed", error);
      } else this.rollbackDefinitive(intentId, "not-started", error);
    } finally {
      --this.activeWorkflowCount;
      this.notifyChanged();
      this.resolveDisposalCompletionIfReady();
      this.pump();
    }
  }

  private resolveDisposalCompletionIfReady() {
    if (this.disposed && this.activeWorkflowCount === 0) {
      this.disposalCompletionResolver.resolve(undefined);
    }
  }

  private createWorkflowContext(intentId: number) {
    const entry = this.requireJournalEntry(intentId);
    const committedAttempts = entry.committedMutationAttempts;
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
  private handleDisposedWorkflow(
    intentId: number,
    runtime: EngineIntentRuntime<TResult>,
    outcome?: SpatialSkeletonMutationOutcome<TResult>,
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
        : new SpatialSkeletonOptimisticQueueEngineDisposedError());
    if (outcome?.status === "indeterminate") {
      this.enterFatalState(intentId, runtime, "indeterminate", outcome.error);
      this.journal.markReloadRequired(intentId, "indeterminate");
      this.notifyChanged();
      return true;
    }
    if (
      outcome?.status === "committed" ||
      entry.committedMutationAttempts.length !== 0
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
    runtime: EngineIntentRuntime<TResult>,
    reason: "not-started" | "rejected",
    error: unknown,
  ) {
    if (runtime.settled.settled) return;
    this.removePreparation(intentId);
    this.options.projection.discardPrepared(intentId);
    runtime.exact.reject(error);
    this.journal.settleUnchanged(intentId, reason, error);
    runtime.settled.resolve(
      unchangedSpatialSkeletonOptimisticEditSettlement(reason, error),
    );
    runtime.lease?.release();
  }

  private handleAttemptFailure(
    intentId: number,
    runtime: EngineIntentRuntime<TResult>,
    settlement: SpatialSkeletonMutationAttemptSettlement<TResult>,
  ) {
    const { outcome } = settlement;
    if (outcome.status === "committed") return;
    if (
      this.requireJournalEntry(intentId).committedMutationAttempts.length !== 0
    ) {
      // A later workflow step cannot erase a commit already observed from
      // authority. Keep the lease and require a reload instead of attempting
      // another mutation or background reconciliation.
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
      this.options.projection.rollbackAndReplay({
        rollbackIntents: this.historyOperations.getProjectionArtifacts(
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
      // prove that its adopted projection matches canonical queue state.
      // Stop this layer, settle the rejected suffix, and require a reload
      // without retaining the datasource-wide lane.
      this.latchLocalProjectionResetFailure(intentId, publicationError, true);
      this.options.onListenerError?.(publicationError);
    }
    for (const suffixIntentId of suffixIds) {
      this.removePreparation(suffixIntentId);
      this.options.projection.discardPrepared(suffixIntentId);
    }
    this.journal.rejectActiveSuffix(intentId, {
      rootReason: reason,
      rootError: error,
      laterError,
    });
    if (this.getFatalState() === undefined) {
      try {
        this.options.history.rollbackFrom(
          this.requireJournalEntry(intentId).metadata.historyTicket,
        );
      } catch (historyError) {
        this.latchLocalProjectionResetFailure(intentId, historyError, true);
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
        unchangedSpatialSkeletonOptimisticEditSettlement(
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

  private latchLocalProjectionResetFailure(
    intentId: number,
    error: unknown,
    preserveRejectedSuffix = false,
  ) {
    if (this.getFatalState() !== undefined) return false;
    const fatalState = freezeSpatialSkeletonOptimisticFatalState({
      reason: "local-projection-reset-failed",
      authority: "unchanged",
      intentId,
      cause: error,
    });
    const latched = this.options.fatalState.latch(fatalState);
    const effectiveFatalState = this.options.fatalState.get();
    if (effectiveFatalState === undefined) {
      throw new Error("The state-owned fatal latch discarded its first value.");
    }
    if (latched) {
      this.handledFatalState = effectiveFatalState;
      this.cancelUnsentForFatal(
        intentId,
        false,
        preserveRejectedSuffix ? intentId : undefined,
      );
    } else {
      this.handleLatchedFatalState(intentId);
    }
    return latched;
  }

  private rollbackUnknown(
    intentId: number,
    runtime: EngineIntentRuntime<TResult>,
    outcome: Exclude<
      SpatialSkeletonMutationOutcome<TResult>,
      { status: "committed" }
    >,
  ) {
    this.enterFatalState(
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
    runtime: EngineIntentRuntime<TResult>,
    authority: "committed" | "indeterminate",
    error: unknown,
  ) {
    this.enterFatalState(intentId, runtime, authority, error);
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
  private enterFatalState(
    faultingIntentId: number,
    faultingRuntime: EngineIntentRuntime<TResult>,
    authority: "committed" | "indeterminate",
    error: unknown,
    rollbackFaultingProjection = false,
  ) {
    const existing = this.getFatalState();
    if (existing !== undefined) {
      this.handleLatchedFatalState(faultingIntentId);
      faultingRuntime.lease?.retain();
      return false;
    }
    const fatalState = freezeSpatialSkeletonOptimisticFatalState({
      reason:
        authority === "indeterminate"
          ? "authority-indeterminate"
          : "committed-local-publication-failed",
      authority,
      intentId: faultingIntentId,
      cause: error,
    });
    const latched = this.options.fatalState.latch(fatalState);
    const effectiveFatalState = this.options.fatalState.get();
    if (effectiveFatalState === undefined) {
      throw new Error("The state-owned fatal latch discarded its first value.");
    }
    if (latched) {
      this.handledFatalState = effectiveFatalState;
      this.cancelUnsentForFatal(faultingIntentId, rollbackFaultingProjection);
    }
    faultingRuntime.lease?.retain();
    return latched;
  }

  private handleLatchedFatalState(faultingIntentId?: number) {
    if (this.disposed) return;
    const effectiveFatalState = this.options.fatalState.get();
    if (effectiveFatalState === undefined) return;
    if (this.handledFatalState === effectiveFatalState) return;
    this.handledFatalState = effectiveFatalState;
    this.cancelUnsentForFatal(faultingIntentId);
    this.notifyChanged();
  }

  private cancelUnsentForFatal(
    faultingIntentId?: number,
    rollbackFaultingProjection = false,
    preserveIntentSequenceAtOrAfter?: number,
  ) {
    const cancellationError = new Error(
      "Canceled because another edit requires a page reload.",
    );
    this.options.history.reset();
    const canceled: Array<readonly [number, EngineIntentRuntime<TResult>]> = [];
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
      const submission = runtime.submission;
      const canceledBeforeCommit =
        submission === undefined ||
        submission.cancelBeforeCommit(cancellationError);
      if (entry.committedMutationAttempts.length !== 0) {
        // A prior physical step already committed. Cancel any current step
        // which has not crossed adapter.commit(), but keep the workflow and its
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
    if (rollbackFaultingProjection && faultingIntentId !== undefined) {
      canceledIds.add(faultingIntentId);
    }
    const rollbackIntents = this.historyOperations.getProjectionArtifacts(
      [
        ...canceled.map(([intentId]) => intentId),
        ...(rollbackFaultingProjection && faultingIntentId !== undefined
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
        this.options.projection.rollbackAndReplay({
          rollbackIntents,
          replayIntents,
        });
      } catch (publicationError) {
        this.options.onListenerError?.(publicationError);
      }
    }

    for (const [intentId, runtime] of canceled) {
      this.removePreparation(intentId);
      try {
        this.options.projection.discardPrepared(intentId);
        runtime.exact.reject(cancellationError);
        this.journal.settleUnchanged(
          intentId,
          "not-started",
          cancellationError,
        );
        runtime.settled.resolve(
          unchangedSpatialSkeletonOptimisticEditSettlement(
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
    runtime: EngineIntentRuntime<TResult>,
  ) {
    const entry = this.requireJournalEntry(intentId);
    this.options.history.confirm(entry.metadata.historyTicket);
    this.journal.settleSuccessful(intentId, "committed");
    this.removePreparation(intentId);
    runtime.lease?.release();
    const lastResult = entry.committedMutationAttempts.at(-1)?.result;
    runtime.settled.resolve(
      committedSpatialSkeletonOptimisticEditSettlement(lastResult),
    );
    this.historyOperations.compactTerminalState();
  }

  private finishNoOp(intentId: number, runtime: EngineIntentRuntime<TResult>) {
    const entry = this.requireJournalEntry(intentId);
    this.options.history.confirm(entry.metadata.historyTicket);
    this.journal.settleSuccessful(intentId, "no-op");
    this.removePreparation(intentId);
    runtime.lease?.release();
    runtime.settled.resolve(
      unchangedSpatialSkeletonOptimisticEditSettlement("no-op"),
    );
    this.historyOperations.compactTerminalState();
  }

  private coalesceQueuedOpposite(
    oppositeIntentId: number,
    opposite: EngineIntentRuntime<TResult>,
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
      const rollbackIntents = this.historyOperations.getProjectionArtifacts([
        targetIntentId,
      ]);
      if (rollbackIntents.length !== 0) {
        this.options.projection.rollbackAndReplay({
          rollbackIntents,
          replayIntents: [],
        });
      }
      // A preparing opposite pair has not published either preview.  It can
      // settle immediately without manufacturing an inverse merely to remove
      // state which was never visible.  The retained forward recipe is enough
      // for a later Redo; that Redo captures its inverse during preparation.
      this.options.projection.discardPrepared(targetIntentId);
      this.options.projection.discardPrepared(oppositeIntentId);
      this.removePreparation(targetIntentId);
      this.removePreparation(oppositeIntentId);
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
          unchangedSpatialSkeletonOptimisticEditSettlement("no-op"),
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

  private requirePreparedWorkflow(entry: {
    readonly metadata: { readonly workflow?: TWorkflow };
  }): TWorkflow {
    if (entry.metadata.workflow === undefined) {
      throw new Error("An unprepared intent cannot start a server mutation.");
    }
    return entry.metadata.workflow;
  }

  private removePreparation(intentId: number) {
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
      this.options.preparation?.remove(intentId);
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
      throw new SpatialSkeletonOptimisticQueueEngineDisposedError();
    }
  }

  private requireEditingAllowed() {
    const fatalState = this.getFatalState();
    if (fatalState !== undefined) {
      throw new SpatialSkeletonOptimisticReloadRequiredError(fatalState);
    }
  }

  private notifyChanged() {
    this.changed.runWithHandlerErrorReporting(
      (error) => this.options.onListenerError?.(error),
      () => this.changed.dispatch(),
    );
  }
}
