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

import { afterEach, describe, expect, it, vi } from "vitest";

import { SpatialSkeletonActions } from "#src/skeleton/command_protocol.js";
import {
  redoSpatialSkeletonCommand,
  undoSpatialSkeletonCommand,
} from "#src/skeleton/commands.js";
import {
  committedSpatialSkeletonOptimisticEditSettlement,
  type SpatialSkeletonOptimisticEditSettlement,
} from "#src/skeleton/optimistic_edit/lifecycle.js";
import {
  SpatialSkeletonState,
  type SpatialSkeletonOptimisticEditExecution,
  type SpatialSkeletonOptimisticEditQueue,
} from "#src/skeleton/spatial_skeleton_manager.js";
import { StatusMessage } from "#src/status.js";

function withExecutionMilestones<T>(
  execution: Promise<T>,
  acceptedByQueue: Promise<void> = Promise.resolve(),
  settled: Promise<SpatialSkeletonOptimisticEditSettlement> = Promise.resolve(
    committedSpatialSkeletonOptimisticEditSettlement(),
  ),
): SpatialSkeletonOptimisticEditExecution<T> {
  Object.defineProperty(execution, "acceptedByQueue", {
    configurable: true,
    value: acceptedByQueue,
  });
  Object.defineProperty(execution, "settled", {
    configurable: true,
    value: settled,
  });
  return execution as SpatialSkeletonOptimisticEditExecution<T>;
}

function makeQueue(
  options: {
    canUndo?: boolean;
    canRedo?: boolean;
    hasUnconfirmedActions?: boolean;
    undoExecution?: SpatialSkeletonOptimisticEditExecution;
    redoExecution?: SpatialSkeletonOptimisticEditExecution;
  } = {},
) {
  return {
    canUndo: vi.fn(() => options.canUndo ?? false),
    canRedo: vi.fn(() => options.canRedo ?? false),
    dispose: vi.fn(async () => {}),
    hasUnconfirmedActions: vi.fn(() => options.hasUnconfirmedActions ?? false),
    undoLatest: vi.fn(
      () =>
        options.undoExecution ?? withExecutionMilestones(Promise.resolve(true)),
    ),
    redoLatest: vi.fn(
      () =>
        options.redoExecution ?? withExecutionMilestones(Promise.resolve(true)),
    ),
    getSnapshot: () => [],
    getRecentActivity: () => [],
    getFatalState: () => undefined,
    handleFatalStateLatched: () => {},
    getProtectedProjectionSegmentIds: () => [],
    ownsAuthoritativeReadSegment: () => false,
  } satisfies SpatialSkeletonOptimisticEditQueue;
}

function makeCommand() {
  return {
    action: SpatialSkeletonActions.moveNodes,
    label: "Test edit",
    payload: Object.freeze({}),
    getQueueInputRequirements: () => ({ required: [] }),
  };
}

function attachTestQueue(
  state: SpatialSkeletonState,
  queue: SpatialSkeletonOptimisticEditQueue,
) {
  (state as any).optimisticEditQueue = queue;
  vi.spyOn(state, "getOptimisticEditingIdentityService").mockReturnValue(
    {} as any,
  );
}

function confirmExecute(
  state: SpatialSkeletonState,
  command: ReturnType<typeof makeCommand>,
) {
  const ticket = state.commandHistory.stageExecute(command.label);
  state.commandHistory.confirm(ticket);
}

describe("optimistic skeleton undo/redo routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers queue-owned undo and redo transitions", async () => {
    const state = new SpatialSkeletonState();
    const queue = makeQueue({
      canUndo: true,
      canRedo: true,
      hasUnconfirmedActions: true,
    });
    attachTestQueue(state, queue);
    vi.spyOn(state.commandHistory, "getProjectedUndoEntry").mockReturnValue({
      entryId: 1,
      label: "Test edit",
    });
    vi.spyOn(state.commandHistory, "getProjectedRedoEntry").mockReturnValue({
      entryId: 2,
      label: "Test edit",
    });
    const layer = { spatialSkeletonState: state };

    await expect(undoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);
    await expect(redoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);

    expect(queue.undoLatest).toHaveBeenCalledOnce();
    expect(queue.redoLatest).toHaveBeenCalledOnce();
  });

  it("preserves queue admission and settlement milestones", async () => {
    let resolveUndo!: (value: boolean) => void;
    let resolveRedo!: (value: boolean) => void;
    const undoAcceptedByQueue = Promise.resolve();
    const redoAcceptedByQueue = Promise.resolve();
    const undoSettled = Promise.resolve(
      committedSpatialSkeletonOptimisticEditSettlement(),
    );
    const redoSettled = Promise.resolve(
      committedSpatialSkeletonOptimisticEditSettlement(),
    );
    const undoExecution = withExecutionMilestones(
      new Promise<boolean>((resolve) => {
        resolveUndo = resolve;
      }),
      undoAcceptedByQueue,
      undoSettled,
    );
    const redoExecution = withExecutionMilestones(
      new Promise<boolean>((resolve) => {
        resolveRedo = resolve;
      }),
      redoAcceptedByQueue,
      redoSettled,
    );
    const state = new SpatialSkeletonState();
    attachTestQueue(
      state,
      makeQueue({
        canUndo: true,
        canRedo: true,
        undoExecution,
        redoExecution,
      }),
    );
    vi.spyOn(state.commandHistory, "getProjectedUndoEntry").mockReturnValue({
      entryId: 1,
      label: "Test edit",
    });
    vi.spyOn(state.commandHistory, "getProjectedRedoEntry").mockReturnValue({
      entryId: 2,
      label: "Test edit",
    });
    const layer = { spatialSkeletonState: state };

    const routedUndo = undoSpatialSkeletonCommand(layer as any);
    const routedRedo = redoSpatialSkeletonCommand(layer as any);

    await Promise.all([routedUndo.acceptedByQueue, routedRedo.acceptedByQueue]);

    resolveUndo(true);
    resolveRedo(true);
    await expect(routedUndo).resolves.toBe(true);
    await expect(routedRedo).resolves.toBe(true);
    await expect(routedUndo.settled).resolves.toEqual(
      committedSpatialSkeletonOptimisticEditSettlement(),
    );
    await expect(routedRedo.settled).resolves.toEqual(
      committedSpatialSkeletonOptimisticEditSettlement(),
    );
  });

  it("returns the state's no-op execution when no queue exists", async () => {
    const state = new SpatialSkeletonState();

    const managerUndo = state.undoLatestOptimisticEdit();
    const managerRedo = state.redoLatestOptimisticEdit();
    vi.spyOn(state, "undoLatestOptimisticEdit").mockReturnValue(managerUndo);
    vi.spyOn(state, "redoLatestOptimisticEdit").mockReturnValue(managerRedo);
    const commandUndo = undoSpatialSkeletonCommand({
      spatialSkeletonState: state,
    } as any);

    const commandRedo = redoSpatialSkeletonCommand({
      spatialSkeletonState: state,
    } as any);

    expect(commandUndo).toBe(managerUndo);
    expect(commandRedo).toBe(managerRedo);

    await Promise.all([
      managerUndo.acceptedByQueue,
      managerRedo.acceptedByQueue,
      commandUndo.acceptedByQueue,
      commandRedo.acceptedByQueue,
    ]);
    await expect(managerUndo).resolves.toBe(false);
    await expect(managerRedo).resolves.toBe(false);
    await expect(commandUndo).resolves.toBe(false);
    await expect(commandRedo).resolves.toBe(false);
    await expect(managerUndo.settled).resolves.toEqual({
      outcome: "unchanged",
      reason: "no-op",
    });
    await expect(managerRedo.settled).resolves.toEqual({
      outcome: "unchanged",
      reason: "no-op",
    });
    await expect(commandUndo.settled).resolves.toEqual({
      outcome: "unchanged",
      reason: "no-op",
    });
    await expect(commandRedo.settled).resolves.toEqual({
      outcome: "unchanged",
      reason: "no-op",
    });
  });

  it("does not dispatch unavailable Undo/Redo to an installed queue", async () => {
    const state = new SpatialSkeletonState();
    const queue = makeQueue();
    attachTestQueue(state, queue);
    const layer = { spatialSkeletonState: state };
    const executions = [
      state.undoLatestOptimisticEdit(),
      state.redoLatestOptimisticEdit(),
      undoSpatialSkeletonCommand(layer as any),
      redoSpatialSkeletonCommand(layer as any),
    ];

    for (const execution of executions) {
      await expect(execution).resolves.toBe(false);
      await expect(execution.acceptedByQueue).resolves.toBeUndefined();
      await expect(execution.settled).resolves.toEqual({
        outcome: "unchanged",
        reason: "no-op",
      });
    }
    expect(queue.undoLatest).not.toHaveBeenCalled();
    expect(queue.redoLatest).not.toHaveBeenCalled();
  });

  it("does not fall through to stateful history when unresolved work has no legal transition", async () => {
    const showTemporaryMessage = vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockReturnValue({ dispose() {} } as StatusMessage);

    const undoState = new SpatialSkeletonState();
    const undoCommand = makeCommand();
    confirmExecute(undoState, undoCommand);
    attachTestQueue(undoState, makeQueue({ hasUnconfirmedActions: true }));

    await expect(
      undoSpatialSkeletonCommand({ spatialSkeletonState: undoState } as any),
    ).resolves.toBe(false);

    const redoState = new SpatialSkeletonState();
    const redoCommand = makeCommand();
    confirmExecute(redoState, redoCommand);
    const undoTicket = redoState.commandHistory.stageUndo()!;
    redoState.commandHistory.confirm(undoTicket);
    attachTestQueue(redoState, makeQueue({ hasUnconfirmedActions: true }));

    await expect(
      redoSpatialSkeletonCommand({ spatialSkeletonState: redoState } as any),
    ).resolves.toBe(false);
    expect(showTemporaryMessage).not.toHaveBeenCalled();
  });

  it("never falls through to direct history execution after the queue settles", async () => {
    const undoState = new SpatialSkeletonState();
    const undoCommand = makeCommand();
    confirmExecute(undoState, undoCommand);
    attachTestQueue(undoState, makeQueue());

    await expect(
      undoSpatialSkeletonCommand({ spatialSkeletonState: undoState } as any),
    ).resolves.toBe(false);

    const redoState = new SpatialSkeletonState();
    const redoCommand = makeCommand();
    confirmExecute(redoState, redoCommand);
    const undoTicket = redoState.commandHistory.stageUndo()!;
    redoState.commandHistory.confirm(undoTicket);
    attachTestQueue(redoState, makeQueue());

    await expect(
      redoSpatialSkeletonCommand({ spatialSkeletonState: redoState } as any),
    ).resolves.toBe(false);
  });
});
