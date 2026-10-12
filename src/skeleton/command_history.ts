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

import type { SpatialSkeletonEditCommand } from "#src/skeleton/command_protocol.js";
import type { SpatialSkeletonOptimisticHistoryPort } from "#src/skeleton/optimistic_edit/ports.js";
import { DEFAULT_SPATIAL_SKELETON_OPTIMISTIC_EDIT_QUEUE_CAPACITY } from "#src/skeleton/optimistic_edit/types.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

export interface SpatialSkeletonCommandHistoryOptions {
  readonly capacity?: number;
}

export interface SpatialSkeletonCommandHistoryEntry {
  readonly entryId: number;
  readonly label: string;
}

export type SpatialSkeletonCommandHistoryTransitionKind =
  | "execute"
  | "undo"
  | "redo";

/**
 * Stable identity for one projected LIFO transition.
 *
 * Dependencies never change after staging. Definitive post-admission failure
 * discards the failed transition and its suffix without rewriting tickets.
 */
export interface SpatialSkeletonCommandHistoryTransitionTicket {
  readonly transitionId: number;
  readonly entryId: number;
  readonly label: string;
  readonly kind: SpatialSkeletonCommandHistoryTransitionKind;
  readonly semanticDependencyTransitionIds: readonly number[];
}

interface ProjectedEntry {
  readonly entry: SpatialSkeletonCommandHistoryEntry;
  exposedByTransitionId?: number;
}

interface ProjectedStacks {
  readonly undo: ProjectedEntry[];
  readonly redo: ProjectedEntry[];
}

/**
 * Bounded projected LIFO history.
 *
 * Authority transitions confirm in intent order. A failure while constructing
 * a not-yet-admitted intent may abandon only the latest staged ticket. Once an
 * intent is admitted, a definitive failure restores the history before it.
 */
export class SpatialSkeletonCommandHistory extends RefCounted {
  readonly canUndo = new WatchableValue(false);
  readonly canRedo = new WatchableValue(false);
  readonly undoLabel = new WatchableValue<string | undefined>(undefined);
  readonly redoLabel = new WatchableValue<string | undefined>(undefined);

  private confirmedUndo: SpatialSkeletonCommandHistoryEntry[] = [];
  private confirmedRedo: SpatialSkeletonCommandHistoryEntry[] = [];
  private projectedUndo: ProjectedEntry[] = [];
  private projectedRedo: ProjectedEntry[] = [];
  private readonly staged: SpatialSkeletonCommandHistoryTransitionTicket[] = [];
  private readonly confirmedTransitionIds = new Set<number>();
  private nextEntryId = 1;
  private nextTransitionId = 1;
  private source: unknown;
  readonly capacity: number;

  constructor(options: SpatialSkeletonCommandHistoryOptions = {}) {
    super();
    const capacity =
      options.capacity ??
      DEFAULT_SPATIAL_SKELETON_OPTIMISTIC_EDIT_QUEUE_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        "The spatial skeleton command-history capacity must be a positive safe integer.",
      );
    }
    this.capacity = capacity;
  }

  private updateState() {
    const canUndo = this.projectedUndo.length !== 0;
    const canRedo = this.projectedRedo.length !== 0;
    const undoLabel = this.projectedUndo.at(-1)?.entry.label;
    const redoLabel = this.projectedRedo.at(-1)?.entry.label;
    if (this.canUndo.value !== canUndo) this.canUndo.value = canUndo;
    if (this.canRedo.value !== canRedo) this.canRedo.value = canRedo;
    if (this.undoLabel.value !== undoLabel) this.undoLabel.value = undoLabel;
    if (this.redoLabel.value !== redoLabel) this.redoLabel.value = redoLabel;
  }

  private trimProjected(stacks: ProjectedStacks) {
    const retained = new Set(
      [...stacks.undo, ...stacks.redo]
        .map(({ entry }) => entry)
        .sort((a, b) => b.entryId - a.entryId)
        .slice(0, this.capacity)
        .map(({ entryId }) => entryId),
    );
    stacks.undo.splice(
      0,
      stacks.undo.length,
      ...stacks.undo.filter(({ entry }) => retained.has(entry.entryId)),
    );
    stacks.redo.splice(
      0,
      stacks.redo.length,
      ...stacks.redo.filter(({ entry }) => retained.has(entry.entryId)),
    );
  }

  private applyTransition(
    stacks: ProjectedStacks,
    ticket: SpatialSkeletonCommandHistoryTransitionTicket,
  ) {
    if (ticket.kind === "execute") {
      stacks.redo.length = 0;
      stacks.undo.push({
        entry: { entryId: ticket.entryId, label: ticket.label },
        exposedByTransitionId: ticket.transitionId,
      });
      this.trimProjected(stacks);
      return;
    }
    const source = ticket.kind === "undo" ? stacks.undo : stacks.redo;
    const destination = ticket.kind === "undo" ? stacks.redo : stacks.undo;
    const top = source.at(-1);
    if (top?.entry.entryId !== ticket.entryId) {
      throw new Error(
        `Command-history ${ticket.kind} ${ticket.transitionId} no longer targets the projected stack top.`,
      );
    }
    source.pop();
    const revealed = source.at(-1);
    if (revealed !== undefined) {
      revealed.exposedByTransitionId = ticket.transitionId;
    }
    destination.push({
      entry: top.entry,
      exposedByTransitionId: ticket.transitionId,
    });
    this.trimProjected(stacks);
  }

  private rebuildProjection() {
    const stacks: ProjectedStacks = {
      undo: this.confirmedUndo.map((entry) => ({ entry })),
      redo: this.confirmedRedo.map((entry) => ({ entry })),
    };
    for (const ticket of this.staged) this.applyTransition(stacks, ticket);
    this.projectedUndo = stacks.undo;
    this.projectedRedo = stacks.redo;
    this.updateState();
  }

  private createTransition(
    kind: SpatialSkeletonCommandHistoryTransitionKind,
    entry: SpatialSkeletonCommandHistoryEntry,
    semanticDependencyTransitionIds: readonly number[],
  ) {
    const ticket = Object.freeze({
      transitionId: this.nextTransitionId++,
      entryId: entry.entryId,
      label: entry.label,
      kind,
      semanticDependencyTransitionIds: Object.freeze([
        ...semanticDependencyTransitionIds,
      ]),
    });
    this.staged.push(ticket);
    this.applyTransition(
      { undo: this.projectedUndo, redo: this.projectedRedo },
      ticket,
    );
    this.updateState();
    return ticket;
  }

  stageExecute(label: string) {
    if (label.length === 0) {
      throw new TypeError("A spatial skeleton history entry requires a label.");
    }
    return this.createTransition(
      "execute",
      { entryId: this.nextEntryId++, label },
      [],
    );
  }

  stageUndo() {
    const source = this.projectedUndo.at(-1);
    if (source === undefined) return undefined;
    return this.createTransition(
      "undo",
      source.entry,
      source.exposedByTransitionId === undefined
        ? []
        : [source.exposedByTransitionId],
    );
  }

  stageRedo() {
    const source = this.projectedRedo.at(-1);
    if (source === undefined) return undefined;
    return this.createTransition(
      "redo",
      source.entry,
      source.exposedByTransitionId === undefined
        ? []
        : [source.exposedByTransitionId],
    );
  }

  /**
   * Marks a transition confirmed and advances the longest confirmed prefix.
   * This preserves immediate queued-opposite settlement without letting later
   * authority reorder the confirmed LIFO stacks.
   */
  confirm(ticket: SpatialSkeletonCommandHistoryTransitionTicket) {
    const index = this.staged.findIndex(
      ({ transitionId }) => transitionId === ticket.transitionId,
    );
    if (index === -1) return;
    this.confirmedTransitionIds.add(ticket.transitionId);
    while (
      this.staged[0] !== undefined &&
      this.confirmedTransitionIds.has(this.staged[0].transitionId)
    ) {
      const next = this.staged.shift()!;
      this.confirmedTransitionIds.delete(next.transitionId);
      const confirmedStacks: ProjectedStacks = {
        undo: this.confirmedUndo.map((entry) => ({ entry })),
        redo: this.confirmedRedo.map((entry) => ({ entry })),
      };
      this.applyTransition(confirmedStacks, next);
      this.confirmedUndo = confirmedStacks.undo.map(({ entry }) => entry);
      this.confirmedRedo = confirmedStacks.redo.map(({ entry }) => entry);
    }
    if (this.staged.length === 0) this.rebuildProjection();
  }

  /** Abandons a synchronous pre-admission transition and restores projection. */
  abandonLatest(ticket: SpatialSkeletonCommandHistoryTransitionTicket) {
    const latest = this.staged.at(-1);
    if (latest === undefined) return;
    if (latest.transitionId !== ticket.transitionId) {
      throw new Error(
        `Only the latest staged command-history transition may be abandoned; received ${ticket.transitionId}.`,
      );
    }
    this.rollbackFrom(ticket);
  }

  /** Restores history before a definitively failed transition, inclusively. */
  rollbackFrom(ticket: SpatialSkeletonCommandHistoryTransitionTicket) {
    const index = this.staged.findIndex(
      ({ transitionId }) => transitionId === ticket.transitionId,
    );
    if (index === -1) {
      throw new Error(
        `Missing staged command-history rollback boundary ${ticket.transitionId}.`,
      );
    }
    for (const discarded of this.staged.splice(index)) {
      this.confirmedTransitionIds.delete(discarded.transitionId);
    }
    this.rebuildProjection();
  }

  getStagedTransitions(): readonly SpatialSkeletonCommandHistoryTransitionTicket[] {
    return Object.freeze([...this.staged]);
  }

  getProjectedUndoEntry(): SpatialSkeletonCommandHistoryEntry | undefined {
    return this.projectedUndo.at(-1)?.entry;
  }

  getProjectedRedoEntry(): SpatialSkeletonCommandHistoryEntry | undefined {
    return this.projectedRedo.at(-1)?.entry;
  }

  getRetainedEntryIds(): readonly number[] {
    return Object.freeze([
      ...new Set([
        ...this.confirmedUndo.map(({ entryId }) => entryId),
        ...this.confirmedRedo.map(({ entryId }) => entryId),
        ...this.projectedUndo.map(({ entry }) => entry.entryId),
        ...this.projectedRedo.map(({ entry }) => entry.entryId),
        // An earlier in-flight save can keep a locally confirmed edit/Undo
        // pair staged. Its recipe may return to Redo if a newer edit fails.
        ...this.staged.map(({ entryId }) => entryId),
      ]),
    ]);
  }

  reset() {
    const changed =
      this.confirmedUndo.length !== 0 ||
      this.confirmedRedo.length !== 0 ||
      this.projectedUndo.length !== 0 ||
      this.projectedRedo.length !== 0 ||
      this.staged.length !== 0;
    this.confirmedUndo = [];
    this.confirmedRedo = [];
    this.projectedUndo = [];
    this.projectedRedo = [];
    this.staged.length = 0;
    this.confirmedTransitionIds.clear();
    this.updateState();
    return changed;
  }

  matchesSource(source: unknown) {
    return this.source === source;
  }

  setSource(source: unknown) {
    if (this.source === source) return false;
    this.source = source;
    this.reset();
    return true;
  }
}

export function createSpatialSkeletonOptimisticHistoryPort(
  history: SpatialSkeletonCommandHistory,
): SpatialSkeletonOptimisticHistoryPort<
  SpatialSkeletonEditCommand,
  SpatialSkeletonCommandHistoryTransitionTicket
> {
  return {
    capacity: history.capacity,
    stageExecute: (command) => history.stageExecute(command.label),
    stageUndo: () => history.stageUndo(),
    stageRedo: () => history.stageRedo(),
    getTicketId: (ticket) => ticket.transitionId,
    getEntryId: (ticket) => ticket.entryId,
    getSemanticDependencyTicketIds: (ticket) =>
      ticket.semanticDependencyTransitionIds,
    confirm: (ticket) => history.confirm(ticket),
    abandonLatest: (ticket) => history.abandonLatest(ticket),
    rollbackFrom: (ticket) => history.rollbackFrom(ticket),
    reset: () => history.reset(),
    canStage: (intent) =>
      intent === "undo" ? history.canUndo.value : history.canRedo.value,
    getProjectedEntryId: (intent) =>
      (intent === "undo"
        ? history.getProjectedUndoEntry()
        : history.getProjectedRedoEntry()
      )?.entryId,
    getRetainedEntryIds: () => history.getRetainedEntryIds(),
  };
}
