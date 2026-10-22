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

import { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  redoSpatialSkeletonCommand,
  undoSpatialSkeletonCommand,
} from "#src/skeleton/edit/submit_edits.js";
import { SpatialSkeletonActions } from "#src/skeleton/edit_commands.js";
import type {
  SpatialSkeletonEditSettlement,
  SpatialSkeletonEditExecution,
  SpatialSkeletonSessionEditQueue,
} from "#src/skeleton/edit_queue/types.js";
import { committedSpatialSkeletonEditSettlement } from "#src/skeleton/edit_queue/types.js";
import { StatusMessage } from "#src/status.js";

function withExecutionMilestones<T>(
  execution: Promise<T>,
  acceptedByQueue: Promise<void> = Promise.resolve(),
  settled: Promise<SpatialSkeletonEditSettlement> = Promise.resolve(
    committedSpatialSkeletonEditSettlement(),
  ),
): SpatialSkeletonEditExecution<T> {
  Object.defineProperty(execution, "acceptedByQueue", {
    configurable: true,
    value: acceptedByQueue,
  });
  Object.defineProperty(execution, "settled", {
    configurable: true,
    value: settled,
  });
  return execution as SpatialSkeletonEditExecution<T>;
}

function makeQueue(
  options: {
    canUndo?: boolean;
    canRedo?: boolean;
    hasUnconfirmedActions?: boolean;
    undoExecution?: SpatialSkeletonEditExecution;
    redoExecution?: SpatialSkeletonEditExecution;
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
    getReloadRequired: () => undefined,
    handleReloadRequiredLatched: () => {},
    getProtectedPreviewSegmentIds: () => [],
    ownsAuthoritativeReadSegment: () => false,
  } satisfies SpatialSkeletonSessionEditQueue;
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
  state: SpatialSkeletonEditSession,
  queue: SpatialSkeletonSessionEditQueue,
) {
  (state as any).editQueue = queue;
  vi.spyOn(state, "getEditingIdentityService").mockReturnValue({} as any);
}

function confirmExecute(
  state: SpatialSkeletonEditSession,
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
    const state = new SpatialSkeletonEditSession();
    const queue = makeQueue({
      canUndo: true,
      canRedo: true,
      hasUnconfirmedActions: true,
    });
    attachTestQueue(state, queue);
    vi.spyOn(state.commandHistory, "getPreviewedUndoEntry").mockReturnValue({
      entryId: 1,
      label: "Test edit",
    });
    vi.spyOn(state.commandHistory, "getPreviewedRedoEntry").mockReturnValue({
      entryId: 2,
      label: "Test edit",
    });
    const layer = { spatialSkeletonEditSession: state };

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
      committedSpatialSkeletonEditSettlement(),
    );
    const redoSettled = Promise.resolve(
      committedSpatialSkeletonEditSettlement(),
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
    const state = new SpatialSkeletonEditSession();
    attachTestQueue(
      state,
      makeQueue({
        canUndo: true,
        canRedo: true,
        undoExecution,
        redoExecution,
      }),
    );
    vi.spyOn(state.commandHistory, "getPreviewedUndoEntry").mockReturnValue({
      entryId: 1,
      label: "Test edit",
    });
    vi.spyOn(state.commandHistory, "getPreviewedRedoEntry").mockReturnValue({
      entryId: 2,
      label: "Test edit",
    });
    const layer = { spatialSkeletonEditSession: state };

    const routedUndo = undoSpatialSkeletonCommand(layer as any);
    const routedRedo = redoSpatialSkeletonCommand(layer as any);

    await Promise.all([routedUndo.acceptedByQueue, routedRedo.acceptedByQueue]);

    resolveUndo(true);
    resolveRedo(true);
    await expect(routedUndo).resolves.toBe(true);
    await expect(routedRedo).resolves.toBe(true);
    await expect(routedUndo.settled).resolves.toEqual(
      committedSpatialSkeletonEditSettlement(),
    );
    await expect(routedRedo.settled).resolves.toEqual(
      committedSpatialSkeletonEditSettlement(),
    );
  });

  it("returns the state's no-op execution when no queue exists", async () => {
    const state = new SpatialSkeletonEditSession();

    const managerUndo = state.undoLatestEdit();
    const managerRedo = state.redoLatestEdit();
    vi.spyOn(state, "undoLatestEdit").mockReturnValue(managerUndo);
    vi.spyOn(state, "redoLatestEdit").mockReturnValue(managerRedo);
    const commandUndo = undoSpatialSkeletonCommand({
      spatialSkeletonEditSession: state,
    } as any);

    const commandRedo = redoSpatialSkeletonCommand({
      spatialSkeletonEditSession: state,
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
    const state = new SpatialSkeletonEditSession();
    const queue = makeQueue();
    attachTestQueue(state, queue);
    const layer = { spatialSkeletonEditSession: state };
    const executions = [
      state.undoLatestEdit(),
      state.redoLatestEdit(),
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

    const undoState = new SpatialSkeletonEditSession();
    const undoCommand = makeCommand();
    confirmExecute(undoState, undoCommand);
    attachTestQueue(undoState, makeQueue({ hasUnconfirmedActions: true }));

    await expect(
      undoSpatialSkeletonCommand({
        spatialSkeletonEditSession: undoState,
      } as any),
    ).resolves.toBe(false);

    const redoState = new SpatialSkeletonEditSession();
    const redoCommand = makeCommand();
    confirmExecute(redoState, redoCommand);
    const undoTicket = redoState.commandHistory.stageUndo()!;
    redoState.commandHistory.confirm(undoTicket);
    attachTestQueue(redoState, makeQueue({ hasUnconfirmedActions: true }));

    await expect(
      redoSpatialSkeletonCommand({
        spatialSkeletonEditSession: redoState,
      } as any),
    ).resolves.toBe(false);
    expect(showTemporaryMessage).not.toHaveBeenCalled();
  });

  it("never falls through to direct history execution after the queue settles", async () => {
    const undoState = new SpatialSkeletonEditSession();
    const undoCommand = makeCommand();
    confirmExecute(undoState, undoCommand);
    attachTestQueue(undoState, makeQueue());

    await expect(
      undoSpatialSkeletonCommand({
        spatialSkeletonEditSession: undoState,
      } as any),
    ).resolves.toBe(false);

    const redoState = new SpatialSkeletonEditSession();
    const redoCommand = makeCommand();
    confirmExecute(redoState, redoCommand);
    const undoTicket = redoState.commandHistory.stageUndo()!;
    redoState.commandHistory.confirm(undoTicket);
    attachTestQueue(redoState, makeQueue());

    await expect(
      redoSpatialSkeletonCommand({
        spatialSkeletonEditSession: redoState,
      } as any),
    ).resolves.toBe(false);
  });
});
