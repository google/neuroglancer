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
 * @file Builds the preview off screen as retained history plus each active
 * intent's delta in order, then adopts it into the display in one step. It also
 * assigns and resolves the stable ID handles of nodes and skeletons.
 */

import type {
  SpatialSkeletonAuthoritativePublication,
  SpatialSkeletonPreviewPort,
  SpatialSkeletonPreviewArtifactsListener,
  SpatialSkeletonPreviewIntentArtifact,
  SpatialSkeletonPreviewRollbackReplayRequest,
} from "#src/skeleton/edit_queue/api.js";
import type { CompleteSkeleton } from "#src/skeleton/edit_queue/complete_skeleton.js";
import type {
  SpatialSkeletonEditDelta,
  SpatialSkeletonEditInverseDelta,
  SpatialSkeletonEditSegmentSnapshot,
  SpatialSkeletonEditSnapshotHandleSource,
} from "#src/skeleton/edit_queue/complete_skeleton_edits.js";
import {
  applySpatialSkeletonEditDelta,
  materializeCompleteSkeletonSet,
  ownsPhysicalSpatialSkeletonSegment,
  remapCompleteSkeletonSet,
  SpatialSkeletonEditValidationError,
  CompleteSkeletonSet,
} from "#src/skeleton/edit_queue/complete_skeleton_edits.js";
import type {
  SpatialSkeletonPreviewUiHintPort,
  SpatialSkeletonPreviewUiHints,
} from "#src/skeleton/edit_queue/preview_ui_hints.js";
import {
  applySpatialSkeletonPreviewUiHintsAfterAdoption,
  cloneSpatialSkeletonPreviewUiHints,
  mergeSpatialSkeletonPreviewUiHints,
} from "#src/skeleton/edit_queue/preview_ui_hints.js";
import type {
  SpatialSkeletonStableIdMappingToken,
  SpatialSkeletonStableIdMappingUpdate,
  SpatialSkeletonStableNodeHandle,
  SpatialSkeletonStableResourceHandle,
  SpatialSkeletonStableSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import {
  SpatialSkeletonStableIdHandles,
  spatialSkeletonStableNode,
  spatialSkeletonStableSegment,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import { bigintCompare } from "#src/util/bigint.js";

export interface SpatialSkeletonDisplayStableOwner {
  readonly segmentId: bigint;
  readonly stableHandle: SpatialSkeletonStableSegmentHandle;
}

export interface SpatialSkeletonDisplayNumericAlias {
  readonly stableHandle: SpatialSkeletonStableSegmentHandle;
  /** Numeric id shown to rendering, picking, and user-facing selection. */
  readonly segmentId: bigint;
  /** False while the numeric id exists only in the local optimistic preview. */
  readonly authoritative?: boolean;
}

export const preparedSpatialSkeletonPreviewCachePublicationBrand = Symbol(
  "prepared spatial skeleton preview state publication",
);

/**
 * Opaque, session-owned result of complete off-screen preview publication
 * preparation. The preview may only return this value to the edit session
 * that created it; a preview ownership token rejects forged/cross-state use.
 */
export interface SpatialSkeletonPreparedPreviewCachePublication {
  readonly [preparedSpatialSkeletonPreviewCachePublicationBrand]: true;
  /** Planned post-adoption revisions, prepared with the cache maps. */
  readonly cacheRevisions: ReadonlyMap<bigint, number>;
}

/** Complete state-facing portion of one immutable optimistic publication. */
export interface SpatialSkeletonPreviewCachePublicationRequest {
  readonly snapshots: Iterable<readonly [bigint, CompleteSkeleton | undefined]>;
  readonly expectedRevisions: ReadonlyMap<bigint, number>;
  /** Confirmed deletions advance revisions even for already-absent snapshots. */
  readonly retiredSegmentIds?: ReadonlySet<bigint>;
  readonly activeStableOwners: Iterable<SpatialSkeletonDisplayStableOwner>;
  readonly numericAliases: Iterable<SpatialSkeletonDisplayNumericAlias>;
  readonly provisionalNodeIds: Iterable<bigint>;
  readonly pendingEditIntentIdsToRemove: Iterable<number>;
  readonly notify: boolean;
}

/**
 * Structural state boundary needed for one immutable preview adoption.
 * `SpatialSkeletonEditSession` implements this interface; keeping it structural
 * makes the preview independently testable and datasource-free.
 */
export interface SpatialSkeletonPreviewPublicationTarget
  extends SpatialSkeletonEditSnapshotHandleSource {
  runSpatialSkeletonDisplayTransaction<T>(
    callback: () => T,
    reportNotificationError?: (error: unknown) => void,
  ): T;
  prepareSpatialSkeletonPreviewCachePublication(
    request: SpatialSkeletonPreviewCachePublicationRequest,
  ): SpatialSkeletonPreparedPreviewCachePublication | undefined;
  adoptPreparedSpatialSkeletonPreviewCachePublication(
    publication: SpatialSkeletonPreparedPreviewCachePublication,
  ): boolean;
  finalizePreparedSpatialSkeletonPreviewCachePublication(
    publication: SpatialSkeletonPreparedPreviewCachePublication,
    reportError?: (error: unknown) => void,
  ): void;
}

/** Retained complete inspection used to seed a cold session-owned preview. */
export interface SpatialSkeletonPreviewInspectionSeed {
  readonly segments: readonly SpatialSkeletonEditSegmentSnapshot[];
  readonly authoritativeBindings: SpatialSkeletonStableIdMappingUpdate<
    bigint,
    bigint
  >;
  readonly expectedCacheRevisions: ReadonlyMap<bigint, number>;
}

/** Generic exact-preview input produced from retained inspected command data. */
export interface SpatialSkeletonPreviewIntentDelta {
  readonly delta: SpatialSkeletonEditDelta;
  /**
   * Complete snapshots retained by pre-admission inspection. Existing
   * confirmed segments are never replaced with previewed cache snapshots;
   * this seed only fills a cold/disjoint part of the baseline.
   */
  readonly inspectionSeed?: SpatialSkeletonPreviewInspectionSeed;
  /** Numeric identities that exist only until authority returns its bindings. */
  readonly provisionalBindings?: SpatialSkeletonStableIdMappingUpdate<
    bigint,
    bigint
  >;
  /** Applied once, after the exact model preview has been adopted. */
  readonly uiHints?: SpatialSkeletonPreviewUiHints;
  /** Applied after this preview is rejected/canceled and survivors refold. */
  readonly rollbackUiHints?: SpatialSkeletonPreviewUiHints;
  /** Defaults to the engine intent id. */
  readonly pendingEditIntentId?: number;
}

/**
 * Datasource-neutral facts returned by authority. Datasource plan state,
 * request payloads, and lifecycle data deliberately do not belong here.
 */
export interface SpatialSkeletonAuthoritativeReconciliation {
  readonly bindings?: SpatialSkeletonStableIdMappingUpdate<bigint, bigint>;
  readonly retiredResources?: readonly SpatialSkeletonStableResourceHandle[];
  /** Deleted physical IDs; their logical handles may remain bound for Undo. */
  readonly retiredSegmentIds?: readonly bigint[];
  /**
   * Rare authoritative replacement for the preview delta. The preview applies
   * exactly one delta to the pre-commit baseline so the resulting canonical
   * forward and inverse recipes remain a truthful Undo/Redo pair.
   */
  readonly finalizedPreviewDelta?: SpatialSkeletonEditDelta;
  /** Rare authority-specific presentation correction; numeric remaps are automatic. */
  readonly uiHints?: SpatialSkeletonPreviewUiHints;
}

/**
 * A complete ordinary datasource read that may replace part of the confirmed
 * baseline.  Reads use physical ids at this boundary because they are issued
 * by the shared state cache, not by a datasource plan.
 */
export interface SpatialSkeletonAuthoritativeReadSnapshot {
  readonly segmentId: bigint;
  readonly snapshot: CompleteSkeleton | undefined;
}

export interface SpatialSkeletonAuthoritativeReadPublicationOptions {
  /** Cache revisions captured when the underlying GET began. */
  readonly expectedCacheRevisions: ReadonlyMap<bigint, number>;
  readonly notify?: boolean;
}

export interface SpatialSkeletonPreparedPreviewPublication {
  readonly generation: number;
  readonly cacheChanges: readonly (readonly [
    bigint,
    CompleteSkeleton | undefined,
  ])[];
  readonly expectedCacheRevisions: ReadonlyMap<bigint, number>;
  readonly activeStableOwners: readonly SpatialSkeletonDisplayStableOwner[];
  readonly numericAliases: readonly SpatialSkeletonDisplayNumericAlias[];
  readonly provisionalNodeIds: readonly bigint[];
  readonly pendingEditIntentIdsToRemove: readonly number[];
  readonly notify: boolean;
}

export class SpatialSkeletonPreviewPublicationFenceError extends Error {
  constructor(
    readonly segmentId: bigint,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Spatial skeleton preview for segment ${segmentId} was prepared at cache revision ${expectedRevision}, but revision ${actualRevision} is current.`,
    );
    this.name = "SpatialSkeletonPreviewPublicationFenceError";
  }
}

export class SpatialSkeletonEditPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialSkeletonEditPreviewError";
  }
}

export interface SpatialSkeletonEditPreviewOptions {
  readonly retainedHistoryWorkspace?: CompleteSkeletonSet;
  readonly mappings?: SpatialSkeletonStableIdHandles<bigint, bigint>;
  readonly uiHints?: SpatialSkeletonPreviewUiHintPort;
  readonly onAuxiliaryError?: (error: unknown) => void;
}

interface IntentPreview {
  readonly intentId: number;
  readonly preview: SpatialSkeletonPreviewIntentDelta;
  readonly mappingToken?: SpatialSkeletonStableIdMappingToken;
  readonly inverseDelta: SpatialSkeletonEditInverseDelta;
}

interface PreparedRuntimePublication {
  /** Revision of the live identity map from which this candidate was derived. */
  readonly expectedMappingRevision: number;
  readonly publicValue: SpatialSkeletonPreparedPreviewPublication;
  readonly mappings: SpatialSkeletonStableIdHandles<bigint, bigint>;
  readonly activeIntents: Map<number, IntentPreview>;
  readonly retainedHistoryWorkspace: CompleteSkeletonSet;
  readonly previewedWorkspace: CompleteSkeletonSet;
  readonly statePublication: SpatialSkeletonPreparedPreviewCachePublication;
  readonly publishedCacheRevisions: Map<bigint, number>;
}

function cloneBindings(
  update: SpatialSkeletonStableIdMappingUpdate<bigint, bigint> | undefined,
): SpatialSkeletonStableIdMappingUpdate<bigint, bigint> | undefined {
  if (update === undefined) return undefined;
  const nodes = update.nodes?.map(
    ([handle, physicalId]) =>
      [Object.freeze({ ...handle }), physicalId] as const,
  );
  const segments = update.segments?.map(
    ([handle, physicalId]) =>
      [Object.freeze({ ...handle }), physicalId] as const,
  );
  return Object.freeze({
    ...(nodes === undefined ? {} : { nodes: Object.freeze(nodes) }),
    ...(segments === undefined ? {} : { segments: Object.freeze(segments) }),
  });
}

function hasBindings(
  update: SpatialSkeletonStableIdMappingUpdate<bigint, bigint> | undefined,
) {
  return (
    (update?.nodes?.length ?? 0) !== 0 || (update?.segments?.length ?? 0) !== 0
  );
}

function validateNumericBindings(
  update: SpatialSkeletonStableIdMappingUpdate<bigint, bigint> | undefined,
  context: string,
) {
  for (const [, physicalId] of [
    ...(update?.nodes ?? []),
    ...(update?.segments ?? []),
  ]) {
    if (physicalId === 0n) {
      throw new SpatialSkeletonEditValidationError(
        `${context} requires nonzero ids; received ${physicalId}.`,
      );
    }
  }
}

function bindingEntriesEqual(
  actual: readonly (readonly [string, bigint])[],
  expected:
    | readonly (readonly [
        SpatialSkeletonStableNodeHandle | SpatialSkeletonStableSegmentHandle,
        bigint,
      ])[]
    | undefined,
) {
  const expectedMap = new Map(
    (expected ?? []).map(([handle, physicalId]) => [
      handle.stableId,
      physicalId,
    ]),
  );
  return (
    actual.length === expectedMap.size &&
    actual.every(([stableId, physicalId]) =>
      Object.is(expectedMap.get(stableId), physicalId),
    )
  );
}

function normalizePreview(
  preview: SpatialSkeletonPreviewIntentDelta,
): SpatialSkeletonPreviewIntentDelta {
  const inspectionSeed =
    preview.inspectionSeed === undefined
      ? undefined
      : Object.freeze({
          segments: Object.freeze(
            preview.inspectionSeed.segments.map(({ segment, snapshot }) =>
              Object.freeze({
                segment: Object.freeze({ ...segment }),
                snapshot,
              }),
            ),
          ),
          authoritativeBindings: cloneBindings(
            preview.inspectionSeed.authoritativeBindings,
          )!,
          expectedCacheRevisions: new Map(
            preview.inspectionSeed.expectedCacheRevisions,
          ),
        });
  return Object.freeze({
    delta: preview.delta,
    ...(inspectionSeed === undefined ? {} : { inspectionSeed }),
    ...(preview.provisionalBindings === undefined
      ? {}
      : { provisionalBindings: cloneBindings(preview.provisionalBindings) }),
    ...(preview.uiHints === undefined
      ? {}
      : {
          uiHints: cloneSpatialSkeletonPreviewUiHints(preview.uiHints),
        }),
    ...(preview.rollbackUiHints === undefined
      ? {}
      : {
          rollbackUiHints: cloneSpatialSkeletonPreviewUiHints(
            preview.rollbackUiHints,
          ),
        }),
    ...(preview.pendingEditIntentId === undefined
      ? {}
      : {
          pendingEditIntentId: preview.pendingEditIntentId,
        }),
  });
}

function sortedArtifacts<TInverse>(
  artifacts: readonly SpatialSkeletonPreviewIntentArtifact<
    SpatialSkeletonPreviewIntentDelta,
    TInverse
  >[],
) {
  return [...artifacts].sort((a, b) => a.intentId - b.intentId);
}

function getPreviewSegmentHandles(
  delta: SpatialSkeletonEditDelta,
): readonly SpatialSkeletonStableSegmentHandle[] {
  switch (delta.kind) {
    case "add":
    case "move":
    case "delete":
    case "reroot":
    case "node-attributes":
    case "restore-delete":
    case "restore-topology":
      return [delta.segment];
    case "split":
      return [delta.sourceSegment, delta.downstreamSegment];
    case "merge":
      return [delta.firstSegment, delta.secondSegment, delta.resultSegment];
    case "join-split":
      return [
        delta.sourceSegment,
        delta.downstreamSegment,
        delta.resultSegment,
      ];
    case "unmerge":
      return [delta.mergedSegment, delta.firstSegment, delta.secondSegment];
  }
}

function selectWorkspaceSegments(
  workspace: CompleteSkeletonSet,
  handles: Iterable<SpatialSkeletonStableSegmentHandle>,
) {
  const keys = new Set([...handles].map(({ stableId }) => stableId));
  return new CompleteSkeletonSet(
    workspace.segments.filter(({ segment }) => keys.has(segment.stableId)),
  );
}

/**
 * Generic owner of the retained-history + active-intent preview equation:
 *
 *   touched slices of retained history + ordered active deltas + identities
 *     = active previewed workspace
 *
 * No datasource code or request state is retained here.
 */
export class SpatialSkeletonEditPreview
  implements
    SpatialSkeletonPreviewPort<
      SpatialSkeletonPreviewIntentDelta,
      SpatialSkeletonAuthoritativeReconciliation,
      SpatialSkeletonEditInverseDelta
    >
{
  private mappingsValue: SpatialSkeletonStableIdHandles<bigint, bigint>;
  private retainedHistoryWorkspaceValue: CompleteSkeletonSet;
  private previewedWorkspaceValue: CompleteSkeletonSet;
  private retainedHistorySegmentKeys = new Set<string>();
  private activeIntents = new Map<number, IntentPreview>();
  private publishedCacheRevisions = new Map<bigint, number>();
  private preparedExact = new Map<
    number,
    {
      readonly preview: SpatialSkeletonPreviewIntentDelta;
      readonly inversePreview: SpatialSkeletonEditInverseDelta;
      readonly publication: PreparedRuntimePublication;
    }
  >();
  private generationValue = 0;
  private readonly physicalNodeHandles = new Map<
    bigint,
    SpatialSkeletonStableNodeHandle
  >();
  private readonly physicalSegmentHandles = new Map<
    bigint,
    SpatialSkeletonStableSegmentHandle
  >();
  private readonly previewArtifactListeners = new Set<
    SpatialSkeletonPreviewArtifactsListener<
      SpatialSkeletonPreviewIntentDelta,
      SpatialSkeletonEditInverseDelta
    >
  >();

  constructor(
    private readonly target: SpatialSkeletonPreviewPublicationTarget,
    private readonly options: SpatialSkeletonEditPreviewOptions = {},
  ) {
    this.mappingsValue = (
      options.mappings ?? new SpatialSkeletonStableIdHandles<bigint, bigint>()
    ).clone();
    this.retainedHistoryWorkspaceValue =
      options.retainedHistoryWorkspace ?? new CompleteSkeletonSet([]);
    this.previewedWorkspaceValue = new CompleteSkeletonSet([]);
  }

  get generation() {
    return this.generationValue;
  }

  get retainedHistoryWorkspace() {
    return this.retainedHistoryWorkspaceValue;
  }

  get previewedWorkspace() {
    return this.previewedWorkspaceValue;
  }

  get mappingRevision() {
    return this.mappingsValue.revision;
  }

  subscribePreviewArtifacts(
    listener: SpatialSkeletonPreviewArtifactsListener<
      SpatialSkeletonPreviewIntentDelta,
      SpatialSkeletonEditInverseDelta
    >,
  ) {
    this.previewArtifactListeners.add(listener);
    return () => this.previewArtifactListeners.delete(listener);
  }

  resolveNode(handle: SpatialSkeletonStableNodeHandle) {
    return this.mappingsValue.resolveNode(handle);
  }

  getOrCreateNodeHandle(nodeId: bigint) {
    return this.getOrCreateNodeHandles([nodeId]).get(nodeId)!;
  }

  getOrCreateNodeHandles(nodeIds: readonly bigint[]) {
    const uniqueNodeIds: bigint[] = [];
    const requestedNodeIds = new Set<bigint>();
    // Validate the complete request before allocating or binding anything so
    // callers never observe a partially-applied batch.
    for (const nodeId of nodeIds) {
      if (nodeId === 0n) {
        throw new RangeError(
          `A spatial skeleton node identity requires a nonzero id; received ${nodeId}.`,
        );
      }
      if (requestedNodeIds.has(nodeId)) continue;
      requestedNodeIds.add(nodeId);
      uniqueNodeIds.push(nodeId);
    }

    const result = new Map<bigint, SpatialSkeletonStableNodeHandle>();
    const unresolvedNodeIds: bigint[] = [];
    for (const nodeId of uniqueNodeIds) {
      const existing = this.physicalNodeHandles.get(nodeId);
      // Preserve the logical identity originally interned for this lookup even
      // after authority rebinds it (for example, a reversed merge). Historical
      // recipes asking for the retired physical id must continue to address the
      // surviving logical resource. A genuinely new physical lookup without an
      // interned handle uses the fresh-authority suffix path below.
      if (existing === undefined) {
        unresolvedNodeIds.push(nodeId);
      } else {
        result.set(nodeId, existing);
      }
    }

    const mappedNodes = this.mappingsValue.findFirstNodes(unresolvedNodeIds);
    const newBindings: Array<
      readonly [SpatialSkeletonStableNodeHandle, bigint]
    > = [];
    for (const nodeId of unresolvedNodeIds) {
      const mapped = mappedNodes.get(nodeId);
      const handle =
        mapped ??
        this.createFreshAuthoritativeNodeHandle(this.mappingsValue, nodeId);
      result.set(nodeId, handle);
      if (mapped === undefined) newBindings.push([handle, nodeId]);
    }
    if (newBindings.length !== 0) {
      this.mappingsValue.bindNodes(newBindings);
    }
    for (const [nodeId, handle] of result) {
      this.physicalNodeHandles.set(nodeId, handle);
    }
    return result;
  }

  getOrCreateSegmentHandle(segmentId: bigint) {
    if (segmentId === 0n) {
      throw new RangeError(
        `A spatial skeleton segment identity requires a nonzero id; received ${segmentId}.`,
      );
    }
    const retainedOwner =
      this.previewedWorkspaceValue.segments.find(
        ({ segment }) =>
          this.mappingsValue.resolveSegment(segment) === segmentId,
      )?.segment ??
      this.retainedHistoryWorkspaceValue.segments.find(
        ({ segment }) =>
          this.mappingsValue.resolveAuthoritativeSegment(segment) === segmentId,
      )?.segment;
    if (retainedOwner !== undefined) {
      this.physicalSegmentHandles.set(segmentId, retainedOwner);
      return retainedOwner;
    }
    const existing = this.physicalSegmentHandles.get(segmentId);
    if (existing !== undefined) return existing;
    const mapped = this.mappingsValue.findSegments(segmentId).at(0);
    const handle =
      mapped ??
      this.createFreshAuthoritativeSegmentHandle(this.mappingsValue, segmentId);
    if (mapped === undefined) this.mappingsValue.bindSegment(handle, segmentId);
    this.physicalSegmentHandles.set(segmentId, handle);
    return handle;
  }

  resolveSegment(handle: SpatialSkeletonStableSegmentHandle) {
    return this.mappingsValue.resolveSegment(handle);
  }

  resolveAuthoritativeNode(handle: SpatialSkeletonStableNodeHandle) {
    return this.mappingsValue.resolveAuthoritativeNode(handle);
  }

  resolveAuthoritativeSegment(handle: SpatialSkeletonStableSegmentHandle) {
    return this.mappingsValue.resolveAuthoritativeSegment(handle);
  }

  resolveNodeTarget(handle: SpatialSkeletonStableNodeHandle) {
    return this.mappingsValue.resolveNodeTarget(handle);
  }

  resolveSegmentTarget(handle: SpatialSkeletonStableSegmentHandle) {
    return this.mappingsValue.resolveSegmentTarget(handle);
  }

  getProtectedSegmentIds() {
    return Object.freeze([
      ...materializeCompleteSkeletonSet(
        this.previewedWorkspaceValue,
        this.mappingsValue,
      ).keys(),
    ]);
  }

  ownsAuthoritativeReadSegment(segmentId: bigint) {
    return (
      this.retainedHistoryWorkspaceValue.segments.some(
        ({ segment }) =>
          this.mappingsValue.resolveAuthoritativeSegment(segment) === segmentId,
      ) ||
      ownsPhysicalSpatialSkeletonSegment(
        this.previewedWorkspaceValue,
        this.mappingsValue,
        segmentId,
      )
    );
  }

  setRetainedHistoryPreviews(
    previews: readonly SpatialSkeletonPreviewIntentDelta[],
  ) {
    const nextKeys = new Set(
      previews.flatMap(({ delta }) =>
        getPreviewSegmentHandles(delta).map(({ stableId }) => stableId),
      ),
    );
    // Active preview state is the other explicit owner of baseline slices.
    // A bounded history replay may evict an old entry while its authority
    // request is still unresolved; never let that history compaction prune the
    // baseline which the active delta still needs for refold or rollback.
    for (const { preview } of this.activeIntents.values()) {
      for (const { stableId } of getPreviewSegmentHandles(preview.delta)) {
        nextKeys.add(stableId);
      }
    }
    if (
      nextKeys.size === this.retainedHistorySegmentKeys.size &&
      [...nextKeys].every((key) => this.retainedHistorySegmentKeys.has(key))
    ) {
      return;
    }
    this.retainedHistorySegmentKeys = nextKeys;
    this.retainedHistoryWorkspaceValue = new CompleteSkeletonSet(
      this.retainedHistoryWorkspaceValue.segments.filter(({ segment }) =>
        nextKeys.has(segment.stableId),
      ),
    );
    const ownedSegmentIds = new Set([
      ...materializeCompleteSkeletonSet(
        this.previewedWorkspaceValue,
        this.mappingsValue,
      ).keys(),
      ...materializeCompleteSkeletonSet(
        this.retainedHistoryWorkspaceValue,
        this.mappingsValue.clone(0),
      ).keys(),
    ]);
    for (const segmentId of this.publishedCacheRevisions.keys()) {
      if (!ownedSegmentIds.has(segmentId)) {
        this.publishedCacheRevisions.delete(segmentId);
      }
    }
    ++this.generationValue;
  }

  prepareExact(intentId: number, preview: SpatialSkeletonPreviewIntentDelta) {
    if (this.activeIntents.has(intentId) || this.preparedExact.has(intentId)) {
      throw new SpatialSkeletonEditPreviewError(
        `Preview intent ${intentId} has already been prepared or adopted.`,
      );
    }
    const normalized = normalizePreview(preview);
    const seeded = this.prepareInspectionSeed(normalized.inspectionSeed);
    const active = new Map(this.activeIntents);
    active.set(intentId, {
      intentId,
      preview: normalized,
      inverseDelta: normalized.delta,
    });
    const publication = this.preparePublication({
      activeIntents: active,
      mappings: seeded.mappings,
      retainedHistoryWorkspace: seeded.retainedHistoryWorkspace,
      acceptedCacheRevisions: normalized.inspectionSeed?.expectedCacheRevisions,
      pendingEditIntentIdsToRemove: [
        normalized.pendingEditIntentId ?? intentId,
      ],
    });
    const preparedRecord = publication.activeIntents.get(intentId)!;
    this.preparedExact.set(intentId, {
      preview: normalized,
      inversePreview: preparedRecord.inverseDelta,
      publication,
    });
    return Object.freeze({
      preview: normalized,
      inversePreview: preparedRecord.inverseDelta,
    });
  }

  discardPrepared(intentId: number) {
    this.preparedExact.delete(intentId);
  }

  /** Publishes fresh reads, then refolds every exact active intent. */
  publishAuthoritativeRead(
    snapshots: Iterable<SpatialSkeletonAuthoritativeReadSnapshot>,
    options: SpatialSkeletonAuthoritativeReadPublicationOptions,
  ) {
    const normalized = this.normalizeAuthoritativeReadSnapshots(snapshots);
    if (normalized.length === 0) return false;
    if (!this.authoritativeReadFencesAreCurrent(normalized, options)) {
      return false;
    }
    return this.publishNormalizedAuthoritativeRead(normalized, {
      acceptedCacheRevisions: options.expectedCacheRevisions,
      notify: options.notify,
    });
  }

  publishExact(intentId: number, preview: SpatialSkeletonPreviewIntentDelta) {
    const pending = this.preparedExact.get(intentId);
    if (pending === undefined || pending.preview !== preview) {
      throw new SpatialSkeletonEditPreviewError(
        `Preview intent ${intentId} was not published with its prepared artifact.`,
      );
    }
    let publication = pending.publication;
    if (
      publication.publicValue.generation !== this.generationValue ||
      publication.expectedMappingRevision !== this.mappingsValue.revision
    ) {
      const seeded = this.prepareInspectionSeed(preview.inspectionSeed);
      const active = new Map(this.activeIntents);
      active.set(intentId, {
        intentId,
        preview,
        inverseDelta: pending.inversePreview,
      });
      publication = this.preparePublication({
        activeIntents: active,
        mappings: seeded.mappings,
        retainedHistoryWorkspace: seeded.retainedHistoryWorkspace,
        acceptedCacheRevisions: preview.inspectionSeed?.expectedCacheRevisions,
        pendingEditIntentIdsToRemove: [preview.pendingEditIntentId ?? intentId],
      });
    }
    this.adoptPublication(publication, {
      uiHints: preview.uiHints,
    });
    this.preparedExact.delete(intentId);
  }

  rollbackAndReplay(
    request: SpatialSkeletonPreviewRollbackReplayRequest<
      SpatialSkeletonPreviewIntentDelta,
      SpatialSkeletonEditInverseDelta
    >,
  ) {
    const active = new Map(this.activeIntents);
    const removedIntents: IntentPreview[] = [];
    for (const artifact of request.rollbackIntents) {
      const { intentId } = artifact;
      const removed = active.get(intentId);
      if (removed !== undefined) {
        removedIntents.push(removed);
        active.delete(intentId);
      }
      this.preparedExact.delete(intentId);
    }
    let replayChanged = false;
    for (const artifact of sortedArtifacts(request.replayIntents)) {
      const { intentId } = artifact;
      const existing = active.get(intentId);
      if (existing?.preview === artifact.preview) continue;
      replayChanged = true;
      active.set(intentId, {
        intentId,
        preview: normalizePreview(artifact.preview),
        inverseDelta: artifact.inversePreview,
      });
    }
    if (removedIntents.length === 0 && !replayChanged) return;
    const rollbackIds = removedIntents.map(({ intentId }) => intentId);
    const restoredHistorySegmentIds = new Set<bigint>();
    for (const { preview } of removedIntents) {
      for (const handle of getPreviewSegmentHandles(preview.delta)) {
        const segmentId =
          this.mappingsValue.resolveAuthoritativeSegment(handle);
        if (segmentId !== undefined) restoredHistorySegmentIds.add(segmentId);
      }
    }
    const publication = this.preparePublication({
      activeIntents: active,
      publishHistorySegmentIds: [...restoredHistorySegmentIds],
      pendingEditIntentIdsToRemove: rollbackIds,
    });
    const rollbackUiHints = mergeSpatialSkeletonPreviewUiHints(
      removedIntents
        .sort((a, b) => b.intentId - a.intentId)
        .map(({ preview }) => preview.rollbackUiHints),
    );
    this.adoptPublication(publication, {
      uiHints: rollbackUiHints,
      // A rolled-back provisional handle is intentionally absent from the
      // adopted mappings. Keep the previous immutable mapping object only as
      // a post-adoption numeric resolver for hiding/remapping that UI id.
      fallbackUiHintMappings: this.mappingsValue,
    });
  }

  publishAuthoritative(
    publication: SpatialSkeletonAuthoritativePublication<
      SpatialSkeletonPreviewIntentDelta,
      SpatialSkeletonAuthoritativeReconciliation,
      SpatialSkeletonEditInverseDelta
    >,
  ) {
    const { intentId } = publication;
    const committed = this.activeIntents.get(intentId);
    if (committed === undefined) {
      throw new SpatialSkeletonEditPreviewError(
        `Cannot reconcile preview intent ${intentId} because it is not active.`,
      );
    }

    validateNumericBindings(
      publication.reconciliation.bindings,
      "Authoritative spatial skeleton reconciliation",
    );

    // Promote the exact semantic delta while the logical handles still have
    // their pre-authority identities. Merge is the important case: authority
    // binds both source handles to one survivor, which would otherwise make
    // the reducer see the two inputs as the same skeleton.
    const preBindingMappings = this.mappingsValue.clone(intentId);
    let nextBaseline = this.retainedHistoryWorkspaceValue;
    const finalizedDelta =
      publication.reconciliation.finalizedPreviewDelta ??
      committed.preview.delta;
    const finalizedPreview =
      finalizedDelta === committed.preview.delta
        ? committed.preview
        : Object.freeze({ ...committed.preview, delta: finalizedDelta });
    const promoted = applySpatialSkeletonEditDelta(
      nextBaseline,
      finalizedDelta,
      preBindingMappings,
    );
    nextBaseline = promoted.edit;
    const finalizedInverse = promoted.inverseDelta;
    const finalizedArtifact = Object.freeze({
      intentId,
      preview: finalizedPreview,
      inversePreview: finalizedInverse,
    });

    const mappings = this.mappingsValue.clone();
    const nodeRemappings = new Map<bigint, bigint>();
    const segmentRemappings = new Map<bigint, bigint>();
    const bindingRemappings = [
      [publication.reconciliation.bindings?.nodes, nodeRemappings],
      [publication.reconciliation.bindings?.segments, segmentRemappings],
    ] as const;
    for (const [bindings, remappings] of bindingRemappings) {
      for (const [handle, physicalId] of bindings ?? []) {
        const previous = preBindingMappings.resolve(handle);
        if (previous !== undefined && previous !== physicalId) {
          remappings.set(previous, physicalId);
        }
      }
    }

    if (committed.mappingToken === undefined) {
      mappings.apply(publication.reconciliation.bindings ?? {});
    } else if (
      !mappings.commit(
        committed.mappingToken,
        publication.reconciliation.bindings,
      )
    ) {
      throw new SpatialSkeletonEditPreviewError(
        `Preview intent ${intentId} lost its provisional identity overlay.`,
      );
    }

    nextBaseline = remapCompleteSkeletonSet(
      nextBaseline,
      nodeRemappings,
      segmentRemappings,
    );

    const active = new Map<number, IntentPreview>();
    for (const artifact of sortedArtifacts(publication.activePreviews)) {
      active.set(artifact.intentId, {
        intentId: artifact.intentId,
        preview: normalizePreview(artifact.preview),
        inverseDelta: artifact.inversePreview,
      });
    }
    this.reconcileMappingOverlays(mappings, active);
    const retiredSegmentIds = new Set(
      publication.reconciliation.retiredSegmentIds ?? [],
    );
    for (const resource of publication.reconciliation.retiredResources ?? []) {
      const segmentId = this.retireAuthoritativeBinding(mappings, resource);
      if (segmentId !== undefined) retiredSegmentIds.add(segmentId);
    }

    const prepared = this.preparePublication({
      activeIntents: active,
      mappings,
      retainedHistoryWorkspace: nextBaseline,
      retiredSegmentIds,
      publishHistorySegmentIds: [
        ...materializeCompleteSkeletonSet(
          selectWorkspaceSegments(
            nextBaseline,
            getPreviewSegmentHandles(finalizedDelta),
          ),
          mappings.clone(0),
        ).keys(),
      ],
      pendingEditIntentIdsToRemove: [intentId],
      precedingArtifacts: [finalizedArtifact],
      rebaseActivePreview: publication.rebaseActivePreview,
    });
    // Numeric UI remaps follow visible identities. An earlier creation must
    // not remap a later Redo's provisional node to its own returned id.
    for (const [bindings, remappings] of bindingRemappings) {
      remappings.clear();
      for (const [handle] of bindings ?? []) {
        const before = this.mappingsValue.resolve(handle);
        const after = prepared.mappings.resolve(handle);
        if (before !== undefined && after !== undefined && before !== after) {
          remappings.set(before, after);
        }
      }
    }
    // A rebased Undo may restore the other side of a Merge. Presentation
    // follows the owners in the final preview, not the intermediate merged
    // baseline (which would collapse both visible skeletons to its survivor).
    for (const { segment } of this.previewedWorkspaceValue.segments) {
      if (prepared.previewedWorkspace.getSegment(segment) === undefined)
        continue;
      const before = this.mappingsValue.resolveSegment(segment);
      const after = prepared.mappings.resolveSegment(segment);
      if (before !== undefined && after !== undefined && before !== after) {
        segmentRemappings.set(before, after);
      }
    }
    this.adoptPublication(prepared, {
      uiHints: publication.reconciliation.uiHints,
      nodeIdRemappings: nodeRemappings,
      segmentIdRemappings: segmentRemappings,
    });
    this.preparedExact.delete(intentId);
    return finalizedArtifact;
  }

  private normalizeAuthoritativeReadSnapshots(
    snapshots: Iterable<SpatialSkeletonAuthoritativeReadSnapshot>,
  ) {
    const bySegmentId = new Map<
      bigint,
      SpatialSkeletonAuthoritativeReadSnapshot
    >();
    for (const { segmentId, snapshot } of snapshots) {
      if (segmentId === 0n) {
        throw new SpatialSkeletonEditValidationError(
          `An authoritative spatial skeleton read has invalid segment id ${segmentId}.`,
        );
      }
      if (bySegmentId.has(segmentId)) {
        throw new SpatialSkeletonEditValidationError(
          `An authoritative spatial skeleton read contains duplicate segment ${segmentId}.`,
        );
      }
      if (snapshot !== undefined) {
        for (const node of snapshot.materialize()) {
          if (node.nodeId === 0n) {
            throw new SpatialSkeletonEditValidationError(
              `Authoritative segment ${segmentId} contains invalid node id ${node.nodeId}.`,
            );
          }
          if (node.segmentId !== segmentId) {
            throw new SpatialSkeletonEditValidationError(
              `Authoritative segment ${segmentId} contains node ${node.nodeId} owned by segment ${node.segmentId}.`,
            );
          }
        }
      }
      bySegmentId.set(segmentId, Object.freeze({ segmentId, snapshot }));
    }
    return Object.freeze([...bySegmentId.values()]);
  }

  private authoritativeReadFencesAreCurrent(
    snapshots: readonly SpatialSkeletonAuthoritativeReadSnapshot[],
    options: SpatialSkeletonAuthoritativeReadPublicationOptions,
  ) {
    for (const { segmentId } of snapshots) {
      if (
        options.expectedCacheRevisions.get(segmentId) !==
        this.target.getCachedSegmentRevision(segmentId)
      ) {
        return false;
      }
    }
    return true;
  }

  private publishNormalizedAuthoritativeRead(
    snapshots: readonly SpatialSkeletonAuthoritativeReadSnapshot[],
    options: {
      readonly acceptedCacheRevisions: ReadonlyMap<bigint, number>;
      readonly notify?: boolean;
    },
  ) {
    const mappings = this.mappingsValue.clone();
    let retainedHistoryWorkspace = this.retainedHistoryWorkspaceValue;
    const baselineByPhysical = materializeCompleteSkeletonSet(
      retainedHistoryWorkspace,
      mappings.clone(0),
    );
    const previewedByPhysical = materializeCompleteSkeletonSet(
      this.previewedWorkspaceValue,
      mappings,
    );
    const changes: Array<{
      readonly segment: SpatialSkeletonStableSegmentHandle;
      readonly snapshot: CompleteSkeleton | undefined;
    }> = [];

    for (const { segmentId, snapshot } of snapshots) {
      const baselineEntry = baselineByPhysical.get(segmentId);
      const previewedEntry = previewedByPhysical.get(segmentId);
      if (
        baselineEntry === undefined &&
        previewedEntry !== undefined &&
        this.activeIntents.size !== 0
      ) {
        throw new SpatialSkeletonEditPreviewError(
          `Cannot publish an ordinary read for active-only segment ${segmentId} before its creating intent settles.`,
        );
      }

      const segment =
        baselineEntry?.segment ??
        previewedEntry?.segment ??
        mappings.findSegments(segmentId).at(-1) ??
        this.createFreshAuthoritativeSegmentHandle(mappings, segmentId);
      if (mappings.resolveAuthoritativeSegment(segment) === undefined) {
        mappings.bindSegment(segment, segmentId);
      }
      if (mappings.resolveAuthoritativeSegment(segment) !== segmentId) {
        throw new SpatialSkeletonEditPreviewError(
          `Logical segment ${segment.stableId} no longer resolves to authoritative read segment ${segmentId}.`,
        );
      }

      changes.push({ segment, snapshot });
    }

    retainedHistoryWorkspace = retainedHistoryWorkspace.withChanges(changes);
    const prepared = this.preparePublication({
      activeIntents: this.activeIntents,
      mappings,
      retainedHistoryWorkspace,
      publishHistorySegmentIds: snapshots.map(({ segmentId }) => segmentId),
      pendingEditIntentIdsToRemove: [],
      acceptedCacheRevisions: options.acceptedCacheRevisions,
      notify: options.notify,
    });
    this.adoptPublication(prepared);
    // An ordinary read may already be represented by the exact immutable
    // handle selected for the candidate. In that case no cache replacement
    // (and therefore no cache revision increment) is needed, but the preview
    // must still acknowledge the observed revision.
    const revisions = new Map(this.publishedCacheRevisions);
    for (const { segmentId } of snapshots) {
      revisions.set(segmentId, this.target.getCachedSegmentRevision(segmentId));
    }
    this.publishedCacheRevisions = revisions;
    return true;
  }

  private createFreshAuthoritativeSegmentHandle(
    mappings: SpatialSkeletonStableIdHandles<bigint, bigint>,
    segmentId: bigint,
  ) {
    const base = `authority:${segmentId}`;
    for (let suffix = 0; ; ++suffix) {
      const handle = spatialSkeletonStableSegment(
        suffix === 0 ? base : `${base}:read:${suffix}`,
      );
      const current = mappings.resolveSegment(handle);
      if (current === undefined || current === segmentId) return handle;
    }
  }

  private createFreshAuthoritativeNodeHandle(
    mappings: SpatialSkeletonStableIdHandles<bigint, bigint>,
    nodeId: bigint,
  ) {
    const base = `authority:${nodeId}`;
    for (let suffix = 0; ; ++suffix) {
      const handle = spatialSkeletonStableNode(
        suffix === 0 ? base : `${base}:read:${suffix}`,
      );
      const current = mappings.resolveNode(handle);
      if (current === undefined || current === nodeId) return handle;
    }
  }

  private preparePublication(options: {
    readonly activeIntents: ReadonlyMap<number, IntentPreview>;
    readonly mappings?: SpatialSkeletonStableIdHandles<bigint, bigint>;
    readonly retainedHistoryWorkspace?: CompleteSkeletonSet;
    /** History snapshots that must be written during this adoption only. */
    readonly publishHistorySegmentIds?: readonly bigint[];
    /** Confirmed deletions must fence reads even when their preview is absent. */
    readonly retiredSegmentIds?: ReadonlySet<bigint>;
    readonly pendingEditIntentIdsToRemove: readonly number[];
    /** Revisions captured when an authoritative read began. */
    readonly acceptedCacheRevisions?: ReadonlyMap<bigint, number>;
    readonly notify?: boolean;
    readonly precedingArtifacts?: readonly SpatialSkeletonPreviewIntentArtifact<
      SpatialSkeletonPreviewIntentDelta,
      SpatialSkeletonEditInverseDelta
    >[];
    readonly rebaseActivePreview?: SpatialSkeletonAuthoritativePublication<
      SpatialSkeletonPreviewIntentDelta,
      SpatialSkeletonAuthoritativeReconciliation,
      SpatialSkeletonEditInverseDelta
    >["rebaseActivePreview"];
  }): PreparedRuntimePublication {
    const expectedMappingRevision = this.mappingsValue.revision;
    const mappings = (options.mappings ?? this.mappingsValue).clone();
    const active = new Map(options.activeIntents);
    this.reconcileMappingOverlays(mappings, active);
    const retainedHistoryWorkspace =
      options.retainedHistoryWorkspace ?? this.retainedHistoryWorkspaceValue;
    const ordered = [...active.values()].sort(
      (a, b) => a.intentId - b.intentId,
    );
    const activeSegmentHandles = ordered.flatMap(({ preview }) =>
      getPreviewSegmentHandles(preview.delta),
    );
    const activeBaseline = selectWorkspaceSegments(
      retainedHistoryWorkspace,
      activeSegmentHandles,
    );
    // Baseline snapshots contain confirmed ids. Replay then introduces each
    // provisional binding immediately before its delta, so a later Undo/Redo
    // cannot change how an earlier delta locates its input nodes or segments.
    const replayMappings = mappings.clone(0);
    const candidateBaselinePhysical = materializeCompleteSkeletonSet(
      activeBaseline,
      replayMappings,
    );
    const historyPhysical = materializeCompleteSkeletonSet(
      retainedHistoryWorkspace,
      replayMappings,
    );
    let previewedWorkspace = activeBaseline;
    const precedingArtifacts = [...(options.precedingArtifacts ?? [])];
    const reducedActive = new Map<number, IntentPreview>();
    for (let input of ordered) {
      const rebased = options.rebaseActivePreview?.(
        input.intentId,
        precedingArtifacts,
      );
      if (rebased !== undefined) {
        input = { ...input, preview: normalizePreview(rebased) };
        active.set(input.intentId, input);
        // A corrected inverse can restore the other side of a Merge. Replace
        // its provisional binding only in this off-screen candidate; normal
        // publications still reject changes to admitted bindings.
        const token = mappings.getOverlayToken(input.intentId);
        if (token !== undefined) mappings.rollback(token);
        this.reconcileMappingOverlays(mappings, active);
      }
      if (input.preview.provisionalBindings !== undefined) {
        replayMappings.stage(input.intentId, input.preview.provisionalBindings);
      }
      const applied = applySpatialSkeletonEditDelta(
        previewedWorkspace,
        input.preview.delta,
        replayMappings,
      );
      previewedWorkspace = applied.edit;
      reducedActive.set(input.intentId, {
        ...input,
        mappingToken: mappings.getOverlayToken(input.intentId),
        inverseDelta: applied.inverseDelta,
      });
      precedingArtifacts.push({
        intentId: input.intentId,
        preview: input.preview,
        inversePreview: applied.inverseDelta,
      });
    }

    const currentPhysical = materializeCompleteSkeletonSet(
      this.previewedWorkspaceValue,
      this.mappingsValue,
    );
    const nextPhysical = materializeCompleteSkeletonSet(
      previewedWorkspace,
      mappings,
    );
    const cacheChanges = new Map<bigint, CompleteSkeleton | undefined>();
    const publishHistorySegmentIds = new Set(
      options.publishHistorySegmentIds ?? [],
    );
    const retiredSegmentIds = options.retiredSegmentIds ?? new Set<bigint>();
    const candidateSegmentIds = new Set([
      ...retiredSegmentIds,
      ...currentPhysical.keys(),
      ...candidateBaselinePhysical.keys(),
      ...nextPhysical.keys(),
      ...publishHistorySegmentIds,
    ]);
    for (const segmentId of candidateSegmentIds) {
      const previewed = nextPhysical.get(segmentId);
      // A surviving active delta which touched a baseline segment owns both
      // its presence and its absence. In particular, a dependent Merge may
      // consume a just-committed Add segment; publishing that new history
      // segment beside the merged result would duplicate every moved node.
      const removedByActivePreview =
        previewed === undefined && candidateBaselinePhysical.has(segmentId);
      const desired =
        previewed?.snapshot ??
        (!removedByActivePreview &&
        (publishHistorySegmentIds.has(segmentId) ||
          currentPhysical.has(segmentId))
          ? historyPhysical.get(segmentId)?.snapshot
          : undefined);
      const visible =
        this.target.getCachedSegmentSnapshotHandle(segmentId)?.handle;
      if (desired !== visible || retiredSegmentIds.has(segmentId)) {
        cacheChanges.set(segmentId, desired);
      }
    }

    const expectedCacheRevisions = new Map<bigint, number>();
    for (const segmentId of cacheChanges.keys()) {
      const currentRevision = this.target.getCachedSegmentRevision(segmentId);
      const publishedRevision = this.publishedCacheRevisions.get(segmentId);
      const currentSnapshot =
        this.target.getCachedSegmentSnapshotHandle(segmentId)?.handle;
      // Cache eviction/invalidation is not an authoritative replacement. If
      // this preview still owns an exact previewed snapshot for the now-cold
      // segment, it may republish that snapshot under the new revision. A
      // confirmed retirement also owns an empty entry after logical aliases
      // move to the survivor. A present but different handle remains a hard
      // fence: it may be a newer read and must first be absorbed explicitly.
      const isOwnedSnapshotInvalidation =
        currentSnapshot === undefined &&
        (currentPhysical.has(segmentId) ||
          historyPhysical.has(segmentId) ||
          retiredSegmentIds.has(segmentId));
      if (
        publishedRevision !== undefined &&
        currentRevision !== publishedRevision &&
        options.acceptedCacheRevisions?.get(segmentId) !== currentRevision &&
        !isOwnedSnapshotInvalidation
      ) {
        throw new SpatialSkeletonPreviewPublicationFenceError(
          segmentId,
          publishedRevision,
          currentRevision,
        );
      }
      expectedCacheRevisions.set(segmentId, currentRevision);
    }

    const activeStableOwners: SpatialSkeletonDisplayStableOwner[] = [];
    const numericAliases: SpatialSkeletonDisplayNumericAlias[] = [];
    // History owns immutable logical handles independently of manager-cache
    // residency. Keep their numeric identity presentation available after the
    // last active delta settles. Active deltas own both presence and absence:
    // do not expose a hidden baseline owner beside its provisional replacement.
    const presentedPhysical = new Map(
      [...historyPhysical].filter(
        ([segmentId]) => !candidateBaselinePhysical.has(segmentId),
      ),
    );
    for (const [segmentId, segment] of nextPhysical) {
      presentedPhysical.set(segmentId, segment);
    }
    for (const [segmentId, { segment }] of presentedPhysical) {
      activeStableOwners.push(
        Object.freeze({ segmentId, stableHandle: segment }),
      );
      const target = mappings.resolveSegmentTarget(segment);
      numericAliases.push(
        Object.freeze({
          stableHandle: segment,
          segmentId,
          authoritative: target.state === "authoritative",
        }),
      );
    }
    activeStableOwners.sort((a, b) => bigintCompare(a.segmentId, b.segmentId));
    numericAliases.sort((a, b) =>
      a.stableHandle.stableId.localeCompare(b.stableHandle.stableId),
    );

    const provisionalNodeIds = new Set<bigint>();
    for (const overlay of mappings.cloneSnapshot().overlays) {
      for (const [, nodeId] of overlay.nodes) {
        if (nodeId === 0n) {
          throw new SpatialSkeletonEditValidationError(
            `A provisional node requires a nonzero id; received ${nodeId}.`,
          );
        }
        provisionalNodeIds.add(nodeId);
      }
    }

    const pendingEditIntentIdsToRemove = Object.freeze([
      ...new Set(options.pendingEditIntentIdsToRemove),
    ]);
    const publicValue: SpatialSkeletonPreparedPreviewPublication =
      Object.freeze({
        generation: this.generationValue,
        cacheChanges: Object.freeze([...cacheChanges]),
        expectedCacheRevisions,
        activeStableOwners: Object.freeze(activeStableOwners),
        numericAliases: Object.freeze(numericAliases),
        provisionalNodeIds: Object.freeze(
          [...provisionalNodeIds].sort(bigintCompare),
        ),
        pendingEditIntentIdsToRemove,
        notify: options.notify ?? true,
      });

    const statePublication =
      this.target.prepareSpatialSkeletonPreviewCachePublication({
        snapshots: publicValue.cacheChanges,
        expectedRevisions: publicValue.expectedCacheRevisions,
        retiredSegmentIds,
        activeStableOwners: publicValue.activeStableOwners,
        numericAliases: publicValue.numericAliases,
        provisionalNodeIds: publicValue.provisionalNodeIds,
        pendingEditIntentIdsToRemove: publicValue.pendingEditIntentIdsToRemove,
        notify: publicValue.notify,
      });
    if (statePublication === undefined) {
      for (const [
        segmentId,
        expectedRevision,
      ] of publicValue.expectedCacheRevisions) {
        const actualRevision = this.target.getCachedSegmentRevision(segmentId);
        if (actualRevision !== expectedRevision) {
          throw new SpatialSkeletonPreviewPublicationFenceError(
            segmentId,
            expectedRevision,
            actualRevision,
          );
        }
      }
      throw new SpatialSkeletonEditPreviewError(
        "Spatial skeleton presentation changed while its preview publication was being prepared.",
      );
    }
    const publishedCacheRevisions = new Map(this.publishedCacheRevisions);
    for (const [segmentId, revision] of statePublication.cacheRevisions) {
      publishedCacheRevisions.set(segmentId, revision);
    }

    return Object.freeze({
      expectedMappingRevision,
      publicValue,
      mappings,
      activeIntents: reducedActive,
      retainedHistoryWorkspace,
      previewedWorkspace,
      statePublication,
      publishedCacheRevisions,
    });
  }

  private adoptPublication(
    publication: PreparedRuntimePublication,
    options: {
      readonly uiHints?: SpatialSkeletonPreviewUiHints;
      readonly nodeIdRemappings?: ReadonlyMap<bigint, bigint>;
      readonly segmentIdRemappings?: ReadonlyMap<bigint, bigint>;
      readonly fallbackUiHintMappings?: SpatialSkeletonStableIdHandles<
        bigint,
        bigint
      >;
    } = {},
  ) {
    if (publication.publicValue.generation !== this.generationValue) {
      throw new SpatialSkeletonEditPreviewError(
        "A stale prepared spatial skeleton publication cannot be adopted.",
      );
    }
    if (publication.expectedMappingRevision !== this.mappingsValue.revision) {
      throw new SpatialSkeletonEditPreviewError(
        "A spatial skeleton publication was prepared from stale logical identity mappings.",
      );
    }
    for (const [segmentId, expectedRevision] of publication.publicValue
      .expectedCacheRevisions) {
      const actualRevision = this.target.getCachedSegmentRevision(segmentId);
      if (actualRevision !== expectedRevision) {
        throw new SpatialSkeletonPreviewPublicationFenceError(
          segmentId,
          expectedRevision,
          actualRevision,
        );
      }
    }

    this.target.runSpatialSkeletonDisplayTransaction(
      () => {
        const adopted =
          this.target.adoptPreparedSpatialSkeletonPreviewCachePublication(
            publication.statePublication,
          );
        if (!adopted) {
          throw new SpatialSkeletonEditPreviewError(
            "A stale prepared spatial skeleton state publication cannot be adopted.",
          );
        }

        // Every state-facing collection and presentation value was prepared
        // off-screen. The target and preview now install those references in the
        // same synchronous callback before any observer is notified.
        this.mappingsValue = publication.mappings;
        this.activeIntents = publication.activeIntents;
        this.retainedHistoryWorkspaceValue =
          publication.retainedHistoryWorkspace;
        this.previewedWorkspaceValue = publication.previewedWorkspace;
        ++this.generationValue;
        this.publishedCacheRevisions = publication.publishedCacheRevisions;
      },
      (error) => this.reportAuxiliaryError(error),
    );
    this.target.finalizePreparedSpatialSkeletonPreviewCachePublication(
      publication.statePublication,
      (error) => this.reportAuxiliaryError(error),
    );

    // A refold can change an active intent's exact inverse even when its
    // immutable forward delta is unchanged. Publish the complete active set
    // only after the model adoption has succeeded. Listener failures are
    // observational: they can neither unwind nor invalidate the adoption.
    const artifacts = Object.freeze(
      [...publication.activeIntents.values()]
        .sort((a, b) => a.intentId - b.intentId)
        .map(({ intentId, preview, inverseDelta }) =>
          Object.freeze({
            intentId,
            preview,
            inversePreview: inverseDelta,
          }),
        ),
    );
    for (const listener of this.previewArtifactListeners) {
      try {
        listener(artifacts);
      } catch (error) {
        this.reportAuxiliaryError(error);
      }
    }

    // Selection, visibility, navigation, and overlay retention are explicitly
    // non-authoritative. Resolve their logical handles only after the core
    // model is installed, invoke the layer once, and never unwind adoption.
    applySpatialSkeletonPreviewUiHintsAfterAdoption({
      port: this.options.uiHints,
      hints: options.uiHints,
      mappings: this.mappingsValue,
      fallbackMappings: options.fallbackUiHintMappings,
      nodeIdRemappings: options.nodeIdRemappings,
      segmentIdRemappings: options.segmentIdRemappings,
      createResolutionError: (resource, stableId) =>
        new SpatialSkeletonEditPreviewError(
          `UI hint references unresolved logical ${resource} ${stableId}.`,
        ),
      reportError: (error) => this.reportAuxiliaryError(error),
    });
  }

  private reportAuxiliaryError(error: unknown) {
    try {
      this.options.onAuxiliaryError?.(error);
    } catch {
      // Reporting is best effort and cannot turn an adopted publication into
      // a failed one.
    }
  }

  private reconcileMappingOverlays(
    mappings: SpatialSkeletonStableIdHandles<bigint, bigint>,
    active: ReadonlyMap<number, IntentPreview>,
  ) {
    const desired = new Set(
      [...active.values()]
        .filter(({ preview }) => hasBindings(preview.provisionalBindings))
        .map(({ intentId }) => intentId),
    );
    for (const overlay of mappings.cloneSnapshot().overlays) {
      if (desired.has(overlay.sequence)) continue;
      mappings.rollback({
        sequence: overlay.sequence,
        tokenRevision: overlay.tokenRevision,
      });
    }
    const existingSnapshots = new Map(
      mappings
        .cloneSnapshot()
        .overlays.map((overlay) => [overlay.sequence, overlay]),
    );
    for (const { intentId, preview } of [...active.values()].sort(
      (a, b) => a.intentId - b.intentId,
    )) {
      if (!hasBindings(preview.provisionalBindings)) {
        continue;
      }
      validateNumericBindings(
        preview.provisionalBindings,
        `Preview intent ${intentId}`,
      );
      const existing = existingSnapshots.get(intentId);
      if (existing !== undefined) {
        if (
          !bindingEntriesEqual(
            existing.nodes,
            preview.provisionalBindings?.nodes,
          ) ||
          !bindingEntriesEqual(
            existing.segments,
            preview.provisionalBindings?.segments,
          )
        ) {
          throw new SpatialSkeletonEditPreviewError(
            `Preview intent ${intentId} changed its immutable provisional bindings.`,
          );
        }
        continue;
      }
      mappings.stage(intentId, preview.provisionalBindings!);
    }
  }

  private prepareInspectionSeed(
    seed: SpatialSkeletonPreviewInspectionSeed | undefined,
  ) {
    const mappings = this.mappingsValue.clone();
    let retainedHistoryWorkspace = this.retainedHistoryWorkspaceValue;
    if (seed === undefined) return { mappings, retainedHistoryWorkspace };

    validateNumericBindings(
      seed.authoritativeBindings,
      "A retained spatial skeleton inspection",
    );
    for (const [segmentId, expectedRevision] of seed.expectedCacheRevisions) {
      if (segmentId === 0n) {
        throw new SpatialSkeletonEditValidationError(
          `A retained inspection has invalid segment id ${segmentId}.`,
        );
      }
      const actualRevision = this.target.getCachedSegmentRevision(segmentId);
      const alreadyOwnedSegment =
        ownsPhysicalSpatialSkeletonSegment(
          this.retainedHistoryWorkspaceValue,
          this.mappingsValue,
          segmentId,
        ) ||
        ownsPhysicalSpatialSkeletonSegment(
          this.previewedWorkspaceValue,
          this.mappingsValue,
          segmentId,
        );
      if (actualRevision !== expectedRevision && !alreadyOwnedSegment) {
        throw new SpatialSkeletonPreviewPublicationFenceError(
          segmentId,
          expectedRevision,
          actualRevision,
        );
      }
    }

    const applyOnlyUnbound = <
      THandle extends
        | SpatialSkeletonStableNodeHandle
        | SpatialSkeletonStableSegmentHandle,
    >(
      bindings: readonly (readonly [THandle, bigint])[] | undefined,
      resolve: (handle: THandle) => bigint | undefined,
    ) => {
      const result: (readonly [THandle, bigint])[] = [];
      for (const [handle, physicalId] of bindings ?? []) {
        const current = resolve(handle);
        if (current !== undefined && current !== physicalId) {
          throw new SpatialSkeletonEditValidationError(
            `Retained inspection identity ${handle.stableId} changed from ${current} to ${physicalId}.`,
          );
        }
        if (current === undefined) result.push([handle, physicalId]);
      }
      return result;
    };
    mappings.apply({
      nodes: applyOnlyUnbound(seed.authoritativeBindings.nodes, (handle) =>
        mappings.resolveNode(handle),
      ),
      segments: applyOnlyUnbound(
        seed.authoritativeBindings.segments,
        (handle) => mappings.resolveSegment(handle),
      ),
    });

    const additions: SpatialSkeletonEditSegmentSnapshot[] = [];
    const previewedPhysicalSegments = materializeCompleteSkeletonSet(
      this.previewedWorkspaceValue,
      mappings,
    );
    for (const retained of seed.segments) {
      if (
        retainedHistoryWorkspace.resolveSegment(retained.segment, mappings) !==
          undefined ||
        this.previewedWorkspaceValue.resolveSegment(
          retained.segment,
          mappings,
        ) !== undefined
      ) {
        continue;
      }
      const segmentId = mappings.resolveSegment(retained.segment);
      if (segmentId === undefined) {
        throw new SpatialSkeletonEditValidationError(
          `Retained inspection segment ${retained.segment.stableId} has no authoritative binding.`,
        );
      }
      if (previewedPhysicalSegments.has(segmentId)) continue;
      if (!seed.expectedCacheRevisions.has(segmentId)) {
        throw new SpatialSkeletonEditValidationError(
          `Retained inspection segment ${segmentId} has no cache revision fence.`,
        );
      }
      additions.push(retained);
    }
    if (additions.length !== 0) {
      retainedHistoryWorkspace = new CompleteSkeletonSet([
        ...retainedHistoryWorkspace.segments,
        ...additions,
      ]);
    }
    return { mappings, retainedHistoryWorkspace };
  }

  /** Retires authority without deleting a later intent's provisional overlay. */
  private retireAuthoritativeBinding(
    mappings: SpatialSkeletonStableIdHandles<bigint, bigint>,
    resource: SpatialSkeletonStableResourceHandle,
  ) {
    const snapshot = mappings.cloneSnapshot();
    // A later Undo may already overlay a replacement. Retire only the confirmed
    // physical id, leaving that provisional identity and its preview intact.
    const retiredSegmentId =
      resource.kind === "segment"
        ? snapshot.baselineSegments.find(
            ([stableId]) => stableId === resource.stableId,
          )?.[1]
        : undefined;
    mappings.restoreSnapshot({
      ...snapshot,
      baselineNodes:
        resource.kind === "node"
          ? snapshot.baselineNodes.filter(
              ([stableId]) => stableId !== resource.stableId,
            )
          : snapshot.baselineNodes,
      baselineSegments:
        resource.kind === "segment"
          ? snapshot.baselineSegments.filter(
              ([stableId]) => stableId !== resource.stableId,
            )
          : snapshot.baselineSegments,
    });
    return retiredSegmentId;
  }
}
