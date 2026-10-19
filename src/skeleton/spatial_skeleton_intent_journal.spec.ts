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
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
  type SpatialSkeletonLogicalResourceHandle,
} from "#src/skeleton/logical_identity.js";
import {
  SpatialSkeletonIntentCapacityError,
  SpatialSkeletonIntentInvariantError,
  SpatialSkeletonIntentJournal,
  type SpatialSkeletonIntentAdmission,
  type SpatialSkeletonIntentSequenceReservation,
} from "#src/skeleton/spatial_skeleton_intent_journal.js";

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
  handle: SpatialSkeletonLogicalResourceHandle,
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
  journal.claimAuthorityWorkflow(sequence);
  journal.markAuthorityCommitStarted(sequence);
  journal.recordCommittedMutationAttempt(sequence, {
    mutation: undefined,
    result: undefined,
  });
  journal.markAuthorityCommitted(sequence);
  journal.settleSuccessful(sequence, "committed");
}

describe("skeleton/spatial_skeleton_intent_journal", () => {
  it("owns immutable committed physical attempts canonically", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const record = admitExact(
      journal,
      admission("compound", spatialSkeletonLogicalSegment("compound")),
    );
    expect(journal.claimAuthorityWorkflow(record.sequence)).toBe(true);
    expect(journal.claimAuthorityWorkflow(record.sequence)).toBe(false);
    expect(journal.get(record.sequence)?.lifecycle.authority).toBe("waiting");
    journal.markAuthorityCommitStarted(record.sequence);

    journal.recordCommittedMutationAttempt(record.sequence, {
      mutation: { step: "split" },
      result: { id: 101 },
    });
    journal.recordCommittedMutationAttempt(record.sequence, {
      mutation: { step: "reroot" },
      result: { id: 202 },
    });

    expect(journal.get(record.sequence)).toEqual(
      expect.objectContaining({
        committedMutationAttempts: [
          expect.objectContaining({
            mutation: { step: "split" },
            result: { id: 101 },
          }),
          expect.objectContaining({
            mutation: { step: "reroot" },
            result: { id: 202 },
          }),
        ],
      }),
    );
    expect(
      Object.isFrozen(journal.get(record.sequence)!.committedMutationAttempts),
    ).toBe(true);
    expect(Object.isFrozen(journal.get(record.sequence))).toBe(true);
    expect(Object.isFrozen(journal.get(record.sequence)!.lifecycle)).toBe(true);
    expect(Object.isFrozen(journal.get(record.sequence)!.resources)).toBe(true);
    expect(
      Object.isFrozen(
        journal.get(record.sequence)!.committedMutationAttempts[0],
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
    const segmentA = spatialSkeletonLogicalSegment("A");
    const segmentB = spatialSkeletonLogicalSegment("B");
    const nodeA = spatialSkeletonLogicalNode("A:node");

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
        admission("wrong-owner", spatialSkeletonLogicalSegment(1)),
      ),
    ).toThrow(SpatialSkeletonIntentInvariantError);
    expect(() => journal.reserveSequence()).toThrow(
      SpatialSkeletonIntentInvariantError,
    );

    const first = admitExact(
      journal,
      admission("first", spatialSkeletonLogicalSegment(1)),
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
        admission("stale", spatialSkeletonLogicalSegment(2)),
        canceled,
      ),
    ).toThrow(SpatialSkeletonIntentInvariantError);
    expect(
      admitExact(journal, admission("second", spatialSkeletonLogicalSegment(2)))
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
    const segment = spatialSkeletonLogicalSegment("A");
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

  it("atomically refreshes only active exact projection artifacts", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const exact = admitExact(
      journal,
      admission("exact", spatialSkeletonLogicalSegment("exact")),
    );
    const reserved = journal.admit(
      admission("reserved", spatialSkeletonLogicalSegment("reserved")),
    );

    expect(() =>
      journal.refreshExactProjectionArtifacts([
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

    journal.refreshExactProjectionArtifacts([
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
    const segmentA = spatialSkeletonLogicalSegment("A");
    const segmentB = spatialSkeletonLogicalSegment("B");
    const first = admitExact(journal, admission("first", segmentA));
    const second = admitExact(journal, admission("second", segmentA));
    const third = admitExact(journal, {
      ...admission("third", spatialSkeletonLogicalNode("created-by-second")),
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
    const segmentA = spatialSkeletonLogicalSegment("A");
    const segmentB = spatialSkeletonLogicalSegment("B");
    const first = admitExact(journal, admission("first", segmentA));
    const second = admitExact(journal, admission("second", segmentB));

    expect(journal.unresolvedWorkCount).toBe(2);
    expect(() =>
      admitExact(
        journal,
        admission("third", spatialSkeletonLogicalSegment("third")),
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
        admission("replacement-work", spatialSkeletonLogicalSegment("C")),
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
    const segment = spatialSkeletonLogicalSegment("A");
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
    const segment = spatialSkeletonLogicalSegment("A");
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
    const segment = spatialSkeletonLogicalSegment("A");
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
    const segment = spatialSkeletonLogicalSegment("A");
    const execute = admitExact(journal, admission("execute", segment));
    admitExact(journal, {
      ...admission("observer", spatialSkeletonLogicalSegment("B")),
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
    const segment = spatialSkeletonLogicalSegment("A");
    const first = admitExact(journal, admission("ticket:1", segment));

    expect(() =>
      admitExact(journal, {
        ...admission("future", spatialSkeletonLogicalSegment("B")),
        semanticDependencySequences: [2],
      }),
    ).toThrow(/not earlier/);
    expect(() =>
      admitExact(journal, {
        ...admission("missing", spatialSkeletonLogicalSegment("B")),
        semanticDependencySequences: [99],
      }),
    ).toThrow(/not earlier/);
    expect(() =>
      admitExact(
        journal,
        admission("ticket:1", spatialSkeletonLogicalSegment("duplicate")),
      ),
    ).toThrow(/history ticket/i);

    journal.rejectActiveSuffix(first.sequence, {
      rootReason: "rejected",
      rootError: new Error("rejected"),
      laterError: new Error("history reset"),
    });
    expect(() =>
      admitExact(journal, {
        ...admission("after-rejection", spatialSkeletonLogicalSegment("C")),
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
    const segmentA = spatialSkeletonLogicalSegment("A");
    const blocked = admitExact(journal, admission("blocked:first", segmentA));
    const dependent = admitExact(
      journal,
      admission("blocked:second", segmentA),
    );
    const independent = admitExact(
      journal,
      admission("independent", spatialSkeletonLogicalSegment("B")),
    );

    expect(() => journal.claimAuthorityWorkflow(dependent.sequence)).toThrow(
      /dependency is unresolved/,
    );
    expect(() =>
      journal.claimAuthorityWorkflow(independent.sequence),
    ).not.toThrow();

    journal.claimAuthorityWorkflow(blocked.sequence);
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

    journal.recordCommittedMutationAttempt(blocked.sequence, {
      mutation: undefined,
      result: undefined,
    });
    journal.markAuthorityCommitted(blocked.sequence);
    expect(journal.get(blocked.sequence)).toMatchObject({
      lifecycle: { authority: "committed" },
      terminal: false,
    });
    journal.settleSuccessful(blocked.sequence, "committed");
    expect(journal.claimAuthorityWorkflow(blocked.sequence)).toBe(false);
    journal.assertInvariants();
  });

  it("requires terminal suffix rejection before a dependent can submit", () => {
    const journal = new SpatialSkeletonIntentJournal<
      string,
      RequestedResult,
      InverseDelta,
      Metadata
    >();
    const segment = spatialSkeletonLogicalSegment("A");
    const first = admitExact(journal, admission("first", segment));
    const second = admitExact(journal, admission("second", segment));

    expect(() => journal.claimAuthorityWorkflow(second.sequence)).toThrow(
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
