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

import type {
  EditableSpatiallyIndexedSkeletonSource,
  SpatialSkeletonConfidenceConfiguration,
  SpatiallyIndexedSkeletonNode,
  SpatiallyIndexedSkeletonSource,
} from "#src/skeleton/api.js";
import {
  getSpatialSkeletonEditCommandFactoryFromSource,
  getSpatialSkeletonEditCommandMetadata,
  isSpatialSkeletonEditCommandFactory,
  SPATIAL_SKELETON_EDIT_COMMAND_METADATA,
} from "#src/skeleton/command_factories.js";
import {
  createSpatialSkeletonOptimisticHistoryPort,
  SpatialSkeletonCommandHistory,
} from "#src/skeleton/command_history.js";
import {
  type SpatialSkeletonAction,
  type SpatialSkeletonEditCommand,
  type SpatialSkeletonQueueInput,
  type SpatialSkeletonQueueInputPreparation,
  type SpatialSkeletonQueueInputRequirement,
} from "#src/skeleton/command_protocol.js";
import {
  createCompleteSkeletonSnapshot,
  type CompleteSkeletonSnapshotHandle,
} from "#src/skeleton/complete_skeleton_snapshot.js";
import {
  SpatialSkeletonInspectionRequiredError,
  type SpatialSkeletonInspectionRequiredReason,
} from "#src/skeleton/edit_errors.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/frontend.js";
import type {
  SpatialSkeletonLogicalNodeHandle,
  SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import {
  assertSpatialSkeletonOptimisticDriverRegistration,
  isSpatialSkeletonOptimisticEditingProvider,
  SpatialSkeletonOptimisticDatasourceContractError,
  type SpatialSkeletonOptimisticEditingProvider,
  type SpatialSkeletonProvisionalNumericIdPolicy,
  type SpatialSkeletonProvisionalNumericIdService,
} from "#src/skeleton/optimistic_edit/api.js";
import { SpatialSkeletonOptimisticQueueEngine } from "#src/skeleton/optimistic_edit/engine.js";
import {
  freezeSpatialSkeletonOptimisticFatalState,
  SpatialSkeletonOptimisticReloadRequiredError,
  type SpatialSkeletonOptimisticFatalState,
} from "#src/skeleton/optimistic_edit/fatal.js";
import { unchangedSpatialSkeletonOptimisticEditSettlement } from "#src/skeleton/optimistic_edit/lifecycle.js";
import {
  SpatialSkeletonOptimisticProjectionRuntime,
  type SpatialSkeletonResolvedProjectionUiHints,
} from "#src/skeleton/optimistic_edit/projection_runtime.js";
import { SpatialSkeletonMutationAttemptScheduler } from "#src/skeleton/optimistic_edit/scheduler.js";
import {
  DEFAULT_SPATIAL_SKELETON_OPTIMISTIC_EDIT_QUEUE_CAPACITY,
  type SpatialSkeletonOptimisticEditActivityEntry,
  type SpatialSkeletonOptimisticEditExecution,
  type SpatialSkeletonOptimisticEditQueue,
  type SpatialSkeletonOptimisticEditQueueEntry,
  type SpatialSkeletonOptimisticEditState,
} from "#src/skeleton/optimistic_edit/types.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { PromiseConcurrencyLimiter } from "#src/util/promise_concurrency_limiter.js";

interface SpatialSkeletonSourceAccess {
  source: unknown;
}

export {
  type SpatialSkeletonOptimisticEditActivityEntry,
  type SpatialSkeletonOptimisticEditExecution,
  type SpatialSkeletonOptimisticEditQueue,
  type SpatialSkeletonOptimisticEditQueueEntry,
  type SpatialSkeletonOptimisticEditState,
} from "#src/skeleton/optimistic_edit/types.js";

function resolvedOptimisticEditExecution<T>(
  value: T,
): SpatialSkeletonOptimisticEditExecution<T> {
  const execution = Promise.resolve(value);
  Object.defineProperty(execution, "acceptedByQueue", {
    configurable: true,
    value: Promise.resolve(),
  });
  Object.defineProperty(execution, "settled", {
    configurable: true,
    value: Promise.resolve(
      unchangedSpatialSkeletonOptimisticEditSettlement("no-op"),
    ),
  });
  return execution as SpatialSkeletonOptimisticEditExecution<T>;
}

function rejectedOptimisticEditExecution<T>(
  error: unknown,
): SpatialSkeletonOptimisticEditExecution<T> {
  const execution = Promise.reject<T>(error);
  const acceptedByQueue = Promise.reject<void>(error);
  // These milestones are intentionally independent. Callers commonly await
  // just the result or just admission, so keep the unused branch observed.
  void execution.catch(() => undefined);
  void acceptedByQueue.catch(() => undefined);
  Object.defineProperty(execution, "acceptedByQueue", {
    configurable: true,
    value: acceptedByQueue,
  });
  Object.defineProperty(execution, "settled", {
    configurable: true,
    value: Promise.resolve(
      unchangedSpatialSkeletonOptimisticEditSettlement("not-started", error),
    ),
  });
  return execution as SpatialSkeletonOptimisticEditExecution<T>;
}

export type SpatialSkeletonPreparationKind =
  | "merge"
  | "split"
  | "delete"
  | "restore"
  | "reroot";

export type SpatialSkeletonPreparationDirection = "execute" | "undo" | "redo";

export type SpatialSkeletonPreparationLifecycle = "preparing";

/**
 * A position captured when a structural intent is admitted. Preparations use these
 * values only when the live node cache cannot resolve the corresponding node;
 * they are therefore truthful last-known locations, not invented topology.
 */
export interface SpatialSkeletonPreparationPosition {
  readonly nodeId: number;
  readonly position: Float32Array;
}

/**
 * Lightweight visual feedback for a structural intent whose exact topology is
 * not available yet.  Node-id lists describe only relationships the command
 * already knows: `endpointNodeIds` is the requested merge edge,
 * `cutParentNodeId` is the existing edge being cut, and `pathNodeIds` is an
 * optional known path (never inferred by the renderer).
 */
export interface SpatialSkeletonPreparationIntent {
  readonly intentId: number;
  readonly sequence: number;
  readonly direction: SpatialSkeletonPreparationDirection;
  readonly kind: SpatialSkeletonPreparationKind;
  readonly lifecycle: SpatialSkeletonPreparationLifecycle;
  readonly logicalNodeHandles?: readonly SpatialSkeletonLogicalNodeHandle[];
  readonly logicalSegmentHandles?: readonly SpatialSkeletonLogicalSegmentHandle[];
  readonly segmentIds: readonly number[];
  readonly nodeId?: number;
  readonly endpointNodeIds?: readonly number[];
  readonly cutNodeId?: number;
  readonly cutParentNodeId?: number;
  readonly rootNodeId?: number;
  readonly pathNodeIds?: readonly number[];
  readonly lastKnownPositions?: readonly SpatialSkeletonPreparationPosition[];
}

/**
 * A cloneable snapshot of a full cached segment.  `undefined` represents an
 * uncached segment, while an empty array represents a known empty segment.
 */
export type SpatialSkeletonCachedSegmentSnapshot =
  | readonly SpatiallyIndexedSkeletonNode[]
  | undefined;

/**
 * The immutable complete-skeleton handle currently represented by a cache
 * entry, paired with the manager revision at which it was published.
 *
 * `cacheRevision` fences asynchronous cache publication. The immutable handle
 * represents snapshot contents without a separate lineage counter.
 */
export interface SpatialSkeletonCachedSegmentSnapshotHandle {
  readonly handle: CompleteSkeletonSnapshotHandle;
  readonly cacheRevision: number;
}

/**
 * An edit's temporary reference to a complete cached skeleton snapshot.
 *
 * Its exact complete snapshot is retained against visual cache eviction.
 * Any explicit cache invalidation or replacement makes it stale; callers must
 * check `isCurrent` before exact-preview publication. `release` removes only this
 * reference's cache-retention registration and is idempotent.
 */
export interface SpatialSkeletonInputReference {
  readonly segmentId: number;
  readonly snapshot: SpatialSkeletonCachedSegmentSnapshotHandle;
  isCurrent(): boolean;
  release(): void;
}

export interface SpatialSkeletonPresentationExactSegment {
  readonly segmentId: number;
  readonly snapshot: SpatialSkeletonCachedSegmentSnapshotHandle;
}

export interface SpatialSkeletonPresentationLogicalOwner {
  readonly segmentId: number;
  readonly logicalHandle: SpatialSkeletonLogicalSegmentHandle;
}

export interface SpatialSkeletonPresentationNumericAlias {
  readonly logicalHandle: SpatialSkeletonLogicalSegmentHandle;
  /** Numeric id shown to rendering, picking, and user-facing selection. */
  readonly segmentId: number;
  /** False while the numeric id exists only in the local optimistic projection. */
  readonly authoritative?: boolean;
}

/**
 * The complete presentation observed by rendering and Skeleton Details.
 * Topology references are always exact complete-skeleton handles.  A cold
 * structural intent is represented only by `preparations` until its exact
 * reducer result can be published in the same presentation transaction.
 */
export interface SpatialSkeletonPresentationSnapshot {
  readonly revision: number;
  readonly exactSegmentSnapshots: readonly SpatialSkeletonPresentationExactSegment[];
  /** Explicit projection removals, including pending deletions and retired IDs. */
  readonly removedSegmentIds: readonly number[];
  readonly activeLogicalOwners: readonly SpatialSkeletonPresentationLogicalOwner[];
  readonly numericAliases: readonly SpatialSkeletonPresentationNumericAlias[];
  /** Node ids that exist only in the local optimistic projection. */
  readonly provisionalNodeIds: readonly number[];
  readonly preparations: readonly SpatialSkeletonPreparationIntent[];
}

const preparedSpatialSkeletonProjectionStatePublicationBrand = Symbol(
  "prepared spatial skeleton projection state publication",
);

/**
 * Opaque, state-owned result of complete off-screen projection publication
 * preparation. The runtime may only return this value to the state instance
 * that created it; a runtime ownership token rejects forged/cross-state use.
 */
export interface SpatialSkeletonPreparedProjectionStatePublication {
  readonly [preparedSpatialSkeletonProjectionStatePublicationBrand]: true;
  /** Planned post-adoption revisions, prepared with the cache maps. */
  readonly cacheRevisions: ReadonlyMap<number, number>;
}

/** Complete state-facing portion of one immutable optimistic publication. */
export interface SpatialSkeletonProjectionStatePublicationRequest {
  readonly snapshots: Iterable<
    readonly [number, CompleteSkeletonSnapshotHandle | undefined]
  >;
  readonly expectedRevisions: ReadonlyMap<number, number>;
  /** Confirmed deletions advance revisions even for already-absent snapshots. */
  readonly retiredSegmentIds?: ReadonlySet<number>;
  readonly activeLogicalOwners: Iterable<SpatialSkeletonPresentationLogicalOwner>;
  readonly numericAliases: Iterable<SpatialSkeletonPresentationNumericAlias>;
  readonly provisionalNodeIds: Iterable<number>;
  readonly preparationIntentIdsToRemove: Iterable<number>;
  readonly notify: boolean;
}

export interface SpatialSkeletonAdoptedProjectionStatePublication {
  readonly cacheRevisions: ReadonlyMap<number, number>;
}

function hasFunction<T extends string>(
  value: unknown,
  property: T,
): value is Record<T, (...args: any[]) => unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[property] === "function"
  );
}

function getProperty<T extends string>(value: unknown, property: T): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<T, unknown>)[property]
    : undefined;
}

function hasValidCommandFactory(
  value: unknown,
  metadata: (typeof SPATIAL_SKELETON_EDIT_COMMAND_METADATA)[number],
) {
  const commandFactory = getProperty(value, metadata.commandProperty);
  return (
    (commandFactory === undefined && !metadata.required) ||
    isSpatialSkeletonEditCommandFactory(commandFactory, metadata.action)
  );
}

function isFiniteNumberArray(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isSpatialSkeletonConfidenceConfiguration(
  value: unknown,
): value is SpatialSkeletonConfidenceConfiguration {
  return (
    typeof value === "object" &&
    value !== null &&
    isFiniteNumberArray(getProperty(value, "values"))
  );
}

function hasOptionalConfidenceConfiguration(value: unknown) {
  const configuration = getProperty(
    value,
    "spatialSkeletonConfidenceConfiguration",
  );
  return (
    configuration === undefined ||
    isSpatialSkeletonConfidenceConfiguration(configuration)
  );
}

export function isSpatiallyIndexedSkeletonSource(
  value: unknown,
): value is SpatiallyIndexedSkeletonSource {
  return (
    typeof getProperty(value, "readonly") === "boolean" &&
    hasFunction(value, "listSkeletons") &&
    hasFunction(value, "getSkeleton") &&
    hasFunction(value, "getSpatialIndexMetadata") &&
    hasFunction(value, "fetchNodes")
  );
}

export function isEditableSpatiallyIndexedSkeletonSource(
  value: unknown,
): value is EditableSpatiallyIndexedSkeletonSource {
  return (
    isSpatiallyIndexedSkeletonSource(value) &&
    !value.readonly &&
    isSpatialSkeletonOptimisticEditingProvider(
      getProperty(value, "optimisticEditing"),
    ) &&
    SPATIAL_SKELETON_EDIT_COMMAND_METADATA.every((metadata) =>
      hasValidCommandFactory(value, metadata),
    ) &&
    hasOptionalConfidenceConfiguration(value)
  );
}

export function getSpatiallyIndexedSkeletonSource(
  value: SpatialSkeletonSourceAccess | undefined,
): SpatiallyIndexedSkeletonSource | undefined {
  if (value === undefined) return undefined;
  return isSpatiallyIndexedSkeletonSource(value.source)
    ? value.source
    : undefined;
}

export function isSpatiallyIndexedSkeletonSourceReadOnly(
  value: SpatialSkeletonSourceAccess | undefined,
): boolean {
  return getSpatiallyIndexedSkeletonSource(value)?.readonly ?? true;
}

export function getEditableSpatiallyIndexedSkeletonSource(
  value: SpatialSkeletonSourceAccess | undefined,
): EditableSpatiallyIndexedSkeletonSource | undefined {
  if (value === undefined) return undefined;
  return isEditableSpatiallyIndexedSkeletonSource(value.source)
    ? value.source
    : undefined;
}

export function getSpatialSkeletonEditCommandFactoryForAction(
  source: EditableSpatiallyIndexedSkeletonSource,
  action: SpatialSkeletonAction,
) {
  return getSpatialSkeletonEditCommandFactoryFromSource(source, action);
}

export function editableSpatiallyIndexedSkeletonSourceSupportsAction(
  source: EditableSpatiallyIndexedSkeletonSource,
  action: SpatialSkeletonAction,
) {
  const commandFactory = getSpatialSkeletonEditCommandFactoryForAction(
    source,
    action,
  );
  if (commandFactory === undefined) return false;
  const metadata = getSpatialSkeletonEditCommandMetadata(action);
  return (
    metadata?.requiresConfidenceConfiguration !== true ||
    source.spatialSkeletonConfidenceConfiguration !== undefined
  );
}

export function normalizeSpatiallyIndexedSkeletonNode(
  node: SpatiallyIndexedSkeletonNode,
  fallbackSegmentId: number,
): SpatiallyIndexedSkeletonNode | undefined {
  const nodeId = Number(node.nodeId);
  const segmentIdValue = Number(node.segmentId);
  const x = Number(node.position[0]);
  const y = Number(node.position[1]);
  const z = Number(node.position[2]);
  if (
    !Number.isFinite(nodeId) ||
    !Number.isFinite(segmentIdValue) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    return undefined;
  }
  const parentNodeId =
    node.parentNodeId === undefined ||
    !Number.isFinite(Number(node.parentNodeId))
      ? undefined
      : Math.round(Number(node.parentNodeId));
  return {
    ...node,
    nodeId: Math.round(nodeId),
    segmentId: Math.round(
      Number.isFinite(segmentIdValue) ? segmentIdValue : fallbackSegmentId,
    ),
    position: new Float32Array([x, y, z]),
    parentNodeId,
    description:
      typeof node.description === "string" && node.description.length > 0
        ? node.description
        : undefined,
    isTrueEnd: node.isTrueEnd ?? false,
    ...((node.radius !== undefined && Number.isFinite(Number(node.radius))) ||
    (node.confidence !== undefined && Number.isFinite(Number(node.confidence)))
      ? {
          ...(node.radius !== undefined && Number.isFinite(Number(node.radius))
            ? { radius: Number(node.radius) }
            : {}),
          ...(node.confidence !== undefined &&
          Number.isFinite(Number(node.confidence))
            ? { confidence: Number(node.confidence) }
            : {}),
        }
      : {}),
  };
}

function cloneSpatiallyIndexedSkeletonNode(
  node: SpatiallyIndexedSkeletonNode,
): SpatiallyIndexedSkeletonNode {
  return {
    ...node,
    position: new Float32Array(node.position),
  };
}

function cachedSkeletonNodesEqual(
  a: SpatiallyIndexedSkeletonNode,
  b: SpatiallyIndexedSkeletonNode,
) {
  if (
    a.nodeId !== b.nodeId ||
    a.segmentId !== b.segmentId ||
    a.parentNodeId !== b.parentNodeId ||
    a.radius !== b.radius ||
    a.confidence !== b.confidence ||
    a.description !== b.description ||
    a.isTrueEnd !== b.isTrueEnd ||
    a.position.length !== b.position.length
  ) {
    return false;
  }
  for (let i = 0; i < a.position.length; ++i) {
    if (a.position[i] !== b.position[i]) return false;
  }
  return true;
}

function cachedSegmentSnapshotsEqual(
  a: readonly SpatiallyIndexedSkeletonNode[] | undefined,
  b: readonly SpatiallyIndexedSkeletonNode[] | undefined,
) {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.length === b.length &&
    a.every((node, index) => cachedSkeletonNodesEqual(node, b[index]))
  );
}

interface SpatialSkeletonCachedSegmentReplacement {
  readonly nodes: readonly SpatiallyIndexedSkeletonNode[] | undefined;
  readonly handle: CompleteSkeletonSnapshotHandle | undefined;
  readonly adoptHandleStorage: boolean;
}

interface SpatialSkeletonPreparedProjectionStatePublicationImplementation
  extends SpatialSkeletonPreparedProjectionStatePublication {
  readonly owner: object;
  readonly expectedCacheRevisionClock: number;
  readonly expectedPresentation: SpatialSkeletonPresentationSnapshot;
  readonly expectedRevisions: ReadonlyMap<number, number>;
  readonly cacheRevisions: ReadonlyMap<number, number>;
  readonly nextCacheRevisionClock: number;
  readonly nextFullSegmentNodeRevisions: Map<number, number>;
  readonly nextFullSegmentNodeCache: Map<
    number,
    SpatiallyIndexedSkeletonNode[]
  >;
  readonly nextFullSegmentSnapshotHandles: Map<
    number,
    SpatialSkeletonCachedSegmentSnapshotHandle
  >;
  readonly nextCachedNodesById: Map<number, SpatiallyIndexedSkeletonNode>;
  readonly nextPresentationLogicalOwners: Map<
    number,
    SpatialSkeletonLogicalSegmentHandle
  >;
  readonly nextPresentationNumericAliases: Map<
    string,
    { readonly segmentId: number; readonly authoritative: boolean }
  >;
  readonly nextPresentationProvisionalNodeIds: Set<number>;
  readonly nextPresentationRemovedSegmentIds: Set<number>;
  readonly nextPreparationsById: Map<number, SpatialSkeletonPreparationIntent>;
  readonly changedSegmentIds: readonly number[];
  readonly abortSegmentIds: readonly number[];
  readonly retiredSegmentIds: ReadonlySet<number>;
  readonly notifyNodeData: boolean;
  readonly presentation?: SpatialSkeletonPresentationSnapshot;
}

function normalizePreparationId(value: number, label: string) {
  const normalized = Math.round(Number(value));
  if (!Number.isSafeInteger(normalized) || normalized === 0) {
    throw new RangeError(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

function normalizePreparationNodeIds(
  values: readonly number[] | undefined,
  label: string,
) {
  if (values === undefined) return undefined;
  return values.map((value) => normalizePreparationId(value, label));
}

function normalizeSpatialSkeletonPreparationIntent(
  preparation: SpatialSkeletonPreparationIntent,
): SpatialSkeletonPreparationIntent {
  const intentId = normalizePreparationId(
    preparation.intentId,
    "preparation intent id",
  );
  if (intentId < 0) {
    throw new RangeError(
      `Invalid preparation intent id: ${preparation.intentId}`,
    );
  }
  if (
    preparation.kind !== "merge" &&
    preparation.kind !== "split" &&
    preparation.kind !== "delete" &&
    preparation.kind !== "restore" &&
    preparation.kind !== "reroot"
  ) {
    throw new TypeError(
      `Invalid spatial skeleton preparation kind: ${preparation.kind}`,
    );
  }
  if (preparation.lifecycle !== "preparing") {
    throw new TypeError(
      `Invalid spatial skeleton preparation lifecycle: ${preparation.lifecycle}`,
    );
  }
  const sequence = normalizePreparationId(
    preparation.sequence,
    "preparation sequence",
  );
  if (sequence < 0) {
    throw new RangeError(
      `Invalid preparation sequence: ${preparation.sequence}`,
    );
  }
  const direction = preparation.direction;
  if (direction !== "execute" && direction !== "undo" && direction !== "redo") {
    throw new TypeError(`Invalid preparation direction: ${direction}`);
  }
  const normalizeOptionalId = (value: number | undefined, label: string) =>
    value === undefined ? undefined : normalizePreparationId(value, label);
  const lastKnownPositions = preparation.lastKnownPositions?.map((entry) => {
    const position = new Float32Array([
      Number(entry.position[0]),
      Number(entry.position[1]),
      Number(entry.position[2]),
    ]);
    if (!position.every(Number.isFinite)) {
      throw new RangeError(
        `Invalid last-known position for spatial skeleton node ${entry.nodeId}.`,
      );
    }
    return Object.freeze({
      nodeId: normalizePreparationId(entry.nodeId, "preparation node id"),
      position,
    });
  });
  const cloneLogicalNodeHandle = ({
    kind,
    stableId,
  }: SpatialSkeletonLogicalNodeHandle) => {
    if (kind !== "node" || String(stableId).length === 0) {
      throw new TypeError("Invalid logical node handle in preparation.");
    }
    return Object.freeze({ kind, stableId: String(stableId) });
  };
  const cloneLogicalSegmentHandle = ({
    kind,
    stableId,
  }: SpatialSkeletonLogicalSegmentHandle) => {
    if (kind !== "segment" || String(stableId).length === 0) {
      throw new TypeError("Invalid logical segment handle in preparation.");
    }
    return Object.freeze({ kind, stableId: String(stableId) });
  };
  return Object.freeze({
    intentId,
    sequence,
    direction,
    kind: preparation.kind,
    lifecycle: preparation.lifecycle,
    logicalNodeHandles:
      preparation.logicalNodeHandles === undefined
        ? undefined
        : Object.freeze(
            preparation.logicalNodeHandles.map(cloneLogicalNodeHandle),
          ),
    logicalSegmentHandles:
      preparation.logicalSegmentHandles === undefined
        ? undefined
        : Object.freeze(
            preparation.logicalSegmentHandles.map(cloneLogicalSegmentHandle),
          ),
    segmentIds: Object.freeze(
      normalizePreparationNodeIds(
        preparation.segmentIds,
        "preparation segment id",
      )!,
    ),
    nodeId: normalizeOptionalId(preparation.nodeId, "preparation node id"),
    endpointNodeIds:
      preparation.endpointNodeIds === undefined
        ? undefined
        : Object.freeze(
            normalizePreparationNodeIds(
              preparation.endpointNodeIds,
              "preparation endpoint node id",
            )!,
          ),
    cutNodeId: normalizeOptionalId(
      preparation.cutNodeId,
      "preparation cut node id",
    ),
    cutParentNodeId: normalizeOptionalId(
      preparation.cutParentNodeId,
      "preparation cut-parent node id",
    ),
    rootNodeId: normalizeOptionalId(
      preparation.rootNodeId,
      "preparation root node id",
    ),
    pathNodeIds:
      preparation.pathNodeIds === undefined
        ? undefined
        : Object.freeze(
            normalizePreparationNodeIds(
              preparation.pathNodeIds,
              "preparation path node id",
            )!,
          ),
    lastKnownPositions:
      lastKnownPositions === undefined
        ? undefined
        : Object.freeze(lastKnownPositions),
  });
}

/**
 * Full-segment skeleton fetches bypass the chunk queue manager, so they are
 * capped separately at min(this, the concurrentDownloads viewer setting).
 */
const MAX_CONCURRENT_FULL_SEGMENT_NODE_FETCHES = 8;

/**
 * Full-segment requests do not go through the chunk queue's request timeout.
 * Bound the underlying source request independently so a lost response cannot
 * retain a concurrency slot forever.
 */
const FULL_SEGMENT_NODE_FETCH_TIMEOUT_MS = 120_000;

class StateOwnedSpatialSkeletonProvisionalNumericIdService
  implements SpatialSkeletonProvisionalNumericIdService
{
  private policy?: SpatialSkeletonProvisionalNumericIdPolicy;

  configure(policy: SpatialSkeletonProvisionalNumericIdPolicy | undefined) {
    this.policy = policy;
  }

  allocateNodeId(intentId: number) {
    return this.allocate("node", intentId);
  }

  allocateSegmentId(intentId: number) {
    return this.allocate("segment", intentId);
  }

  private allocate(kind: "node" | "segment", intentId: number) {
    const policy = this.policy;
    if (policy === undefined) {
      throw new SpatialSkeletonOptimisticDatasourceContractError(
        `This spatial skeleton datasource did not register a provisional numeric-ID policy for ${kind} creation.`,
      );
    }
    const id =
      kind === "node"
        ? policy.allocateNodeId(intentId)
        : policy.allocateSegmentId(intentId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new SpatialSkeletonOptimisticDatasourceContractError(
        `The datasource provisional ${kind} ID policy returned invalid ID ${id}.`,
      );
    }
    return id;
  }
}

type StateOwnedSpatialSkeletonOptimisticEngine =
  SpatialSkeletonOptimisticEditQueue & {
    subscribe(listener: () => void): () => void;
    getSnapshot(): readonly SpatialSkeletonOptimisticEditQueueEntry[];
    getRecentActivity(): readonly SpatialSkeletonOptimisticEditActivityEntry[];
    submitExecute(
      command: SpatialSkeletonEditCommand,
      queueInput:
        | SpatialSkeletonQueueInput
        | SpatialSkeletonQueueInputPreparation,
    ): SpatialSkeletonOptimisticEditExecution<boolean>;
    submitUndo(): SpatialSkeletonOptimisticEditExecution<boolean>;
    submitRedo(): SpatialSkeletonOptimisticEditExecution<boolean>;
  };

export interface SpatialSkeletonStateOptions {
  /** Shared admission, history, and recent-activity capacity. */
  readonly optimisticEditQueueCapacity?: number;
}

export class SpatialSkeletonState
  extends RefCounted
  implements SpatialSkeletonOptimisticEditState
{
  readonly commandHistory: SpatialSkeletonCommandHistory;
  readonly optimisticEditQueueCapacity: number;
  readonly editMode = new WatchableValue(false);
  readonly mergeMode = new WatchableValue(false);
  readonly splitMode = new WatchableValue(false);
  readonly mergeAnchorNodeId = new WatchableValue<number | undefined>(
    undefined,
  );
  // When true, the selected-node highlight is hidden even if a node is
  // selected. Driven by the edit tool so that entering merge/split mode does
  // not display a stale highlight until the user makes their first click
  // (merge) or is suppressed entirely until a click/exit (split).
  readonly suppressSelectedNodeHighlight = new WatchableValue(false);
  readonly nodeDataVersion = new WatchableValue(0);
  readonly pendingNodePositionVersion = new WatchableValue(0);
  readonly optimisticEditQueueVersion = new WatchableValue(0);
  /**
   * Shared exact topology and structural-preparation presentation.  Rendering
   * and details should subscribe here so they cannot observe cache adoption
   * and preparation removal as two different presentation revisions.
   */
  readonly spatialSkeletonPresentation =
    new WatchableValue<SpatialSkeletonPresentationSnapshot>(
      Object.freeze({
        revision: 0,
        exactSegmentSnapshots: Object.freeze([]),
        removedSegmentIds: Object.freeze([]),
        activeLogicalOwners: Object.freeze([]),
        numericAliases: Object.freeze([]),
        provisionalNodeIds: Object.freeze([]),
        preparations: Object.freeze([]),
      }),
    );
  /** The single pointer-drag coordinate rendered before queue admission. */
  private pendingNodePosition:
    | { nodeId: number; position: Float32Array }
    | undefined;
  private spatialSkeletonPreparationsById = new Map<
    number,
    SpatialSkeletonPreparationIntent
  >();
  private presentationLogicalOwners = new Map<
    number,
    SpatialSkeletonLogicalSegmentHandle
  >();
  private presentationNumericAliases = new Map<
    string,
    { readonly segmentId: number; readonly authoritative: boolean }
  >();
  private presentationProvisionalNodeIds = new Set<number>();
  private presentationRemovedSegmentIds = new Set<number>();
  private presentationTransactionDepth = 0;
  private presentationPublicationPending = false;
  private preparedPresentationPublication:
    | SpatialSkeletonPresentationSnapshot
    | undefined;
  private readonly presentationNotificationErrorReporters = new Set<
    (error: unknown) => void
  >();
  private nodeDataNotificationPending = false;
  private readonly projectionStatePublicationOwner = {};
  private readonly adoptedProjectionStatePublications = new WeakSet<object>();
  /** Complete node arrays for the current cached versions of skeletons. */
  private fullSegmentNodeCache = new Map<
    number,
    SpatiallyIndexedSkeletonNode[]
  >();
  /** Immutable views of those versions, paired with local cache revisions. */
  private fullSegmentSnapshotHandles = new Map<
    number,
    SpatialSkeletonCachedSegmentSnapshotHandle
  >();
  /**
   * Per-segment registrations that protect current snapshots from eviction.
   * Each acquisition adds its own token pointing to the snapshot and revision;
   * releasing that input reference removes only its token.
   */
  private queueInputReferenceRegistrations = new Map<
    number,
    Map<object, SpatialSkeletonCachedSegmentSnapshotHandle>
  >();
  /**
   * A monotonic revision fence for each complete segment cache entry.  The
   * floor represents a global cache invalidation without having to enumerate
   * every segment id that may have been captured by an outstanding read.
   */
  private fullSegmentNodeRevisionClock = 0;
  private fullSegmentNodeRevisionFloor = 0;
  private fullSegmentNodeRevisions = new Map<number, number>();
  private pendingFullSegmentNodeFetches = new Map<
    number,
    {
      promise: Promise<SpatiallyIndexedSkeletonNode[]>;
      abortController: AbortController;
      retainWhileInactive: boolean;
      /** Command/source instances currently awaiting this shared read. */
      requestOwners: Set<object>;
      /** True once a visual or other unowned caller has joined the read. */
      hasUnownedConsumer: boolean;
    }
  >();
  private fullSegmentNodeFetchLimitLayer:
    | SpatiallyIndexedSkeletonLayer
    | undefined;
  private fullSegmentNodeFetchLimiter = new PromiseConcurrencyLimiter(() => {
    const itemLimit =
      this.fullSegmentNodeFetchLimitLayer?.chunkManager?.chunkQueueManager
        ?.capacities?.download?.itemLimit?.value;
    return Math.min(
      MAX_CONCURRENT_FULL_SEGMENT_NODE_FETCHES,
      itemLimit ?? Number.POSITIVE_INFINITY,
    );
  });
  private cachedNodesById = new Map<number, SpatiallyIndexedSkeletonNode>();
  /**
   * First-wins, layer-scoped editing latch. It deliberately is not part of
   * queue or datasource runtime state: clearing either cannot make editing
   * safe again after authority became unknowable.
   */
  private optimisticEditFatalState:
    | SpatialSkeletonOptimisticFatalState
    | undefined;
  private optimisticEditQueue?: StateOwnedSpatialSkeletonOptimisticEngine;
  private optimisticEditSource?: EditableSpatiallyIndexedSkeletonSource;
  private optimisticProjectionRuntime?: SpatialSkeletonOptimisticProjectionRuntime;
  private optimisticQueueSubscriptionCleanup?: () => void;
  private optimisticDatasourceCleanup?: () => void;
  private optimisticFatalLatchOrigin?: SpatialSkeletonOptimisticEditQueue;

  constructor(options: SpatialSkeletonStateOptions = {}) {
    super();
    const capacity =
      options.optimisticEditQueueCapacity ??
      DEFAULT_SPATIAL_SKELETON_OPTIMISTIC_EDIT_QUEUE_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        "The spatial skeleton optimistic-edit queue capacity must be a positive safe integer.",
      );
    }
    this.optimisticEditQueueCapacity = capacity;
    this.commandHistory = this.registerDisposer(
      new SpatialSkeletonCommandHistory({ capacity }),
    );
  }

  /**
   * Constructs the single queue runtime owned by this layer state. Providers
   * contribute workflow/transport behavior, never another queue.
   */
  ensureOptimisticEditingEngine(
    layer: SpatialSkeletonLayerContext,
    source: EditableSpatiallyIndexedSkeletonSource,
    provider: SpatialSkeletonOptimisticEditingProvider,
  ): SpatialSkeletonOptimisticEditQueue {
    if (
      this.optimisticEditSource === source &&
      this.optimisticEditQueue !== undefined
    ) {
      return this.optimisticEditQueue;
    }

    const projection = new SpatialSkeletonOptimisticProjectionRuntime(this, {
      uiHints:
        layer.applySpatialSkeletonProjectionUiHints === undefined
          ? undefined
          : {
              apply: (hints) =>
                layer.applySpatialSkeletonProjectionUiHints!(hints),
            },
      onAuxiliaryError: (error) => console.error(error),
    });
    const provisionalIds =
      new StateOwnedSpatialSkeletonProvisionalNumericIdService();
    const registration = provider.createDriver({
      source,
      identities: projection,
      provisionalIds,
    });
    assertSpatialSkeletonOptimisticDriverRegistration(registration);
    provisionalIds.configure(registration.provisionalNumericIdPolicy);
    const attempts = new SpatialSkeletonMutationAttemptScheduler({
      adapter: registration.mutationAdapter,
    });
    const engine = new SpatialSkeletonOptimisticQueueEngine({
      driver: registration.driver,
      projection,
      history: createSpatialSkeletonOptimisticHistoryPort(this.commandHistory),
      attempts,
      preparation: {
        publish: (intentId, intent, descriptor) => {
          const { lastKnownPositions, ...preparation } = descriptor;
          this.setSpatialSkeletonPreparation({
            ...preparation,
            intentId,
            sequence: intentId,
            direction: intent,
            lifecycle: "preparing",
            segmentIds: descriptor.segmentIds ?? [],
            ...(lastKnownPositions === undefined
              ? {}
              : {
                  lastKnownPositions: lastKnownPositions.map(
                    ({ nodeId, position }) => ({
                      nodeId,
                      position: new Float32Array(Array.from(position, Number)),
                    }),
                  ),
                }),
          });
        },
        remove: (intentId) => {
          this.removeSpatialSkeletonPreparation(intentId);
        },
      },
      fatalState: {
        get: () => this.getOptimisticEditFatalState(),
        latch: (fatalState) => {
          this.optimisticFatalLatchOrigin = engine;
          try {
            return this.latchOptimisticEditFatalState(fatalState);
          } finally {
            this.optimisticFatalLatchOrigin = undefined;
          }
        },
      },
      onListenerError: (error) => console.error(error),
    }) as StateOwnedSpatialSkeletonOptimisticEngine;

    // The candidate is complete before replacing the current engine. A
    // provider construction failure therefore leaves the old source usable.
    this.releaseOptimisticEditingEngine();
    this.commandHistory.setSource(source);
    this.optimisticEditSource = source;
    this.optimisticProjectionRuntime = projection;
    this.optimisticEditQueue = engine;
    this.optimisticDatasourceCleanup = registration.cleanup;
    this.optimisticQueueSubscriptionCleanup = engine.subscribe(() =>
      this.notifyOptimisticEditQueueChanged(),
    );
    const fatalState = this.optimisticEditFatalState;
    if (fatalState === undefined) {
      this.notifyOptimisticEditQueueChanged();
    } else {
      engine.handleFatalStateLatched(fatalState);
    }
    return engine;
  }

  releaseOptimisticEditingEngine() {
    const queue = this.optimisticEditQueue;
    const datasourceCleanup = this.optimisticDatasourceCleanup;
    const hadRuntime =
      queue !== undefined ||
      this.optimisticProjectionRuntime !== undefined ||
      datasourceCleanup !== undefined;
    this.optimisticQueueSubscriptionCleanup?.();
    this.optimisticQueueSubscriptionCleanup = undefined;
    // Capture and clear ownership before disposal so a synchronous callback
    // cannot schedule the same datasource cleanup twice.
    this.optimisticDatasourceCleanup = undefined;
    this.optimisticEditQueue = undefined;
    this.optimisticEditSource = undefined;
    this.optimisticProjectionRuntime = undefined;
    const disposal = queue?.dispose();
    if (datasourceCleanup !== undefined) {
      const runDatasourceCleanup = () => {
        try {
          datasourceCleanup();
        } catch (error) {
          console.error(error);
        }
      };
      if (disposal === undefined) {
        runDatasourceCleanup();
      } else {
        // The queue owns classification of any transport already in flight.
        // A replacement can be installed immediately, while the detached
        // datasource is cleaned up exactly once after disposal unwinds.
        void disposal.then(runDatasourceCleanup, runDatasourceCleanup);
      }
    }
    if (hadRuntime) this.notifyOptimisticEditQueueChanged();
    return hadRuntime;
  }

  executeOptimisticEdit(
    command: SpatialSkeletonEditCommand,
    queueInput:
      | SpatialSkeletonQueueInput
      | SpatialSkeletonQueueInputPreparation,
  ) {
    this.assertOptimisticEditingAllowed();
    const engine = this.optimisticEditQueue;
    if (engine === undefined) {
      return rejectedOptimisticEditExecution<void>(
        new SpatialSkeletonOptimisticDatasourceContractError(
          "Editable spatial skeleton datasource has no installed queue driver.",
        ),
      );
    }
    const submitted = engine.submitExecute(command, queueInput);
    const execution = submitted.then(() => undefined);
    Object.defineProperties(execution, {
      acceptedByQueue: { configurable: true, value: submitted.acceptedByQueue },
      settled: { configurable: true, value: submitted.settled },
    });
    return execution as SpatialSkeletonOptimisticEditExecution<void>;
  }

  getOptimisticEditingIdentityService() {
    const identities = this.optimisticProjectionRuntime;
    if (identities === undefined) {
      throw new SpatialSkeletonOptimisticDatasourceContractError(
        "Editable spatial skeleton datasource has no installed queue identity service.",
      );
    }
    return identities;
  }

  notifyOptimisticEditQueueChanged() {
    this.optimisticEditQueueVersion.value =
      this.optimisticEditQueueVersion.value + 1;
  }

  getOptimisticEditFatalState() {
    return this.optimisticEditFatalState;
  }

  latchOptimisticEditFatalState(
    state: SpatialSkeletonOptimisticFatalState,
  ): boolean {
    if (this.optimisticEditFatalState !== undefined) return false;
    this.optimisticEditFatalState =
      freezeSpatialSkeletonOptimisticFatalState(state);

    // A latched layer may still be inspected and navigated, but no mutation
    // gesture may remain armed. These are interaction-only overlays and do
    // not alter the last complete adopted skeleton projection.
    this.editMode.value = false;
    this.mergeMode.value = false;
    this.splitMode.value = false;
    this.clearMergeAnchor();
    this.suppressSelectedNodeHighlight.value = false;
    this.clearPendingNodePositions();

    // The latch is state-owned and may be won by an engine which has already
    // been replaced. Always stop the currently installed engine as well.
    const activeQueue = this.optimisticEditQueue;
    if (activeQueue === undefined) {
      this.notifyOptimisticEditQueueChanged();
    } else if (activeQueue !== this.optimisticFatalLatchOrigin) {
      // The engine publishes the single queue/UI revision after synchronously
      // canceling and refolding its unsent work.
      activeQueue.handleFatalStateLatched(this.optimisticEditFatalState);
    }
    return true;
  }

  assertOptimisticEditingAllowed() {
    const fatalState = this.optimisticEditFatalState;
    if (fatalState !== undefined) {
      throw new SpatialSkeletonOptimisticReloadRequiredError(fatalState);
    }
  }

  private prepareSpatialSkeletonPresentationPublication(
    options: {
      readonly fullSegmentSnapshotHandles?: ReadonlyMap<
        number,
        SpatialSkeletonCachedSegmentSnapshotHandle
      >;
      readonly fullSegmentNodeRevisions?: ReadonlyMap<number, number>;
      readonly fullSegmentNodeRevisionFloor?: number;
      readonly logicalOwners?: ReadonlyMap<
        number,
        SpatialSkeletonLogicalSegmentHandle
      >;
      readonly numericAliases?: ReadonlyMap<
        string,
        { readonly segmentId: number; readonly authoritative: boolean }
      >;
      readonly provisionalNodeIds?: ReadonlySet<number>;
      readonly removedSegmentIds?: ReadonlySet<number>;
      readonly preparationsById?: ReadonlyMap<
        number,
        SpatialSkeletonPreparationIntent
      >;
      readonly revision?: number;
    } = {},
  ): SpatialSkeletonPresentationSnapshot {
    const preparations = [
      ...(
        options.preparationsById ?? this.spatialSkeletonPreparationsById
      ).values(),
    ].sort((a, b) => a.sequence - b.sequence || a.intentId - b.intentId);
    const revisionFloor =
      options.fullSegmentNodeRevisionFloor ?? this.fullSegmentNodeRevisionFloor;
    const revisions =
      options.fullSegmentNodeRevisions ?? this.fullSegmentNodeRevisions;
    const exactSegmentSnapshots = [
      ...(options.fullSegmentSnapshotHandles ??
        this.fullSegmentSnapshotHandles),
    ]
      .filter(
        ([segmentId, snapshot]) =>
          snapshot.cacheRevision ===
          Math.max(revisionFloor, revisions.get(segmentId) ?? 0),
      )
      .sort(([a], [b]) => a - b)
      .map(([segmentId, snapshot]) =>
        Object.freeze({
          segmentId,
          snapshot: Object.freeze({ ...snapshot }),
        }),
      );
    const activeLogicalOwners = [
      ...(options.logicalOwners ?? this.presentationLogicalOwners),
    ]
      .sort(([a], [b]) => a - b)
      .map(([segmentId, logicalHandle]) =>
        Object.freeze({ segmentId, logicalHandle }),
      );
    const numericAliases = [
      ...(options.numericAliases ?? this.presentationNumericAliases),
    ]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stableId, { segmentId, authoritative }]) =>
        Object.freeze({
          logicalHandle: Object.freeze({
            kind: "segment" as const,
            stableId,
          }),
          segmentId,
          authoritative,
        }),
      );
    const provisionalNodeIds = [
      ...(options.provisionalNodeIds ?? this.presentationProvisionalNodeIds),
    ].sort((a, b) => a - b);
    return Object.freeze({
      revision:
        options.revision ?? this.spatialSkeletonPresentation.value.revision + 1,
      exactSegmentSnapshots: Object.freeze(exactSegmentSnapshots),
      removedSegmentIds: Object.freeze(
        [
          ...(options.removedSegmentIds ?? this.presentationRemovedSegmentIds),
        ].sort((a, b) => a - b),
      ),
      activeLogicalOwners: Object.freeze(activeLogicalOwners),
      numericAliases: Object.freeze(numericAliases),
      provisionalNodeIds: Object.freeze(provisionalNodeIds),
      preparations: Object.freeze(preparations),
    });
  }

  private reportSpatialSkeletonPresentationObserverError(error: unknown) {
    for (const reportError of this.presentationNotificationErrorReporters) {
      try {
        reportError(error);
      } catch {
        // Reporting cannot make an already-adopted model fail.
      }
    }
  }

  private publishPreparedSpatialSkeletonPresentation(
    publication: SpatialSkeletonPresentationSnapshot,
  ) {
    const publishPresentation = () => {
      this.spatialSkeletonPresentation.value = publication;
    };
    if (this.presentationNotificationErrorReporters.size === 0) {
      publishPresentation();
      return;
    }
    const reportError = (error: unknown) =>
      this.reportSpatialSkeletonPresentationObserverError(error);
    this.spatialSkeletonPresentation.changed.runWithHandlerErrorReporting(
      reportError,
      publishPresentation,
    );
  }

  private publishSpatialSkeletonPresentation() {
    this.presentationPublicationPending = false;
    this.publishPreparedSpatialSkeletonPresentation(
      this.prepareSpatialSkeletonPresentationPublication(),
    );
  }

  private requestSpatialSkeletonPresentationPublication() {
    this.preparedPresentationPublication = undefined;
    if (this.presentationTransactionDepth !== 0) {
      this.presentationPublicationPending = true;
      return;
    }
    this.publishSpatialSkeletonPresentation();
  }

  /**
   * Runs a synchronous presentation transaction.  Complete-cache adoption,
   * preparation changes, aliases, owners, and the node-data notification are
   * coalesced into a single presentation publication at the outer boundary.
   */
  runSpatialSkeletonPresentationTransaction<T>(
    callback: () => T,
    reportNotificationError?: (error: unknown) => void,
  ): T {
    if (reportNotificationError !== undefined) {
      this.presentationNotificationErrorReporters.add(reportNotificationError);
    }
    ++this.presentationTransactionDepth;
    try {
      return callback();
    } finally {
      if (--this.presentationTransactionDepth === 0) {
        try {
          // Publish the already-prepared presentation first.  Node-data
          // observers commonly schedule a redraw and must never observe the
          // newly adopted cache through an older alias/provisional/preparation
          // snapshot.  Both publications still happen only after every core
          // reference was installed by the transaction callback.
          const preparedPresentation = this.preparedPresentationPublication;
          this.preparedPresentationPublication = undefined;
          if (preparedPresentation !== undefined) {
            this.publishPreparedSpatialSkeletonPresentation(
              preparedPresentation,
            );
          } else if (this.presentationPublicationPending) {
            this.publishSpatialSkeletonPresentation();
          }
          if (this.nodeDataNotificationPending) {
            this.nodeDataNotificationPending = false;
            const publishNodeData = () => {
              this.nodeDataVersion.value = this.nodeDataVersion.value + 1;
            };
            if (this.presentationNotificationErrorReporters.size === 0) {
              publishNodeData();
            } else {
              this.nodeDataVersion.changed.runWithHandlerErrorReporting(
                (error) =>
                  this.reportSpatialSkeletonPresentationObserverError(error),
                publishNodeData,
              );
            }
          }
        } finally {
          this.presentationNotificationErrorReporters.clear();
        }
      }
    }
  }

  private prepareSpatialSkeletonPresentationIdentities(
    activeLogicalOwners: Iterable<SpatialSkeletonPresentationLogicalOwner>,
    numericAliases: Iterable<SpatialSkeletonPresentationNumericAlias>,
    provisionalNodeIds: Iterable<number> = [],
  ) {
    const nextOwners = new Map<number, SpatialSkeletonLogicalSegmentHandle>();
    for (const { segmentId, logicalHandle } of activeLogicalOwners) {
      if (!Number.isSafeInteger(segmentId) || segmentId === 0) {
        throw new RangeError(
          `Invalid spatial skeleton presentation segment id: ${segmentId}`,
        );
      }
      if (
        logicalHandle.kind !== "segment" ||
        logicalHandle.stableId.length === 0
      ) {
        throw new TypeError(
          "Invalid active logical segment owner in presentation.",
        );
      }
      nextOwners.set(segmentId, Object.freeze({ ...logicalHandle }));
    }
    const nextAliases = new Map<
      string,
      { readonly segmentId: number; readonly authoritative: boolean }
    >();
    for (const { logicalHandle, segmentId, authoritative } of numericAliases) {
      if (!Number.isSafeInteger(segmentId) || segmentId === 0) {
        throw new RangeError(
          `Invalid spatial skeleton presentation alias: ${segmentId}`,
        );
      }
      if (
        logicalHandle.kind !== "segment" ||
        logicalHandle.stableId.length === 0
      ) {
        throw new TypeError("Invalid logical segment alias in presentation.");
      }
      nextAliases.set(logicalHandle.stableId, {
        segmentId,
        authoritative: authoritative ?? true,
      });
    }
    const nextProvisionalNodeIds = new Set<number>();
    for (const nodeId of provisionalNodeIds) {
      if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
        throw new RangeError(
          `Invalid spatial skeleton provisional node id: ${nodeId}`,
        );
      }
      nextProvisionalNodeIds.add(nodeId);
    }
    const ownersUnchanged =
      nextOwners.size === this.presentationLogicalOwners.size &&
      [...nextOwners].every(
        ([segmentId, handle]) =>
          this.presentationLogicalOwners.get(segmentId)?.stableId ===
          handle.stableId,
      );
    const aliasesUnchanged =
      nextAliases.size === this.presentationNumericAliases.size &&
      [...nextAliases].every(([stableId, alias]) => {
        const current = this.presentationNumericAliases.get(stableId);
        return (
          current?.segmentId === alias.segmentId &&
          current.authoritative === alias.authoritative
        );
      });
    const provisionalNodeIdsUnchanged =
      nextProvisionalNodeIds.size ===
        this.presentationProvisionalNodeIds.size &&
      [...nextProvisionalNodeIds].every((nodeId) =>
        this.presentationProvisionalNodeIds.has(nodeId),
      );
    return {
      nextOwners,
      nextAliases,
      nextProvisionalNodeIds,
      changed: !(
        ownersUnchanged &&
        aliasesUnchanged &&
        provisionalNodeIdsUnchanged
      ),
    };
  }

  /** Adds a preparation and rejects accidental reuse of an active intent id. */
  addSpatialSkeletonPreparation(preparation: SpatialSkeletonPreparationIntent) {
    const normalized = normalizeSpatialSkeletonPreparationIntent(preparation);
    if (this.spatialSkeletonPreparationsById.has(normalized.intentId)) {
      throw new Error(
        `Spatial skeleton preparation ${normalized.intentId} already exists.`,
      );
    }
    this.spatialSkeletonPreparationsById.set(normalized.intentId, normalized);
    this.requestSpatialSkeletonPresentationPublication();
    return true;
  }

  /** Atomically replaces the cue as a queued intent acquires complete inputs. */
  private setSpatialSkeletonPreparation(
    preparation: SpatialSkeletonPreparationIntent,
  ) {
    const normalized = normalizeSpatialSkeletonPreparationIntent(preparation);
    this.spatialSkeletonPreparationsById.set(normalized.intentId, normalized);
    this.requestSpatialSkeletonPresentationPublication();
  }

  removeSpatialSkeletonPreparation(intentId: number) {
    const normalizedIntentId = normalizePreparationId(
      intentId,
      "preparation intent id",
    );
    if (!this.spatialSkeletonPreparationsById.delete(normalizedIntentId)) {
      return false;
    }
    this.requestSpatialSkeletonPresentationPublication();
    return true;
  }

  clearSpatialSkeletonPreparations() {
    if (this.spatialSkeletonPreparationsById.size === 0) return false;
    this.spatialSkeletonPreparationsById.clear();
    this.requestSpatialSkeletonPresentationPublication();
    return true;
  }

  hasUnconfirmedOptimisticEdits() {
    return (
      this.optimisticEditFatalState !== undefined ||
      (this.optimisticEditQueue?.hasUnconfirmedActions() ?? false)
    );
  }

  getOptimisticEditQueueSnapshot(): readonly SpatialSkeletonOptimisticEditQueueEntry[] {
    return this.optimisticEditQueue?.getSnapshot() ?? [];
  }

  getOptimisticEditQueueRecentActivity(): readonly SpatialSkeletonOptimisticEditActivityEntry[] {
    return this.optimisticEditQueue?.getRecentActivity() ?? [];
  }

  canUndoOptimisticEdit() {
    if (this.optimisticEditFatalState !== undefined) return false;
    return this.optimisticEditQueue?.canUndo() ?? false;
  }

  undoLatestOptimisticEdit() {
    if (this.optimisticEditFatalState !== undefined) {
      return rejectedOptimisticEditExecution<boolean>(
        new SpatialSkeletonOptimisticReloadRequiredError(
          this.optimisticEditFatalState,
        ),
      );
    }
    return this.optimisticEditQueue?.canUndo()
      ? this.optimisticEditQueue.undoLatest()
      : resolvedOptimisticEditExecution(false);
  }

  canRedoOptimisticEdit() {
    if (this.optimisticEditFatalState !== undefined) return false;
    return this.optimisticEditQueue?.canRedo() ?? false;
  }

  redoLatestOptimisticEdit() {
    if (this.optimisticEditFatalState !== undefined) {
      return rejectedOptimisticEditExecution<boolean>(
        new SpatialSkeletonOptimisticReloadRequiredError(
          this.optimisticEditFatalState,
        ),
      );
    }
    return this.optimisticEditQueue?.canRedo()
      ? this.optimisticEditQueue.redoLatest()
      : resolvedOptimisticEditExecution(false);
  }

  getPendingNodeIds() {
    const pending = this.pendingNodePosition;
    return pending === undefined
      ? [][Symbol.iterator]()
      : [pending.nodeId].values();
  }

  getPendingNodePosition(nodeId: number) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    const pending = this.pendingNodePosition;
    if (pending === undefined || pending.nodeId !== normalizedNodeId) {
      return undefined;
    }
    return pending.position;
  }

  private normalizeNodeId(nodeId: number | undefined) {
    if (nodeId === undefined) return undefined;
    const normalizedNodeId = Math.round(Number(nodeId));
    if (!Number.isSafeInteger(normalizedNodeId) || normalizedNodeId <= 0) {
      return undefined;
    }
    return normalizedNodeId;
  }

  setMergeAnchor(nodeId: number | undefined) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    if (this.mergeAnchorNodeId.value === normalizedNodeId) {
      return false;
    }
    this.mergeAnchorNodeId.value = normalizedNodeId;
    return true;
  }

  clearMergeAnchor() {
    return this.setMergeAnchor(undefined);
  }

  setPendingNodePosition(nodeId: number, position: ArrayLike<number>) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    const x = Number(position[0]);
    const y = Number(position[1]);
    const z = Number(position[2]);
    if (
      normalizedNodeId === undefined ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z)
    ) {
      return false;
    }
    const existing = this.pendingNodePosition;
    if (
      existing?.nodeId === normalizedNodeId &&
      existing.position[0] === x &&
      existing.position[1] === y &&
      existing.position[2] === z
    ) {
      return false;
    }
    this.pendingNodePosition = {
      // Once reconciliation remaps an in-progress provisional node, later
      // pointer-move events still carry the original picked id. Preserve the
      // remapped active identity until the gesture is cleared.
      nodeId: existing?.nodeId ?? normalizedNodeId,
      position: new Float32Array([x, y, z]),
    };
    this.pendingNodePositionVersion.value =
      this.pendingNodePositionVersion.value + 1;
    return true;
  }

  /**
   * Moves the active drag coordinate when a provisional node id is reconciled
   * to its authoritative id.
   */
  remapPendingNodePositions(remappings: ReadonlyMap<number, number>) {
    const pending = this.pendingNodePosition;
    if (remappings.size === 0 || pending === undefined) {
      return false;
    }
    const resolveNodeId = (nodeId: number) => {
      const visited = new Set<number>();
      let current = nodeId;
      while (!visited.has(current)) {
        visited.add(current);
        const next = this.normalizeNodeId(remappings.get(current));
        if (next === undefined || next === current) break;
        current = next;
      }
      return current;
    };
    const targetNodeId = resolveNodeId(pending.nodeId);
    if (targetNodeId === pending.nodeId) return false;
    this.pendingNodePosition = { ...pending, nodeId: targetNodeId };
    this.pendingNodePositionVersion.value =
      this.pendingNodePositionVersion.value + 1;
    return true;
  }

  clearPendingNodePositions() {
    if (this.pendingNodePosition === undefined) return false;
    this.pendingNodePosition = undefined;
    this.pendingNodePositionVersion.value =
      this.pendingNodePositionVersion.value + 1;
    return true;
  }

  updateCommandHistorySource(source: unknown) {
    if (this.commandHistory.matchesSource(source)) {
      return false;
    }
    this.releaseOptimisticEditingEngine();
    return this.commandHistory.setSource(source);
  }

  clearInspectedSkeletonCache() {
    return this.runSpatialSkeletonPresentationTransaction(() =>
      this.clearInspectedSkeletonCacheInPresentation(),
    );
  }

  private clearInspectedSkeletonCacheInPresentation() {
    const cacheChanged =
      this.fullSegmentNodeCache.size !== 0 ||
      this.pendingFullSegmentNodeFetches.size !== 0 ||
      this.cachedNodesById.size !== 0;
    const pendingChanged = this.clearPendingNodePositions();
    if (!cacheChanged) {
      return pendingChanged;
    }
    this.clearFullSkeletonCache();
    this.markNodeDataChanged({ invalidateFullSkeletonCache: false });
    return true;
  }

  clearRuntimeState() {
    return this.runSpatialSkeletonPresentationTransaction(() =>
      this.clearRuntimeStateInPresentation(),
    );
  }

  private clearRuntimeStateInPresentation() {
    const optimisticQueueChanged = this.releaseOptimisticEditingEngine();
    const cacheChanged =
      this.fullSegmentNodeCache.size !== 0 ||
      this.pendingFullSegmentNodeFetches.size !== 0 ||
      this.cachedNodesById.size !== 0;
    const pendingChanged = this.clearPendingNodePositions();
    const intentCuesChanged = this.clearSpatialSkeletonPreparations();
    const presentationIdentitiesChanged =
      this.presentationLogicalOwners.size !== 0 ||
      this.presentationNumericAliases.size !== 0 ||
      this.presentationProvisionalNodeIds.size !== 0 ||
      this.presentationRemovedSegmentIds.size !== 0;
    if (presentationIdentitiesChanged) {
      this.presentationLogicalOwners.clear();
      this.presentationNumericAliases.clear();
      this.presentationProvisionalNodeIds.clear();
      this.presentationRemovedSegmentIds.clear();
      this.requestSpatialSkeletonPresentationPublication();
    }
    const mergeAnchorChanged = this.clearMergeAnchor();
    let modeChanged = false;
    if (this.editMode.value) {
      this.editMode.value = false;
      modeChanged = true;
    }
    if (this.mergeMode.value) {
      this.mergeMode.value = false;
      modeChanged = true;
    }
    if (this.splitMode.value) {
      this.splitMode.value = false;
      modeChanged = true;
    }
    const historyChanged = this.commandHistory.reset();
    if (cacheChanged) {
      this.clearFullSkeletonCache();
      this.markNodeDataChanged({ invalidateFullSkeletonCache: false });
    }
    return (
      cacheChanged ||
      pendingChanged ||
      intentCuesChanged ||
      presentationIdentitiesChanged ||
      optimisticQueueChanged ||
      mergeAnchorChanged ||
      modeChanged ||
      historyChanged
    );
  }

  markNodeDataChanged(options: { invalidateFullSkeletonCache?: boolean } = {}) {
    if (options.invalidateFullSkeletonCache ?? true) {
      this.clearFullSkeletonCache();
    }
    if (this.presentationTransactionDepth !== 0) {
      this.nodeDataNotificationPending = true;
    } else {
      this.nodeDataVersion.value = this.nodeDataVersion.value + 1;
    }
    this.requestSpatialSkeletonPresentationPublication();
  }

  getCachedSegmentNodes(segmentId: number) {
    return this.fullSegmentNodeCache.get(segmentId);
  }

  /**
   * Returns the current local revision of a complete cached segment.  The
   * revision also changes when an uncached segment is explicitly invalidated,
   * allowing callers to fence asynchronous work without relying on cache
   * presence alone.
   */
  getCachedSegmentRevision(segmentId: number) {
    if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
      throw new RangeError(`Invalid spatial skeleton segment id: ${segmentId}`);
    }
    return this.getCurrentCachedSegmentRevision(segmentId);
  }

  /**
   * Returns the immutable handle represented by the current cache entry and
   * the manager revision that fences it.  The pair is omitted for an uncached
   * segment; callers should re-check `cacheRevision` before publishing work
   * derived asynchronously from the handle.
   */
  getCachedSegmentSnapshotHandle(
    segmentId: number,
  ): SpatialSkeletonCachedSegmentSnapshotHandle | undefined {
    if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
      throw new RangeError(`Invalid spatial skeleton segment id: ${segmentId}`);
    }
    const entry = this.fullSegmentSnapshotHandles.get(segmentId);
    if (
      entry === undefined ||
      entry.cacheRevision !== this.getCurrentCachedSegmentRevision(segmentId)
    ) {
      return undefined;
    }
    return entry;
  }

  /**
   * Validates a queue input requirement against the current complete
   * projected snapshot without starting a read or changing cache state.
   */
  private getCachedQueueInputSegment(
    requirement: SpatialSkeletonQueueInputRequirement,
  ):
    | {
        readonly segmentId: number;
        readonly snapshot: SpatialSkeletonCachedSegmentSnapshotHandle;
      }
    | undefined {
    const { segmentId, nodeId } = requirement;
    if (
      nodeId !== undefined &&
      (!Number.isSafeInteger(nodeId) || nodeId <= 0)
    ) {
      throw new RangeError(`Invalid spatial skeleton node id: ${nodeId}`);
    }
    const snapshot = this.getCachedSegmentSnapshotHandle(segmentId);
    if (snapshot === undefined) return undefined;
    const node =
      nodeId === undefined ? undefined : snapshot.handle.getNode(nodeId);
    if (
      nodeId !== undefined &&
      (node === undefined || node.segmentId !== segmentId)
    ) {
      return undefined;
    }
    return Object.freeze({
      segmentId,
      snapshot: Object.freeze({ ...snapshot }),
    });
  }

  /**
   * Acquires a reference that keeps the current complete snapshot available.
   * Returns `undefined` when the snapshot is not cached or does not contain
   * the requested node. The caller releases its reference after preparation.
   */
  tryAcquireInputReference(
    requirement: SpatialSkeletonQueueInputRequirement,
  ): SpatialSkeletonInputReference | undefined {
    const cachedInput = this.getCachedQueueInputSegment(requirement);
    if (cachedInput === undefined) return undefined;

    const token = {};
    let registrationsForSegment = this.queueInputReferenceRegistrations.get(
      cachedInput.segmentId,
    );
    if (registrationsForSegment === undefined) {
      registrationsForSegment = new Map();
      this.queueInputReferenceRegistrations.set(
        cachedInput.segmentId,
        registrationsForSegment,
      );
    }
    registrationsForSegment.set(token, cachedInput.snapshot);
    let released = false;
    const isCurrent = () => {
      if (
        released ||
        this.queueInputReferenceRegistrations
          .get(cachedInput.segmentId)
          ?.get(token) !== cachedInput.snapshot
      ) {
        return false;
      }
      const current = this.getCachedSegmentSnapshotHandle(
        cachedInput.segmentId,
      );
      return (
        current?.handle === cachedInput.snapshot.handle &&
        current.cacheRevision === cachedInput.snapshot.cacheRevision
      );
    };
    const release = () => {
      if (released) return;
      released = true;
      const currentRegistrations = this.queueInputReferenceRegistrations.get(
        cachedInput.segmentId,
      );
      if (currentRegistrations?.delete(token) !== true) return;
      if (currentRegistrations.size === 0) {
        this.queueInputReferenceRegistrations.delete(cachedInput.segmentId);
      }
    };
    return Object.freeze({
      ...cachedInput,
      isCurrent,
      release,
    });
  }

  /** Acquires an input reference or reports a typed requirement error. */
  acquireInputReference(
    requirement: SpatialSkeletonQueueInputRequirement,
    action?: SpatialSkeletonAction,
  ): SpatialSkeletonInputReference {
    const inputReference = this.tryAcquireInputReference(requirement);
    if (inputReference !== undefined) return inputReference;
    const reason: SpatialSkeletonInspectionRequiredReason =
      this.getCachedSegmentSnapshotHandle(requirement.segmentId) === undefined
        ? "snapshot-unavailable"
        : "node-unavailable";
    throw new SpatialSkeletonInspectionRequiredError(
      requirement,
      action,
      reason,
    );
  }

  getCachedNode(nodeId: number) {
    return this.cachedNodesById.get(nodeId);
  }

  /**
   * Atomically replaces complete cached segments.
   *
   * Each input node and its position are cloned, and its segment id is set to
   * the entry key.  `undefined` deletes a cache entry; `[]` records a known
   * empty segment.  All input is validated before any cache or pending fetch
   * is changed.  Node-data listeners are notified once after the whole
   * replacement unless `notify` is false.
   */
  replaceCachedSegmentSnapshots(
    snapshots: Iterable<
      readonly [number, SpatialSkeletonCachedSegmentSnapshot]
    >,
    options: {
      notify?: boolean;
      /**
       * When supplied, no replacement is published unless every affected
       * segment still has the captured revision.  The check and the complete
       * cache replacement occur synchronously as one atomic operation.
       */
      expectedRevisions?: ReadonlyMap<number, number>;
    } = {},
  ) {
    const replacements = new Map<
      number,
      {
        nodes: readonly SpatiallyIndexedSkeletonNode[] | undefined;
        handle: CompleteSkeletonSnapshotHandle | undefined;
        adoptHandleStorage: boolean;
      }
    >();
    for (const [segmentId, snapshot] of snapshots) {
      if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
        throw new RangeError(
          `Invalid spatial skeleton segment id: ${segmentId}`,
        );
      }
      if (snapshot === undefined) {
        replacements.set(segmentId, {
          nodes: undefined,
          handle: undefined,
          adoptHandleStorage: false,
        });
        continue;
      }
      const clonedNodes: SpatiallyIndexedSkeletonNode[] = [];
      for (const node of snapshot) {
        if (!Number.isSafeInteger(node.nodeId) || node.nodeId <= 0) {
          throw new RangeError(
            `Invalid spatial skeleton node id: ${node.nodeId}`,
          );
        }
        clonedNodes.push(
          cloneSpatiallyIndexedSkeletonNode({ ...node, segmentId }),
        );
      }
      replacements.set(segmentId, {
        nodes: clonedNodes,
        // Untrusted input remains defensively cloned above. The immutable
        // handle is the complete baseline used by inspection and projection.
        handle: createCompleteSkeletonSnapshot(clonedNodes),
        adoptHandleStorage: false,
      });
    }
    return this.publishCachedSegmentSnapshotReplacements(replacements, options);
  }

  /** Routes only queue-owned reads through projection/history state. */
  private publishAuthoritativeReadSnapshots(
    snapshots: ReadonlyMap<
      number,
      readonly SpatiallyIndexedSkeletonNode[] | undefined
    >,
    options: {
      readonly notify?: boolean;
      readonly expectedRevisions: ReadonlyMap<number, number>;
    },
  ) {
    const runtime = this.optimisticProjectionRuntime;
    if (runtime === undefined) {
      return this.replaceCachedSegmentSnapshots(snapshots, {
        notify: options.notify,
        expectedRevisions: options.expectedRevisions,
      });
    }
    const owned = new Map<
      number,
      readonly SpatiallyIndexedSkeletonNode[] | undefined
    >();
    const ordinary = new Map<
      number,
      readonly SpatiallyIndexedSkeletonNode[] | undefined
    >();
    for (const [segmentId, snapshot] of snapshots) {
      (this.optimisticEditQueue?.ownsAuthoritativeReadSegment(segmentId)
        ? owned
        : ordinary
      ).set(segmentId, snapshot);
    }
    let changed = false;
    if (ordinary.size !== 0) {
      changed =
        this.replaceCachedSegmentSnapshots(ordinary, {
          notify: false,
          expectedRevisions: new Map(
            [...ordinary.keys()].map((segmentId) => [
              segmentId,
              options.expectedRevisions.get(segmentId)!,
            ]),
          ),
        }) || changed;
    }
    if (owned.size !== 0) {
      changed =
        runtime.publishAuthoritativeRead(
          [...owned].map(([segmentId, nodes]) => ({
            segmentId,
            snapshot:
              nodes === undefined
                ? undefined
                : createCompleteSkeletonSnapshot(nodes),
          })),
          {
            notify: false,
            expectedCacheRevisions: new Map(
              [...owned.keys()].map((segmentId) => [
                segmentId,
                options.expectedRevisions.get(segmentId)!,
              ]),
            ),
          },
        ) || changed;
    }
    if (changed && (options.notify ?? true)) {
      this.markNodeDataChanged({ invalidateFullSkeletonCache: false });
    }
    return changed;
  }

  /**
   * Fully prepares the state-owned portion of an optimistic publication.
   * Lazy handles are materialized, reverse ownership is validated, cache
   * revisions are fenced, and complete replacement maps/presentation values
   * are built before the returned opaque artifact can be adopted.
   */
  prepareSpatialSkeletonProjectionStatePublication(
    request: SpatialSkeletonProjectionStatePublicationRequest,
  ): SpatialSkeletonPreparedProjectionStatePublication | undefined {
    const handles = new Map<
      number,
      CompleteSkeletonSnapshotHandle | undefined
    >();
    for (const [segmentId, handle] of request.snapshots) {
      if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
        throw new RangeError(
          `Invalid spatial skeleton segment id: ${segmentId}`,
        );
      }
      if (handles.has(segmentId)) {
        throw new Error(
          `Spatial skeleton projection publication contains duplicate segment ${segmentId}.`,
        );
      }
      handles.set(segmentId, handle);
    }

    const retiredSegmentIds = new Set(request.retiredSegmentIds);
    for (const segmentId of retiredSegmentIds) {
      if (!handles.has(segmentId) || handles.get(segmentId) !== undefined) {
        throw new Error(
          `Retired spatial skeleton segment ${segmentId} must be removed from the complete-snapshot cache.`,
        );
      }
    }

    for (const segmentId of handles.keys()) {
      if (
        request.expectedRevisions.get(segmentId) !==
        this.getCurrentCachedSegmentRevision(segmentId)
      ) {
        return undefined;
      }
    }

    const replacements = new Map<
      number,
      SpatialSkeletonCachedSegmentReplacement
    >();
    for (const [segmentId, handle] of handles) {
      if (handle === undefined) {
        replacements.set(segmentId, {
          nodes: undefined,
          handle: undefined,
          adoptHandleStorage: true,
        });
        continue;
      }
      const nodes = handle.materialize();
      for (const node of nodes) {
        if (!Number.isSafeInteger(node.nodeId) || node.nodeId <= 0) {
          throw new RangeError(
            `Invalid spatial skeleton node id: ${node.nodeId}`,
          );
        }
        if (node.segmentId !== segmentId) {
          throw new Error(
            `Trusted complete skeleton handle for segment ${segmentId} contains node ${node.nodeId} owned by segment ${node.segmentId}.`,
          );
        }
      }
      replacements.set(segmentId, {
        nodes,
        handle,
        adoptHandleStorage: true,
      });
    }

    const nextPresentationRemovedSegmentIds = new Set(
      this.presentationRemovedSegmentIds,
    );
    for (const [segmentId, handle] of handles) {
      if (handle === undefined)
        nextPresentationRemovedSegmentIds.add(segmentId);
      else nextPresentationRemovedSegmentIds.delete(segmentId);
    }
    const removalsChanged =
      nextPresentationRemovedSegmentIds.size !==
        this.presentationRemovedSegmentIds.size ||
      [...nextPresentationRemovedSegmentIds].some(
        (id) => !this.presentationRemovedSegmentIds.has(id),
      );

    const changedSegmentIds = [...replacements]
      .filter(([segmentId, replacement]) => {
        const currentHandle = this.fullSegmentSnapshotHandles.get(segmentId);
        return (
          retiredSegmentIds.has(segmentId) ||
          replacement.handle !== currentHandle?.handle ||
          replacement.nodes !== this.fullSegmentNodeCache.get(segmentId)
        );
      })
      .map(([segmentId]) => segmentId);
    const changedSegmentIdSet = new Set(changedSegmentIds);
    const nextFullSegmentNodeCache = new Map(this.fullSegmentNodeCache);
    const nextFullSegmentSnapshotHandles = new Map(
      this.fullSegmentSnapshotHandles,
    );
    const nextCachedNodesById = new Map(this.cachedNodesById);

    for (const segmentId of changedSegmentIds) {
      for (const node of this.fullSegmentNodeCache.get(segmentId) ?? []) {
        if (nextCachedNodesById.get(node.nodeId) === node) {
          nextCachedNodesById.delete(node.nodeId);
        }
      }
    }
    for (const [segmentId, replacement] of replacements) {
      if (!changedSegmentIdSet.has(segmentId)) continue;
      for (const node of replacement.nodes ?? []) {
        const existing = nextCachedNodesById.get(node.nodeId);
        if (existing !== undefined) {
          throw new Error(
            `Spatial skeleton node ${node.nodeId} is present in both segment ${existing.segmentId} and segment ${segmentId}.`,
          );
        }
        nextCachedNodesById.set(node.nodeId, node);
      }
      if (replacement.nodes === undefined) {
        nextFullSegmentNodeCache.delete(segmentId);
      } else {
        nextFullSegmentNodeCache.set(
          segmentId,
          replacement.nodes as SpatiallyIndexedSkeletonNode[],
        );
      }
    }

    const expectedCacheRevisionClock = this.fullSegmentNodeRevisionClock;
    let nextCacheRevisionClock = expectedCacheRevisionClock;
    const nextFullSegmentNodeRevisions = new Map(this.fullSegmentNodeRevisions);
    const cacheRevisions = new Map<number, number>();
    for (const segmentId of changedSegmentIds) {
      const cacheRevision = ++nextCacheRevisionClock;
      nextFullSegmentNodeRevisions.set(segmentId, cacheRevision);
      const handle = replacements.get(segmentId)!.handle;
      if (handle === undefined) {
        nextFullSegmentSnapshotHandles.delete(segmentId);
      } else {
        nextFullSegmentSnapshotHandles.set(segmentId, {
          handle,
          cacheRevision,
        });
      }
    }
    for (const segmentId of handles.keys()) {
      cacheRevisions.set(
        segmentId,
        Math.max(
          this.fullSegmentNodeRevisionFloor,
          nextFullSegmentNodeRevisions.get(segmentId) ?? 0,
        ),
      );
    }

    const identities = this.prepareSpatialSkeletonPresentationIdentities(
      request.activeLogicalOwners,
      request.numericAliases,
      request.provisionalNodeIds,
    );
    const nextPreparationsById = new Map(this.spatialSkeletonPreparationsById);
    let preparationsChanged = false;
    for (const intentId of request.preparationIntentIdsToRemove) {
      preparationsChanged =
        nextPreparationsById.delete(
          normalizePreparationId(intentId, "preparation intent id"),
        ) || preparationsChanged;
    }
    const publishPresentation =
      removalsChanged ||
      identities.changed ||
      preparationsChanged ||
      (request.notify && changedSegmentIds.length !== 0);
    const presentation = publishPresentation
      ? this.prepareSpatialSkeletonPresentationPublication({
          fullSegmentSnapshotHandles: nextFullSegmentSnapshotHandles,
          fullSegmentNodeRevisions: nextFullSegmentNodeRevisions,
          logicalOwners: identities.nextOwners,
          numericAliases: identities.nextAliases,
          provisionalNodeIds: identities.nextProvisionalNodeIds,
          removedSegmentIds: nextPresentationRemovedSegmentIds,
          preparationsById: nextPreparationsById,
          revision: this.spatialSkeletonPresentation.value.revision + 1,
        })
      : undefined;

    const implementation: SpatialSkeletonPreparedProjectionStatePublicationImplementation =
      {
        [preparedSpatialSkeletonProjectionStatePublicationBrand]: true,
        owner: this.projectionStatePublicationOwner,
        expectedCacheRevisionClock,
        expectedPresentation: this.spatialSkeletonPresentation.value,
        expectedRevisions: new Map(request.expectedRevisions),
        cacheRevisions,
        nextCacheRevisionClock,
        nextFullSegmentNodeRevisions,
        nextFullSegmentNodeCache,
        nextFullSegmentSnapshotHandles,
        nextCachedNodesById,
        nextPresentationLogicalOwners: identities.nextOwners,
        nextPresentationNumericAliases: identities.nextAliases,
        nextPresentationProvisionalNodeIds: identities.nextProvisionalNodeIds,
        nextPresentationRemovedSegmentIds,
        nextPreparationsById,
        changedSegmentIds: Object.freeze(changedSegmentIds),
        abortSegmentIds: Object.freeze([...changedSegmentIds]),
        retiredSegmentIds,
        notifyNodeData: request.notify && changedSegmentIds.length !== 0,
        ...(presentation === undefined ? {} : { presentation }),
      };
    return Object.freeze(implementation);
  }

  /** Installs a genuine prepared publication using reference assignments only. */
  adoptPreparedSpatialSkeletonProjectionStatePublication(
    publication: SpatialSkeletonPreparedProjectionStatePublication,
  ): SpatialSkeletonAdoptedProjectionStatePublication | undefined {
    const prepared =
      publication as SpatialSkeletonPreparedProjectionStatePublicationImplementation;
    if (
      prepared?.owner !== this.projectionStatePublicationOwner ||
      prepared[preparedSpatialSkeletonProjectionStatePublicationBrand] !== true
    ) {
      throw new TypeError(
        "Prepared spatial skeleton projection publication belongs to another state.",
      );
    }
    if (this.adoptedProjectionStatePublications.has(prepared)) {
      throw new Error(
        "Prepared spatial skeleton projection publication was already adopted.",
      );
    }
    if (
      this.fullSegmentNodeRevisionClock !==
        prepared.expectedCacheRevisionClock ||
      this.spatialSkeletonPresentation.value !== prepared.expectedPresentation
    ) {
      return undefined;
    }
    for (const [segmentId, expectedRevision] of prepared.expectedRevisions) {
      if (
        this.getCurrentCachedSegmentRevision(segmentId) !== expectedRevision
      ) {
        return undefined;
      }
    }

    this.adoptedProjectionStatePublications.add(prepared);
    this.fullSegmentNodeRevisionClock = prepared.nextCacheRevisionClock;
    this.fullSegmentNodeRevisions = prepared.nextFullSegmentNodeRevisions;
    this.fullSegmentNodeCache = prepared.nextFullSegmentNodeCache;
    this.fullSegmentSnapshotHandles = prepared.nextFullSegmentSnapshotHandles;
    this.cachedNodesById = prepared.nextCachedNodesById;
    this.presentationLogicalOwners = prepared.nextPresentationLogicalOwners;
    this.presentationNumericAliases = prepared.nextPresentationNumericAliases;
    this.presentationProvisionalNodeIds =
      prepared.nextPresentationProvisionalNodeIds;
    this.presentationRemovedSegmentIds =
      prepared.nextPresentationRemovedSegmentIds;
    this.spatialSkeletonPreparationsById = prepared.nextPreparationsById;
    if (prepared.notifyNodeData) this.nodeDataNotificationPending = true;
    if (prepared.presentation !== undefined) {
      this.presentationPublicationPending = false;
      this.preparedPresentationPublication = prepared.presentation;
    }
    return prepared;
  }

  /** Runs callback-bearing cache cleanup only after core adoption completed. */
  finalizePreparedSpatialSkeletonProjectionStatePublication(
    publication: SpatialSkeletonPreparedProjectionStatePublication,
    reportError?: (error: unknown) => void,
  ) {
    const prepared =
      publication as SpatialSkeletonPreparedProjectionStatePublicationImplementation;
    if (
      prepared?.owner !== this.projectionStatePublicationOwner ||
      !this.adoptedProjectionStatePublications.has(prepared)
    ) {
      throw new TypeError(
        "Only an adopted state-owned spatial skeleton publication can be finalized.",
      );
    }
    for (const segmentId of prepared.abortSegmentIds) {
      try {
        this.abortPendingFullSegmentNodeFetch(
          segmentId,
          prepared.retiredSegmentIds.has(segmentId)
            ? "spatial skeleton full-segment inspection request retired after authoritative topology change"
            : "spatial skeleton full-segment inspection request replaced by atomic local cache update",
          { preserveRetained: !prepared.retiredSegmentIds.has(segmentId) },
        );
      } catch (error) {
        try {
          reportError?.(error);
        } catch {
          // Finalization is best effort after the model is already adopted.
        }
      }
    }
  }

  private publishCachedSegmentSnapshotReplacements(
    replacements: ReadonlyMap<
      number,
      {
        nodes: readonly SpatiallyIndexedSkeletonNode[] | undefined;
        handle: CompleteSkeletonSnapshotHandle | undefined;
        adoptHandleStorage: boolean;
      }
    >,
    options: {
      notify?: boolean;
      expectedRevisions?: ReadonlyMap<number, number>;
    },
  ) {
    if (replacements.size === 0) return false;

    if (options.expectedRevisions !== undefined) {
      for (const segmentId of replacements.keys()) {
        if (
          options.expectedRevisions.get(segmentId) !==
          this.getCurrentCachedSegmentRevision(segmentId)
        ) {
          return false;
        }
      }
    }

    const changedSegmentIds: number[] = [];
    for (const [segmentId, replacement] of replacements) {
      const currentHandle = this.fullSegmentSnapshotHandles.get(segmentId);
      if (
        replacement.adoptHandleStorage
          ? replacement.handle !== currentHandle?.handle ||
            replacement.nodes !== this.fullSegmentNodeCache.get(segmentId)
          : !cachedSegmentSnapshotsEqual(
              this.fullSegmentNodeCache.get(segmentId),
              replacement.nodes,
            )
      ) {
        changedSegmentIds.push(segmentId);
      }
    }
    if (changedSegmentIds.length === 0) {
      return false;
    }
    const changedSegmentIdSet = new Set(changedSegmentIds);

    // Validate the prospective reverse-index entries before mutating either
    // cache.  The existing reverse index lets us check ownership against every
    // unaffected segment without walking or rebuilding their complete
    // snapshots.  Entries owned by changed segments are intentionally ignored:
    // those old entries are removed below before the validated replacements
    // are installed.  `nextChangedNodesById` additionally rejects duplicates
    // between (or within) the replacements themselves.
    const nextChangedNodesById = new Map<
      number,
      SpatiallyIndexedSkeletonNode
    >();
    for (const [segmentId, replacement] of replacements) {
      if (
        changedSegmentIdSet.has(segmentId) &&
        replacement.nodes !== undefined
      ) {
        for (const node of replacement.nodes) {
          const changedExisting = nextChangedNodesById.get(node.nodeId);
          if (changedExisting !== undefined) {
            throw new Error(
              `Spatial skeleton node ${node.nodeId} is present in both segment ${changedExisting.segmentId} and segment ${segmentId}.`,
            );
          }
          const unaffectedExisting = this.cachedNodesById.get(node.nodeId);
          if (
            unaffectedExisting !== undefined &&
            !changedSegmentIdSet.has(unaffectedExisting.segmentId)
          ) {
            throw new Error(
              `Spatial skeleton node ${node.nodeId} is present in both segment ${unaffectedExisting.segmentId} and segment ${segmentId}.`,
            );
          }
          nextChangedNodesById.set(node.nodeId, node);
        }
      }
    }

    for (const segmentId of changedSegmentIds) {
      this.abortPendingFullSegmentNodeFetch(
        segmentId,
        "spatial skeleton full-segment inspection request replaced by atomic local cache update",
        { preserveRetained: true },
      );
    }
    // Remove only reverse-index entries belonging to snapshots that are about
    // to change.  Identity guards against deleting a newer/corrupt entry if an
    // invariant was violated elsewhere, while the validation above still
    // makes this entire publication all-or-nothing for expected input.
    for (const segmentId of changedSegmentIds) {
      const previousNodes = this.fullSegmentNodeCache.get(segmentId);
      if (previousNodes === undefined) continue;
      for (const node of previousNodes) {
        if (this.cachedNodesById.get(node.nodeId) === node) {
          this.cachedNodesById.delete(node.nodeId);
        }
      }
    }
    for (const [segmentId, replacement] of replacements) {
      if (!changedSegmentIdSet.has(segmentId)) continue;
      if (replacement.nodes === undefined) {
        this.fullSegmentNodeCache.delete(segmentId);
      } else {
        this.presentationRemovedSegmentIds.delete(segmentId);
        // The public cache historically exposes a mutable-array type. Trusted
        // handle materializations are frozen readonly arrays at runtime, but
        // retaining the established type avoids widening unrelated callers.
        this.fullSegmentNodeCache.set(
          segmentId,
          replacement.nodes as SpatiallyIndexedSkeletonNode[],
        );
      }
    }
    for (const segmentId of changedSegmentIds) {
      const cacheRevision = this.advanceCachedSegmentRevision(segmentId);
      const handle = replacements.get(segmentId)!.handle;
      if (handle === undefined) {
        this.fullSegmentSnapshotHandles.delete(segmentId);
      } else {
        this.fullSegmentSnapshotHandles.set(segmentId, {
          handle,
          cacheRevision,
        });
      }
    }
    for (const [nodeId, node] of nextChangedNodesById) {
      this.cachedNodesById.set(nodeId, node);
    }
    if (options.notify ?? true) {
      this.markNodeDataChanged({ invalidateFullSkeletonCache: false });
    }
    return true;
  }

  private deleteCachedSegment(segmentId: number) {
    const previousSegmentNodes = this.fullSegmentNodeCache.get(segmentId);
    if (previousSegmentNodes === undefined) return false;
    for (const node of previousSegmentNodes) {
      if (this.cachedNodesById.get(node.nodeId) === node) {
        this.cachedNodesById.delete(node.nodeId);
      }
    }

    this.fullSegmentNodeCache.delete(segmentId);
    this.fullSegmentSnapshotHandles.delete(segmentId);
    this.advanceCachedSegmentRevision(segmentId);
    return true;
  }

  private abortPendingFullSegmentNodeFetch(
    segmentId: number,
    message: string,
    options: { preserveRetained?: boolean } = {},
  ) {
    const pendingEntry = this.pendingFullSegmentNodeFetches.get(segmentId);
    if (
      pendingEntry === undefined ||
      ((options.preserveRetained ?? false) && pendingEntry.retainWhileInactive)
    ) {
      return false;
    }
    pendingEntry.abortController.abort(new DOMException(message, "AbortError"));
    this.pendingFullSegmentNodeFetches.delete(segmentId);
    return true;
  }

  /**
   * Releases every pending full-skeleton read leased by `owner`.
   *
   * A shared request is aborted only after its final explicit owner is
   * released and only if no unowned (for example, visual) consumer ever
   * joined it. Fetch retention remains monotonic for surviving shared
   * consumers: releasing an owner does not undo retention.
   */
  releaseFullSegmentNodeFetchOwner(owner: object) {
    let released = false;
    for (const [segmentId, pendingEntry] of this
      .pendingFullSegmentNodeFetches) {
      if (!pendingEntry.requestOwners.delete(owner)) continue;
      released = true;
      if (
        pendingEntry.requestOwners.size === 0 &&
        !pendingEntry.hasUnownedConsumer
      ) {
        this.abortPendingFullSegmentNodeFetch(
          segmentId,
          "spatial skeleton full-segment request owner released",
        );
      }
    }
    return released;
  }

  private getCurrentCachedSegmentRevision(segmentId: number) {
    return Math.max(
      this.fullSegmentNodeRevisionFloor,
      this.fullSegmentNodeRevisions.get(segmentId) ?? 0,
    );
  }

  private advanceCachedSegmentRevision(segmentId: number) {
    const revision = ++this.fullSegmentNodeRevisionClock;
    this.fullSegmentNodeRevisions.set(segmentId, revision);
    return revision;
  }

  evictInactiveSegmentNodes(activeSegmentIds: Iterable<number>) {
    const activeSegmentIdSet = new Set(activeSegmentIds);
    for (const segmentId of this.optimisticEditQueue?.getProtectedProjectionSegmentIds() ??
      []) {
      if (Number.isSafeInteger(segmentId) && segmentId > 0) {
        activeSegmentIdSet.add(segmentId);
      }
    }
    for (const [segmentId, registrationsForSegment] of this
      .queueInputReferenceRegistrations) {
      const current = this.getCachedSegmentSnapshotHandle(segmentId);
      for (const [token, snapshot] of registrationsForSegment) {
        if (
          current?.handle === snapshot.handle &&
          current.cacheRevision === snapshot.cacheRevision
        ) {
          activeSegmentIdSet.add(segmentId);
        } else {
          // A replacement or explicit invalidation makes this input reference
          // stale. Do not let it accidentally retain a newer snapshot.
          registrationsForSegment.delete(token);
        }
      }
      if (registrationsForSegment.size === 0) {
        this.queueInputReferenceRegistrations.delete(segmentId);
      }
    }
    let changed = false;
    for (const segmentId of this.fullSegmentNodeCache.keys()) {
      if (activeSegmentIdSet.has(segmentId)) continue;
      changed = this.deleteCachedSegment(segmentId) || changed;
    }
    for (const [segmentId, pendingEntry] of this
      .pendingFullSegmentNodeFetches) {
      if (
        activeSegmentIdSet.has(segmentId) ||
        pendingEntry.retainWhileInactive
      ) {
        continue;
      }
      if (
        this.abortPendingFullSegmentNodeFetch(
          segmentId,
          "spatial skeleton full-segment inspection request evicted for inactive segment",
        )
      ) {
        // There may not have been a cache entry to delete, but eviction is
        // still an explicit invalidation of this fetch's publication fence.
        this.advanceCachedSegmentRevision(segmentId);
      }
    }
    return changed;
  }

  async getFullSegmentNodes(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    segmentId: number,
    options: {
      retainWhileInactive?: boolean;
      /**
       * Opaque lease owner that can release this pending read on disposal.
       * An owned read starts before unowned reads waiting for a slot.
       */
      requestOwner?: object;
    } = {},
  ): Promise<SpatiallyIndexedSkeletonNode[]> {
    const cached = this.fullSegmentNodeCache.get(segmentId);
    if (cached !== undefined) {
      return cached;
    }
    const pendingEntry = this.pendingFullSegmentNodeFetches.get(segmentId);
    if (pendingEntry !== undefined) {
      if (options.requestOwner === undefined) {
        pendingEntry.hasUnownedConsumer = true;
      } else {
        pendingEntry.requestOwners.add(options.requestOwner);
      }
      if (options.retainWhileInactive) {
        // A command may join a fetch that was originally started only for the
        // render overlay. Promote the shared request so visibility-based cache
        // eviction cannot cancel work that an edit is actively awaiting.
        pendingEntry.retainWhileInactive = true;
      }
      return pendingEntry.promise;
    }
    const skeletonSource = getSpatiallyIndexedSkeletonSource(skeletonLayer);
    if (skeletonSource === undefined) {
      throw new Error(
        "The active spatial skeleton source does not expose full skeleton inspection.",
      );
    }
    const fetchRevision = this.getCachedSegmentRevision(segmentId);
    const abortController = new AbortController();
    const pendingFetch: {
      promise?: Promise<SpatiallyIndexedSkeletonNode[]>;
    } = {};
    this.fullSegmentNodeFetchLimitLayer = skeletonLayer;
    const fetchPromise = this.fullSegmentNodeFetchLimiter
      .run(
        async () => {
          if (abortController.signal.aborted) {
            throw (
              abortController.signal.reason ??
              new DOMException("Skeleton request aborted.", "AbortError")
            );
          }
          const timeout = setTimeout(() => {
            abortController.abort(
              new DOMException(
                `Spatial skeleton ${segmentId} full-segment request timed out.`,
                "TimeoutError",
              ),
            );
          }, FULL_SEGMENT_NODE_FETCH_TIMEOUT_MS);
          let rejectAbort!: (reason: unknown) => void;
          const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
          });
          const rejectFromAbort = () =>
            rejectAbort(
              abortController.signal.reason ??
                new DOMException("Skeleton request aborted.", "AbortError"),
            );
          abortController.signal.addEventListener("abort", rejectFromAbort, {
            once: true,
          });
          let sourceRequest: Promise<SpatiallyIndexedSkeletonNode[]>;
          try {
            sourceRequest = Promise.resolve(
              skeletonSource.getSkeleton(segmentId, {
                signal: abortController.signal,
              }),
            );
          } catch (error) {
            sourceRequest = Promise.reject(error);
          }
          // If abort/deadline wins the race, the source may still resolve or
          // reject later because not every implementation observes its
          // signal. Keep that detached outcome observed.
          void sourceRequest.catch(() => undefined);
          let fetchedNodes: SpatiallyIndexedSkeletonNode[];
          try {
            fetchedNodes = await Promise.race([sourceRequest, aborted]);
          } finally {
            clearTimeout(timeout);
            abortController.signal.removeEventListener(
              "abort",
              rejectFromAbort,
            );
          }
          const normalizedNodes: SpatiallyIndexedSkeletonNode[] = [];
          for (const fetchedNode of fetchedNodes) {
            const mappedNode = normalizeSpatiallyIndexedSkeletonNode(
              fetchedNode,
              segmentId,
            );
            if (mappedNode === undefined) continue;
            normalizedNodes.push(mappedNode);
          }
          normalizedNodes.sort((a, b) => a.nodeId - b.nodeId);
          if (
            this.getCurrentCachedSegmentRevision(segmentId) === fetchRevision &&
            pendingFetch.promise !== undefined &&
            this.pendingFullSegmentNodeFetches.get(segmentId)?.promise ===
              pendingFetch.promise
          ) {
            this.publishAuthoritativeReadSnapshots(
              new Map([[segmentId, normalizedNodes]]),
              {
                expectedRevisions: new Map([[segmentId, fetchRevision]]),
              },
            );
          }
          return normalizedNodes;
        },
        {
          signal: abortController.signal,
          isPrioritized: () => {
            const pendingEntry =
              this.pendingFullSegmentNodeFetches.get(segmentId);
            return (
              pendingEntry !== undefined &&
              pendingEntry.promise === pendingFetch.promise &&
              pendingEntry.requestOwners.size > 0
            );
          },
        },
      )
      .finally(() => {
        if (
          this.pendingFullSegmentNodeFetches.get(segmentId)?.promise ===
          pendingFetch.promise
        ) {
          this.pendingFullSegmentNodeFetches.delete(segmentId);
        }
      });
    pendingFetch.promise = fetchPromise;
    this.pendingFullSegmentNodeFetches.set(segmentId, {
      promise: fetchPromise,
      abortController,
      retainWhileInactive: options.retainWhileInactive ?? false,
      requestOwners:
        options.requestOwner === undefined
          ? new Set<object>()
          : new Set([options.requestOwner]),
      hasUnownedConsumer: options.requestOwner === undefined,
    });
    return fetchPromise;
  }

  private clearFullSkeletonCache() {
    this.fullSegmentNodeRevisionFloor = ++this.fullSegmentNodeRevisionClock;
    this.fullSegmentNodeRevisions.clear();
    for (const segmentId of this.pendingFullSegmentNodeFetches.keys()) {
      this.abortPendingFullSegmentNodeFetch(
        segmentId,
        "stale spatial skeleton full-segment inspection request",
      );
    }
    this.fullSegmentNodeCache.clear();
    this.fullSegmentSnapshotHandles.clear();
    this.queueInputReferenceRegistrations.clear();
    this.cachedNodesById.clear();
  }

  disposed() {
    this.releaseOptimisticEditingEngine();
    super.disposed();
  }
}

export interface SpatialSkeletonLayerContext {
  getSpatiallyIndexedSkeletonLayer(): SpatiallyIndexedSkeletonLayer | undefined;
  readonly spatialSkeletonState: SpatialSkeletonState;
  /** Optional because headless/test layer contexts have no presentation UI. */
  applySpatialSkeletonProjectionUiHints?(
    hints: SpatialSkeletonResolvedProjectionUiHints,
  ): void;
}
