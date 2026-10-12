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

import { describe, expect, it } from "vitest";

import {
  createSpatialSkeletonOptimisticHistoryPort,
  SpatialSkeletonCommandHistory,
} from "#src/skeleton/command_history.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonEditCommand,
} from "#src/skeleton/command_protocol.js";

function command(label: string): SpatialSkeletonEditCommand {
  return {
    action: SpatialSkeletonActions.moveNodes,
    label,
    payload: Object.freeze({}),
    getQueueInputRequirements: () => ({ required: [] }),
  };
}

describe("skeleton/command_history", () => {
  it("projects staged execute, undo, and redo as a LIFO suffix", () => {
    const history = new SpatialSkeletonCommandHistory();
    const first = history.stageExecute("First");
    const second = history.stageExecute("Second");

    expect(history.undoLabel.value).toBe("Second");
    const undoSecond = history.stageUndo()!;
    expect(undoSecond).toMatchObject({
      kind: "undo",
      entryId: second.entryId,
      semanticDependencyTransitionIds: [second.transitionId],
    });
    expect(history.undoLabel.value).toBe("First");
    expect(history.redoLabel.value).toBe("Second");

    const undoFirst = history.stageUndo()!;
    expect(undoFirst.semanticDependencyTransitionIds).toEqual([
      undoSecond.transitionId,
    ]);
    const redoFirst = history.stageRedo()!;
    expect(redoFirst).toMatchObject({
      kind: "redo",
      entryId: first.entryId,
      semanticDependencyTransitionIds: [undoFirst.transitionId],
    });
  });

  it("advances only the confirmed prefix when a later no-op settles first", () => {
    const history = new SpatialSkeletonCommandHistory();
    const first = history.stageExecute("First");
    const second = history.stageExecute("Second");

    history.confirm(second);
    expect(history.getStagedTransitions()).toEqual([first, second]);
    history.confirm(first);
    expect(history.getStagedTransitions()).toEqual([]);
    expect(history.undoLabel.value).toBe("Second");
  });

  it("abandons only the newest pre-admission transition", () => {
    const history = new SpatialSkeletonCommandHistory();
    const original = history.stageExecute("Original");
    history.confirm(original);
    const undo = history.stageUndo()!;
    history.confirm(undo);

    const replacement = history.stageExecute("Replacement");
    expect(history.canRedo.value).toBe(false);
    history.abandonLatest(replacement);
    expect(history.canUndo.value).toBe(false);
    expect(history.redoLabel.value).toBe("Original");

    const first = history.stageExecute("First");
    const second = history.stageExecute("Second");
    expect(() => history.abandonLatest(first)).toThrow(/latest staged/);
    history.abandonLatest(second);
    history.abandonLatest(first);
  });

  it("explicitly resets confirmed and staged state", () => {
    const history = new SpatialSkeletonCommandHistory();
    const confirmed = history.stageExecute("Confirmed");
    history.confirm(confirmed);
    const failed = history.stageExecute("Failed");
    history.stageExecute("Canceled later");

    expect(history.reset()).toBe(true);
    expect(history.canUndo.value).toBe(false);
    expect(history.canRedo.value).toBe(false);
    expect(history.getRetainedEntryIds()).toEqual([]);
    expect(history.getStagedTransitions()).toEqual([]);

    expect(() => history.confirm(failed)).not.toThrow();
    expect(history.reset()).toBe(false);
  });

  it("applies one capacity bound to confirmed and projected stacks", () => {
    const history = new SpatialSkeletonCommandHistory({ capacity: 3 });
    const tickets = Array.from({ length: 5 }, (_, index) =>
      history.stageExecute(`Command ${index + 1}`),
    );
    for (const ticket of tickets) history.confirm(ticket);

    expect(history.getRetainedEntryIds()).toEqual(
      tickets.slice(-3).map(({ entryId }) => entryId),
    );
    expect([
      history.stageUndo(),
      history.stageUndo(),
      history.stageUndo(),
    ]).not.toContain(undefined);
    expect(history.stageUndo()).toBeUndefined();
  });

  it("restores Redo and capacity entries displaced by a rejected Execute", () => {
    const history = new SpatialSkeletonCommandHistory({ capacity: 2 });
    const first = history.stageExecute("First");
    history.confirm(first);
    const second = history.stageExecute("Second");
    history.confirm(second);
    history.confirm(history.stageUndo()!);
    const failed = history.stageExecute("Failed");
    const later = history.stageExecute("Later");
    expect(history.canRedo.value).toBe(false);

    history.rollbackFrom(failed);
    expect(history.undoLabel.value).toBe("First");
    expect(history.redoLabel.value).toBe("Second");
    expect(history.getRetainedEntryIds()).toEqual([
      first.entryId,
      second.entryId,
    ]);
    history.confirm(later);
    expect(history.redoLabel.value).toBe("Second");
    const redo = history.stageRedo()!;
    expect(redo.transitionId).toBeGreaterThan(later.transitionId);
    history.confirm(redo);
    expect(history.undoLabel.value).toBe("Second");

    const overflow = history.stageExecute("Overflow");
    history.rollbackFrom(overflow);
    history.confirm(history.stageUndo()!);
    history.confirm(history.stageUndo()!);
    expect(history.stageUndo()).toBeUndefined();
    expect(history.redoLabel.value).toBe("First");
  });

  it.each(["undo", "redo"] as const)(
    "restores the source stack after rejected %s",
    (kind) => {
      const history = new SpatialSkeletonCommandHistory();
      const original = history.stageExecute("Original");
      history.confirm(original);
      if (kind === "redo") history.confirm(history.stageUndo()!);
      const failed = (
        kind === "undo" ? history.stageUndo() : history.stageRedo()
      )!;
      history.stageExecute("Canceled later");
      history.rollbackFrom(failed);
      expect(history.canUndo.value).toBe(kind === "undo");
      expect(history.canRedo.value).toBe(kind === "redo");
      const retry = (
        kind === "undo" ? history.stageUndo() : history.stageRedo()
      )!;
      expect(retry.entryId).toBe(original.entryId);
      history.confirm(retry);
      expect(history.canUndo.value).toBe(kind === "redo");
      expect(history.canRedo.value).toBe(kind === "undo");
    },
  );

  it("retains staged recipes and confirmations only before the rollback boundary", () => {
    const history = new SpatialSkeletonCommandHistory({ capacity: 2 });
    const pending = history.stageExecute("Still saving");
    const reverted = history.stageExecute("Reverted before failure");
    const undo = history.stageUndo()!;
    history.confirm(reverted);
    history.confirm(undo);
    const failed = history.stageExecute("Failed");
    const later = history.stageExecute("Reverted after failure");
    const laterUndo = history.stageUndo()!;
    history.confirm(later);
    history.confirm(laterUndo);
    expect(history.getRetainedEntryIds()).toContain(reverted.entryId);

    history.rollbackFrom(failed);
    expect(history.getStagedTransitions()).toEqual([pending, reverted, undo]);
    expect(history.undoLabel.value).toBe("Still saving");
    expect(history.redoLabel.value).toBe("Reverted before failure");
    history.confirm(later);
    history.confirm(laterUndo);
    history.confirm(pending);
    expect(history.getStagedTransitions()).toEqual([]);
    expect(history.getRetainedEntryIds()).toEqual([
      pending.entryId,
      reverted.entryId,
    ]);
    expect(history.redoLabel.value).toBe("Reverted before failure");
  });

  it("rejects a missing rollback boundary instead of silently losing history", () => {
    const history = new SpatialSkeletonCommandHistory();
    const confirmed = history.stageExecute("Saved");
    history.confirm(confirmed);
    expect(() => history.rollbackFrom(confirmed)).toThrow(/rollback boundary/);
    expect(history.undoLabel.value).toBe("Saved");
  });

  it("exposes the direct-cutover history port", () => {
    const history = new SpatialSkeletonCommandHistory();
    const port = createSpatialSkeletonOptimisticHistoryPort(history);
    const execute = port.stageExecute(command("Move node"));
    const undo = port.stageUndo()!;

    expect(port.getTicketId(execute)).toBe(execute.transitionId);
    expect(port.getEntryId(undo)).toBe(execute.entryId);
    expect(port.getSemanticDependencyTicketIds(undo)).toEqual([
      execute.transitionId,
    ]);
    port.reset();
    expect(() => port.confirm(execute)).not.toThrow();
  });

  it("resets history when its source changes", () => {
    const history = new SpatialSkeletonCommandHistory();
    history.stageExecute("Move");
    expect(history.setSource({ id: 1 })).toBe(true);
    expect(history.canUndo.value).toBe(false);
    expect(history.setSource(history)).toBe(true);
    expect(history.setSource(history)).toBe(false);
  });
});
