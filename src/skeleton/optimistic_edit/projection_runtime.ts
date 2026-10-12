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

import type { CompleteSkeletonSnapshotHandle } from "#src/skeleton/complete_skeleton_snapshot.js";
import {
  SpatialSkeletonLogicalHandleMappings,
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
  type SpatialSkeletonLogicalHandleMappingToken,
  type SpatialSkeletonLogicalHandleMappingUpdate,
  type SpatialSkeletonLogicalNodeHandle,
  type SpatialSkeletonLogicalResourceHandle,
  type SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import type {
  SpatialSkeletonAuthoritativePublication,
  SpatialSkeletonOptimisticProjectionPort,
  SpatialSkeletonProjectionArtifactsListener,
  SpatialSkeletonProjectionIntentArtifact,
  SpatialSkeletonProjectionRollbackReplayRequest,
} from "#src/skeleton/optimistic_edit/ports.js";
import {
  applySpatialSkeletonProjectionUiHintsAfterAdoption,
  cloneSpatialSkeletonProjectionUiHints,
  mergeSpatialSkeletonProjectionUiHints,
  type SpatialSkeletonProjectionUiHintPort,
  type SpatialSkeletonProjectionUiHints,
} from "#src/skeleton/optimistic_edit/projection_ui_hints.js";
import {
  materializePhysicalSpatialSkeletonWorkspace,
  ownsPhysicalSpatialSkeletonSegment,
  remapSpatialSkeletonProjectionWorkspace,
} from "#src/skeleton/optimistic_edit/projection_workspace.js";
import type {
  SpatialSkeletonPreparedProjectionStatePublication,
  SpatialSkeletonProjectionStatePublicationRequest,
  SpatialSkeletonPresentationLogicalOwner,
  SpatialSkeletonPresentationNumericAlias,
} from "#src/skeleton/spatial_skeleton_manager.js";
import {
  applySpatialSkeletonProjectionDelta,
  SpatialSkeletonProjectionValidationError,
  SpatialSkeletonProjectionWorkspace,
  type SpatialSkeletonProjectionDelta,
  type SpatialSkeletonProjectionInverseDelta,
  type SpatialSkeletonProjectionSegmentSnapshot,
  type SpatialSkeletonProjectionSnapshotHandleSource,
} from "#src/skeleton/spatial_skeleton_projection_reducer.js";

export type {
  SpatialSkeletonProjectionSelectionPin,
  SpatialSkeletonProjectionUiHintPort,
  SpatialSkeletonProjectionUiHints,
  SpatialSkeletonResolvedProjectionUiHints,
} from "#src/skeleton/optimistic_edit/projection_ui_hints.js";

/**
 * Structural state boundary needed for one immutable projection adoption.
 * `SpatialSkeletonState` implements this interface; keeping it structural
 * makes the projection runtime independently testable and datasource-free.
 */
export interface SpatialSkeletonProjectionPublicationTarget
  extends SpatialSkeletonProjectionSnapshotHandleSource {
  runSpatialSkeletonPresentationTransaction<T>(
    callback: () => T,
    reportNotificationError?: (error: unknown) => void,
  ): T;
  prepareSpatialSkeletonProjectionStatePublication(
    request: SpatialSkeletonProjectionStatePublicationRequest,
  ): SpatialSkeletonPreparedProjectionStatePublication | undefined;
  adoptPreparedSpatialSkeletonProjectionStatePublication(
    publication: SpatialSkeletonPreparedProjectionStatePublication,
  ): { readonly cacheRevisions: ReadonlyMap<number, number> } | undefined;
  finalizePreparedSpatialSkeletonProjectionStatePublication(
    publication: SpatialSkeletonPreparedProjectionStatePublication,
    reportError?: (error: unknown) => void,
  ): void;
}

/** Retained complete inspection used to seed a cold state-owned runtime. */
export interface SpatialSkeletonProjectionInspectionSeed {
  readonly segments: readonly SpatialSkeletonProjectionSegmentSnapshot[];
  readonly authoritativeBindings: SpatialSkeletonLogicalHandleMappingUpdate<
    number,
    number
  >;
  readonly expectedCacheRevisions: ReadonlyMap<number, number>;
}

/** Generic exact-preview input produced from retained inspected command data. */
export interface SpatialSkeletonProjectionIntentDelta {
  readonly delta: SpatialSkeletonProjectionDelta;
  /**
   * Complete snapshots retained by pre-admission inspection. Existing
   * confirmed segments are never replaced with projected cache snapshots;
   * this seed only fills a cold/disjoint part of the baseline.
   */
  readonly inspectionSeed?: SpatialSkeletonProjectionInspectionSeed;
  /** Numeric identities that exist only until authority returns its bindings. */
  readonly provisionalBindings?: SpatialSkeletonLogicalHandleMappingUpdate<
    number,
    number
  >;
  /** Applied once, after the exact model preview has been adopted. */
  readonly uiHints?: SpatialSkeletonProjectionUiHints;
  /** Applied after this preview is rejected/canceled and survivors refold. */
  readonly rollbackUiHints?: SpatialSkeletonProjectionUiHints;
  /** Defaults to the engine intent id. */
  readonly preparationIntentId?: number;
}

/**
 * Datasource-neutral facts returned by authority. Datasource workflow state,
 * request payloads, and lifecycle data deliberately do not belong here.
 */
export interface SpatialSkeletonAuthoritativeReconciliation {
  readonly bindings?: SpatialSkeletonLogicalHandleMappingUpdate<number, number>;
  readonly retiredResources?: readonly SpatialSkeletonLogicalResourceHandle[];
  /** Deleted physical IDs; their logical handles may remain bound for Undo. */
  readonly retiredSegmentIds?: readonly number[];
  /**
   * Rare authoritative replacement for the preview delta. The runtime applies
   * exactly one delta to the pre-commit baseline so the resulting canonical
   * forward and inverse recipes remain a truthful Undo/Redo pair.
   */
  readonly finalizedProjectionDelta?: SpatialSkeletonProjectionDelta;
  /** Rare authority-specific presentation correction; numeric remaps are automatic. */
  readonly uiHints?: SpatialSkeletonProjectionUiHints;
}

/**
 * A complete ordinary datasource read that may replace part of the confirmed
 * baseline.  Reads use physical ids at this boundary because they are issued
 * by the shared state cache, not by a datasource workflow.
 */
export interface SpatialSkeletonAuthoritativeReadSnapshot {
  readonly segmentId: number;
  readonly snapshot: CompleteSkeletonSnapshotHandle | undefined;
}

export interface SpatialSkeletonAuthoritativeReadPublicationOptions {
  /** Cache revisions captured when the underlying GET began. */
  readonly expectedCacheRevisions: ReadonlyMap<number, number>;
  readonly notify?: boolean;
}

export interface SpatialSkeletonPreparedProjectionPublication {
  readonly generation: number;
  readonly cacheChanges: readonly (readonly [
    number,
    CompleteSkeletonSnapshotHandle | undefined,
  ])[];
  readonly expectedCacheRevisions: ReadonlyMap<number, number>;
  readonly activeLogicalOwners: readonly SpatialSkeletonPresentationLogicalOwner[];
  readonly numericAliases: readonly SpatialSkeletonPresentationNumericAlias[];
  readonly provisionalNodeIds: readonly number[];
  readonly preparationIntentIdsToRemove: readonly number[];
  readonly notify: boolean;
}

export class SpatialSkeletonProjectionPublicationFenceError extends Error {
  constructor(
    readonly segmentId: number,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Spatial skeleton projection for segment ${segmentId} was prepared at cache revision ${expectedRevision}, but revision ${actualRevision} is current.`,
    );
    this.name = "SpatialSkeletonProjectionPublicationFenceError";
  }
}

export class SpatialSkeletonProjectionRuntimeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialSkeletonProjectionRuntimeStateError";
  }
}

export interface SpatialSkeletonProjectionRuntimeOptions {
  readonly retainedHistoryWorkspace?: SpatialSkeletonProjectionWorkspace;
  readonly mappings?: SpatialSkeletonLogicalHandleMappings<number, number>;
  readonly uiHints?: SpatialSkeletonProjectionUiHintPort;
  readonly onAuxiliaryError?: (error: unknown) => void;
}

interface RuntimeIntentProjection {
  readonly intentId: number;
  readonly projection: SpatialSkeletonProjectionIntentDelta;
  readonly mappingToken?: SpatialSkeletonLogicalHandleMappingToken;
  readonly inverseDelta: SpatialSkeletonProjectionInverseDelta;
}

interface PreparedRuntimePublication {
  /** Revision of the live identity map from which this candidate was derived. */
  readonly expectedMappingRevision: number;
  readonly publicValue: SpatialSkeletonPreparedProjectionPublication;
  readonly mappings: SpatialSkeletonLogicalHandleMappings<number, number>;
  readonly activeIntents: Map<number, RuntimeIntentProjection>;
  readonly retainedHistoryWorkspace: SpatialSkeletonProjectionWorkspace;
  readonly projectedWorkspace: SpatialSkeletonProjectionWorkspace;
  readonly statePublication: SpatialSkeletonPreparedProjectionStatePublication;
  readonly publishedCacheRevisions: Map<number, number>;
}

function cloneBindings(
  update: SpatialSkeletonLogicalHandleMappingUpdate<number, number> | undefined,
): SpatialSkeletonLogicalHandleMappingUpdate<number, number> | undefined {
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
  update: SpatialSkeletonLogicalHandleMappingUpdate<number, number> | undefined,
) {
  return (
    (update?.nodes?.length ?? 0) !== 0 || (update?.segments?.length ?? 0) !== 0
  );
}

function validateNumericBindings(
  update: SpatialSkeletonLogicalHandleMappingUpdate<number, number> | undefined,
  context: string,
) {
  for (const [, physicalId] of [
    ...(update?.nodes ?? []),
    ...(update?.segments ?? []),
  ]) {
    if (!Number.isSafeInteger(physicalId) || physicalId <= 0) {
      throw new SpatialSkeletonProjectionValidationError(
        `${context} requires positive numeric ids; received ${physicalId}.`,
      );
    }
  }
}

function bindingEntriesEqual(
  actual: readonly (readonly [string, number])[],
  expected:
    | readonly (readonly [
        SpatialSkeletonLogicalNodeHandle | SpatialSkeletonLogicalSegmentHandle,
        number,
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

function normalizeProjection(
  projection: SpatialSkeletonProjectionIntentDelta,
): SpatialSkeletonProjectionIntentDelta {
  const inspectionSeed =
    projection.inspectionSeed === undefined
      ? undefined
      : Object.freeze({
          segments: Object.freeze(
            projection.inspectionSeed.segments.map(({ segment, snapshot }) =>
              Object.freeze({
                segment: Object.freeze({ ...segment }),
                snapshot,
              }),
            ),
          ),
          authoritativeBindings: cloneBindings(
            projection.inspectionSeed.authoritativeBindings,
          )!,
          expectedCacheRevisions: new Map(
            projection.inspectionSeed.expectedCacheRevisions,
          ),
        });
  return Object.freeze({
    delta: projection.delta,
    ...(inspectionSeed === undefined ? {} : { inspectionSeed }),
    ...(projection.provisionalBindings === undefined
      ? {}
      : { provisionalBindings: cloneBindings(projection.provisionalBindings) }),
    ...(projection.uiHints === undefined
      ? {}
      : {
          uiHints: cloneSpatialSkeletonProjectionUiHints(projection.uiHints),
        }),
    ...(projection.rollbackUiHints === undefined
      ? {}
      : {
          rollbackUiHints: cloneSpatialSkeletonProjectionUiHints(
            projection.rollbackUiHints,
          ),
        }),
    ...(projection.preparationIntentId === undefined
      ? {}
      : {
          preparationIntentId: projection.preparationIntentId,
        }),
  });
}

function sortedArtifacts<TInverse>(
  artifacts: readonly SpatialSkeletonProjectionIntentArtifact<
    SpatialSkeletonProjectionIntentDelta,
    TInverse
  >[],
) {
  return [...artifacts].sort((a, b) => a.intentId - b.intentId);
}

function getProjectionSegmentHandles(
  delta: SpatialSkeletonProjectionDelta,
): readonly SpatialSkeletonLogicalSegmentHandle[] {
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
  workspace: SpatialSkeletonProjectionWorkspace,
  handles: Iterable<SpatialSkeletonLogicalSegmentHandle>,
) {
  const keys = new Set([...handles].map(({ stableId }) => stableId));
  return new SpatialSkeletonProjectionWorkspace(
    workspace.segments.filter(({ segment }) => keys.has(segment.stableId)),
  );
}

/**
 * Generic owner of the retained-history + active-intent projection equation:
 *
 *   touched slices of retained history + ordered active deltas + identities
 *     = active projected workspace
 *
 * No datasource code or request state is retained here.
 */
export class SpatialSkeletonOptimisticProjectionRuntime
  implements
    SpatialSkeletonOptimisticProjectionPort<
      SpatialSkeletonProjectionIntentDelta,
      SpatialSkeletonAuthoritativeReconciliation,
      SpatialSkeletonProjectionInverseDelta
    >
{
  private mappingsValue: SpatialSkeletonLogicalHandleMappings<number, number>;
  private retainedHistoryWorkspaceValue: SpatialSkeletonProjectionWorkspace;
  private projectedWorkspaceValue: SpatialSkeletonProjectionWorkspace;
  private retainedHistorySegmentKeys = new Set<string>();
  private activeIntents = new Map<number, RuntimeIntentProjection>();
  private publishedCacheRevisions = new Map<number, number>();
  private preparedExact = new Map<
    number,
    {
      readonly projection: SpatialSkeletonProjectionIntentDelta;
      readonly inverseProjection: SpatialSkeletonProjectionInverseDelta;
      readonly publication: PreparedRuntimePublication;
    }
  >();
  private generationValue = 0;
  private readonly physicalNodeHandles = new Map<
    number,
    SpatialSkeletonLogicalNodeHandle
  >();
  private readonly physicalSegmentHandles = new Map<
    number,
    SpatialSkeletonLogicalSegmentHandle
  >();
  private readonly projectionArtifactListeners = new Set<
    SpatialSkeletonProjectionArtifactsListener<
      SpatialSkeletonProjectionIntentDelta,
      SpatialSkeletonProjectionInverseDelta
    >
  >();

  constructor(
    private readonly target: SpatialSkeletonProjectionPublicationTarget,
    private readonly options: SpatialSkeletonProjectionRuntimeOptions = {},
  ) {
    this.mappingsValue = (
      options.mappings ??
      new SpatialSkeletonLogicalHandleMappings<number, number>()
    ).clone();
    this.retainedHistoryWorkspaceValue =
      options.retainedHistoryWorkspace ??
      new SpatialSkeletonProjectionWorkspace([]);
    this.projectedWorkspaceValue = new SpatialSkeletonProjectionWorkspace([]);
  }

  get generation() {
    return this.generationValue;
  }

  get retainedHistoryWorkspace() {
    return this.retainedHistoryWorkspaceValue;
  }

  get projectedWorkspace() {
    return this.projectedWorkspaceValue;
  }

  get mappingRevision() {
    return this.mappingsValue.revision;
  }

  subscribeProjectionArtifacts(
    listener: SpatialSkeletonProjectionArtifactsListener<
      SpatialSkeletonProjectionIntentDelta,
      SpatialSkeletonProjectionInverseDelta
    >,
  ) {
    this.projectionArtifactListeners.add(listener);
    return () => this.projectionArtifactListeners.delete(listener);
  }

  resolveNode(handle: SpatialSkeletonLogicalNodeHandle) {
    return this.mappingsValue.resolveNode(handle);
  }

  getOrCreateNodeHandle(nodeId: number) {
    return this.getOrCreateNodeHandles([nodeId]).get(nodeId)!;
  }

  getOrCreateNodeHandles(nodeIds: readonly number[]) {
    const uniqueNodeIds: number[] = [];
    const requestedNodeIds = new Set<number>();
    // Validate the complete request before allocating or binding anything so
    // callers never observe a partially-applied batch.
    for (const nodeId of nodeIds) {
      if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
        throw new RangeError(
          `A spatial skeleton node identity requires a positive numeric id; received ${nodeId}.`,
        );
      }
      if (requestedNodeIds.has(nodeId)) continue;
      requestedNodeIds.add(nodeId);
      uniqueNodeIds.push(nodeId);
    }

    const result = new Map<number, SpatialSkeletonLogicalNodeHandle>();
    const unresolvedNodeIds: number[] = [];
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
      readonly [SpatialSkeletonLogicalNodeHandle, number]
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

  getOrCreateSegmentHandle(segmentId: number) {
    if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
      throw new RangeError(
        `A spatial skeleton segment identity requires a positive numeric id; received ${segmentId}.`,
      );
    }
    const retainedOwner =
      this.projectedWorkspaceValue.segments.find(
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

  resolveSegment(handle: SpatialSkeletonLogicalSegmentHandle) {
    return this.mappingsValue.resolveSegment(handle);
  }

  resolveAuthoritativeNode(handle: SpatialSkeletonLogicalNodeHandle) {
    return this.mappingsValue.resolveAuthoritativeNode(handle);
  }

  resolveAuthoritativeSegment(handle: SpatialSkeletonLogicalSegmentHandle) {
    return this.mappingsValue.resolveAuthoritativeSegment(handle);
  }

  resolveNodeTarget(handle: SpatialSkeletonLogicalNodeHandle) {
    return this.mappingsValue.resolveNodeTarget(handle);
  }

  resolveSegmentTarget(handle: SpatialSkeletonLogicalSegmentHandle) {
    return this.mappingsValue.resolveSegmentTarget(handle);
  }

  getProtectedSegmentIds() {
    return Object.freeze([
      ...materializePhysicalSpatialSkeletonWorkspace(
        this.projectedWorkspaceValue,
        this.mappingsValue,
      ).keys(),
    ]);
  }

  ownsAuthoritativeReadSegment(segmentId: number) {
    return (
      this.retainedHistoryWorkspaceValue.segments.some(
        ({ segment }) =>
          this.mappingsValue.resolveAuthoritativeSegment(segment) === segmentId,
      ) ||
      ownsPhysicalSpatialSkeletonSegment(
        this.projectedWorkspaceValue,
        this.mappingsValue,
        segmentId,
      )
    );
  }

  setRetainedHistoryProjections(
    projections: readonly SpatialSkeletonProjectionIntentDelta[],
  ) {
    const nextKeys = new Set(
      projections.flatMap(({ delta }) =>
        getProjectionSegmentHandles(delta).map(({ stableId }) => stableId),
      ),
    );
    // Active projection state is the other explicit owner of baseline slices.
    // A bounded history replay may evict an old entry while its authority
    // request is still unresolved; never let that history compaction prune the
    // baseline which the active delta still needs for refold or rollback.
    for (const { projection } of this.activeIntents.values()) {
      for (const { stableId } of getProjectionSegmentHandles(
        projection.delta,
      )) {
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
    this.retainedHistoryWorkspaceValue = new SpatialSkeletonProjectionWorkspace(
      this.retainedHistoryWorkspaceValue.segments.filter(({ segment }) =>
        nextKeys.has(segment.stableId),
      ),
    );
    const ownedSegmentIds = new Set([
      ...materializePhysicalSpatialSkeletonWorkspace(
        this.projectedWorkspaceValue,
        this.mappingsValue,
      ).keys(),
      ...materializePhysicalSpatialSkeletonWorkspace(
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

  prepareExact(
    intentId: number,
    projection: SpatialSkeletonProjectionIntentDelta,
  ) {
    if (this.activeIntents.has(intentId) || this.preparedExact.has(intentId)) {
      throw new SpatialSkeletonProjectionRuntimeStateError(
        `Projection intent ${intentId} has already been prepared or adopted.`,
      );
    }
    const normalized = normalizeProjection(projection);
    const seeded = this.prepareInspectionSeed(normalized.inspectionSeed);
    const active = new Map(this.activeIntents);
    active.set(intentId, {
      intentId,
      projection: normalized,
      inverseDelta: normalized.delta,
    });
    const publication = this.preparePublication({
      activeIntents: active,
      mappings: seeded.mappings,
      retainedHistoryWorkspace: seeded.retainedHistoryWorkspace,
      acceptedCacheRevisions: normalized.inspectionSeed?.expectedCacheRevisions,
      preparationIntentIdsToRemove: [
        normalized.preparationIntentId ?? intentId,
      ],
    });
    const preparedRecord = publication.activeIntents.get(intentId)!;
    this.preparedExact.set(intentId, {
      projection: normalized,
      inverseProjection: preparedRecord.inverseDelta,
      publication,
    });
    return Object.freeze({
      projection: normalized,
      inverseProjection: preparedRecord.inverseDelta,
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

  publishExact(
    intentId: number,
    projection: SpatialSkeletonProjectionIntentDelta,
  ) {
    const pending = this.preparedExact.get(intentId);
    if (pending === undefined || pending.projection !== projection) {
      throw new SpatialSkeletonProjectionRuntimeStateError(
        `Projection intent ${intentId} was not published with its prepared artifact.`,
      );
    }
    let publication = pending.publication;
    if (
      publication.publicValue.generation !== this.generationValue ||
      publication.expectedMappingRevision !== this.mappingsValue.revision
    ) {
      const seeded = this.prepareInspectionSeed(projection.inspectionSeed);
      const active = new Map(this.activeIntents);
      active.set(intentId, {
        intentId,
        projection,
        inverseDelta: pending.inverseProjection,
      });
      publication = this.preparePublication({
        activeIntents: active,
        mappings: seeded.mappings,
        retainedHistoryWorkspace: seeded.retainedHistoryWorkspace,
        acceptedCacheRevisions:
          projection.inspectionSeed?.expectedCacheRevisions,
        preparationIntentIdsToRemove: [
          projection.preparationIntentId ?? intentId,
        ],
      });
    }
    this.adoptPublication(publication, {
      uiHints: projection.uiHints,
    });
    this.preparedExact.delete(intentId);
  }

  rollbackAndReplay(
    request: SpatialSkeletonProjectionRollbackReplayRequest<
      SpatialSkeletonProjectionIntentDelta,
      SpatialSkeletonProjectionInverseDelta
    >,
  ) {
    const active = new Map(this.activeIntents);
    const removedIntents: RuntimeIntentProjection[] = [];
    for (const artifact of request.rollbackIntents) {
      const intentId = artifact.intentId;
      const removed = active.get(intentId);
      if (removed !== undefined) {
        removedIntents.push(removed);
        active.delete(intentId);
      }
      this.preparedExact.delete(intentId);
    }
    let replayChanged = false;
    for (const artifact of sortedArtifacts(request.replayIntents)) {
      const intentId = artifact.intentId;
      const existing = active.get(intentId);
      if (existing?.projection === artifact.projection) continue;
      replayChanged = true;
      active.set(intentId, {
        intentId,
        projection: normalizeProjection(artifact.projection),
        inverseDelta: artifact.inverseProjection,
      });
    }
    if (removedIntents.length === 0 && !replayChanged) return;
    const rollbackIds = removedIntents.map(({ intentId }) => intentId);
    const restoredHistorySegmentIds = new Set<number>();
    for (const { projection } of removedIntents) {
      for (const handle of getProjectionSegmentHandles(projection.delta)) {
        const segmentId =
          this.mappingsValue.resolveAuthoritativeSegment(handle);
        if (segmentId !== undefined) restoredHistorySegmentIds.add(segmentId);
      }
    }
    const publication = this.preparePublication({
      activeIntents: active,
      publishHistorySegmentIds: [...restoredHistorySegmentIds],
      preparationIntentIdsToRemove: rollbackIds,
    });
    const rollbackUiHints = mergeSpatialSkeletonProjectionUiHints(
      removedIntents
        .sort((a, b) => b.intentId - a.intentId)
        .map(({ projection }) => projection.rollbackUiHints),
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
      SpatialSkeletonProjectionIntentDelta,
      SpatialSkeletonAuthoritativeReconciliation,
      SpatialSkeletonProjectionInverseDelta
    >,
  ) {
    const intentId = publication.intentId;
    const committed = this.activeIntents.get(intentId);
    if (committed === undefined) {
      throw new SpatialSkeletonProjectionRuntimeStateError(
        `Cannot reconcile projection intent ${intentId} because it is not active.`,
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
      publication.reconciliation.finalizedProjectionDelta ??
      committed.projection.delta;
    const finalizedProjection =
      finalizedDelta === committed.projection.delta
        ? committed.projection
        : Object.freeze({ ...committed.projection, delta: finalizedDelta });
    const promoted = applySpatialSkeletonProjectionDelta(
      nextBaseline,
      finalizedDelta,
      preBindingMappings,
    );
    nextBaseline = promoted.projection;
    const finalizedInverse = promoted.inverseDelta;
    const finalizedArtifact = Object.freeze({
      intentId,
      projection: finalizedProjection,
      inverseProjection: finalizedInverse,
    });

    const mappings = this.mappingsValue.clone();
    const nodeRemappings = new Map<number, number>();
    const segmentRemappings = new Map<number, number>();
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
      throw new SpatialSkeletonProjectionRuntimeStateError(
        `Projection intent ${intentId} lost its provisional identity overlay.`,
      );
    }

    nextBaseline = remapSpatialSkeletonProjectionWorkspace(
      nextBaseline,
      nodeRemappings,
      segmentRemappings,
    );

    const active = new Map<number, RuntimeIntentProjection>();
    for (const artifact of sortedArtifacts(publication.activePreviews)) {
      active.set(artifact.intentId, {
        intentId: artifact.intentId,
        projection: normalizeProjection(artifact.projection),
        inverseDelta: artifact.inverseProjection,
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
        ...materializePhysicalSpatialSkeletonWorkspace(
          selectWorkspaceSegments(
            nextBaseline,
            getProjectionSegmentHandles(finalizedDelta),
          ),
          mappings.clone(0),
        ).keys(),
      ],
      preparationIntentIdsToRemove: [intentId],
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
    for (const { segment } of this.projectedWorkspaceValue.segments) {
      if (prepared.projectedWorkspace.getSegment(segment) === undefined)
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
      number,
      SpatialSkeletonAuthoritativeReadSnapshot
    >();
    for (const { segmentId, snapshot } of snapshots) {
      if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
        throw new SpatialSkeletonProjectionValidationError(
          `An authoritative spatial skeleton read has invalid segment id ${segmentId}.`,
        );
      }
      if (bySegmentId.has(segmentId)) {
        throw new SpatialSkeletonProjectionValidationError(
          `An authoritative spatial skeleton read contains duplicate segment ${segmentId}.`,
        );
      }
      if (snapshot !== undefined) {
        for (const node of snapshot.materialize()) {
          if (!Number.isSafeInteger(node.nodeId) || node.nodeId <= 0) {
            throw new SpatialSkeletonProjectionValidationError(
              `Authoritative segment ${segmentId} contains invalid node id ${node.nodeId}.`,
            );
          }
          if (node.segmentId !== segmentId) {
            throw new SpatialSkeletonProjectionValidationError(
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
      readonly acceptedCacheRevisions: ReadonlyMap<number, number>;
      readonly notify?: boolean;
    },
  ) {
    const mappings = this.mappingsValue.clone();
    let retainedHistoryWorkspace = this.retainedHistoryWorkspaceValue;
    const baselineByPhysical = materializePhysicalSpatialSkeletonWorkspace(
      retainedHistoryWorkspace,
      mappings.clone(0),
    );
    const projectedByPhysical = materializePhysicalSpatialSkeletonWorkspace(
      this.projectedWorkspaceValue,
      mappings,
    );
    const changes: Array<{
      readonly segment: SpatialSkeletonLogicalSegmentHandle;
      readonly snapshot: CompleteSkeletonSnapshotHandle | undefined;
    }> = [];

    for (const { segmentId, snapshot } of snapshots) {
      const baselineEntry = baselineByPhysical.get(segmentId);
      const projectedEntry = projectedByPhysical.get(segmentId);
      if (
        baselineEntry === undefined &&
        projectedEntry !== undefined &&
        this.activeIntents.size !== 0
      ) {
        throw new SpatialSkeletonProjectionRuntimeStateError(
          `Cannot publish an ordinary read for active-only segment ${segmentId} before its creating intent settles.`,
        );
      }

      const segment =
        baselineEntry?.segment ??
        projectedEntry?.segment ??
        mappings.findSegments(segmentId).at(-1) ??
        this.createFreshAuthoritativeSegmentHandle(mappings, segmentId);
      if (mappings.resolveAuthoritativeSegment(segment) === undefined) {
        mappings.bindSegment(segment, segmentId);
      }
      if (mappings.resolveAuthoritativeSegment(segment) !== segmentId) {
        throw new SpatialSkeletonProjectionRuntimeStateError(
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
      preparationIntentIdsToRemove: [],
      acceptedCacheRevisions: options.acceptedCacheRevisions,
      notify: options.notify,
    });
    this.adoptPublication(prepared);
    // An ordinary read may already be represented by the exact immutable
    // handle selected for the candidate. In that case no cache replacement
    // (and therefore no cache revision increment) is needed, but the runtime
    // must still acknowledge the observed revision.
    const revisions = new Map(this.publishedCacheRevisions);
    for (const { segmentId } of snapshots) {
      revisions.set(segmentId, this.target.getCachedSegmentRevision(segmentId));
    }
    this.publishedCacheRevisions = revisions;
    return true;
  }

  private createFreshAuthoritativeSegmentHandle(
    mappings: SpatialSkeletonLogicalHandleMappings<number, number>,
    segmentId: number,
  ) {
    const base = `authority:${segmentId}`;
    for (let suffix = 0; ; ++suffix) {
      const handle = spatialSkeletonLogicalSegment(
        suffix === 0 ? base : `${base}:read:${suffix}`,
      );
      const current = mappings.resolveSegment(handle);
      if (current === undefined || current === segmentId) return handle;
    }
  }

  private createFreshAuthoritativeNodeHandle(
    mappings: SpatialSkeletonLogicalHandleMappings<number, number>,
    nodeId: number,
  ) {
    const base = `authority:${nodeId}`;
    for (let suffix = 0; ; ++suffix) {
      const handle = spatialSkeletonLogicalNode(
        suffix === 0 ? base : `${base}:read:${suffix}`,
      );
      const current = mappings.resolveNode(handle);
      if (current === undefined || current === nodeId) return handle;
    }
  }

  private preparePublication(options: {
    readonly activeIntents: ReadonlyMap<number, RuntimeIntentProjection>;
    readonly mappings?: SpatialSkeletonLogicalHandleMappings<number, number>;
    readonly retainedHistoryWorkspace?: SpatialSkeletonProjectionWorkspace;
    /** History snapshots that must be written during this adoption only. */
    readonly publishHistorySegmentIds?: readonly number[];
    /** Confirmed deletions must fence reads even when their preview is absent. */
    readonly retiredSegmentIds?: ReadonlySet<number>;
    readonly preparationIntentIdsToRemove: readonly number[];
    /** Revisions captured when an authoritative read began. */
    readonly acceptedCacheRevisions?: ReadonlyMap<number, number>;
    readonly notify?: boolean;
    readonly precedingArtifacts?: readonly SpatialSkeletonProjectionIntentArtifact<
      SpatialSkeletonProjectionIntentDelta,
      SpatialSkeletonProjectionInverseDelta
    >[];
    readonly rebaseActivePreview?: SpatialSkeletonAuthoritativePublication<
      SpatialSkeletonProjectionIntentDelta,
      SpatialSkeletonAuthoritativeReconciliation,
      SpatialSkeletonProjectionInverseDelta
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
    const activeSegmentHandles = ordered.flatMap(({ projection }) =>
      getProjectionSegmentHandles(projection.delta),
    );
    const activeBaseline = selectWorkspaceSegments(
      retainedHistoryWorkspace,
      activeSegmentHandles,
    );
    // Baseline snapshots contain confirmed ids. Replay then introduces each
    // provisional binding immediately before its delta, so a later Undo/Redo
    // cannot change how an earlier delta locates its input nodes or segments.
    const replayMappings = mappings.clone(0);
    const candidateBaselinePhysical =
      materializePhysicalSpatialSkeletonWorkspace(
        activeBaseline,
        replayMappings,
      );
    const historyPhysical = materializePhysicalSpatialSkeletonWorkspace(
      retainedHistoryWorkspace,
      replayMappings,
    );
    let projectedWorkspace = activeBaseline;
    const precedingArtifacts = [...(options.precedingArtifacts ?? [])];
    const reducedActive = new Map<number, RuntimeIntentProjection>();
    for (let input of ordered) {
      const rebased = options.rebaseActivePreview?.(
        input.intentId,
        precedingArtifacts,
      );
      if (rebased !== undefined) {
        input = { ...input, projection: normalizeProjection(rebased) };
        active.set(input.intentId, input);
        // A corrected inverse can restore the other side of a Merge. Replace
        // its provisional binding only in this off-screen candidate; normal
        // publications still reject changes to admitted bindings.
        const token = mappings.getOverlayToken(input.intentId);
        if (token !== undefined) mappings.rollback(token);
        this.reconcileMappingOverlays(mappings, active);
      }
      if (input.projection.provisionalBindings !== undefined) {
        replayMappings.stage(
          input.intentId,
          input.projection.provisionalBindings,
        );
      }
      const applied = applySpatialSkeletonProjectionDelta(
        projectedWorkspace,
        input.projection.delta,
        replayMappings,
      );
      projectedWorkspace = applied.projection;
      reducedActive.set(input.intentId, {
        ...input,
        mappingToken: mappings.getOverlayToken(input.intentId),
        inverseDelta: applied.inverseDelta,
      });
      precedingArtifacts.push({
        intentId: input.intentId,
        projection: input.projection,
        inverseProjection: applied.inverseDelta,
      });
    }

    const currentPhysical = materializePhysicalSpatialSkeletonWorkspace(
      this.projectedWorkspaceValue,
      this.mappingsValue,
    );
    const nextPhysical = materializePhysicalSpatialSkeletonWorkspace(
      projectedWorkspace,
      mappings,
    );
    const cacheChanges = new Map<
      number,
      CompleteSkeletonSnapshotHandle | undefined
    >();
    const publishHistorySegmentIds = new Set(
      options.publishHistorySegmentIds ?? [],
    );
    const retiredSegmentIds = options.retiredSegmentIds ?? new Set<number>();
    const candidateSegmentIds = new Set([
      ...retiredSegmentIds,
      ...currentPhysical.keys(),
      ...candidateBaselinePhysical.keys(),
      ...nextPhysical.keys(),
      ...publishHistorySegmentIds,
    ]);
    for (const segmentId of candidateSegmentIds) {
      const projected = nextPhysical.get(segmentId);
      // A surviving active delta which touched a baseline segment owns both
      // its presence and its absence. In particular, a dependent Merge may
      // consume a just-committed Add segment; publishing that new history
      // segment beside the merged result would duplicate every moved node.
      const removedByActiveProjection =
        projected === undefined && candidateBaselinePhysical.has(segmentId);
      const desired =
        projected?.snapshot ??
        (!removedByActiveProjection &&
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

    const expectedCacheRevisions = new Map<number, number>();
    for (const segmentId of cacheChanges.keys()) {
      const currentRevision = this.target.getCachedSegmentRevision(segmentId);
      const publishedRevision = this.publishedCacheRevisions.get(segmentId);
      const currentSnapshot =
        this.target.getCachedSegmentSnapshotHandle(segmentId)?.handle;
      // Cache eviction/invalidation is not an authoritative replacement. If
      // this runtime still owns an exact projected snapshot for the now-cold
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
        throw new SpatialSkeletonProjectionPublicationFenceError(
          segmentId,
          publishedRevision,
          currentRevision,
        );
      }
      expectedCacheRevisions.set(segmentId, currentRevision);
    }

    const activeLogicalOwners: SpatialSkeletonPresentationLogicalOwner[] = [];
    const numericAliases: SpatialSkeletonPresentationNumericAlias[] = [];
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
      activeLogicalOwners.push(
        Object.freeze({ segmentId, logicalHandle: segment }),
      );
      const target = mappings.resolveSegmentTarget(segment);
      numericAliases.push(
        Object.freeze({
          logicalHandle: segment,
          segmentId,
          authoritative: target.state === "authoritative",
        }),
      );
    }
    activeLogicalOwners.sort((a, b) => a.segmentId - b.segmentId);
    numericAliases.sort((a, b) =>
      a.logicalHandle.stableId.localeCompare(b.logicalHandle.stableId),
    );

    const provisionalNodeIds = new Set<number>();
    for (const overlay of mappings.cloneSnapshot().overlays) {
      for (const [, nodeId] of overlay.nodes) {
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
          throw new SpatialSkeletonProjectionValidationError(
            `A provisional node requires a positive numeric id; received ${nodeId}.`,
          );
        }
        provisionalNodeIds.add(nodeId);
      }
    }

    const preparationIntentIdsToRemove = Object.freeze([
      ...new Set(options.preparationIntentIdsToRemove),
    ]);
    const publicValue: SpatialSkeletonPreparedProjectionPublication =
      Object.freeze({
        generation: this.generationValue,
        cacheChanges: Object.freeze([...cacheChanges]),
        expectedCacheRevisions,
        activeLogicalOwners: Object.freeze(activeLogicalOwners),
        numericAliases: Object.freeze(numericAliases),
        provisionalNodeIds: Object.freeze(
          [...provisionalNodeIds].sort((a, b) => a - b),
        ),
        preparationIntentIdsToRemove,
        notify: options.notify ?? true,
      });

    const statePublication =
      this.target.prepareSpatialSkeletonProjectionStatePublication({
        snapshots: publicValue.cacheChanges,
        expectedRevisions: publicValue.expectedCacheRevisions,
        retiredSegmentIds,
        activeLogicalOwners: publicValue.activeLogicalOwners,
        numericAliases: publicValue.numericAliases,
        provisionalNodeIds: publicValue.provisionalNodeIds,
        preparationIntentIdsToRemove: publicValue.preparationIntentIdsToRemove,
        notify: publicValue.notify,
      });
    if (statePublication === undefined) {
      for (const [
        segmentId,
        expectedRevision,
      ] of publicValue.expectedCacheRevisions) {
        const actualRevision = this.target.getCachedSegmentRevision(segmentId);
        if (actualRevision !== expectedRevision) {
          throw new SpatialSkeletonProjectionPublicationFenceError(
            segmentId,
            expectedRevision,
            actualRevision,
          );
        }
      }
      throw new SpatialSkeletonProjectionRuntimeStateError(
        "Spatial skeleton presentation changed while its projection publication was being prepared.",
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
      projectedWorkspace,
      statePublication,
      publishedCacheRevisions,
    });
  }

  private adoptPublication(
    publication: PreparedRuntimePublication,
    options: {
      readonly uiHints?: SpatialSkeletonProjectionUiHints;
      readonly nodeIdRemappings?: ReadonlyMap<number, number>;
      readonly segmentIdRemappings?: ReadonlyMap<number, number>;
      readonly fallbackUiHintMappings?: SpatialSkeletonLogicalHandleMappings<
        number,
        number
      >;
    } = {},
  ) {
    if (publication.publicValue.generation !== this.generationValue) {
      throw new SpatialSkeletonProjectionRuntimeStateError(
        "A stale prepared spatial skeleton publication cannot be adopted.",
      );
    }
    if (publication.expectedMappingRevision !== this.mappingsValue.revision) {
      throw new SpatialSkeletonProjectionRuntimeStateError(
        "A spatial skeleton publication was prepared from stale logical identity mappings.",
      );
    }
    for (const [segmentId, expectedRevision] of publication.publicValue
      .expectedCacheRevisions) {
      const actualRevision = this.target.getCachedSegmentRevision(segmentId);
      if (actualRevision !== expectedRevision) {
        throw new SpatialSkeletonProjectionPublicationFenceError(
          segmentId,
          expectedRevision,
          actualRevision,
        );
      }
    }

    this.target.runSpatialSkeletonPresentationTransaction(
      () => {
        const adopted =
          this.target.adoptPreparedSpatialSkeletonProjectionStatePublication(
            publication.statePublication,
          );
        if (adopted === undefined) {
          throw new SpatialSkeletonProjectionRuntimeStateError(
            "A stale prepared spatial skeleton state publication cannot be adopted.",
          );
        }

        // Every state-facing collection and presentation value was prepared
        // off-screen. The target and runtime now install those references in the
        // same synchronous callback before any observer is notified.
        this.mappingsValue = publication.mappings;
        this.activeIntents = publication.activeIntents;
        this.retainedHistoryWorkspaceValue =
          publication.retainedHistoryWorkspace;
        this.projectedWorkspaceValue = publication.projectedWorkspace;
        ++this.generationValue;
        this.publishedCacheRevisions = publication.publishedCacheRevisions;
      },
      (error) => this.reportAuxiliaryError(error),
    );
    this.target.finalizePreparedSpatialSkeletonProjectionStatePublication(
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
        .map(({ intentId, projection, inverseDelta }) =>
          Object.freeze({
            intentId,
            projection,
            inverseProjection: inverseDelta,
          }),
        ),
    );
    for (const listener of this.projectionArtifactListeners) {
      try {
        listener(artifacts);
      } catch (error) {
        this.reportAuxiliaryError(error);
      }
    }

    // Selection, visibility, navigation, and overlay retention are explicitly
    // non-authoritative. Resolve their logical handles only after the core
    // model is installed, invoke the layer once, and never unwind adoption.
    applySpatialSkeletonProjectionUiHintsAfterAdoption({
      port: this.options.uiHints,
      hints: options.uiHints,
      mappings: this.mappingsValue,
      fallbackMappings: options.fallbackUiHintMappings,
      nodeIdRemappings: options.nodeIdRemappings,
      segmentIdRemappings: options.segmentIdRemappings,
      createResolutionError: (resource, stableId) =>
        new SpatialSkeletonProjectionRuntimeStateError(
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
    mappings: SpatialSkeletonLogicalHandleMappings<number, number>,
    active: ReadonlyMap<number, RuntimeIntentProjection>,
  ) {
    const desired = new Set(
      [...active.values()]
        .filter(({ projection }) => hasBindings(projection.provisionalBindings))
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
    for (const { intentId, projection } of [...active.values()].sort(
      (a, b) => a.intentId - b.intentId,
    )) {
      if (!hasBindings(projection.provisionalBindings)) {
        continue;
      }
      validateNumericBindings(
        projection.provisionalBindings,
        `Projection intent ${intentId}`,
      );
      const existing = existingSnapshots.get(intentId);
      if (existing !== undefined) {
        if (
          !bindingEntriesEqual(
            existing.nodes,
            projection.provisionalBindings?.nodes,
          ) ||
          !bindingEntriesEqual(
            existing.segments,
            projection.provisionalBindings?.segments,
          )
        ) {
          throw new SpatialSkeletonProjectionRuntimeStateError(
            `Projection intent ${intentId} changed its immutable provisional bindings.`,
          );
        }
        continue;
      }
      mappings.stage(intentId, projection.provisionalBindings!);
    }
  }

  private prepareInspectionSeed(
    seed: SpatialSkeletonProjectionInspectionSeed | undefined,
  ) {
    const mappings = this.mappingsValue.clone();
    let retainedHistoryWorkspace = this.retainedHistoryWorkspaceValue;
    if (seed === undefined) return { mappings, retainedHistoryWorkspace };

    validateNumericBindings(
      seed.authoritativeBindings,
      "A retained spatial skeleton inspection",
    );
    for (const [segmentId, expectedRevision] of seed.expectedCacheRevisions) {
      if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
        throw new SpatialSkeletonProjectionValidationError(
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
          this.projectedWorkspaceValue,
          this.mappingsValue,
          segmentId,
        );
      if (actualRevision !== expectedRevision && !alreadyOwnedSegment) {
        throw new SpatialSkeletonProjectionPublicationFenceError(
          segmentId,
          expectedRevision,
          actualRevision,
        );
      }
    }

    const applyOnlyUnbound = <
      THandle extends
        | SpatialSkeletonLogicalNodeHandle
        | SpatialSkeletonLogicalSegmentHandle,
    >(
      bindings: readonly (readonly [THandle, number])[] | undefined,
      resolve: (handle: THandle) => number | undefined,
    ) => {
      const result: (readonly [THandle, number])[] = [];
      for (const [handle, physicalId] of bindings ?? []) {
        const current = resolve(handle);
        if (current !== undefined && current !== physicalId) {
          throw new SpatialSkeletonProjectionValidationError(
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

    const additions: SpatialSkeletonProjectionSegmentSnapshot[] = [];
    const projectedPhysicalSegments =
      materializePhysicalSpatialSkeletonWorkspace(
        this.projectedWorkspaceValue,
        mappings,
      );
    for (const retained of seed.segments) {
      if (
        retainedHistoryWorkspace.resolveSegment(retained.segment, mappings) !==
          undefined ||
        this.projectedWorkspaceValue.resolveSegment(
          retained.segment,
          mappings,
        ) !== undefined
      ) {
        continue;
      }
      const segmentId = mappings.resolveSegment(retained.segment);
      if (segmentId === undefined) {
        throw new SpatialSkeletonProjectionValidationError(
          `Retained inspection segment ${retained.segment.stableId} has no authoritative binding.`,
        );
      }
      if (projectedPhysicalSegments.has(segmentId)) continue;
      if (!seed.expectedCacheRevisions.has(segmentId)) {
        throw new SpatialSkeletonProjectionValidationError(
          `Retained inspection segment ${segmentId} has no cache revision fence.`,
        );
      }
      additions.push(retained);
    }
    if (additions.length !== 0) {
      retainedHistoryWorkspace = new SpatialSkeletonProjectionWorkspace([
        ...retainedHistoryWorkspace.segments,
        ...additions,
      ]);
    }
    return { mappings, retainedHistoryWorkspace };
  }

  /** Retires authority without deleting a later intent's provisional overlay. */
  private retireAuthoritativeBinding(
    mappings: SpatialSkeletonLogicalHandleMappings<number, number>,
    resource: SpatialSkeletonLogicalResourceHandle,
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
