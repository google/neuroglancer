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

import {
  getSpatialSkeletonLogicalResourceKey,
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
  type SpatialSkeletonLogicalResourceHandle,
} from "#src/skeleton/logical_identity.js";
import {
  createInitialSpatialSkeletonOptimisticIntentLifecycle,
  type SpatialSkeletonOptimisticAuthorityReason,
  type SpatialSkeletonOptimisticIntentLifecycle,
  type SpatialSkeletonOptimisticReconciliationLifecycle,
} from "#src/skeleton/optimistic_edit/lifecycle.js";
import { DEFAULT_SPATIAL_SKELETON_OPTIMISTIC_EDIT_QUEUE_CAPACITY } from "#src/skeleton/optimistic_edit/types.js";

export type SpatialSkeletonIntentKind = "execute" | "undo" | "redo";

export type SpatialSkeletonIntentPreviewState =
  | "reserved"
  | "preparing"
  | "exact"
  | "promoted"
  | "rolled-back";

export type SpatialSkeletonIntentResourceAccess = "read" | "write";

export interface SpatialSkeletonIntentResource {
  readonly handle: SpatialSkeletonLogicalResourceHandle;
  readonly access: SpatialSkeletonIntentResourceAccess;
}

export type SpatialSkeletonIntentDependencyKind =
  | "resource"
  | "semantic"
  | "coalescing";

export interface SpatialSkeletonIntentAdmission<
  HistoryTicketId,
  RequestedResult,
  InverseDelta,
  Metadata,
> {
  readonly kind: SpatialSkeletonIntentKind;
  readonly historyTicketId: HistoryTicketId;
  readonly resources?: readonly SpatialSkeletonIntentResource[];
  readonly semanticDependencySequences?: readonly number[];
  readonly requestedResult: RequestedResult;
  readonly inverseDelta: InverseDelta;
  readonly metadata: Metadata;
  /**
   * Shares the predecessor's unresolved-work capacity slot.  This is only
   * accepted for the latest writer of exactly the same non-empty write set.
   */
  readonly coalescesSequence?: number;
}

/** One authority-confirmed physical step retained by the canonical journal. */
export interface SpatialSkeletonCommittedMutationAttempt<
  TMutation = unknown,
  TResult = unknown,
> {
  readonly mutation: TMutation;
  readonly result: TResult;
}

export interface SpatialSkeletonIntentRecord<
  HistoryTicketId,
  RequestedResult,
  InverseDelta,
  Metadata,
  CommittedMutationAttempt extends
    SpatialSkeletonCommittedMutationAttempt = SpatialSkeletonCommittedMutationAttempt,
> {
  readonly sequence: number;
  readonly historyTicketId: HistoryTicketId;
  readonly kind: SpatialSkeletonIntentKind;
  readonly resources: readonly SpatialSkeletonIntentResource[];
  readonly resourceDependencySequences: readonly number[];
  readonly semanticDependencySequences: readonly number[];
  readonly dependencySequences: readonly number[];
  readonly capacityGroupSequence: number;
  readonly requestedResult: RequestedResult;
  readonly inverseDelta: InverseDelta;
  readonly metadata: Metadata;
  /** Canonical user-visible lifecycle for this semantic intent. */
  readonly lifecycle: SpatialSkeletonOptimisticIntentLifecycle;
  /**
   * Immutable committed mutation/result pairs in physical workflow order.
   * Its length is the number of commits authority has accepted for the intent.
   */
  readonly committedMutationAttempts: readonly CommittedMutationAttempt[];
  /** Number of later active intents canceled with this root rejection. */
  readonly canceledLaterIntentCount?: number;
  readonly terminal: boolean;
  readonly rejectionReason: unknown;
}

interface MutableSpatialSkeletonIntentRecord<
  HistoryTicketId,
  RequestedResult,
  InverseDelta,
  Metadata,
  CommittedMutationAttempt extends
    SpatialSkeletonCommittedMutationAttempt = SpatialSkeletonCommittedMutationAttempt,
> {
  readonly sequence: number;
  readonly historyTicketId: HistoryTicketId;
  readonly kind: SpatialSkeletonIntentKind;
  readonly resources: SpatialSkeletonIntentResource[];
  readonly resourceDependencySequences: Set<number>;
  readonly semanticDependencySequences: Set<number>;
  readonly dependencyKinds: Map<
    number,
    Set<SpatialSkeletonIntentDependencyKind>
  >;
  readonly capacityGroupSequence: number;
  requestedResult: RequestedResult;
  inverseDelta: InverseDelta;
  metadata: Metadata;
  lifecycle: SpatialSkeletonOptimisticIntentLifecycle;
  readonly committedMutationAttempts: CommittedMutationAttempt[];
  canceledLaterIntentCount?: number;
  rejectionReason: unknown;
}

export interface SpatialSkeletonIntentSequenceReservation {
  readonly sequence: number;
  readonly revision: number;
}

export class SpatialSkeletonIntentCapacityError extends Error {
  constructor(
    readonly capacity: number,
    readonly unresolvedWorkCount: number,
  ) {
    super(
      `The optimistic skeleton edit queue already has ${capacity} unresolved intents.`,
    );
    this.name = "SpatialSkeletonIntentCapacityError";
  }
}

export class SpatialSkeletonIntentInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialSkeletonIntentInvariantError";
  }
}

const previewTransitions: Readonly<
  Record<
    SpatialSkeletonIntentPreviewState,
    ReadonlySet<SpatialSkeletonIntentPreviewState>
  >
> = {
  reserved: new Set(["preparing", "exact", "rolled-back"]),
  preparing: new Set(["exact", "rolled-back"]),
  exact: new Set(["promoted", "rolled-back"]),
  promoted: new Set(),
  "rolled-back": new Set(),
};

function isTerminalPreviewState(state: SpatialSkeletonIntentPreviewState) {
  return state === "promoted" || state === "rolled-back";
}

function isTerminalHistoryState(
  state: SpatialSkeletonOptimisticIntentLifecycle["history"],
) {
  return state === "advanced" || state === "rejected";
}

function isTerminalIntent(record: {
  lifecycle: SpatialSkeletonOptimisticIntentLifecycle;
}) {
  const { lifecycle } = record;
  return (
    isTerminalPreviewState(lifecycle.preview) &&
    (lifecycle.authority === "committed" ||
      lifecycle.authority === "unchanged") &&
    (lifecycle.reconciliation === "complete" ||
      lifecycle.reconciliation === "not-required") &&
    isTerminalHistoryState(lifecycle.history)
  );
}

function isRejectedIntent(record: {
  lifecycle: SpatialSkeletonOptimisticIntentLifecycle;
}) {
  return (
    record.lifecycle.authority === "unchanged" &&
    record.lifecycle.authorityReason !== "no-op"
  );
}

function isEffectiveResourceWriter(record: {
  lifecycle: SpatialSkeletonOptimisticIntentLifecycle;
}) {
  return record.lifecycle.authority !== "unchanged";
}

function normalizeResources(
  resources: readonly SpatialSkeletonIntentResource[],
) {
  const byKey = new Map<string, SpatialSkeletonIntentResource>();
  for (const resource of resources) {
    const key = getSpatialSkeletonLogicalResourceKey(resource.handle);
    const existing = byKey.get(key);
    if (existing === undefined || resource.access === "write") {
      byKey.set(key, {
        handle:
          resource.handle.kind === "node"
            ? spatialSkeletonLogicalNode(resource.handle.stableId)
            : spatialSkeletonLogicalSegment(resource.handle.stableId),
        access: resource.access,
      });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    getSpatialSkeletonLogicalResourceKey(a.handle).localeCompare(
      getSpatialSkeletonLogicalResourceKey(b.handle),
    ),
  );
}

function sorted(values: Iterable<number>) {
  return [...values].sort((a, b) => a - b);
}

/**
 * Ordered semantic intent journal and dependency index.
 *
 * This class contains no reducer, rendering, or CATMAID knowledge.  It is a
 * deterministic bookkeeping primitive shared by admission, hydration, the
 * mutation lane, reconciliation, undo, and redo.
 */
export class SpatialSkeletonIntentJournal<
  HistoryTicketId = number,
  RequestedResult = unknown,
  InverseDelta = unknown,
  Metadata = undefined,
  CommittedMutationAttempt extends
    SpatialSkeletonCommittedMutationAttempt = SpatialSkeletonCommittedMutationAttempt,
> {
  private nextSequence = 1;
  private nextReservationRevision = 1;
  private sequenceReservation?: SpatialSkeletonIntentSequenceReservation;
  private readonly records = new Map<
    number,
    MutableSpatialSkeletonIntentRecord<
      HistoryTicketId,
      RequestedResult,
      InverseDelta,
      Metadata,
      CommittedMutationAttempt
    >
  >();
  private readonly historyTickets = new Map<HistoryTicketId, number>();
  private readonly lastWriterByResource = new Map<string, number>();
  private readonly reverseDependents = new Map<number, Set<number>>();

  constructor(
    readonly capacity = DEFAULT_SPATIAL_SKELETON_OPTIMISTIC_EDIT_QUEUE_CAPACITY,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error(
        "The optimistic intent journal capacity must be positive.",
      );
    }
  }

  get size() {
    return this.records.size;
  }

  get unresolvedIntentCount() {
    let result = 0;
    for (const record of this.records.values()) {
      if (!isTerminalIntent(record)) ++result;
    }
    return result;
  }

  get unresolvedWorkCount() {
    const groups = new Set<number>();
    for (const record of this.records.values()) {
      if (!isTerminalIntent(record)) {
        groups.add(record.capacityGroupSequence);
      }
    }
    return groups.size;
  }

  get hasUnresolvedIntents() {
    return this.unresolvedIntentCount !== 0;
  }

  /**
   * Reserves the next sequence while a synchronous driver constructs its
   * logical descriptor. This makes intent-owned handles deterministic without
   * admitting a partially-described record or allowing re-entrant admission
   * to steal the advertised id.
   */
  reserveSequence(): SpatialSkeletonIntentSequenceReservation {
    if (this.sequenceReservation !== undefined) {
      throw new SpatialSkeletonIntentInvariantError(
        `Optimistic intent sequence ${this.sequenceReservation.sequence} is already reserved.`,
      );
    }
    const reservation = Object.freeze({
      sequence: this.nextSequence,
      revision: this.nextReservationRevision++,
    });
    this.sequenceReservation = reservation;
    return reservation;
  }

  cancelSequenceReservation(
    reservation: SpatialSkeletonIntentSequenceReservation,
  ) {
    if (!this.matchesSequenceReservation(reservation)) return false;
    this.sequenceReservation = undefined;
    return true;
  }

  canAdmit(coalescesSequence?: number) {
    if (coalescesSequence !== undefined) {
      const target = this.records.get(coalescesSequence);
      return (
        target !== undefined &&
        !isTerminalIntent(target) &&
        target.lifecycle.authority === "queued"
      );
    }
    return this.unresolvedWorkCount < this.capacity;
  }

  admit(
    admission: SpatialSkeletonIntentAdmission<
      HistoryTicketId,
      RequestedResult,
      InverseDelta,
      Metadata
    >,
    reservation?: SpatialSkeletonIntentSequenceReservation,
  ) {
    if (this.sequenceReservation !== undefined) {
      if (
        reservation === undefined ||
        !this.matchesSequenceReservation(reservation)
      ) {
        throw new SpatialSkeletonIntentInvariantError(
          `Optimistic intent sequence ${this.sequenceReservation.sequence} is reserved by another admission.`,
        );
      }
    } else if (reservation !== undefined) {
      throw new SpatialSkeletonIntentInvariantError(
        `Optimistic intent sequence reservation ${reservation.sequence} is no longer active.`,
      );
    }
    if (this.historyTickets.has(admission.historyTicketId)) {
      throw new SpatialSkeletonIntentInvariantError(
        "A history ticket may only be admitted once.",
      );
    }

    const sequence = this.nextSequence;
    const resources = normalizeResources(admission.resources ?? []);
    const coalescingTarget =
      admission.coalescesSequence === undefined
        ? undefined
        : this.requireRecord(admission.coalescesSequence);
    if (coalescingTarget !== undefined) {
      this.validateCoalescing(resources, coalescingTarget);
    } else if (this.unresolvedWorkCount >= this.capacity) {
      throw new SpatialSkeletonIntentCapacityError(
        this.capacity,
        this.unresolvedWorkCount,
      );
    }

    const resourceDependencies = new Set<number>();
    for (const resource of resources) {
      const lastWriter = this.lastWriterByResource.get(
        getSpatialSkeletonLogicalResourceKey(resource.handle),
      );
      if (lastWriter !== undefined) resourceDependencies.add(lastWriter);
    }
    const semanticDependencies = new Set<number>();
    for (const dependency of admission.semanticDependencySequences ?? []) {
      this.validateEarlierActiveDependency(sequence, dependency);
      semanticDependencies.add(dependency);
    }

    const dependencyKinds = new Map<
      number,
      Set<SpatialSkeletonIntentDependencyKind>
    >();
    const addDependencyKind = (
      dependency: number,
      kind: SpatialSkeletonIntentDependencyKind,
    ) => {
      let kinds = dependencyKinds.get(dependency);
      if (kinds === undefined) {
        kinds = new Set();
        dependencyKinds.set(dependency, kinds);
      }
      kinds.add(kind);
    };
    for (const dependency of resourceDependencies) {
      addDependencyKind(dependency, "resource");
    }
    for (const dependency of semanticDependencies) {
      addDependencyKind(dependency, "semantic");
    }
    if (coalescingTarget !== undefined) {
      semanticDependencies.add(coalescingTarget.sequence);
      addDependencyKind(coalescingTarget.sequence, "coalescing");
    }

    const record: MutableSpatialSkeletonIntentRecord<
      HistoryTicketId,
      RequestedResult,
      InverseDelta,
      Metadata,
      CommittedMutationAttempt
    > = {
      sequence,
      historyTicketId: admission.historyTicketId,
      kind: admission.kind,
      resources,
      resourceDependencySequences: resourceDependencies,
      semanticDependencySequences: semanticDependencies,
      dependencyKinds,
      capacityGroupSequence:
        coalescingTarget?.capacityGroupSequence ?? sequence,
      requestedResult: admission.requestedResult,
      inverseDelta: admission.inverseDelta,
      metadata: admission.metadata,
      lifecycle: {
        ...createInitialSpatialSkeletonOptimisticIntentLifecycle(),
      },
      committedMutationAttempts: [],
      canceledLaterIntentCount: undefined,
      rejectionReason: undefined,
    };

    this.records.set(sequence, record);
    this.historyTickets.set(admission.historyTicketId, sequence);
    this.sequenceReservation = undefined;
    ++this.nextSequence;
    for (const dependency of dependencyKinds.keys()) {
      let dependents = this.reverseDependents.get(dependency);
      if (dependents === undefined) {
        dependents = new Set();
        this.reverseDependents.set(dependency, dependents);
      }
      dependents.add(sequence);
    }
    for (const resource of resources) {
      if (resource.access === "write") {
        this.lastWriterByResource.set(
          getSpatialSkeletonLogicalResourceKey(resource.handle),
          sequence,
        );
      }
    }
    return this.snapshot(record);
  }

  get(sequence: number) {
    const record = this.records.get(sequence);
    return record === undefined ? undefined : this.snapshot(record);
  }

  getByHistoryTicket(historyTicketId: HistoryTicketId) {
    const sequence = this.historyTickets.get(historyTicketId);
    return sequence === undefined ? undefined : this.get(sequence);
  }

  getEntries(options: { includeTerminal?: boolean } = {}) {
    const result: SpatialSkeletonIntentRecord<
      HistoryTicketId,
      RequestedResult,
      InverseDelta,
      Metadata,
      CommittedMutationAttempt
    >[] = [];
    for (const record of this.records.values()) {
      if (options.includeTerminal === false && isTerminalIntent(record))
        continue;
      result.push(this.snapshot(record));
    }
    return result;
  }

  /**
   * Removes old terminal records after their effects have been folded into the
   * caller's retained history workspace.
   *
   * Active records do not need successful terminal dependencies in order to
   * remain blocked: those operations have already completed.  Their edges are
   * therefore detached while resource indexes are rebuilt over the retained
   * suffix.  A terminal record that owns the capacity group of an unresolved
   * coalesced intent is retained until that group settles.
   */
  compactTerminalRecords(
    options: {
      retainRecent?: number;
      preserveSequences?: Iterable<number>;
    } = {},
  ) {
    const retainRecent = options.retainRecent ?? 0;
    if (!Number.isSafeInteger(retainRecent) || retainRecent < 0) {
      throw new Error("retainRecent must be a non-negative safe integer.");
    }
    const terminalSequences = [...this.records.values()]
      .filter(isTerminalIntent)
      .map(({ sequence }) => sequence);
    const removable = new Set(
      terminalSequences.slice(
        0,
        Math.max(0, terminalSequences.length - retainRecent),
      ),
    );
    for (const sequence of options.preserveSequences ?? []) {
      if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error(
          "preserveSequences must contain positive safe integers.",
        );
      }
      removable.delete(sequence);
    }
    if (removable.size === 0) return 0;

    // A coalesced unresolved intent counts against its original capacity
    // group. Keep that group root until the final member settles.
    for (const record of this.records.values()) {
      if (!isTerminalIntent(record)) {
        removable.delete(record.capacityGroupSequence);
      }
    }
    if (removable.size === 0) return 0;

    for (const sequence of removable) {
      const record = this.records.get(sequence);
      if (record === undefined) continue;
      if (this.historyTickets.get(record.historyTicketId) === sequence) {
        this.historyTickets.delete(record.historyTicketId);
      }
      this.records.delete(sequence);
    }
    for (const record of this.records.values()) {
      for (const sequence of removable) {
        record.dependencyKinds.delete(sequence);
        record.resourceDependencySequences.delete(sequence);
        record.semanticDependencySequences.delete(sequence);
      }
    }
    this.rebuildResourceDependencyIndexes();
    return removable.size;
  }

  getBlockingDependencies(sequence: number) {
    const record = this.requireRecord(sequence);
    const result: number[] = [];
    for (const dependency of record.dependencyKinds.keys()) {
      const dependencyRecord = this.requireRecord(dependency);
      if (!isTerminalIntent(dependencyRecord)) result.push(dependency);
    }
    return result.sort((a, b) => a - b);
  }

  setPreviewState(sequence: number, state: SpatialSkeletonIntentPreviewState) {
    const record = this.requireRecord(sequence);
    const current = record.lifecycle.preview;
    if (current === state) return false;
    if (!previewTransitions[current].has(state)) {
      throw new SpatialSkeletonIntentInvariantError(
        `Invalid preview transition ${current} -> ${state} for intent ${sequence}.`,
      );
    }
    record.lifecycle = { ...record.lifecycle, preview: state };
    return true;
  }

  /**
   * Atomically installs prepared or refolded forward/inverse artifacts and
   * any workflow metadata rebuilt from their canonical history recipes.
   *
   * Every record is validated before any record is changed.  The preparing
   * state is accepted because first-preview adoption notifies immediately
   * before the engine advances that same record to `exact`.
   */
  refreshExactProjectionArtifacts(
    artifacts: readonly {
      readonly sequence: number;
      readonly requestedResult: RequestedResult;
      readonly inverseDelta: InverseDelta;
      readonly metadata?: Metadata;
    }[],
  ) {
    const replacements: Array<{
      readonly record: MutableSpatialSkeletonIntentRecord<
        HistoryTicketId,
        RequestedResult,
        InverseDelta,
        Metadata,
        CommittedMutationAttempt
      >;
      readonly requestedResult: RequestedResult;
      readonly inverseDelta: InverseDelta;
      readonly metadata?: Metadata;
    }> = [];
    const seen = new Set<number>();
    for (const artifact of artifacts) {
      if (seen.has(artifact.sequence)) {
        throw new SpatialSkeletonIntentInvariantError(
          `Projection artifact refresh contains duplicate intent ${artifact.sequence}.`,
        );
      }
      seen.add(artifact.sequence);
      const record = this.requireRecord(artifact.sequence);
      if (
        record.lifecycle.preview !== "preparing" &&
        record.lifecycle.preview !== "exact"
      ) {
        throw new SpatialSkeletonIntentInvariantError(
          `Intent ${artifact.sequence} cannot refresh exact projection artifacts from preview state ${record.lifecycle.preview}.`,
        );
      }
      if (isTerminalIntent(record)) {
        throw new SpatialSkeletonIntentInvariantError(
          `Terminal intent ${artifact.sequence} cannot refresh exact projection artifacts.`,
        );
      }
      replacements.push({
        record,
        requestedResult: artifact.requestedResult,
        inverseDelta: artifact.inverseDelta,
        metadata: artifact.metadata,
      });
    }
    for (const replacement of replacements) {
      replacement.record.requestedResult = replacement.requestedResult;
      replacement.record.inverseDelta = replacement.inverseDelta;
      if (replacement.metadata !== undefined) {
        replacement.record.metadata = replacement.metadata;
      }
    }
    return replacements.map(({ record }) => this.snapshot(record));
  }

  /** Refreshes a retained terminal recipe after authoritative Redo adoption. */
  refreshRetainedRecord(
    sequence: number,
    replacement: {
      readonly requestedResult: RequestedResult;
      readonly inverseDelta: InverseDelta;
      readonly metadata?: Metadata;
    },
  ) {
    const record = this.requireRecord(sequence);
    if (!isTerminalIntent(record)) {
      throw new SpatialSkeletonIntentInvariantError(
        `Retained intent ${sequence} must be terminal before its canonical recipe is refreshed.`,
      );
    }
    record.requestedResult = replacement.requestedResult;
    record.inverseDelta = replacement.inverseDelta;
    if (replacement.metadata !== undefined) {
      record.metadata = replacement.metadata;
    }
    return this.snapshot(record);
  }

  setReconciliationState(
    sequence: number,
    reconciliation: SpatialSkeletonOptimisticReconciliationLifecycle,
  ) {
    const record = this.requireRecord(sequence);
    if (record.lifecycle.reconciliation === reconciliation) return false;
    record.lifecycle = { ...record.lifecycle, reconciliation };
    return true;
  }

  /** Advances the canonical physical cursor after one validated commit. */
  recordCommittedMutationAttempt(
    sequence: number,
    attempt: CommittedMutationAttempt,
  ) {
    const record = this.requireRecord(sequence);
    if (record.lifecycle.authority !== "running") {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot record a mutation while authority is ${record.lifecycle.authority}.`,
      );
    }
    record.committedMutationAttempts.push(
      Object.freeze({ ...attempt }) as CommittedMutationAttempt,
    );
    return this.snapshot(record);
  }

  markAuthorityCommitted(sequence: number) {
    const record = this.requireRecord(sequence);
    if (
      record.lifecycle.authority !== "running" ||
      record.committedMutationAttempts.length === 0
    ) {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot commit authority before a running mutation succeeds.`,
      );
    }
    record.lifecycle = {
      ...record.lifecycle,
      authority: "committed",
      authorityReason: undefined,
    };
    return this.snapshot(record);
  }

  /**
   * Atomically claims one exact, dependency-ready logical workflow.  The
   * authority lifecycle remains visibly queued while the scheduler waits for
   * a lease; `markAuthorityCommitStarted` advances it at the adapter boundary.
   */
  claimAuthorityWorkflow(sequence: number) {
    const record = this.requireRecord(sequence);
    if (record.lifecycle.authority !== "queued") return false;
    if (record.lifecycle.preview !== "exact") {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot claim authority from preview state ${record.lifecycle.preview}.`,
      );
    }
    if (this.getBlockingDependencies(sequence).length !== 0) {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot claim authority while a dependency is unresolved.`,
      );
    }
    record.lifecycle = { ...record.lifecycle, authority: "waiting" };
    return true;
  }

  /** Marks the scheduler's exact adapter-commit boundary. */
  markAuthorityCommitStarted(sequence: number) {
    const record = this.requireRecord(sequence);
    if (record.lifecycle.authority === "running") return false;
    if (record.lifecycle.authority !== "waiting") {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot start transport while authority is ${record.lifecycle.authority}.`,
      );
    }
    record.lifecycle = { ...record.lifecycle, authority: "running" };
    return true;
  }

  /** Records a fatal authority outcome without falsely settling history. */
  markReloadRequired(
    sequence: number,
    authority: "committed" | "indeterminate",
  ) {
    const record = this.requireRecord(sequence);
    if (
      record.lifecycle.authority !== "queued" &&
      record.lifecycle.authority !== "waiting" &&
      record.lifecycle.authority !== "running" &&
      record.lifecycle.authority !== "committed" &&
      record.lifecycle.authority !== "indeterminate"
    ) {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot require reload while authority is ${record.lifecycle.authority}.`,
      );
    }
    record.lifecycle = {
      ...record.lifecycle,
      authority,
      reconciliation: "blocked",
      history: "staged",
    };
    return this.snapshot(record);
  }

  /** Settles one definitively unchanged intent without cascading. */
  settleUnchanged(
    sequence: number,
    authorityReason: Exclude<SpatialSkeletonOptimisticAuthorityReason, "no-op">,
    error: unknown,
  ) {
    const record = this.requireRecord(sequence);
    if (
      record.lifecycle.authority === "committed" ||
      record.lifecycle.authority === "indeterminate"
    ) {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot settle unchanged after authority ${record.lifecycle.authority}.`,
      );
    }
    record.lifecycle = {
      ...record.lifecycle,
      preview: "rolled-back",
      authority: "unchanged",
      authorityReason,
      reconciliation: "not-required",
      history: "rejected",
    };
    record.rejectionReason = error;
    this.rebuildLastWriterIndex();
    return this.snapshot(record);
  }

  /** Finishes a confirmed or physical no-op intent without cascading. */
  settleSuccessful(sequence: number, outcome: "committed" | "no-op") {
    const record = this.requireRecord(sequence);
    if (this.getBlockingDependencies(sequence).length !== 0) {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot settle while an earlier dependency is unresolved.`,
      );
    }
    if (isTerminalIntent(record)) {
      if (isRejectedIntent(record)) {
        throw new SpatialSkeletonIntentInvariantError(
          `Rejected intent ${sequence} cannot be settled successfully.`,
        );
      }
      return this.snapshot(record);
    }
    if (outcome === "committed" && record.lifecycle.authority !== "committed") {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot confirm while authority is ${record.lifecycle.authority}.`,
      );
    }
    if (
      outcome === "no-op" &&
      record.lifecycle.authority !== "queued" &&
      record.lifecycle.authority !== "waiting"
    ) {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot settle as a no-op while authority is ${record.lifecycle.authority}.`,
      );
    }
    if (
      !previewTransitions[record.lifecycle.preview].has(
        outcome === "no-op" ? "rolled-back" : "promoted",
      )
    ) {
      throw new SpatialSkeletonIntentInvariantError(
        `Invalid successful preview settlement from ${record.lifecycle.preview} for ${outcome}.`,
      );
    }
    record.lifecycle =
      outcome === "no-op"
        ? {
            ...record.lifecycle,
            preview: "rolled-back",
            authority: "unchanged",
            authorityReason: "no-op",
            reconciliation: "not-required",
            history: "advanced",
          }
        : {
            ...record.lifecycle,
            preview: "promoted",
            authority: "committed",
            reconciliation: "complete",
            history: "advanced",
          };
    return this.snapshot(record);
  }

  /**
   * Atomically settles an unsent intent and its opposite as a physical no-op.
   *
   * This is intentionally different from two `settleSuccessful` calls.  The
   * canceled execute may itself be ordered after unresolved work, but neither
   * member of the pair will now issue a POST.  Their dependency edges must be
   * detached together so the earlier physical writer remains authoritative.
   * Coalescing is unsafe once any other active intent has observed either
   * preview, and is rejected in that case.
   */
  settleQueuedCancellationPair(
    targetSequence: number,
    oppositeSequence: number,
  ) {
    const target = this.requireRecord(targetSequence);
    const opposite = this.requireRecord(oppositeSequence);
    if (
      target.lifecycle.authority !== "queued" ||
      opposite.lifecycle.authority !== "queued" ||
      isTerminalIntent(target) ||
      isTerminalIntent(opposite)
    ) {
      throw new SpatialSkeletonIntentInvariantError(
        "Only two unresolved queued intents can be canceled as a no-op pair.",
      );
    }
    if (
      opposite.capacityGroupSequence !== target.capacityGroupSequence ||
      !opposite.dependencyKinds.get(targetSequence)?.has("coalescing")
    ) {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${oppositeSequence} is not the coalesced opposite of intent ${targetSequence}.`,
      );
    }
    if (opposite.lifecycle.preview !== "exact") {
      throw new SpatialSkeletonIntentInvariantError(
        `Cancellation intent ${oppositeSequence} must publish its exact rollback preview before settlement.`,
      );
    }
    for (const sequence of [targetSequence, oppositeSequence]) {
      const externalDependent = [
        ...(this.reverseDependents.get(sequence) ?? []),
      ].find(
        (dependentSequence) =>
          dependentSequence !== oppositeSequence &&
          !isTerminalIntent(this.requireRecord(dependentSequence)),
      );
      if (externalDependent !== undefined) {
        throw new SpatialSkeletonIntentInvariantError(
          `Intent ${sequence} cannot be canceled after active intent ${externalDependent} observed it.`,
        );
      }
    }

    for (const record of [target, opposite]) {
      record.resourceDependencySequences.clear();
      record.semanticDependencySequences.clear();
      record.dependencyKinds.clear();
      record.rejectionReason = undefined;
    }
    target.lifecycle = {
      preview: "rolled-back",
      authority: "unchanged",
      authorityReason: "no-op",
      reconciliation: "not-required",
      history: "advanced",
    };
    opposite.lifecycle = {
      preview: "promoted",
      authority: "unchanged",
      authorityReason: "no-op",
      reconciliation: "not-required",
      history: "advanced",
    };
    this.rebuildResourceDependencyIndexes();
    return {
      target: this.snapshot(target),
      opposite: this.snapshot(opposite),
    };
  }

  /**
   * Atomically rejects one definitive-failure root and every later active
   * intent. Earlier geometry survives; the engine restores history before
   * the failed transition separately after this journal transition.
   */
  rejectActiveSuffix(
    sequence: number,
    options: {
      readonly rootReason: SpatialSkeletonOptimisticAuthorityReason;
      readonly rootError: unknown;
      readonly laterError: unknown;
    },
  ) {
    const root = this.requireRecord(sequence);
    if (isTerminalIntent(root)) return [];
    const suffix = [...this.records.values()].filter(
      (record) => record.sequence >= sequence && !isTerminalIntent(record),
    );
    for (const record of suffix) {
      if (
        record.lifecycle.authority === "committed" ||
        record.lifecycle.authority === "indeterminate" ||
        (record.sequence !== sequence &&
          record.lifecycle.authority === "running")
      ) {
        throw new SpatialSkeletonIntentInvariantError(
          `Cannot reset intent suffix ${sequence}: later intent ${record.sequence} has started or committed authority.`,
        );
      }
    }
    for (const record of suffix) {
      const isRoot = record.sequence === sequence;
      record.lifecycle = {
        ...record.lifecycle,
        preview: "rolled-back",
        authority: "unchanged",
        authorityReason: isRoot ? options.rootReason : "not-started",
        reconciliation: "not-required",
        history: "rejected",
      };
      record.rejectionReason = isRoot ? options.rootError : options.laterError;
    }
    root.canceledLaterIntentCount = suffix.length - 1;
    this.rebuildLastWriterIndex();
    return suffix.map((record) => this.snapshot(record));
  }

  assertInvariants() {
    let previousSequence = 0;
    const expectedLastWriters = new Map<string, number>();
    const expectedReverseDependents = new Map<number, Set<number>>();
    const capacityGroups = new Set<number>();
    for (const record of this.records.values()) {
      if (record.sequence <= previousSequence) {
        throw new SpatialSkeletonIntentInvariantError(
          "Intent sequences must be strictly increasing.",
        );
      }
      previousSequence = record.sequence;
      if (this.historyTickets.get(record.historyTicketId) !== record.sequence) {
        throw new SpatialSkeletonIntentInvariantError(
          `History ticket index is inconsistent for intent ${record.sequence}.`,
        );
      }
      if (
        record.capacityGroupSequence > record.sequence ||
        !this.records.has(record.capacityGroupSequence)
      ) {
        throw new SpatialSkeletonIntentInvariantError(
          `Intent ${record.sequence} has an invalid capacity group.`,
        );
      }
      for (const dependency of record.dependencyKinds.keys()) {
        if (dependency >= record.sequence || !this.records.has(dependency)) {
          throw new SpatialSkeletonIntentInvariantError(
            `Intent ${record.sequence} has a missing or non-earlier dependency ${dependency}.`,
          );
        }
        let dependents = expectedReverseDependents.get(dependency);
        if (dependents === undefined) {
          dependents = new Set();
          expectedReverseDependents.set(dependency, dependents);
        }
        dependents.add(record.sequence);
        if (
          !isTerminalIntent(record) &&
          isRejectedIntent(this.requireRecord(dependency))
        ) {
          throw new SpatialSkeletonIntentInvariantError(
            `Active intent ${record.sequence} depends on rejected intent ${dependency}.`,
          );
        }
      }
      if (
        (record.lifecycle.authority === "waiting" ||
          record.lifecycle.authority === "running") &&
        this.getBlockingDependencies(record.sequence).length !== 0
      ) {
        throw new SpatialSkeletonIntentInvariantError(
          `Submitted intent ${record.sequence} has an unresolved dependency.`,
        );
      }
      if (isTerminalIntent(record)) {
        if (
          isRejectedIntent(record) &&
          record.lifecycle.history !== "rejected"
        ) {
          throw new SpatialSkeletonIntentInvariantError(
            `Rejected intent ${record.sequence} must reject history.`,
          );
        }
        if (
          !isRejectedIntent(record) &&
          record.lifecycle.history !== "advanced"
        ) {
          throw new SpatialSkeletonIntentInvariantError(
            `Successful intent ${record.sequence} must advance history.`,
          );
        }
      } else {
        capacityGroups.add(record.capacityGroupSequence);
      }
      if (isEffectiveResourceWriter(record)) {
        for (const resource of record.resources) {
          if (resource.access === "write") {
            expectedLastWriters.set(
              getSpatialSkeletonLogicalResourceKey(resource.handle),
              record.sequence,
            );
          }
        }
      }
    }
    if (capacityGroups.size > this.capacity) {
      throw new SpatialSkeletonIntentInvariantError(
        "Unresolved work exceeds the journal capacity.",
      );
    }
    if (!mapsEqual(expectedLastWriters, this.lastWriterByResource)) {
      throw new SpatialSkeletonIntentInvariantError(
        "The last-writer resource index is inconsistent.",
      );
    }
    if (!setMapsEqual(expectedReverseDependents, this.reverseDependents)) {
      throw new SpatialSkeletonIntentInvariantError(
        "The reverse-dependent index is inconsistent.",
      );
    }
  }

  private requireRecord(sequence: number) {
    const record = this.records.get(sequence);
    if (record === undefined) {
      throw new SpatialSkeletonIntentInvariantError(
        `Unknown optimistic intent sequence ${sequence}.`,
      );
    }
    return record;
  }

  private matchesSequenceReservation(
    reservation: SpatialSkeletonIntentSequenceReservation,
  ) {
    return (
      this.sequenceReservation?.sequence === reservation.sequence &&
      this.sequenceReservation.revision === reservation.revision
    );
  }

  private validateEarlierActiveDependency(
    sequence: number,
    dependencySequence: number,
  ) {
    if (dependencySequence >= sequence) {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} dependency ${dependencySequence} is not earlier.`,
      );
    }
    const dependency = this.requireRecord(dependencySequence);
    if (isRejectedIntent(dependency)) {
      throw new SpatialSkeletonIntentInvariantError(
        `Intent ${sequence} cannot depend on rejected intent ${dependencySequence}.`,
      );
    }
  }

  private validateCoalescing(
    resources: readonly SpatialSkeletonIntentResource[],
    target: MutableSpatialSkeletonIntentRecord<
      HistoryTicketId,
      RequestedResult,
      InverseDelta,
      Metadata,
      CommittedMutationAttempt
    >,
  ) {
    if (isTerminalIntent(target)) {
      throw new SpatialSkeletonIntentInvariantError(
        `Cannot coalesce into terminal intent ${target.sequence}.`,
      );
    }
    if (target.lifecycle.authority !== "queued") {
      throw new SpatialSkeletonIntentInvariantError(
        `Cannot coalesce into intent ${target.sequence} after its workflow was claimed.`,
      );
    }
    const activeObserver = [
      ...(this.reverseDependents.get(target.sequence) ?? []),
    ].find(
      (dependentSequence) =>
        !isTerminalIntent(this.requireRecord(dependentSequence)),
    );
    if (activeObserver !== undefined) {
      throw new SpatialSkeletonIntentInvariantError(
        `Cannot coalesce intent ${target.sequence} after active intent ${activeObserver} observed it.`,
      );
    }
    const writeKeys = resources
      .filter((resource) => resource.access === "write")
      .map((resource) => getSpatialSkeletonLogicalResourceKey(resource.handle));
    const targetWriteKeys = target.resources
      .filter((resource) => resource.access === "write")
      .map((resource) => getSpatialSkeletonLogicalResourceKey(resource.handle));
    if (
      writeKeys.length === 0 ||
      writeKeys.length !== targetWriteKeys.length ||
      writeKeys.some((key, index) => key !== targetWriteKeys[index]) ||
      writeKeys.some(
        (key) => this.lastWriterByResource.get(key) !== target.sequence,
      )
    ) {
      throw new SpatialSkeletonIntentInvariantError(
        "A net-neutral coalescing intent must target the latest writer of exactly the same non-empty write set.",
      );
    }
  }

  private rebuildLastWriterIndex() {
    this.lastWriterByResource.clear();
    for (const record of this.records.values()) {
      if (!isEffectiveResourceWriter(record)) continue;
      for (const resource of record.resources) {
        if (resource.access === "write") {
          this.lastWriterByResource.set(
            getSpatialSkeletonLogicalResourceKey(resource.handle),
            record.sequence,
          );
        }
      }
    }
  }

  private rebuildResourceDependencyIndexes() {
    for (const record of this.records.values()) {
      record.resourceDependencySequences.clear();
      for (const [dependency, kinds] of record.dependencyKinds) {
        kinds.delete("resource");
        if (kinds.size === 0) record.dependencyKinds.delete(dependency);
      }
    }
    this.lastWriterByResource.clear();
    for (const record of this.records.values()) {
      if (!isEffectiveResourceWriter(record)) continue;
      for (const resource of record.resources) {
        const resourceKey = getSpatialSkeletonLogicalResourceKey(
          resource.handle,
        );
        const dependency = this.lastWriterByResource.get(resourceKey);
        if (dependency !== undefined) {
          record.resourceDependencySequences.add(dependency);
          let kinds = record.dependencyKinds.get(dependency);
          if (kinds === undefined) {
            kinds = new Set();
            record.dependencyKinds.set(dependency, kinds);
          }
          kinds.add("resource");
        }
        if (resource.access === "write") {
          this.lastWriterByResource.set(resourceKey, record.sequence);
        }
      }
    }
    this.rebuildReverseDependentIndex();
  }

  private rebuildReverseDependentIndex() {
    this.reverseDependents.clear();
    for (const record of this.records.values()) {
      for (const dependency of record.dependencyKinds.keys()) {
        let dependents = this.reverseDependents.get(dependency);
        if (dependents === undefined) {
          dependents = new Set();
          this.reverseDependents.set(dependency, dependents);
        }
        dependents.add(record.sequence);
      }
    }
  }

  private snapshot(
    record: MutableSpatialSkeletonIntentRecord<
      HistoryTicketId,
      RequestedResult,
      InverseDelta,
      Metadata,
      CommittedMutationAttempt
    >,
  ): SpatialSkeletonIntentRecord<
    HistoryTicketId,
    RequestedResult,
    InverseDelta,
    Metadata,
    CommittedMutationAttempt
  > {
    return Object.freeze({
      sequence: record.sequence,
      historyTicketId: record.historyTicketId,
      kind: record.kind,
      resources: Object.freeze([...record.resources]),
      resourceDependencySequences: Object.freeze(
        sorted(record.resourceDependencySequences),
      ),
      semanticDependencySequences: Object.freeze(
        sorted(record.semanticDependencySequences),
      ),
      dependencySequences: Object.freeze(sorted(record.dependencyKinds.keys())),
      capacityGroupSequence: record.capacityGroupSequence,
      requestedResult: record.requestedResult,
      inverseDelta: record.inverseDelta,
      metadata: record.metadata,
      lifecycle: Object.freeze({ ...record.lifecycle }),
      committedMutationAttempts: Object.freeze([
        ...record.committedMutationAttempts,
      ]),
      canceledLaterIntentCount: record.canceledLaterIntentCount,
      terminal: isTerminalIntent(record),
      rejectionReason: record.rejectionReason,
    });
  }
}

function mapsEqual<Key, Value>(a: Map<Key, Value>, b: Map<Key, Value>) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || !Object.is(b.get(key), value)) return false;
  }
  return true;
}

function setMapsEqual<Key, Value>(
  a: Map<Key, Set<Value>>,
  b: Map<Key, Set<Value>>,
) {
  if (a.size !== b.size) return false;
  for (const [key, values] of a) {
    const otherValues = b.get(key);
    if (
      otherValues === undefined ||
      values.size !== otherValues.size ||
      [...values].some((value) => !otherValues.has(value))
    ) {
      return false;
    }
  }
  return true;
}
