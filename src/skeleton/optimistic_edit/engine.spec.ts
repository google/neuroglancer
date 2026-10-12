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

import { describe, expect, it, vi } from "vitest";

import {
  SpatialSkeletonCommandHistory,
  type SpatialSkeletonCommandHistoryTransitionTicket as Ticket,
} from "#src/skeleton/command_history.js";
import type {
  SpatialSkeletonQueueInput,
  SpatialSkeletonQueueInputPreparation,
} from "#src/skeleton/command_protocol.js";
import { spatialSkeletonLogicalSegment } from "#src/skeleton/logical_identity.js";
import type {
  SpatialSkeletonMutationContext,
  SpatialSkeletonMutationFailureDisposition,
  SpatialSkeletonOptimisticMutationAdapter,
} from "#src/skeleton/optimistic_edit/api.js";
import { SpatialSkeletonMutationAuthorityLeaseCoordinator } from "#src/skeleton/optimistic_edit/authority_lease_coordinator.js";
import { SpatialSkeletonOptimisticQueueEngine } from "#src/skeleton/optimistic_edit/engine.js";
import type { SpatialSkeletonOptimisticFatalState } from "#src/skeleton/optimistic_edit/fatal.js";
import type {
  SpatialSkeletonIntentDriver,
  SpatialSkeletonOptimisticHistoryPort,
  SpatialSkeletonOptimisticProjectionPort,
  SpatialSkeletonProjectionArtifactsListener,
  SpatialSkeletonProjectionIntentArtifact,
} from "#src/skeleton/optimistic_edit/ports.js";
import { SpatialSkeletonMutationAttemptScheduler } from "#src/skeleton/optimistic_edit/scheduler.js";

interface Input {
  readonly name: string;
  readonly segment: number;
  readonly steps?: number;
  readonly prepare?: Promise<void>;
}

interface Workflow {
  readonly input: Input;
}

interface Mutation {
  readonly name: string;
}

interface Result {
  readonly value: string;
}

interface Commit {
  readonly mutation: Mutation;
  readonly context: SpatialSkeletonMutationContext;
  resolve(value: Result): void;
  reject(error: unknown): void;
}

const queueInput: SpatialSkeletonQueueInput = Object.freeze({
  segments: Object.freeze([]),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeHarness(
  options: {
    failPublication?: boolean;
    failRollback?: boolean;
    failPreparationFor?: string;
    delayPreparationFor?: string;
    capacity?: number;
    previewPreparation?: Promise<void>;
    coordinator?: SpatialSkeletonMutationAuthorityLeaseCoordinator;
    mutationScope?: object;
    onListenerError?: (error: unknown) => void;
  } = {},
) {
  const events: string[] = [];
  const commits: Commit[] = [];
  let failPublication = options.failPublication ?? false;
  let failRollback = options.failRollback ?? false;
  let fatal: SpatialSkeletonOptimisticFatalState | undefined;
  const commandHistory = new SpatialSkeletonCommandHistory({
    capacity: options.capacity,
  });
  const reset = vi.spyOn(commandHistory, "reset");
  const rollbackFrom = vi.spyOn(commandHistory, "rollbackFrom");
  const history: SpatialSkeletonOptimisticHistoryPort<Input, Ticket> = {
    capacity: commandHistory.capacity,
    stageExecute: (input) => commandHistory.stageExecute(input.name),
    stageUndo: () => commandHistory.stageUndo(),
    stageRedo: () => commandHistory.stageRedo(),
    getTicketId: (ticket) => ticket.transitionId,
    getEntryId: (ticket) => ticket.entryId,
    getSemanticDependencyTicketIds: (ticket) =>
      ticket.semanticDependencyTransitionIds,
    confirm: (ticket) => {
      commandHistory.confirm(ticket);
      events.push(`confirm:${ticket.transitionId}`);
    },
    abandonLatest: (ticket) => commandHistory.abandonLatest(ticket),
    rollbackFrom: (ticket) => commandHistory.rollbackFrom(ticket),
    reset: () => commandHistory.reset(),
    canStage: (intent) =>
      (intent === "undo" ? commandHistory.canUndo : commandHistory.canRedo)
        .value,
    getProjectedEntryId: (intent) =>
      (intent === "undo"
        ? commandHistory.getProjectedUndoEntry()
        : commandHistory.getProjectedRedoEntry()
      )?.entryId,
    getRetainedEntryIds: () => commandHistory.getRetainedEntryIds(),
  };

  const adapter: SpatialSkeletonOptimisticMutationAdapter<Mutation, Result> = {
    mutationScope: options.mutationScope ?? {},
    commit: (mutation, context) => {
      const pending = deferred<Result>();
      commits.push({ mutation, context, ...pending });
      events.push(`commit:${mutation.name}`);
      return pending.promise;
    },
    classifyFailure: (error) =>
      (error as { disposition?: SpatialSkeletonMutationFailureDisposition })
        .disposition ?? "indeterminate",
  };

  const active = new Map<
    number,
    SpatialSkeletonProjectionIntentArtifact<string, string>
  >();
  const listeners = new Set<
    SpatialSkeletonProjectionArtifactsListener<string, string>
  >();
  const emit = () => {
    const artifacts = [...active.values()];
    for (const listener of listeners) listener(artifacts);
  };
  const projection: SpatialSkeletonOptimisticProjectionPort<
    string,
    string,
    string
  > = {
    subscribeProjectionArtifacts: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepareExact: async (intentId, value) => {
      if (
        value === `projection:${options.failPreparationFor}` ||
        value === `projection:${options.delayPreparationFor}`
      ) {
        await options.previewPreparation;
      }
      if (value === `projection:${options.failPreparationFor}`) {
        throw new Error("preview preparation failed");
      }
      events.push(`prepare:${intentId}`);
      return { projection: value, inverseProjection: `inverse:${value}` };
    },
    discardPrepared: (intentId) => events.push(`discard:${intentId}`),
    publishExact: (intentId, value) => {
      active.set(intentId, {
        intentId,
        projection: value,
        inverseProjection: `inverse:${value}`,
      });
      events.push(`preview:${intentId}`);
      emit();
    },
    rollbackAndReplay: ({ rollbackIntents, replayIntents }) => {
      if (failRollback) {
        failRollback = false;
        throw new Error("rollback publication failed");
      }
      events.push(
        `rollback:${rollbackIntents.map(({ intentId }) => intentId).join(",")}`,
      );
      for (const { intentId } of rollbackIntents) active.delete(intentId);
      for (const artifact of replayIntents)
        active.set(artifact.intentId, artifact);
      emit();
    },
    publishAuthoritative: ({ intentId, reconciliation }) => {
      if (failPublication) {
        failPublication = false;
        throw new Error("publication failed");
      }
      const artifact = active.get(intentId)!;
      active.delete(intentId);
      events.push(`authority:${intentId}:${reconciliation}`);
      emit();
      return artifact;
    },
    setRetainedHistoryProjections: () => undefined,
    ownsAuthoritativeReadSegment: () => false,
    getProtectedSegmentIds: () => [],
  };

  const driver: SpatialSkeletonIntentDriver<
    Input,
    Workflow,
    string,
    Mutation,
    Result,
    string,
    string
  > = {
    describeIntent: (input) => ({ kind: "test", commandLabel: input.name }),
    createLogicalIntent: (input, context) => ({
      kind: "test",
      commandLabel: input.name,
      logicalResources: [
        {
          handle: spatialSkeletonLogicalSegment(input.segment),
          access: "write",
        },
      ],
      projection:
        context.intent === "undo"
          ? context.recipe.inverseProjection!
          : context.intent === "redo"
            ? context.recipe.projection
            : `projection:${input.name}`,
      workflow: { input },
    }),
    nextAttempt: async (workflow, context) => {
      await workflow.input.prepare;
      const cursor = context.committedAttempts.length;
      if (cursor >= (workflow.input.steps ?? 1)) return undefined;
      return {
        materializeMutation: () => ({
          name: `${workflow.input.name}:${cursor}`,
        }),
      };
    },
    createReconciliation: (workflow) => `saved:${workflow.input.name}`,
  };

  const engine = new SpatialSkeletonOptimisticQueueEngine({
    driver,
    projection,
    history,
    onListenerError: options.onListenerError,
    attempts: new SpatialSkeletonMutationAttemptScheduler({
      adapter,
      coordinator:
        options.coordinator ??
        new SpatialSkeletonMutationAuthorityLeaseCoordinator(),
    }),
    fatalState: {
      get: () => fatal,
      latch: (candidate) => {
        if (fatal !== undefined) return false;
        fatal = candidate;
        return true;
      },
    },
  });

  return {
    engine,
    projection,
    commits,
    events,
    history,
    commandHistory,
    reset,
    rollbackFrom,
    getFatal: () => fatal,
  };
}

function pendingInputs(read = deferred<void>()) {
  const released = vi.fn();
  const signals: AbortSignal[] = [];
  const policy: SpatialSkeletonQueueInputPreparation = {
    getProtectedSegmentIds: () => [],
    validate: vi.fn(() => released),
    acquire: vi.fn(async (signal) => {
      signals.push(signal);
      await read.promise;
      return {
        input: queueInput,
        assertCurrent: () => signal.throwIfAborted(),
        release: vi.fn(),
      };
    }),
  };
  return { read, policy, signals, released };
}

describe("SpatialSkeletonOptimisticQueueEngine", () => {
  it("reprepares Undo when authority finalizes its inverse during preparation", async () => {
    const { engine, projection, commits, events, getFatal } = makeHarness();
    const execute = engine.submitExecute(
      { name: "merge", segment: 1 },
      queueInput,
    );
    await execute;
    await flush();
    const gate = deferred<void>();
    const prepare = projection.prepareExact.bind(projection);
    vi.spyOn(projection, "prepareExact").mockImplementationOnce(
      async (...args) => {
        const result = await prepare(...args);
        await gate.promise;
        return result;
      },
    );
    const publish = projection.publishAuthoritative.bind(projection);
    vi.spyOn(projection, "publishAuthoritative").mockImplementationOnce(
      (publication) => ({
        ...publish(publication),
        inverseProjection: "corrected inverse",
      }),
    );
    const publishExact = vi.spyOn(projection, "publishExact");
    const undo = engine.submitUndo();
    await flush();
    commits[0].resolve({ value: "merged" });
    await execute.settled;
    expect(publishExact).not.toHaveBeenCalled();
    gate.resolve();
    await undo;
    await flush();
    expect(events).toContain("discard:2");
    expect(publishExact).toHaveBeenCalledExactlyOnceWith(
      2,
      "corrected inverse",
    );
    commits[1].resolve({ value: "undone" });
    await undo.settled;
    expect(getFatal()).toBeUndefined();
  });

  async function save(harness: ReturnType<typeof makeHarness>, name: string) {
    const execution = harness.engine.submitExecute(
      { name, segment: 1 },
      queueInput,
    );
    await execution;
    await flush();
    harness.commits.at(-1)!.resolve({ value: `${name} saved` });
    await flush();
    expect(harness.getFatal()).toBeUndefined();
    await execution.settled;
  }

  function rejection() {
    return Object.assign(new Error("rejected"), {
      disposition: "rejected" as const,
    });
  }

  it.each([false, true])(
    "isolates observer failures through saving and unsubscribe (reporter throws: %s)",
    async (reporterThrows) => {
      const observerError = new Error("observer failed");
      const onListenerError = vi.fn(() => {
        if (reporterThrows) throw new Error("error reporter failed");
      });
      const harness = makeHarness({ onListenerError });
      const { engine, commandHistory } = harness;
      const unsubscribeThrowing = engine.subscribe(() => {
        throw observerError;
      });
      const observer = vi.fn();
      const unsubscribeObserver = engine.subscribe(observer);

      await save(harness, "first");
      expect(onListenerError).toHaveBeenCalledWith(observerError);
      expect(observer).toHaveBeenCalled();
      expect(commandHistory.undoLabel.value).toBe("first");

      unsubscribeThrowing();
      unsubscribeObserver();
      observer.mockClear();
      onListenerError.mockClear();
      await save(harness, "second");
      expect(observer).not.toHaveBeenCalled();
      expect(onListenerError).not.toHaveBeenCalled();
      expect(commandHistory.undoLabel.value).toBe("second");
      await engine.dispose();
    },
  );

  it("restores and executes a Redo branch cleared by a rejected new edit", async () => {
    const harness = makeHarness();
    const { engine, commits, commandHistory, reset } = harness;
    await save(harness, "original");
    const undo = engine.submitUndo();
    await undo;
    await flush();
    commits.at(-1)!.resolve({ value: "undone" });
    await undo.settled;

    const failed = engine.submitExecute(
      { name: "failed", segment: 1 },
      queueInput,
    );
    const later = engine.submitExecute(
      { name: "later", segment: 2 },
      queueInput,
    );
    await Promise.all([failed, later]);
    await flush();
    commits.at(-1)!.reject(rejection());
    await Promise.all([failed.settled, later.settled]);
    expect(commandHistory.undoLabel.value).toBeUndefined();
    expect(commandHistory.redoLabel.value).toBe("original");
    expect(reset).not.toHaveBeenCalled();
    const redo = engine.submitRedo();
    await redo;
    await flush();
    expect(commits.at(-1)!.mutation.name).toBe("original:0");
    commits.at(-1)!.resolve({ value: "redone" });
    await redo.settled;
    expect(commandHistory.undoLabel.value).toBe("original");
    expect(commandHistory.canRedo.value).toBe(false);
  });

  it.each(["undo", "redo"] as const)(
    "can explicitly retry a definitively rejected %s",
    async (kind) => {
      const harness = makeHarness();
      const { engine, commits, commandHistory } = harness;
      await save(harness, "original");
      if (kind === "redo") {
        const undo = engine.submitUndo();
        await undo;
        await flush();
        commits.at(-1)!.resolve({ value: "undone" });
        await undo.settled;
      }
      const failed =
        kind === "undo" ? engine.submitUndo() : engine.submitRedo();
      await failed;
      await flush();
      commits.at(-1)!.reject(rejection());
      await failed.settled;
      expect(commandHistory.canUndo.value).toBe(kind === "undo");
      expect(commandHistory.canRedo.value).toBe(kind === "redo");
      const retry = kind === "undo" ? engine.submitUndo() : engine.submitRedo();
      await retry;
      await flush();
      expect(commits.at(-1)!.mutation.name).toBe("original:0");
      commits.at(-1)!.resolve({ value: "retry saved" });
      await retry.settled;
      expect(commandHistory.canUndo.value).toBe(kind === "redo");
      expect(commandHistory.canRedo.value).toBe(kind === "undo");
    },
  );

  it.each(["committed", "rejected"] as const)(
    "preserves an earlier in-flight ticket after preparation failure until it is %s",
    async (outcome) => {
      const harness = makeHarness({ failPreparationFor: "bad preview" });
      const { engine, commits, commandHistory, reset } = harness;
      await save(harness, "saved before both");
      const earlier = engine.submitExecute(
        { name: "earlier", segment: 1 },
        queueInput,
      );
      await earlier;
      await flush();
      const failed = engine.submitExecute(
        { name: "bad preview", segment: 2 },
        queueInput,
      );
      await expect(failed).rejects.toThrow("preview preparation failed");
      await failed.settled;
      expect(commandHistory.undoLabel.value).toBe("earlier");
      expect(reset).not.toHaveBeenCalled();
      if (outcome === "committed")
        commits.at(-1)!.resolve({ value: "saved earlier" });
      else commits.at(-1)!.reject(rejection());
      await earlier.settled;
      expect(commandHistory.getStagedTransitions()).toEqual([]);
      expect(commandHistory.undoLabel.value).toBe(
        outcome === "committed" ? "earlier" : "saved before both",
      );
      const undo = engine.submitUndo();
      await undo;
      await flush();
      commits.at(-1)!.resolve({ value: "undone" });
      await undo.settled;
      expect(reset).not.toHaveBeenCalled();
    },
  );

  it("restores a staged Redo recipe after its activity rows have been evicted", async () => {
    const preparation = deferred<void>();
    const { engine, commits, commandHistory } = makeHarness({
      capacity: 3,
      failPreparationFor: "bad preview",
      previewPreparation: preparation.promise,
    });
    const earlier = engine.submitExecute(
      { name: "saving", segment: 1 },
      queueInput,
    );
    await earlier;
    await flush();
    const reverted = engine.submitExecute(
      { name: "restore to Redo", segment: 2 },
      queueInput,
    );
    await reverted;
    await engine.submitUndo().settled;
    const failed = engine.submitExecute(
      { name: "bad preview", segment: 3 },
      queueInput,
    );
    const failedPreview = expect(failed).rejects.toThrow(
      "preview preparation failed",
    );
    for (let index = 0; index < 4; ++index) {
      const later = engine.submitExecute(
        { name: `later pair ${index}`, segment: 4 },
        queueInput,
      );
      await later;
      await engine.submitUndo().settled;
    }
    expect(
      engine
        .getRecentActivity()
        .some(({ commandLabel }) => commandLabel === "restore to Redo"),
    ).toBe(false);
    const staleTickets = commandHistory.getStagedTransitions().slice(3);
    preparation.resolve();
    await failedPreview;
    await failed.settled;
    expect(commandHistory.redoLabel.value).toBe("restore to Redo");
    for (const ticket of staleTickets) commandHistory.confirm(ticket);
    expect(
      engine.getRecentActivity().every(({ status }) => status === "reverted"),
    ).toBe(true);

    // Exercise the recovered recipe before the earlier save has even replied.
    const redo = engine.submitRedo();
    await redo;
    expect(commits).toHaveLength(1);
    commits[0]!.resolve({ value: "first saved" });
    await earlier.settled;
    await flush();
    expect(commits.at(-1)!.mutation.name).toBe("restore to Redo:0");
    commits.at(-1)!.resolve({ value: "redone" });
    await redo.settled;
    expect(commandHistory.getStagedTransitions()).toEqual([]);
    expect(commandHistory.getRetainedEntryIds()).toHaveLength(2);
    expect(commandHistory.undoLabel.value).toBe("restore to Redo");
    expect(commandHistory.canRedo.value).toBe(false);
  });

  it.each([false, true])(
    "ignores canceled preparation when it finishes later (throws: %s)",
    async (throws) => {
      const preparation = deferred<void>();
      const harness = makeHarness({
        delayPreparationFor: "later",
        failPreparationFor: throws ? "later" : undefined,
        previewPreparation: preparation.promise,
      });
      const { engine, commits, commandHistory, events, getFatal } = harness;
      await save(harness, "saved");
      const failed = engine.submitExecute(
        { name: "failed", segment: 1 },
        queueInput,
      );
      await failed;
      await flush();
      const later = engine.submitExecute(
        { name: "later", segment: 2 },
        queueInput,
      );
      const canceled = expect(later).rejects.toThrow(
        "Canceled because an earlier edit was not saved",
      );
      await flush();
      commits.at(-1)!.reject(rejection());
      await Promise.all([failed.settled, later.settled, canceled]);
      preparation.resolve();
      await flush();
      expect(getFatal()).toBeUndefined();
      expect(commandHistory.undoLabel.value).toBe("saved");
      expect(commandHistory.canRedo.value).toBe(false);
      expect(commandHistory.getStagedTransitions()).toEqual([]);
      expect(events).not.toContain("preview:3");
      expect(commits).toHaveLength(2);
      await save(harness, "fresh");
      expect(commandHistory.undoLabel.value).toBe("fresh");
    },
  );

  it.each(["missing boundary", "restoration throws"])(
    "requires reload when history recovery fails: %s",
    async (failure) => {
      const harness = makeHarness();
      const { engine, commits, commandHistory, rollbackFrom, reset, getFatal } =
        harness;
      await save(harness, "saved");
      const failed = engine.submitExecute(
        { name: "failed", segment: 1 },
        queueInput,
      );
      await failed;
      await flush();
      if (failure === "missing boundary") commandHistory.reset();
      else
        rollbackFrom.mockImplementationOnce(() => {
          throw new Error("history restoration failed");
        });
      commits.at(-1)!.reject(rejection());
      await failed.settled;
      expect(getFatal()).toMatchObject({
        reason: "local-projection-reset-failed",
        authority: "unchanged",
      });
      expect(reset).toHaveBeenCalled();
      expect(engine.canUndo()).toBe(false);
      expect(engine.canRedo()).toBe(false);
      expect(() =>
        engine.submitExecute({ name: "blocked", segment: 1 }, queueInput),
      ).toThrow();
    },
  );

  it("publishes previews concurrently but starts authority strictly by sequence", async () => {
    const firstPreparation = deferred<void>();
    const { engine, commits, events } = makeHarness();
    const first = engine.submitExecute(
      { name: "first", segment: 1, prepare: firstPreparation.promise },
      queueInput,
    );
    const second = engine.submitExecute(
      { name: "second", segment: 2 },
      queueInput,
    );

    await expect(second).resolves.toBe(true);
    await flush();
    expect(events).toContain("preview:2");
    expect(commits).toHaveLength(0);

    firstPreparation.resolve();
    await expect(first).resolves.toBe(true);
    await flush();
    expect(commits.map(({ mutation }) => mutation.name)).toEqual(["first:0"]);
    commits[0]!.resolve({ value: "first saved" });
    await expect(first.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    await flush();
    expect(commits.map(({ mutation }) => mutation.name)).toEqual([
      "first:0",
      "second:0",
    ]);
    commits[1]!.resolve({ value: "second saved" });
    await expect(second.settled).resolves.toMatchObject({
      outcome: "committed",
    });
  });

  it("reuses one lease for compound steps and releases before the next intent", async () => {
    const { engine, commits } = makeHarness();
    const first = engine.submitExecute(
      { name: "compound", segment: 1, steps: 2 },
      queueInput,
    );
    const second = engine.submitExecute(
      { name: "next", segment: 2 },
      queueInput,
    );
    await Promise.all([first, second]);
    await flush();
    commits[0]!.resolve({ value: "step one" });
    await flush();
    commits[1]!.resolve({ value: "step two" });
    await expect(first.settled).resolves.toMatchObject({
      outcome: "committed",
    });
    await flush();
    expect(commits[0]!.context.operationId).not.toBe(
      commits[1]!.context.operationId,
    );
    expect(commits[2]!.mutation.name).toBe("next:0");
    commits[2]!.resolve({ value: "next saved" });
    await expect(second.settled).resolves.toMatchObject({
      outcome: "committed",
    });
  });

  it.each(["rejected", "indeterminate"] as const)(
    "retains the shared lane when a later compound step is %s",
    async (disposition) => {
      const options = {
        coordinator: new SpatialSkeletonMutationAuthorityLeaseCoordinator(),
        mutationScope: {},
      };
      const { engine, commits, events, getFatal } = makeHarness(options);
      const peer = makeHarness(options);
      const compound = engine.submitExecute(
        { name: "compound", segment: 1, steps: 2 },
        queueInput,
      );
      const later = engine.submitExecute(
        { name: "later", segment: 2 },
        queueInput,
      );
      await Promise.all([compound, later]);
      await flush();
      const peerExecution = peer.engine.submitExecute(
        { name: "peer", segment: 3 },
        queueInput,
      );
      await peerExecution;

      const settled = vi.fn();
      void compound.settled.then(settled);
      commits[0]!.resolve({ value: "first step saved" });
      await flush();
      expect(commits[1]!.mutation.name).toBe("compound:1");
      commits[1]!.reject(
        Object.assign(new Error("second step failed"), { disposition }),
      );
      await flush();

      expect(getFatal()).toMatchObject({
        reason: "committed-local-publication-failed",
        authority: "committed",
      });
      expect(settled).not.toHaveBeenCalled();
      expect(events).not.toContain("authority:1:saved:compound");
      await expect(later.settled).resolves.toMatchObject({
        outcome: "unchanged",
        reason: "not-started",
      });
      expect(engine.getRecentActivity()).toMatchObject([
        {
          commandLabel: "later",
          status: "not-saved",
          reason: "Canceled because another edit requires a page reload.",
        },
      ]);
      expect(engine.canUndo()).toBe(false);
      expect(engine.canRedo()).toBe(false);
      expect(commits).toHaveLength(2);
      expect(peer.commits).toHaveLength(0);
      await Promise.all([engine.dispose(), peer.engine.dispose()]);
    },
  );

  it("rolls back and cancels the complete suffix after definitive rejection", async () => {
    const { engine, commits, reset } = makeHarness();
    const failed = engine.submitExecute(
      { name: "failed", segment: 1 },
      queueInput,
    );
    const later = engine.submitExecute(
      { name: "later", segment: 2 },
      queueInput,
    );
    await Promise.all([failed, later]);
    await flush();
    const rejection = Object.assign(new Error("rejected"), {
      disposition: "rejected" as const,
    });
    commits[0]!.reject(rejection);

    await expect(failed.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "rejected",
      error: rejection,
    });
    await expect(later.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "not-started",
      error: expect.objectContaining({
        message: "Canceled because an earlier edit was not saved.",
      }),
    });
    expect(engine.getSnapshot()[0]).toMatchObject({
      canceledLaterIntentCount: 1,
    });
    expect(reset).not.toHaveBeenCalled();
    expect(engine.canUndo()).toBe(false);
    expect(engine.canRedo()).toBe(false);
    expect(commits).toHaveLength(1);
  });

  it("requires reload if definitive suffix rollback cannot be published", async () => {
    const { engine, commits, getFatal, reset } = makeHarness({
      failRollback: true,
    });
    const failed = engine.submitExecute(
      { name: "failed", segment: 1 },
      queueInput,
    );
    const later = engine.submitExecute(
      { name: "later", segment: 2 },
      queueInput,
    );
    await Promise.all([failed, later]);
    await flush();
    commits[0]!.reject(
      Object.assign(new Error("rejected"), {
        disposition: "rejected" as const,
      }),
    );

    await expect(failed.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "rejected",
    });
    await expect(later.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "not-started",
    });
    expect(getFatal()).toMatchObject({
      reason: "local-projection-reset-failed",
      authority: "unchanged",
    });
    expect(engine.getSnapshot()[0]).toMatchObject({
      canceledLaterIntentCount: 1,
    });
    expect(reset).toHaveBeenCalled();
    expect(engine.canUndo()).toBe(false);
    expect(engine.canRedo()).toBe(false);
    expect(commits).toHaveLength(1);
  });

  it("rejects both queued opposites when coalescing preview rollback fails", async () => {
    const earlierPreparation = deferred<void>();
    const { engine, commits } = makeHarness({ failRollback: true });
    const earlier = engine.submitExecute(
      { name: "earlier", segment: 1, prepare: earlierPreparation.promise },
      queueInput,
    );
    const move = engine.submitExecute({ name: "move", segment: 2 }, queueInput);
    await expect(move).resolves.toBe(true);

    const undo = engine.submitUndo();
    await expect(undo).rejects.toThrow(
      "Canceled because an earlier edit was not saved",
    );
    await expect(move.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "not-started",
      error: expect.objectContaining({
        message: "rollback publication failed",
      }),
    });
    await expect(undo.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "not-started",
    });
    expect(commits).toHaveLength(0);

    await expect(earlier).resolves.toBe(true);
    const disposal = engine.dispose();
    earlierPreparation.resolve();
    await disposal;
  });

  it("cancels earlier lane waiters when a local reset failure requires reload", async () => {
    const coordinator = new SpatialSkeletonMutationAuthorityLeaseCoordinator();
    const mutationScope = {};
    const externalLease = await coordinator.acquire({ mutationScope });
    const { engine, commits, getFatal } = makeHarness({
      coordinator,
      mutationScope,
      failPreparationFor: "bad preview",
      failRollback: true,
    });
    const first = engine.submitExecute(
      { name: "waiting", segment: 1 },
      queueInput,
    );
    const failed = engine.submitExecute(
      { name: "bad preview", segment: 2 },
      queueInput,
    );
    await expect(first).resolves.toBe(true);
    await expect(failed).rejects.toThrow("preview preparation failed");
    await expect(first.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "not-started",
    });
    expect(getFatal()).toMatchObject({
      reason: "local-projection-reset-failed",
      authority: "unchanged",
    });

    externalLease.release();
    await flush();
    expect(commits).toHaveLength(0);
  });

  it("disposes unsent work without issuing an automatic inverse mutation", async () => {
    const preparation = deferred<void>();
    const { engine, commits, reset } = makeHarness();
    const execution = engine.submitExecute(
      { name: "unsent", segment: 1, prepare: preparation.promise },
      queueInput,
    );
    const disposal = engine.dispose();
    preparation.resolve();
    await expect(disposal).resolves.toBeUndefined();
    await expect(execution).rejects.toThrow(/disposed/);
    await expect(execution.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "not-started",
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(commits).toHaveLength(0);
    await expect(engine.dispose()).resolves.toBeUndefined();
  });

  it("classifies late rejection after disposal and releases the lane", async () => {
    const { engine, commits } = makeHarness();
    const execution = engine.submitExecute(
      { name: "started", segment: 1 },
      queueInput,
    );
    await execution;
    await flush();
    const disposal = engine.dispose();
    commits[0]!.reject(
      Object.assign(new Error("rejected"), {
        disposition: "rejected" as const,
      }),
    );
    await expect(disposal).resolves.toBeUndefined();
    await expect(execution.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "rejected",
    });
    expect(commits).toHaveLength(1);
  });

  it("requires reload if disposal cannot remove its adopted preview", async () => {
    const { engine, commits, getFatal } = makeHarness({ failRollback: true });
    const execution = engine.submitExecute(
      { name: "started", segment: 1 },
      queueInput,
    );
    await execution;
    await flush();

    const disposal = engine.dispose();
    expect(getFatal()).toMatchObject({
      reason: "local-projection-reset-failed",
      authority: "unchanged",
    });
    commits[0]!.reject(
      Object.assign(new Error("rejected"), {
        disposition: "rejected" as const,
      }),
    );
    await expect(disposal).resolves.toBeUndefined();
    await expect(execution.settled).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "rejected",
    });
    expect(commits).toHaveLength(1);
  });

  it("retains a late commit after disposal as Reload required", async () => {
    const { engine, commits, getFatal } = makeHarness();
    const execution = engine.submitExecute(
      { name: "started", segment: 1 },
      queueInput,
    );
    await execution;
    await flush();
    const disposal = engine.dispose();
    commits[0]!.resolve({ value: "saved" });
    await expect(disposal).resolves.toBeUndefined();
    expect(getFatal()).toMatchObject({
      reason: "committed-local-publication-failed",
      authority: "committed",
    });
    let settled = false;
    void execution.settled.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    expect(commits).toHaveLength(1);
  });

  it("retains indeterminate authority and starts no later transport", async () => {
    const { engine, commits, getFatal } = makeHarness();
    const first = engine.submitExecute(
      { name: "unknown", segment: 1 },
      queueInput,
    );
    const later = engine.submitExecute(
      { name: "later", segment: 2 },
      queueInput,
    );
    await Promise.all([first, later]);
    await flush();
    commits[0]!.reject(new Error("network lost"));
    await flush();
    expect(getFatal()).toMatchObject({
      reason: "authority-indeterminate",
      authority: "indeterminate",
    });
    expect(engine.getRecentActivity()).toMatchObject([
      {
        commandLabel: "later",
        status: "not-saved",
        reason: "Canceled because another edit requires a page reload.",
      },
    ]);
    expect(
      engine.getSnapshot().find((entry) => entry.commandLabel === "later")
        ?.reason,
    ).toBe("Canceled because another edit requires a page reload.");
    expect(commits).toHaveLength(1);
  });

  it("keeps explicit Undo/Redo history recipes independent of checkpoints", async () => {
    const { engine, commits } = makeHarness();
    const execute = engine.submitExecute(
      { name: "move", segment: 1 },
      queueInput,
    );
    await execute;
    await flush();
    commits[0]!.resolve({ value: "saved" });
    await execute.settled;

    const undo = engine.submitUndo();
    await undo;
    await flush();
    expect(commits[1]!.context.intent).toBe("undo");
    commits[1]!.resolve({ value: "undone" });
    await undo.settled;

    const redo = engine.submitRedo();
    await redo;
    await flush();
    expect(commits[2]!.context.intent).toBe("redo");
    commits[2]!.resolve({ value: "redone" });
    await expect(redo.settled).resolves.toMatchObject({ outcome: "committed" });
  });
  it("admits loading and ready inputs in call order, before either recipe is built", async () => {
    const { engine, events, commits } = makeHarness();
    const cold = pendingInputs();
    const warm = pendingInputs();
    warm.read.resolve();
    const first = engine.submitExecute(
      { name: "cold", segment: 1 },
      cold.policy,
    );
    const second = engine.submitExecute(
      { name: "warm", segment: 2 },
      warm.policy,
    );
    await Promise.all([first.acceptedByQueue, second.acceptedByQueue]);
    expect(engine.getSnapshot().map(({ operationId }) => operationId)).toEqual([
      1, 2,
    ]);
    expect(engine.canUndo()).toBe(true);
    await flush();
    expect(cold.policy.acquire).toHaveBeenCalledOnce();
    expect(warm.policy.acquire).not.toHaveBeenCalled();
    expect(events.filter((event) => event.startsWith("preview:"))).toEqual([]);
    expect(commits).toHaveLength(0);
    cold.read.resolve();
    await Promise.all([first, second]);
    await flush();
    expect(events.filter((event) => event.startsWith("preview:"))).toEqual([
      "preview:1",
      "preview:2",
    ]);
    expect(commits[0].mutation.name).toBe("cold:0");
    commits[0].resolve({ value: "saved" });
    await first.settled;
    await flush();
    expect(commits[1].mutation.name).toBe("warm:0");
    commits[1].resolve({ value: "saved" });
    await second.settled;
    expect(cold.released).toHaveBeenCalledOnce();
    expect(warm.released).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "undoes an unprepared action and redoes it with fresh preparation (read started: %s)",
    async (started) => {
      const { engine, events, commits } = makeHarness();
      const cold = pendingInputs();
      const first = engine.submitExecute(
        { name: "cold", segment: 1 },
        cold.policy,
      );
      await first.acceptedByQueue;
      if (started) await flush();
      const undo = engine.submitUndo();
      await Promise.all([first, undo]);
      expect(commits).toHaveLength(0);
      expect(engine.canRedo()).toBe(true);
      expect(events.filter((event) => event.startsWith("preview:"))).toEqual(
        [],
      );
      expect(cold.released).toHaveBeenCalledOnce();
      if (started) expect(cold.signals[0].aborted).toBe(true);
      const redo = engine.submitRedo();
      await redo.acceptedByQueue;
      cold.read.resolve();
      await redo;
      await flush();
      expect(commits).toHaveLength(1);
      expect(commits[0].context.intent).toBe("redo");
      commits[0].resolve({ value: "redone" });
      await redo.settled;
      expect(engine.canUndo()).toBe(true);
    },
  );

  it("rolls back a failed input read and cancels its queued suffix before transport", async () => {
    const { engine, commits, commandHistory } = makeHarness();
    const cold = pendingInputs();
    const warm = pendingInputs();
    warm.read.resolve();
    const first = engine.submitExecute(
      { name: "cold", segment: 1 },
      cold.policy,
    );
    const second = engine.submitExecute(
      { name: "warm", segment: 2 },
      warm.policy,
    );
    const results = Promise.allSettled([first, second]);
    await flush();
    cold.read.reject(new Error("read failed"));
    const result = await results;
    expect(result.every(({ status }) => status === "rejected")).toBe(true);
    await Promise.all([first.settled, second.settled]);
    expect(warm.policy.acquire).not.toHaveBeenCalled();
    expect(commits).toHaveLength(0);
    expect(commandHistory.canUndo.value).toBe(false);
    expect(engine.getSnapshot()).toMatchObject([
      {
        canceledLaterIntentCount: 1,
        lifecycle: { authorityReason: "not-started" },
      },
      { lifecycle: { authorityReason: "not-started" } },
    ]);
    expect(cold.released).toHaveBeenCalledOnce();
    expect(warm.released).toHaveBeenCalledOnce();
  });

  it("counts preparing intents against capacity before running validation or reads", async () => {
    const { engine } = makeHarness({ capacity: 1 });
    const cold = pendingInputs();
    const rejected = pendingInputs();
    const first = engine.submitExecute(
      { name: "cold", segment: 1 },
      cold.policy,
    );
    expect(() =>
      engine.submitExecute({ name: "later", segment: 2 }, rejected.policy),
    ).toThrow("safety limit");
    expect(rejected.policy.validate).not.toHaveBeenCalled();
    expect(rejected.policy.acquire).not.toHaveBeenCalled();
    await engine.dispose();
    await expect(first).rejects.toThrow("disposed");
    expect(cold.released).toHaveBeenCalledOnce();
  });

  it("disposes pending acquisition without allowing a late response to publish or save", async () => {
    const { engine, events, commits } = makeHarness();
    const cold = pendingInputs();
    const first = engine.submitExecute(
      { name: "cold", segment: 1 },
      cold.policy,
    );
    await flush();
    await engine.dispose();
    await expect(first).rejects.toThrow("disposed");
    expect(cold.signals[0].aborted).toBe(true);
    cold.read.resolve();
    await flush();
    expect(commits).toHaveLength(0);
    expect(events.filter((event) => event.startsWith("preview:"))).toEqual([]);
    expect(cold.released).toHaveBeenCalledOnce();
  });
});
