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

import type {
  SpatialSkeletonIntentAdmission,
  SpatialSkeletonIntentSequenceReservation,
} from "#src/skeleton/edit_queue/edit_intent_journal.js";
import {
  SpatialSkeletonIntentCapacityError,
  SpatialSkeletonIntentInvariantError,
  SpatialSkeletonIntentJournal,
} from "#src/skeleton/edit_queue/edit_intent_journal.js";
import type { SpatialSkeletonStableResourceHandle } from "#src/skeleton/edit_queue/stable_id_handles.js";
import {
  spatialSkeletonStableNode,
  spatialSkeletonStableSegment,
} from "#src/skeleton/edit_queue/stable_id_handles.js";

interface RequestedResult {
  readonly value: string;
}

interface InverseDelta {
  readonly before: string;
}

interface Metadata {
  readonly label: string;
}

type Journal = SpatialSkeletonIntentJournal<
  string,
  RequestedResult,
  InverseDelta,
  Metadata
>;

function admission(
  historyTicketId: string,
  handle: SpatialSkeletonStableResourceHandle,
  options: Partial<
    SpatialSkeletonIntentAdmission<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >
  > = {},
): SpatialSkeletonIntentAdmission<
  string,
  RequestedResult,
  InverseDelta,
  Metadata
> {
  return {
    kind: "execute",
    historyTicketId,
    resources: [{ handle, access: "write" }],
    requestedResult: { value: `after:${historyTicketId}` },
    inverseDelta: { before: `before:${historyTicketId}` },
    metadata: { label: historyTicketId },
    ...options,
  };
}

function admitExact(
  journal: Journal,
  value: SpatialSkeletonIntentAdmission<
    string,
    RequestedResult,
    InverseDelta,
    Metadata
  >,
  reservation?: SpatialSkeletonIntentSequenceReservation,
) {
  const record = journal.admit(value, reservation);
  journal.setPreviewState(record.sequence, "exact");
  return journal.get(record.sequence)!;
}

function settle(journal: Journal, sequence: number) {
  journal.claimAuthorityPlan(sequence);
  journal.markAuthorityCommitStarted(sequence);
  journal.recordCommittedEditRequestAttempt(sequence, {
    editRequest: undefined,
    result: undefined,
  });
  journal.markAuthorityCommitted(sequence);
  journal.settleSuccessful(sequence, "committed");
}

describe("edit intent journal", () => {
  it("owns immutable committed physical attempts canonically", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const record = admitExact(
      journal,
      admission("compound", spatialSkeletonStableSegment("compound")),
    );
    expect(journal.claimAuthorityPlan(record.sequence)).toBe(true);
    expect(journal.claimAuthorityPlan(record.sequence)).toBe(false);
    expect(journal.get(record.sequence)?.lifecycle.authority).toBe("waiting");
    journal.markAuthorityCommitStarted(record.sequence);

    journal.recordCommittedEditRequestAttempt(record.sequence, {
      editRequest: { step: "split" },
      result: { id: 101 },
    });
    journal.recordCommittedEditRequestAttempt(record.sequence, {
      editRequest: { step: "reroot" },
      result: { id: 202 },
    });

    expect(journal.get(record.sequence)).toEqual(
      expect.objectContaining({
        committedEditRequestAttempts: [
          expect.objectContaining({
            editRequest: { step: "split" },
            result: { id: 101 },
          }),
          expect.objectContaining({
            editRequest: { step: "reroot" },
            result: { id: 202 },
          }),
        ],
      }),
    );
    expect(
      Object.isFrozen(
        journal.get(record.sequence)!.committedEditRequestAttempts,
      ),
    ).toBe(true);
    expect(Object.isFrozen(journal.get(record.sequence))).toBe(true);
    expect(Object.isFrozen(journal.get(record.sequence)!.lifecycle)).toBe(true);
    expect(Object.isFrozen(journal.get(record.sequence)!.resources)).toBe(true);
    expect(
      Object.isFrozen(
        journal.get(record.sequence)!.committedEditRequestAttempts[0],
      ),
    ).toBe(true);
  });

  it("indexes resource and semantic dependencies in intent order", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segmentA = spatialSkeletonStableSegment("A");
    const segmentB = spatialSkeletonStableSegment("B");
    const nodeA = spatialSkeletonStableNode("A:node");

    const merge = admitExact(journal, admission("merge", segmentA));
    const edit = admitExact(journal, {
      ...admission("edit", nodeA),
      resources: [
        { handle: segmentA, access: "read" },
        { handle: nodeA, access: "write" },
      ],
    });
    const independent = admitExact(journal, admission("independent", segmentB));
    const historyOrdered = admitExact(journal, {
      ...admission("history", segmentB),
      semanticDependencySequences: [edit.sequence],
    });

    expect(merge.sequence).toBe(1);
    expect(edit.resourceDependencySequences).toEqual([merge.sequence]);
    expect(edit.semanticDependencySequences).toEqual([]);
    expect(independent.dependencySequences).toEqual([]);
    expect(historyOrdered.resourceDependencySequences).toEqual([
      independent.sequence,
    ]);
    expect(historyOrdered.semanticDependencySequences).toEqual([edit.sequence]);
    settle(journal, merge.sequence);
    journal.assertInvariants();
  });

  it("reserves deterministic intent ids without admitting partial records", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const reserved = journal.reserveSequence();

    expect(reserved.sequence).toBe(1);
    expect(journal.size).toBe(0);
    expect(() =>
      admitExact(
        journal,
        admission("wrong-owner", spatialSkeletonStableSegment(1)),
      ),
    ).toThrow(SpatialSkeletonIntentInvariantError);
    expect(() => journal.reserveSequence()).toThrow(
      SpatialSkeletonIntentInvariantError,
    );

    const first = admitExact(
      journal,
      admission("first", spatialSkeletonStableSegment(1)),
      reserved,
    );
    expect(first.sequence).toBe(1);
    expect(first.lifecycle).toEqual(
      expect.objectContaining({
        preview: "exact",
        authority: "queued",
        history: "staged",
      }),
    );

    const canceled = journal.reserveSequence();
    expect(canceled.sequence).toBe(2);
    expect(journal.cancelSequenceReservation(canceled)).toBe(true);
    expect(journal.cancelSequenceReservation(canceled)).toBe(false);
    expect(() =>
      admitExact(
        journal,
        admission("stale", spatialSkeletonStableSegment(2)),
        canceled,
      ),
    ).toThrow(SpatialSkeletonIntentInvariantError);
    expect(
      admitExact(journal, admission("second", spatialSkeletonStableSegment(2)))
        .sequence,
    ).toBe(2);
    journal.assertInvariants();
  });

  it("records execute, undo, and redo as independent state machines", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segment = spatialSkeletonStableSegment("A");
    const execute = admitExact(journal, admission("execute:1", segment));
    const undoAdmission = journal.admit({
      ...admission("undo:1", segment),
      kind: "undo",
      semanticDependencySequences: [execute.sequence],
      requestedResult: { value: "original" },
      inverseDelta: { before: "edited" },
    });
    journal.setPreviewState(undoAdmission.sequence, "preparing");
    const undo = journal.get(undoAdmission.sequence)!;
    const redo = admitExact(journal, {
      ...admission("redo:1", segment),
      kind: "redo",
      semanticDependencySequences: [undo.sequence],
      requestedResult: { value: "edited-again" },
      inverseDelta: { before: "original" },
    });

    expect(execute.kind).toBe("execute");
    expect(undo).toMatchObject({
      kind: "undo",
      lifecycle: {
        preview: "preparing",
        authority: "queued",
        history: "staged",
      },
      requestedResult: { value: "original" },
      inverseDelta: { before: "edited" },
    });
    expect(redo).toMatchObject({
      kind: "redo",
      lifecycle: {
        preview: "exact",
        authority: "queued",
        history: "staged",
      },
    });

    journal.setPreviewState(undo.sequence, "exact");
    expect(journal.get(undo.sequence)?.lifecycle.preview).toBe("exact");
    expect(journal.get(execute.sequence)?.lifecycle.preview).toBe("exact");
    expect(journal.get(redo.sequence)?.lifecycle.preview).toBe("exact");
    journal.assertInvariants();
  });

  it("atomically refreshes only active exact preview artifacts", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const exact = admitExact(
      journal,
      admission("exact", spatialSkeletonStableSegment("exact")),
    );
    const reserved = journal.admit(
      admission("reserved", spatialSkeletonStableSegment("reserved")),
    );

    expect(() =>
      journal.refreshExactPreviewArtifacts([
        {
          sequence: exact.sequence,
          requestedResult: { value: "new-forward" },
          inverseDelta: { before: "new-inverse" },
        },
        {
          sequence: reserved.sequence,
          requestedResult: { value: "invalid-forward" },
          inverseDelta: { before: "invalid-inverse" },
        },
      ]),
    ).toThrow(/preview state reserved/);
    expect(journal.get(exact.sequence)).toMatchObject({
      requestedResult: { value: "after:exact" },
      inverseDelta: { before: "before:exact" },
    });

    journal.refreshExactPreviewArtifacts([
      {
        sequence: exact.sequence,
        requestedResult: { value: "new-forward" },
        inverseDelta: { before: "new-inverse" },
      },
    ]);
    expect(journal.get(exact.sequence)).toMatchObject({
      requestedResult: { value: "new-forward" },
      inverseDelta: { before: "new-inverse" },
    });
  });

  it("rejects the complete active suffix", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segmentA = spatialSkeletonStableSegment("A");
    const segmentB = spatialSkeletonStableSegment("B");
    const first = admitExact(journal, admission("first", segmentA));
    const second = admitExact(journal, admission("second", segmentA));
    const third = admitExact(journal, {
      ...admission("third", spatialSkeletonStableNode("created-by-second")),
      semanticDependencySequences: [second.sequence],
    });
    const independent = admitExact(journal, admission("independent", segmentB));

    const laterError = new Error("history reset");
    expect(
      journal
        .rejectActiveSuffix(first.sequence, {
          rootReason: "rejected",
          rootError: "CATMAID rejected merge",
          laterError,
        })
        .map(({ sequence }) => sequence),
    ).toEqual([
      first.sequence,
      second.sequence,
      third.sequence,
      independent.sequence,
    ]);
    for (const sequence of [
      first.sequence,
      second.sequence,
      third.sequence,
      independent.sequence,
    ]) {
      expect(journal.get(sequence)).toMatchObject({
        lifecycle: {
          preview: "rolled-back",
          authority: "unchanged",
          history: "rejected",
        },
        terminal: true,
        rejectionReason:
          sequence === first.sequence ? "CATMAID rejected merge" : laterError,
      });
    }
    expect(journal.unresolvedIntentCount).toBe(0);
    expect(journal.get(first.sequence)?.canceledLaterIntentCount).toBe(3);
    journal.assertInvariants();
  });

  it("enforces 64 work slots while allowing explicitly net-neutral coalescing", () => {
    expect(new SpatialSkeletonIntentJournal().capacity).toBe(64);
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >(2);
    const segmentA = spatialSkeletonStableSegment("A");
    const segmentB = spatialSkeletonStableSegment("B");
    const first = admitExact(journal, admission("first", segmentA));
    const second = admitExact(journal, admission("second", segmentB));

    expect(journal.unresolvedWorkCount).toBe(2);
    expect(() =>
      admitExact(
        journal,
        admission("third", spatialSkeletonStableSegment("third")),
      ),
    ).toThrow(SpatialSkeletonIntentCapacityError);

    const coalesced = admitExact(journal, {
      ...admission("second:new-value", segmentB),
      coalescesSequence: second.sequence,
    });
    expect(coalesced.capacityGroupSequence).toBe(second.capacityGroupSequence);
    expect(coalesced.dependencySequences).toEqual([second.sequence]);
    expect(journal.unresolvedIntentCount).toBe(3);
    expect(journal.unresolvedWorkCount).toBe(2);

    expect(() =>
      admitExact(journal, {
        ...admission("invalid-coalesce", segmentB),
        coalescesSequence: second.sequence,
      }),
    ).toThrow(/latest writer|observed/);

    settle(journal, first.sequence);
    expect(journal.unresolvedWorkCount).toBe(1);
    expect(() =>
      admitExact(
        journal,
        admission("replacement-work", spatialSkeletonStableSegment("C")),
      ),
    ).not.toThrow();
    journal.assertInvariants();
  });

  it("compacts folded terminal records without retaining stale dependency edges", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segment = spatialSkeletonStableSegment("A");
    const first = admitExact(journal, admission("first", segment));
    settle(journal, first.sequence);
    const second = admitExact(journal, admission("second", segment));
    settle(journal, second.sequence);
    const active = admitExact(journal, admission("active", segment));

    expect(active.dependencySequences).toEqual([second.sequence]);
    expect(journal.compactTerminalRecords({ retainRecent: 1 })).toBe(1);
    expect(journal.get(first.sequence)).toBeUndefined();
    expect(journal.get(second.sequence)).toBeDefined();
    expect(journal.get(active.sequence)?.dependencySequences).toEqual([
      second.sequence,
    ]);

    expect(journal.compactTerminalRecords()).toBe(1);
    expect(journal.get(second.sequence)).toBeUndefined();
    expect(journal.get(active.sequence)?.dependencySequences).toEqual([]);
    journal.assertInvariants();
  });

  it("retains a terminal capacity-group root until its coalesced intent settles", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segment = spatialSkeletonStableSegment("A");
    const original = admitExact(journal, admission("original", segment));
    const coalesced = admitExact(journal, {
      ...admission("coalesced", segment),
      coalescesSequence: original.sequence,
    });
    settle(journal, original.sequence);

    expect(journal.compactTerminalRecords()).toBe(0);
    expect(journal.get(original.sequence)).toBeDefined();

    settle(journal, coalesced.sequence);
    expect(journal.compactTerminalRecords()).toBe(2);
    expect(journal.getEntries()).toEqual([]);
    journal.assertInvariants();
  });

  it("atomically cancels an unsent pair without losing its earlier writer", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segment = spatialSkeletonStableSegment("A");
    const blocker = admitExact(journal, admission("blocker", segment));
    const execute = admitExact(journal, admission("execute", segment));
    const undo = admitExact(journal, {
      ...admission("undo", segment),
      kind: "undo",
      coalescesSequence: execute.sequence,
    });

    expect(execute.dependencySequences).toEqual([blocker.sequence]);
    journal.setPreviewState(undo.sequence, "promoted");
    expect(() =>
      journal.settleQueuedCancellationPair(execute.sequence, undo.sequence),
    ).toThrow(/exact rollback preview/);
    // Restore a fresh journal because preview state transitions are
    // intentionally one-way.
    const retry = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const retryBlocker = admitExact(retry, admission("blocker", segment));
    const retryExecute = admitExact(retry, admission("execute", segment));
    const retryUndo = admitExact(retry, {
      ...admission("undo", segment),
      kind: "undo",
      coalescesSequence: retryExecute.sequence,
    });
    retry.setPreviewState(retryUndo.sequence, "exact");

    expect(
      retry.settleQueuedCancellationPair(
        retryExecute.sequence,
        retryUndo.sequence,
      ),
    ).toMatchObject({
      target: {
        lifecycle: {
          authority: "unchanged",
          preview: "rolled-back",
          history: "advanced",
        },
      },
      opposite: {
        lifecycle: {
          authority: "unchanged",
          preview: "promoted",
          history: "advanced",
        },
      },
    });
    expect(retry.unresolvedWorkCount).toBe(1);
    const follower = admitExact(retry, admission("follower", segment));
    expect(follower.dependencySequences).toEqual([retryBlocker.sequence]);
    retry.assertInvariants();
  });

  it("refuses no-op coalescing after another active intent observed the target", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segment = spatialSkeletonStableSegment("A");
    const execute = admitExact(journal, admission("execute", segment));
    admitExact(journal, {
      ...admission("observer", spatialSkeletonStableSegment("B")),
      semanticDependencySequences: [execute.sequence],
    });
    expect(() =>
      admitExact(journal, {
        ...admission("undo", segment),
        kind: "undo",
        coalescesSequence: execute.sequence,
      }),
    ).toThrow(/active intent .* observed/);
    expect(journal.hasUnresolvedIntents).toBe(true);
    journal.assertInvariants();
  });

  it("rejects missing, future, duplicate-ticket, and rejected dependencies", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segment = spatialSkeletonStableSegment("A");
    const first = admitExact(journal, admission("ticket:1", segment));

    expect(() =>
      admitExact(journal, {
        ...admission("future", spatialSkeletonStableSegment("B")),
        semanticDependencySequences: [2],
      }),
    ).toThrow(/not earlier/);
    expect(() =>
      admitExact(journal, {
        ...admission("missing", spatialSkeletonStableSegment("B")),
        semanticDependencySequences: [99],
      }),
    ).toThrow(/not earlier/);
    expect(() =>
      admitExact(
        journal,
        admission("ticket:1", spatialSkeletonStableSegment("duplicate")),
      ),
    ).toThrow(/history ticket/i);

    journal.rejectActiveSuffix(first.sequence, {
      rootReason: "rejected",
      rootError: new Error("rejected"),
      laterError: new Error("history reset"),
    });
    expect(() =>
      admitExact(journal, {
        ...admission("after-rejection", spatialSkeletonStableSegment("C")),
        semanticDependencySequences: [first.sequence],
      }),
    ).toThrow(/rejected intent/);
    journal.assertInvariants();
  });

  it("prevents unsafe submission and distinguishes lease waiting from commit", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segmentA = spatialSkeletonStableSegment("A");
    const blocked = admitExact(journal, admission("blocked:first", segmentA));
    const dependent = admitExact(
      journal,
      admission("blocked:second", segmentA),
    );
    const independent = admitExact(
      journal,
      admission("independent", spatialSkeletonStableSegment("B")),
    );

    expect(() => journal.claimAuthorityPlan(dependent.sequence)).toThrow(
      /dependency is unresolved/,
    );
    expect(() =>
      journal.claimAuthorityPlan(independent.sequence),
    ).not.toThrow();

    journal.claimAuthorityPlan(blocked.sequence);
    expect(journal.get(blocked.sequence)).toMatchObject({
      lifecycle: { authority: "waiting", preview: "exact" },
      terminal: false,
    });
    journal.markAuthorityCommitStarted(blocked.sequence);
    expect(journal.get(blocked.sequence)).toMatchObject({
      lifecycle: { authority: "running" },
    });
    expect(journal.getBlockingDependencies(dependent.sequence)).toEqual([
      blocked.sequence,
    ]);

    journal.recordCommittedEditRequestAttempt(blocked.sequence, {
      editRequest: undefined,
      result: undefined,
    });
    journal.markAuthorityCommitted(blocked.sequence);
    expect(journal.get(blocked.sequence)).toMatchObject({
      lifecycle: { authority: "committed" },
      terminal: false,
    });
    journal.settleSuccessful(blocked.sequence, "committed");
    expect(journal.claimAuthorityPlan(blocked.sequence)).toBe(false);
    journal.assertInvariants();
  });

  it("requires terminal suffix rejection before a dependent can submit", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segment = spatialSkeletonStableSegment("A");
    const first = admitExact(journal, admission("first", segment));
    const second = admitExact(journal, admission("second", segment));

    expect(() => journal.claimAuthorityPlan(second.sequence)).toThrow(
      SpatialSkeletonIntentInvariantError,
    );
    expect(
      journal
        .rejectActiveSuffix(first.sequence, {
          rootReason: "rejected",
          rootError: new Error("rejected"),
          laterError: new Error("history reset"),
        })
        .map(({ sequence }) => sequence),
    ).toEqual([first.sequence, second.sequence]);
    expect(journal.hasUnresolvedIntents).toBe(false);
    expect(journal.unresolvedWorkCount).toBe(0);
    journal.assertInvariants();
  });
});
