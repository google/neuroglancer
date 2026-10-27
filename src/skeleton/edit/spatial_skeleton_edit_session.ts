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
 * @file Holds one layer's spatial skeleton editing state: its edit modes, its
 * edit queue, its complete skeleton cache, and the display of confirmed
 * skeletons and previews.
 */

import type {
  EditableSkeletonSource,
  SkeletonNode,
} from "#src/skeleton/api.js";
import type {
  CompleteSkeletonCachePublication,
  CompleteSkeletonDownloadTarget,
  SpatialSkeletonCachedSegmentSnapshot,
} from "#src/skeleton/edit/complete_skeleton_cache.js";
import { CompleteSkeletonCache } from "#src/skeleton/edit/complete_skeleton_cache.js";
import type {
  SpatialSkeletonAction,
  SpatialSkeletonEditCommand,
} from "#src/skeleton/edit_commands.js";
import { getSpatialSkeletonEditCommandFactoryFromSource } from "#src/skeleton/edit_commands.js";
import type {
  SpatialSkeletonEditPlannerProvider,
  SpatialSkeletonProvisionalNumericIdPolicy,
  SpatialSkeletonProvisionalNumericIdService,
} from "#src/skeleton/edit_queue/api.js";
import {
  assertSpatialSkeletonEditPlannerRegistration,
  isSpatialSkeletonEditPlannerProvider,
  SpatialSkeletonDatasourceContractError,
} from "#src/skeleton/edit_queue/api.js";
import type { CompleteSkeleton } from "#src/skeleton/edit_queue/complete_skeleton.js";
import { createCompleteSkeleton } from "#src/skeleton/edit_queue/complete_skeleton.js";
import { SpatialSkeletonEditQueue } from "#src/skeleton/edit_queue/edit_queue.js";
import type {
  SpatialSkeletonPreparedPreviewCachePublication,
  SpatialSkeletonDisplayStableOwner,
  SpatialSkeletonDisplayNumericAlias,
  SpatialSkeletonPreviewCachePublicationRequest,
} from "#src/skeleton/edit_queue/preview.js";
import {
  preparedSpatialSkeletonPreviewCachePublicationBrand,
  SpatialSkeletonEditPreview,
} from "#src/skeleton/edit_queue/preview.js";
import type { SpatialSkeletonResolvedPreviewUiHints } from "#src/skeleton/edit_queue/preview_ui_hints.js";
import type {
  SpatialSkeletonQueueInput,
  SpatialSkeletonQueueInputPreparation,
  SpatialSkeletonQueueInputRequirement,
} from "#src/skeleton/edit_queue/queue_input.js";
import { SpatialSkeletonRequestScheduler } from "#src/skeleton/edit_queue/request_scheduler.js";
import type {
  SpatialSkeletonStableNodeHandle,
  SpatialSkeletonStableSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import type {
  SpatialSkeletonEditActivityEntry,
  SpatialSkeletonEditExecution,
  SpatialSkeletonSessionEditQueue,
  SpatialSkeletonEditQueueEntry,
  SpatialSkeletonUndoRedoControls,
  SpatialSkeletonReloadRequiredDetails,
} from "#src/skeleton/edit_queue/types.js";
import {
  DEFAULT_SPATIAL_SKELETON_EDIT_QUEUE_CAPACITY,
  freezeSpatialSkeletonReloadRequiredDetails,
  SpatialSkeletonReloadRequiredError,
  unchangedSpatialSkeletonEditSettlement,
} from "#src/skeleton/edit_queue/types.js";
import {
  createSpatialSkeletonHistoryPort,
  SpatialSkeletonUndoHistory,
} from "#src/skeleton/edit_queue/undo_history.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";
import { bigintCompare } from "#src/util/bigint.js";
import { RefCounted } from "#src/util/disposable.js";

export function getSpatialSkeletonEditPlannerProvider(
  source: EditableSkeletonSource,
): SpatialSkeletonEditPlannerProvider | undefined {
  const candidate = source.editPlannerProvider;
  return isSpatialSkeletonEditPlannerProvider(candidate)
    ? candidate
    : undefined;
}

/**
 * Ensures the session-owned queue using the editable source's validated planner.
 *
 * Command construction calls this boundary every time. The layer state reuses
 * its existing engine for the same source and replaces it only after a new
 * datasource registration has been validated.
 */
export function ensureSpatialSkeletonEditQueue(
  layer: SpatialSkeletonLayerContext,
  source: EditableSkeletonSource,
): SpatialSkeletonSessionEditQueue {
  const state = layer.spatialSkeletonEditSession;
  const provider = getSpatialSkeletonEditPlannerProvider(source);
  if (provider === undefined) {
    throw new SpatialSkeletonDatasourceContractError(
      "Writable spatial skeleton datasource is missing editPlannerProvider.createPlanner().",
    );
  }
  return state.ensureEditQueue(layer, source, provider);
}

function resolvedEditExecution<T>(value: T): SpatialSkeletonEditExecution<T> {
  const execution = Promise.resolve(value);
  Object.defineProperty(execution, "acceptedByQueue", {
    configurable: true,
    value: Promise.resolve(),
  });
  Object.defineProperty(execution, "settled", {
    configurable: true,
    value: Promise.resolve(unchangedSpatialSkeletonEditSettlement("no-op")),
  });
  return execution as SpatialSkeletonEditExecution<T>;
}

function rejectedEditExecution<T>(
  error: unknown,
): SpatialSkeletonEditExecution<T> {
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
      unchangedSpatialSkeletonEditSettlement("not-started", error),
    ),
  });
  return execution as SpatialSkeletonEditExecution<T>;
}

export type SpatialSkeletonPendingEditKind =
  | "merge"
  | "split"
  | "delete"
  | "restore"
  | "reroot";

export type SpatialSkeletonPendingEditDirection = "execute" | "undo" | "redo";

export type SpatialSkeletonPendingEditLifecycle = "preparing";

/**
 * A position captured when a structural intent is admitted. Preparations use these
 * values only when the live node cache cannot resolve the corresponding node;
 * they are therefore truthful last-known locations, not invented topology.
 */
export interface SpatialSkeletonPendingEditPosition {
  readonly nodeId: bigint;
  readonly position: Float32Array;
}

/**
 * Lightweight visual feedback for a structural intent whose exact topology is
 * not available yet.  Node-id lists describe only relationships the command
 * already knows: `endpointNodeIds` is the requested merge edge,
 * `cutParentNodeId` is the existing edge being cut, and `pathNodeIds` is an
 * optional known path (never inferred by the renderer).
 */
export interface SpatialSkeletonPendingEdit {
  readonly intentId: number;
  readonly sequence: number;
  readonly direction: SpatialSkeletonPendingEditDirection;
  readonly kind: SpatialSkeletonPendingEditKind;
  readonly lifecycle: SpatialSkeletonPendingEditLifecycle;
  readonly stableNodeHandles?: readonly SpatialSkeletonStableNodeHandle[];
  readonly stableSegmentHandles?: readonly SpatialSkeletonStableSegmentHandle[];
  readonly segmentIds: readonly bigint[];
  readonly nodeId?: bigint;
  readonly endpointNodeIds?: readonly bigint[];
  readonly cutNodeId?: bigint;
  readonly cutParentNodeId?: bigint;
  readonly rootNodeId?: bigint;
  readonly pathNodeIds?: readonly bigint[];
  readonly lastKnownPositions?: readonly SpatialSkeletonPendingEditPosition[];
}

/**
 * The complete presentation observed by rendering and Skeleton Details.
 * Topology references are always exact complete-skeleton handles.  A cold
 * structural intent is represented only by `pendingEdits` until its exact
 * reducer result can be published in the same presentation transaction.
 */
export interface SpatialSkeletonDisplaySnapshot {
  readonly revision: number;
  /** Explicit preview removals, including pending deletions and retired IDs. */
  readonly removedSegmentIds: readonly bigint[];
  readonly activeStableOwners: readonly SpatialSkeletonDisplayStableOwner[];
  readonly numericAliases: readonly SpatialSkeletonDisplayNumericAlias[];
  /** Node ids that exist only in the local optimistic preview. */
  readonly provisionalNodeIds: readonly bigint[];
  readonly pendingEdits: readonly SpatialSkeletonPendingEdit[];
}

/**
 * Returns active numeric aliases that exist only in the optimistic preview.
 * These ids are presentation state rather than datasource identities and receive a
 * temporary render color until their owning operation is confirmed.
 */
function getActiveProvisionalSpatialSkeletonSegmentIds(
  display: SpatialSkeletonDisplaySnapshot,
): bigint[] {
  const activeOwners = new Map(
    display.activeStableOwners.map(({ segmentId, stableHandle }) => [
      segmentId,
      stableHandle.stableId,
    ]),
  );
  const provisionalSegmentIds = new Set<bigint>();
  for (const alias of display.numericAliases) {
    if (
      alias.authoritative !== false ||
      alias.segmentId === 0n ||
      activeOwners.get(alias.segmentId) !== alias.stableHandle.stableId
    ) {
      continue;
    }
    provisionalSegmentIds.add(alias.segmentId);
  }
  return [...provisionalSegmentIds].sort(bigintCompare);
}

export function getSpatialSkeletonEditCommandFactoryForAction(
  source: EditableSkeletonSource,
  action: SpatialSkeletonAction,
) {
  return getSpatialSkeletonEditCommandFactoryFromSource(source, action);
}

export function editableSpatiallyIndexedSkeletonSourceSupportsAction(
  source: EditableSkeletonSource,
  action: SpatialSkeletonAction,
) {
  const commandFactory = getSpatialSkeletonEditCommandFactoryForAction(
    source,
    action,
  );
  return commandFactory !== undefined;
}

interface SpatialSkeletonPreparedPreviewCachePublicationImplementation
  extends SpatialSkeletonPreparedPreviewCachePublication {
  readonly owner: object;
  readonly cache: CompleteSkeletonCachePublication;
  readonly expectedDisplay: SpatialSkeletonDisplaySnapshot;
  readonly nextDisplayStableOwners: Map<
    bigint,
    SpatialSkeletonStableSegmentHandle
  >;
  readonly nextDisplayNumericAliases: Map<
    string,
    { readonly segmentId: bigint; readonly authoritative: boolean }
  >;
  readonly nextDisplayProvisionalNodeIds: Set<bigint>;
  readonly nextDisplayRemovedSegmentIds: Set<bigint>;
  readonly nextPendingEditsById: Map<number, SpatialSkeletonPendingEdit>;
  readonly notifyNodeData: boolean;
  readonly display?: SpatialSkeletonDisplaySnapshot;
}

function normalizePendingEditId(value: number, label: string) {
  const normalized = Math.round(Number(value));
  if (!Number.isSafeInteger(normalized) || normalized === 0) {
    throw new RangeError(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

function normalizePendingEditNodeId(value: bigint, label: string) {
  if (value === 0n) {
    throw new RangeError(`Invalid ${label}: ${value}`);
  }
  return value;
}

function normalizePendingEditNodeIds(
  values: readonly bigint[] | undefined,
  label: string,
) {
  if (values === undefined) return undefined;
  return values.map((value) => normalizePendingEditNodeId(value, label));
}

function normalizeSpatialSkeletonPendingEdit(
  pendingEdit: SpatialSkeletonPendingEdit,
): SpatialSkeletonPendingEdit {
  const intentId = normalizePendingEditId(
    pendingEdit.intentId,
    "preparation intent id",
  );
  if (intentId < 0) {
    throw new RangeError(
      `Invalid preparation intent id: ${pendingEdit.intentId}`,
    );
  }
  if (
    pendingEdit.kind !== "merge" &&
    pendingEdit.kind !== "split" &&
    pendingEdit.kind !== "delete" &&
    pendingEdit.kind !== "restore" &&
    pendingEdit.kind !== "reroot"
  ) {
    throw new TypeError(
      `Invalid spatial skeleton preparation kind: ${pendingEdit.kind}`,
    );
  }
  if (pendingEdit.lifecycle !== "preparing") {
    throw new TypeError(
      `Invalid spatial skeleton preparation lifecycle: ${pendingEdit.lifecycle}`,
    );
  }
  const sequence = normalizePendingEditId(
    pendingEdit.sequence,
    "preparation sequence",
  );
  if (sequence < 0) {
    throw new RangeError(
      `Invalid preparation sequence: ${pendingEdit.sequence}`,
    );
  }
  const { direction } = pendingEdit;
  if (direction !== "execute" && direction !== "undo" && direction !== "redo") {
    throw new TypeError(`Invalid preparation direction: ${direction}`);
  }
  const normalizeOptionalId = (value: bigint | undefined, label: string) =>
    value === undefined ? undefined : normalizePendingEditNodeId(value, label);
  const lastKnownPositions = pendingEdit.lastKnownPositions?.map((entry) => {
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
      nodeId: normalizePendingEditNodeId(entry.nodeId, "preparation node id"),
      position,
    });
  });
  const cloneStableNodeHandle = ({
    kind,
    stableId,
  }: SpatialSkeletonStableNodeHandle) => {
    if (kind !== "node" || String(stableId).length === 0) {
      throw new TypeError("Invalid logical node handle in preparation.");
    }
    return Object.freeze({ kind, stableId: String(stableId) });
  };
  const cloneStableSegmentHandle = ({
    kind,
    stableId,
  }: SpatialSkeletonStableSegmentHandle) => {
    if (kind !== "segment" || String(stableId).length === 0) {
      throw new TypeError("Invalid logical segment handle in preparation.");
    }
    return Object.freeze({ kind, stableId: String(stableId) });
  };
  return Object.freeze({
    intentId,
    sequence,
    direction,
    kind: pendingEdit.kind,
    lifecycle: pendingEdit.lifecycle,
    stableNodeHandles:
      pendingEdit.stableNodeHandles === undefined
        ? undefined
        : Object.freeze(
            pendingEdit.stableNodeHandles.map(cloneStableNodeHandle),
          ),
    stableSegmentHandles:
      pendingEdit.stableSegmentHandles === undefined
        ? undefined
        : Object.freeze(
            pendingEdit.stableSegmentHandles.map(cloneStableSegmentHandle),
          ),
    segmentIds: Object.freeze(
      normalizePendingEditNodeIds(
        pendingEdit.segmentIds,
        "preparation segment id",
      )!,
    ),
    nodeId: normalizeOptionalId(pendingEdit.nodeId, "preparation node id"),
    endpointNodeIds:
      pendingEdit.endpointNodeIds === undefined
        ? undefined
        : Object.freeze(
            normalizePendingEditNodeIds(
              pendingEdit.endpointNodeIds,
              "preparation endpoint node id",
            )!,
          ),
    cutNodeId: normalizeOptionalId(
      pendingEdit.cutNodeId,
      "preparation cut node id",
    ),
    cutParentNodeId: normalizeOptionalId(
      pendingEdit.cutParentNodeId,
      "preparation cut-parent node id",
    ),
    rootNodeId: normalizeOptionalId(
      pendingEdit.rootNodeId,
      "preparation root node id",
    ),
    pathNodeIds:
      pendingEdit.pathNodeIds === undefined
        ? undefined
        : Object.freeze(
            normalizePendingEditNodeIds(
              pendingEdit.pathNodeIds,
              "preparation path node id",
            )!,
          ),
    lastKnownPositions:
      lastKnownPositions === undefined
        ? undefined
        : Object.freeze(lastKnownPositions),
  });
}

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
    const { policy } = this;
    if (policy === undefined) {
      throw new SpatialSkeletonDatasourceContractError(
        `This spatial skeleton datasource did not register a provisional numeric-ID policy for ${kind} creation.`,
      );
    }
    const id =
      kind === "node"
        ? policy.allocateNodeId(intentId)
        : policy.allocateSegmentId(intentId);
    if (id === 0n) {
      throw new SpatialSkeletonDatasourceContractError(
        `The datasource provisional ${kind} ID policy returned invalid ID ${id}.`,
      );
    }
    return id;
  }
}

type SessionOwnedSpatialSkeletonEditQueue = SpatialSkeletonSessionEditQueue & {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly SpatialSkeletonEditQueueEntry[];
  getRecentActivity(): readonly SpatialSkeletonEditActivityEntry[];
  submitExecute(
    command: SpatialSkeletonEditCommand,
    queueInput:
      | SpatialSkeletonQueueInput
      | SpatialSkeletonQueueInputPreparation,
  ): SpatialSkeletonEditExecution<boolean>;
  submitUndo(): SpatialSkeletonEditExecution<boolean>;
  submitRedo(): SpatialSkeletonEditExecution<boolean>;
};

export interface SpatialSkeletonEditSessionOptions {
  /** Shared admission, history, and recent-activity capacity. */
  readonly editQueueCapacity?: number;
}

export interface SpatialSkeletonLayerContext {
  getSpatiallyIndexedSkeletonLayer(): SpatiallyIndexedSkeletonLayer | undefined;
  readonly spatialSkeletonEditSession: SpatialSkeletonEditSession;
  /** Optional because headless/test layer contexts have no presentation UI. */
  applySpatialSkeletonPreviewUiHints?(
    hints: SpatialSkeletonResolvedPreviewUiHints,
  ): void;
}

export class SpatialSkeletonEditSession
  extends RefCounted
  implements SpatialSkeletonUndoRedoControls, CompleteSkeletonDownloadTarget
{
  readonly commandHistory: SpatialSkeletonUndoHistory;
  readonly editQueueCapacity: number;
  readonly editMode = new WatchableValue(false);
  readonly mergeMode = new WatchableValue(false);
  readonly splitMode = new WatchableValue(false);
  readonly mergeAnchorNodeId = new WatchableValue<bigint | undefined>(
    undefined,
  );
  // When true, the selected-node highlight is hidden even if a node is
  // selected. Driven by the edit tool so that entering merge/split mode does
  // not display a stale highlight until the user makes their first click
  // (merge) or is suppressed entirely until a click/exit (split).
  readonly suppressSelectedNodeHighlight = new WatchableValue(false);
  readonly provisionalSegmentIds = this.registerDisposer(new Uint64Set());
  readonly nodeDataVersion = new WatchableValue(0);
  readonly pendingNodePositionVersion = new WatchableValue(0);
  readonly editQueueVersion = new WatchableValue(0);
  /**
   * Shared exact topology and structural-preparation presentation.  Rendering
   * and details should subscribe here so they cannot observe cache adoption
   * and preparation removal as two different presentation revisions.
   */
  readonly spatialSkeletonDisplay =
    new WatchableValue<SpatialSkeletonDisplaySnapshot>(
      Object.freeze({
        revision: 0,
        removedSegmentIds: Object.freeze([]),
        activeStableOwners: Object.freeze([]),
        numericAliases: Object.freeze([]),
        provisionalNodeIds: Object.freeze([]),
        pendingEdits: Object.freeze([]),
      }),
    );
  /** The single pointer-drag coordinate rendered before queue admission. */
  private pendingNodePosition:
    | { nodeId: bigint; position: Float32Array }
    | undefined;
  private spatialSkeletonPendingEditsById = new Map<
    number,
    SpatialSkeletonPendingEdit
  >();
  private displayStableOwners = new Map<
    bigint,
    SpatialSkeletonStableSegmentHandle
  >();
  private displayNumericAliases = new Map<
    string,
    { readonly segmentId: bigint; readonly authoritative: boolean }
  >();
  private displayProvisionalNodeIds = new Set<bigint>();
  private displayRemovedSegmentIds = new Set<bigint>();
  private displayTransactionDepth = 0;
  private displayPublicationPending = false;
  private preparedDisplayPublication:
    | SpatialSkeletonDisplaySnapshot
    | undefined;
  private readonly displayNotificationErrorReporters = new Set<
    (error: unknown) => void
  >();
  private nodeDataNotificationPending = false;
  private readonly previewCachePublicationOwner = {};
  private readonly adoptedPreviewCachePublications = new WeakSet<object>();
  private readonly completeSkeletons = new CompleteSkeletonCache(this);
  /**
   * First-wins, layer-scoped editing latch. It deliberately is not part of
   * queue or datasource runtime state: clearing either cannot make editing
   * safe again after authority became unknowable.
   */
  private reloadRequired: SpatialSkeletonReloadRequiredDetails | undefined;
  private editQueue?: SessionOwnedSpatialSkeletonEditQueue;
  private editSource?: EditableSkeletonSource;
  private editPreview?: SpatialSkeletonEditPreview;
  private queueSubscriptionCleanup?: () => void;
  private datasourceCleanup?: () => void;
  private reloadRequiredLatchOrigin?: SpatialSkeletonSessionEditQueue;

  constructor(options: SpatialSkeletonEditSessionOptions = {}) {
    super();
    const capacity =
      options.editQueueCapacity ?? DEFAULT_SPATIAL_SKELETON_EDIT_QUEUE_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        "The spatial skeleton optimistic-edit queue capacity must be a positive safe integer.",
      );
    }
    this.editQueueCapacity = capacity;
    this.commandHistory = this.registerDisposer(
      new SpatialSkeletonUndoHistory({ capacity }),
    );
  }

  /**
   * Constructs the single queue runtime owned by this layer state. Providers
   * contribute plan/transport behavior, never another queue.
   */
  ensureEditQueue(
    layer: SpatialSkeletonLayerContext,
    source: EditableSkeletonSource,
    provider: SpatialSkeletonEditPlannerProvider,
  ): SpatialSkeletonSessionEditQueue {
    if (this.editSource === source && this.editQueue !== undefined) {
      return this.editQueue;
    }

    const preview = new SpatialSkeletonEditPreview(this, {
      uiHints:
        layer.applySpatialSkeletonPreviewUiHints === undefined
          ? undefined
          : {
              apply: (hints) =>
                layer.applySpatialSkeletonPreviewUiHints!(hints),
            },
      onAuxiliaryError: (error) => console.error(error),
    });
    const provisionalIds =
      new StateOwnedSpatialSkeletonProvisionalNumericIdService();
    const registration = provider.createPlanner({
      source,
      identities: preview,
      provisionalIds,
    });
    assertSpatialSkeletonEditPlannerRegistration(registration);
    provisionalIds.configure(registration.provisionalNumericIdPolicy);
    const attempts = new SpatialSkeletonRequestScheduler({
      adapter: registration.editRequestAdapter,
    });
    const engine = new SpatialSkeletonEditQueue({
      planner: registration.planner,
      preview,
      history: createSpatialSkeletonHistoryPort(this.commandHistory),
      attempts,
      pendingEdit: {
        publish: (intentId, intent, descriptor) => {
          const { lastKnownPositions, ...pendingEdit } = descriptor;
          this.setSpatialSkeletonPendingEdit({
            ...pendingEdit,
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
          this.removeSpatialSkeletonPendingEdit(intentId);
        },
      },
      reloadRequired: {
        get: () => this.getReloadRequired(),
        latch: (reloadRequired) => {
          this.reloadRequiredLatchOrigin = engine;
          try {
            return this.latchReloadRequired(reloadRequired);
          } finally {
            this.reloadRequiredLatchOrigin = undefined;
          }
        },
      },
      onListenerError: (error) => console.error(error),
    }) as SessionOwnedSpatialSkeletonEditQueue;

    // The candidate is complete before replacing the current engine. A
    // provider construction failure therefore leaves the old source usable.
    this.releaseEditQueue();
    this.commandHistory.setSource(source);
    this.editSource = source;
    this.editPreview = preview;
    this.editQueue = engine;
    this.datasourceCleanup = registration.cleanup;
    this.queueSubscriptionCleanup = engine.subscribe(() =>
      this.notifyEditQueueChanged(),
    );
    const latchedReloadRequired = this.reloadRequired;
    if (latchedReloadRequired === undefined) {
      this.notifyEditQueueChanged();
    } else {
      engine.handleReloadRequiredLatched(latchedReloadRequired);
    }
    return engine;
  }

  releaseEditQueue() {
    const queue = this.editQueue;
    const datasourceCleanup = this.datasourceCleanup;
    const hadRuntime =
      queue !== undefined ||
      this.editPreview !== undefined ||
      datasourceCleanup !== undefined;
    this.queueSubscriptionCleanup?.();
    this.queueSubscriptionCleanup = undefined;
    // Capture and clear ownership before disposal so a synchronous callback
    // cannot schedule the same datasource cleanup twice.
    this.datasourceCleanup = undefined;
    this.editQueue = undefined;
    this.editSource = undefined;
    this.editPreview = undefined;
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
    if (hadRuntime) this.notifyEditQueueChanged();
    return hadRuntime;
  }

  executeEdit(
    command: SpatialSkeletonEditCommand,
    queueInput:
      | SpatialSkeletonQueueInput
      | SpatialSkeletonQueueInputPreparation,
  ) {
    this.assertEditingAllowed();
    const engine = this.editQueue;
    if (engine === undefined) {
      return rejectedEditExecution<void>(
        new SpatialSkeletonDatasourceContractError(
          "Editable spatial skeleton datasource has no installed queue planner.",
        ),
      );
    }
    const submitted = engine.submitExecute(command, queueInput);
    const execution = submitted.then(() => undefined);
    Object.defineProperties(execution, {
      acceptedByQueue: { configurable: true, value: submitted.acceptedByQueue },
      settled: { configurable: true, value: submitted.settled },
    });
    return execution as SpatialSkeletonEditExecution<void>;
  }

  getEditingIdentityService() {
    const identities = this.editPreview;
    if (identities === undefined) {
      throw new SpatialSkeletonDatasourceContractError(
        "Editable spatial skeleton datasource has no installed queue identity service.",
      );
    }
    return identities;
  }

  notifyEditQueueChanged() {
    this.editQueueVersion.value = this.editQueueVersion.value + 1;
  }

  getReloadRequired() {
    return this.reloadRequired;
  }

  latchReloadRequired(state: SpatialSkeletonReloadRequiredDetails): boolean {
    if (this.reloadRequired !== undefined) return false;
    this.reloadRequired = freezeSpatialSkeletonReloadRequiredDetails(state);

    // A latched layer may still be inspected and navigated, but no edit request
    // gesture may remain armed. These are interaction-only overlays and do
    // not alter the last complete adopted skeleton preview.
    this.editMode.value = false;
    this.mergeMode.value = false;
    this.splitMode.value = false;
    this.clearMergeAnchor();
    this.suppressSelectedNodeHighlight.value = false;
    this.clearPendingNodePositions();

    // The latch is session-owned and may be won by an engine which has already
    // been replaced. Always stop the currently installed engine as well.
    const activeQueue = this.editQueue;
    if (activeQueue === undefined) {
      this.notifyEditQueueChanged();
    } else if (activeQueue !== this.reloadRequiredLatchOrigin) {
      // The engine publishes the single queue/UI revision after synchronously
      // canceling and refolding its unsent work.
      activeQueue.handleReloadRequiredLatched(this.reloadRequired);
    }
    return true;
  }

  assertEditingAllowed() {
    const reloadRequired = this.reloadRequired;
    if (reloadRequired !== undefined) {
      throw new SpatialSkeletonReloadRequiredError(reloadRequired);
    }
  }

  private prepareSpatialSkeletonDisplayPublication(
    options: {
      readonly stableOwners?: ReadonlyMap<
        bigint,
        SpatialSkeletonStableSegmentHandle
      >;
      readonly numericAliases?: ReadonlyMap<
        string,
        { readonly segmentId: bigint; readonly authoritative: boolean }
      >;
      readonly provisionalNodeIds?: ReadonlySet<bigint>;
      readonly removedSegmentIds?: ReadonlySet<bigint>;
      readonly pendingEditsById?: ReadonlyMap<
        number,
        SpatialSkeletonPendingEdit
      >;
      readonly revision?: number;
    } = {},
  ): SpatialSkeletonDisplaySnapshot {
    const pendingEdits = [
      ...(
        options.pendingEditsById ?? this.spatialSkeletonPendingEditsById
      ).values(),
    ].sort((a, b) => a.sequence - b.sequence || a.intentId - b.intentId);
    const activeStableOwners = [
      ...(options.stableOwners ?? this.displayStableOwners),
    ]
      .sort(([a], [b]) => bigintCompare(a, b))
      .map(([segmentId, stableHandle]) =>
        Object.freeze({ segmentId, stableHandle }),
      );
    const numericAliases = [
      ...(options.numericAliases ?? this.displayNumericAliases),
    ]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stableId, { segmentId, authoritative }]) =>
        Object.freeze({
          stableHandle: Object.freeze({
            kind: "segment" as const,
            stableId,
          }),
          segmentId,
          authoritative,
        }),
      );
    const provisionalNodeIds = [
      ...(options.provisionalNodeIds ?? this.displayProvisionalNodeIds),
    ].sort(bigintCompare);
    return Object.freeze({
      revision:
        options.revision ?? this.spatialSkeletonDisplay.value.revision + 1,
      removedSegmentIds: Object.freeze(
        [...(options.removedSegmentIds ?? this.displayRemovedSegmentIds)].sort(
          bigintCompare,
        ),
      ),
      activeStableOwners: Object.freeze(activeStableOwners),
      numericAliases: Object.freeze(numericAliases),
      provisionalNodeIds: Object.freeze(provisionalNodeIds),
      pendingEdits: Object.freeze(pendingEdits),
    });
  }

  private reportSpatialSkeletonDisplayObserverError(error: unknown) {
    for (const reportError of this.displayNotificationErrorReporters) {
      try {
        reportError(error);
      } catch {
        // Reporting cannot make an already-adopted model fail.
      }
    }
  }

  private notifyWithReporters(publish: () => void) {
    if (this.displayNotificationErrorReporters.size === 0) {
      publish();
      return;
    }
    try {
      publish();
    } catch (error) {
      this.reportSpatialSkeletonDisplayObserverError(error);
    }
  }

  private updateProvisionalSegmentIds(display: SpatialSkeletonDisplaySnapshot) {
    const nextIds = getActiveProvisionalSpatialSkeletonSegmentIds(display);
    const { provisionalSegmentIds } = this;
    if (
      nextIds.length === provisionalSegmentIds.size &&
      nextIds.every((segmentId) => provisionalSegmentIds.has(segmentId))
    ) {
      return;
    }
    provisionalSegmentIds.clear();
    if (nextIds.length !== 0) provisionalSegmentIds.add(nextIds);
  }

  private publishPreparedSpatialSkeletonDisplay(
    publication: SpatialSkeletonDisplaySnapshot,
  ) {
    this.updateProvisionalSegmentIds(publication);
    this.notifyWithReporters(() => {
      this.spatialSkeletonDisplay.value = publication;
    });
  }

  private publishSpatialSkeletonDisplay() {
    this.displayPublicationPending = false;
    this.publishPreparedSpatialSkeletonDisplay(
      this.prepareSpatialSkeletonDisplayPublication(),
    );
  }

  private requestSpatialSkeletonDisplayPublication() {
    this.preparedDisplayPublication = undefined;
    if (this.displayTransactionDepth !== 0) {
      this.displayPublicationPending = true;
      return;
    }
    this.publishSpatialSkeletonDisplay();
  }

  /**
   * Runs a synchronous presentation transaction.  Complete-cache adoption,
   * preparation changes, aliases, owners, and the node-data notification are
   * coalesced into a single presentation publication at the outer boundary.
   */
  runSpatialSkeletonDisplayTransaction<T>(
    callback: () => T,
    reportNotificationError?: (error: unknown) => void,
  ): T {
    if (reportNotificationError !== undefined) {
      this.displayNotificationErrorReporters.add(reportNotificationError);
    }
    ++this.displayTransactionDepth;
    try {
      return callback();
    } finally {
      if (--this.displayTransactionDepth === 0) {
        try {
          // Publish the already-prepared presentation first.  Node-data
          // observers commonly schedule a redraw and must never observe the
          // newly adopted cache through an older alias/provisional/preparation
          // snapshot.  Both publications still happen only after every core
          // reference was installed by the transaction callback.
          const preparedDisplay = this.preparedDisplayPublication;
          this.preparedDisplayPublication = undefined;
          if (preparedDisplay !== undefined) {
            this.publishPreparedSpatialSkeletonDisplay(preparedDisplay);
          } else if (this.displayPublicationPending) {
            this.publishSpatialSkeletonDisplay();
          }
          if (this.nodeDataNotificationPending) {
            this.nodeDataNotificationPending = false;
            this.notifyWithReporters(() => {
              this.nodeDataVersion.value = this.nodeDataVersion.value + 1;
            });
          }
        } finally {
          this.displayNotificationErrorReporters.clear();
        }
      }
    }
  }

  private prepareSpatialSkeletonDisplayIdentities(
    activeStableOwners: Iterable<SpatialSkeletonDisplayStableOwner>,
    numericAliases: Iterable<SpatialSkeletonDisplayNumericAlias>,
    provisionalNodeIds: Iterable<bigint> = [],
  ) {
    const nextOwners = new Map<bigint, SpatialSkeletonStableSegmentHandle>();
    for (const { segmentId, stableHandle } of activeStableOwners) {
      if (segmentId === 0n) {
        throw new RangeError(
          `Invalid spatial skeleton presentation segment id: ${segmentId}`,
        );
      }
      if (
        stableHandle.kind !== "segment" ||
        stableHandle.stableId.length === 0
      ) {
        throw new TypeError(
          "Invalid active logical segment owner in presentation.",
        );
      }
      nextOwners.set(segmentId, Object.freeze({ ...stableHandle }));
    }
    const nextAliases = new Map<
      string,
      { readonly segmentId: bigint; readonly authoritative: boolean }
    >();
    for (const { stableHandle, segmentId, authoritative } of numericAliases) {
      if (segmentId === 0n) {
        throw new RangeError(
          `Invalid spatial skeleton presentation alias: ${segmentId}`,
        );
      }
      if (
        stableHandle.kind !== "segment" ||
        stableHandle.stableId.length === 0
      ) {
        throw new TypeError("Invalid logical segment alias in presentation.");
      }
      nextAliases.set(stableHandle.stableId, {
        segmentId,
        authoritative: authoritative ?? true,
      });
    }
    const nextProvisionalNodeIds = new Set<bigint>();
    for (const nodeId of provisionalNodeIds) {
      if (nodeId === 0n) {
        throw new RangeError(
          `Invalid spatial skeleton provisional node id: ${nodeId}`,
        );
      }
      nextProvisionalNodeIds.add(nodeId);
    }
    const ownersUnchanged =
      nextOwners.size === this.displayStableOwners.size &&
      [...nextOwners].every(
        ([segmentId, handle]) =>
          this.displayStableOwners.get(segmentId)?.stableId === handle.stableId,
      );
    const aliasesUnchanged =
      nextAliases.size === this.displayNumericAliases.size &&
      [...nextAliases].every(([stableId, alias]) => {
        const current = this.displayNumericAliases.get(stableId);
        return (
          current?.segmentId === alias.segmentId &&
          current.authoritative === alias.authoritative
        );
      });
    const provisionalNodeIdsUnchanged =
      nextProvisionalNodeIds.size === this.displayProvisionalNodeIds.size &&
      [...nextProvisionalNodeIds].every((nodeId) =>
        this.displayProvisionalNodeIds.has(nodeId),
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
  addSpatialSkeletonPendingEdit(pendingEdit: SpatialSkeletonPendingEdit) {
    const normalized = normalizeSpatialSkeletonPendingEdit(pendingEdit);
    if (this.spatialSkeletonPendingEditsById.has(normalized.intentId)) {
      throw new Error(
        `Spatial skeleton preparation ${normalized.intentId} already exists.`,
      );
    }
    this.spatialSkeletonPendingEditsById.set(normalized.intentId, normalized);
    this.requestSpatialSkeletonDisplayPublication();
    return true;
  }

  /** Atomically replaces the cue as a queued intent acquires complete inputs. */
  private setSpatialSkeletonPendingEdit(
    pendingEdit: SpatialSkeletonPendingEdit,
  ) {
    const normalized = normalizeSpatialSkeletonPendingEdit(pendingEdit);
    this.spatialSkeletonPendingEditsById.set(normalized.intentId, normalized);
    this.requestSpatialSkeletonDisplayPublication();
  }

  removeSpatialSkeletonPendingEdit(intentId: number) {
    const normalizedIntentId = normalizePendingEditId(
      intentId,
      "preparation intent id",
    );
    if (!this.spatialSkeletonPendingEditsById.delete(normalizedIntentId)) {
      return false;
    }
    this.requestSpatialSkeletonDisplayPublication();
    return true;
  }

  clearSpatialSkeletonPendingEdits() {
    if (this.spatialSkeletonPendingEditsById.size === 0) return false;
    this.spatialSkeletonPendingEditsById.clear();
    this.requestSpatialSkeletonDisplayPublication();
    return true;
  }

  hasUnconfirmedEdits() {
    return (
      this.reloadRequired !== undefined ||
      (this.editQueue?.hasUnconfirmedActions() ?? false)
    );
  }

  getEditQueueRows(): readonly SpatialSkeletonEditQueueEntry[] {
    return this.editQueue?.getSnapshot() ?? [];
  }

  getEditQueueRecentActivity(): readonly SpatialSkeletonEditActivityEntry[] {
    return this.editQueue?.getRecentActivity() ?? [];
  }

  canUndoEdit() {
    if (this.reloadRequired !== undefined) return false;
    return this.editQueue?.canUndo() ?? false;
  }

  undoLatestEdit() {
    if (this.reloadRequired !== undefined) {
      return rejectedEditExecution<boolean>(
        new SpatialSkeletonReloadRequiredError(this.reloadRequired),
      );
    }
    return this.editQueue?.canUndo()
      ? this.editQueue.undoLatest()
      : resolvedEditExecution(false);
  }

  canRedoEdit() {
    if (this.reloadRequired !== undefined) return false;
    return this.editQueue?.canRedo() ?? false;
  }

  redoLatestEdit() {
    if (this.reloadRequired !== undefined) {
      return rejectedEditExecution<boolean>(
        new SpatialSkeletonReloadRequiredError(this.reloadRequired),
      );
    }
    return this.editQueue?.canRedo()
      ? this.editQueue.redoLatest()
      : resolvedEditExecution(false);
  }

  getPendingNodeIds() {
    const pending = this.pendingNodePosition;
    return pending === undefined
      ? [][Symbol.iterator]()
      : [pending.nodeId].values();
  }

  getPendingNodePosition(nodeId: bigint) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    const pending = this.pendingNodePosition;
    if (pending === undefined || pending.nodeId !== normalizedNodeId) {
      return undefined;
    }
    return pending.position;
  }

  private normalizeNodeId(nodeId: bigint | undefined) {
    return nodeId === undefined || nodeId === 0n ? undefined : nodeId;
  }

  setMergeAnchor(nodeId: bigint | undefined) {
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

  setPendingNodePosition(nodeId: bigint, position: ArrayLike<number>) {
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
  remapPendingNodePositions(remappings: ReadonlyMap<bigint, bigint>) {
    const pending = this.pendingNodePosition;
    if (remappings.size === 0 || pending === undefined) {
      return false;
    }
    const resolveNodeId = (nodeId: bigint) => {
      const visited = new Set<bigint>();
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

  clearRuntimeState() {
    return this.runSpatialSkeletonDisplayTransaction(() =>
      this.clearRuntimeStateInDisplay(),
    );
  }

  private clearRuntimeStateInDisplay() {
    const queueChanged = this.releaseEditQueue();
    const cacheChanged = !this.completeSkeletons.isEmpty;
    const pendingChanged = this.clearPendingNodePositions();
    const intentCuesChanged = this.clearSpatialSkeletonPendingEdits();
    const displayIdentitiesChanged =
      this.displayStableOwners.size !== 0 ||
      this.displayNumericAliases.size !== 0 ||
      this.displayProvisionalNodeIds.size !== 0 ||
      this.displayRemovedSegmentIds.size !== 0;
    if (displayIdentitiesChanged) {
      this.displayStableOwners.clear();
      this.displayNumericAliases.clear();
      this.displayProvisionalNodeIds.clear();
      this.displayRemovedSegmentIds.clear();
      this.requestSpatialSkeletonDisplayPublication();
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
      this.completeSkeletons.clear();
      this.markNodeDataChanged();
    }
    return (
      cacheChanged ||
      pendingChanged ||
      intentCuesChanged ||
      displayIdentitiesChanged ||
      queueChanged ||
      mergeAnchorChanged ||
      modeChanged ||
      historyChanged
    );
  }

  markNodeDataChanged() {
    if (this.displayTransactionDepth !== 0) {
      this.nodeDataNotificationPending = true;
    } else {
      this.nodeDataVersion.value = this.nodeDataVersion.value + 1;
    }
    this.requestSpatialSkeletonDisplayPublication();
  }

  getCachedSegmentNodes(segmentId: bigint) {
    return this.completeSkeletons.getSegmentNodes(segmentId);
  }

  getCachedSegmentRevision(segmentId: bigint) {
    return this.completeSkeletons.getSegmentRevision(segmentId);
  }

  getCachedSegmentSnapshotHandle(segmentId: bigint) {
    return this.completeSkeletons.getSnapshotHandle(segmentId);
  }

  tryAcquireInputReference(requirement: SpatialSkeletonQueueInputRequirement) {
    return this.completeSkeletons.tryAcquireInputReference(requirement);
  }

  acquireInputReference(
    requirement: SpatialSkeletonQueueInputRequirement,
    action?: SpatialSkeletonAction,
  ) {
    return this.completeSkeletons.acquireInputReference(requirement, action);
  }

  getCachedNode(nodeId: bigint) {
    return this.completeSkeletons.getNode(nodeId);
  }

  /** The cached node at its pending position, if it has one. */
  getDisplayedNode(nodeId: bigint): SkeletonNode | undefined {
    const cachedNode = this.completeSkeletons.getNode(nodeId);
    if (cachedNode === undefined) {
      return undefined;
    }
    const pendingPosition =
      this.getPendingNodePosition(cachedNode.nodeId) ?? cachedNode.position;
    return {
      ...cachedNode,
      position: new Float32Array([
        Number(pendingPosition[0]),
        Number(pendingPosition[1]),
        Number(pendingPosition[2]),
      ]),
    };
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
      readonly [bigint, SpatialSkeletonCachedSegmentSnapshot]
    >,
    options: {
      notify?: boolean;
      /**
       * When supplied, no replacement is published unless every affected
       * segment still has the captured revision.  The check and the complete
       * cache replacement occur synchronously as one atomic operation.
       */
      expectedRevisions?: ReadonlyMap<bigint, number>;
    } = {},
  ) {
    const changedSegmentIds = this.completeSkeletons.replaceSnapshots(
      snapshots,
      { expectedRevisions: options.expectedRevisions },
    );
    if (changedSegmentIds.length === 0) return false;
    for (const segmentId of changedSegmentIds) {
      if (this.completeSkeletons.getSegmentNodes(segmentId) !== undefined) {
        this.displayRemovedSegmentIds.delete(segmentId);
      }
    }
    if (options.notify ?? true) {
      this.markNodeDataChanged();
    }
    return true;
  }

  /** Routes only queue-owned reads through preview/history state. */
  publishAuthoritativeReadSnapshots(
    snapshots: ReadonlyMap<bigint, readonly SkeletonNode[] | undefined>,
    options: {
      readonly notify?: boolean;
      readonly expectedRevisions: ReadonlyMap<bigint, number>;
    },
  ) {
    const runtime = this.editPreview;
    if (runtime === undefined) {
      return this.replaceCachedSegmentSnapshots(snapshots, {
        notify: options.notify,
        expectedRevisions: options.expectedRevisions,
      });
    }
    const owned = new Map<bigint, readonly SkeletonNode[] | undefined>();
    const ordinary = new Map<bigint, readonly SkeletonNode[] | undefined>();
    for (const [segmentId, snapshot] of snapshots) {
      (this.editQueue?.ownsAuthoritativeReadSegment(segmentId)
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
              nodes === undefined ? undefined : createCompleteSkeleton(nodes),
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
      this.markNodeDataChanged();
    }
    return changed;
  }

  /**
   * Fully prepares the session-owned portion of an optimistic publication.
   * Lazy handles are materialized, reverse ownership is validated, cache
   * revisions are fenced, and complete replacement maps/presentation values
   * are built before the returned opaque artifact can be adopted.
   */
  prepareSpatialSkeletonPreviewCachePublication(
    request: SpatialSkeletonPreviewCachePublicationRequest,
  ): SpatialSkeletonPreparedPreviewCachePublication | undefined {
    const handles = new Map<bigint, CompleteSkeleton | undefined>();
    for (const [segmentId, handle] of request.snapshots) {
      if (segmentId === 0n) {
        throw new RangeError(
          `Invalid spatial skeleton segment id: ${segmentId}`,
        );
      }
      if (handles.has(segmentId)) {
        throw new Error(
          `Spatial skeleton preview publication contains duplicate segment ${segmentId}.`,
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

    const cache = this.completeSkeletons.preparePublication(
      handles,
      retiredSegmentIds,
      request.expectedRevisions,
    );
    if (cache === undefined) return undefined;
    const nodeDataChanged =
      request.notify && cache.changedSegmentIds.length !== 0;

    const nextDisplayRemovedSegmentIds = new Set(this.displayRemovedSegmentIds);
    for (const [segmentId, handle] of handles) {
      if (handle === undefined) nextDisplayRemovedSegmentIds.add(segmentId);
      else nextDisplayRemovedSegmentIds.delete(segmentId);
    }
    const removalsChanged =
      nextDisplayRemovedSegmentIds.size !==
        this.displayRemovedSegmentIds.size ||
      [...nextDisplayRemovedSegmentIds].some(
        (id) => !this.displayRemovedSegmentIds.has(id),
      );

    const identities = this.prepareSpatialSkeletonDisplayIdentities(
      request.activeStableOwners,
      request.numericAliases,
      request.provisionalNodeIds,
    );
    const nextPendingEditsById = new Map(this.spatialSkeletonPendingEditsById);
    let pendingEditsChanged = false;
    for (const intentId of request.pendingEditIntentIdsToRemove) {
      pendingEditsChanged =
        nextPendingEditsById.delete(
          normalizePendingEditId(intentId, "preparation intent id"),
        ) || pendingEditsChanged;
    }
    const publishDisplay =
      removalsChanged ||
      identities.changed ||
      pendingEditsChanged ||
      nodeDataChanged;
    const display = publishDisplay
      ? this.prepareSpatialSkeletonDisplayPublication({
          stableOwners: identities.nextOwners,
          numericAliases: identities.nextAliases,
          provisionalNodeIds: identities.nextProvisionalNodeIds,
          removedSegmentIds: nextDisplayRemovedSegmentIds,
          pendingEditsById: nextPendingEditsById,
          revision: this.spatialSkeletonDisplay.value.revision + 1,
        })
      : undefined;

    const implementation: SpatialSkeletonPreparedPreviewCachePublicationImplementation =
      {
        [preparedSpatialSkeletonPreviewCachePublicationBrand]: true,
        owner: this.previewCachePublicationOwner,
        cacheRevisions: cache.cacheRevisions,
        cache,
        expectedDisplay: this.spatialSkeletonDisplay.value,
        nextDisplayStableOwners: identities.nextOwners,
        nextDisplayNumericAliases: identities.nextAliases,
        nextDisplayProvisionalNodeIds: identities.nextProvisionalNodeIds,
        nextDisplayRemovedSegmentIds,
        nextPendingEditsById,
        notifyNodeData: nodeDataChanged,
        ...(display === undefined ? {} : { display }),
      };
    return Object.freeze(implementation);
  }

  /** Installs a genuine prepared publication using reference assignments only. */
  adoptPreparedSpatialSkeletonPreviewCachePublication(
    publication: SpatialSkeletonPreparedPreviewCachePublication,
  ): boolean {
    const prepared =
      publication as SpatialSkeletonPreparedPreviewCachePublicationImplementation;
    if (
      prepared?.owner !== this.previewCachePublicationOwner ||
      prepared[preparedSpatialSkeletonPreviewCachePublicationBrand] !== true
    ) {
      throw new TypeError(
        "Prepared spatial skeleton preview publication belongs to another edit session.",
      );
    }
    if (this.adoptedPreviewCachePublications.has(prepared)) {
      throw new Error(
        "Prepared spatial skeleton preview publication was already adopted.",
      );
    }
    if (
      !this.completeSkeletons.canAdoptPublication(prepared.cache) ||
      this.spatialSkeletonDisplay.value !== prepared.expectedDisplay
    ) {
      return false;
    }

    this.adoptedPreviewCachePublications.add(prepared);
    this.completeSkeletons.adoptPublication(prepared.cache);
    this.displayStableOwners = prepared.nextDisplayStableOwners;
    this.displayNumericAliases = prepared.nextDisplayNumericAliases;
    this.displayProvisionalNodeIds = prepared.nextDisplayProvisionalNodeIds;
    this.displayRemovedSegmentIds = prepared.nextDisplayRemovedSegmentIds;
    this.spatialSkeletonPendingEditsById = prepared.nextPendingEditsById;
    if (prepared.notifyNodeData) this.nodeDataNotificationPending = true;
    if (prepared.display !== undefined) {
      this.displayPublicationPending = false;
      this.preparedDisplayPublication = prepared.display;
    }
    return true;
  }

  /** Runs callback-bearing cache cleanup only after core adoption completed. */
  finalizePreparedSpatialSkeletonPreviewCachePublication(
    publication: SpatialSkeletonPreparedPreviewCachePublication,
    reportError?: (error: unknown) => void,
  ) {
    const prepared =
      publication as SpatialSkeletonPreparedPreviewCachePublicationImplementation;
    if (
      prepared?.owner !== this.previewCachePublicationOwner ||
      !this.adoptedPreviewCachePublications.has(prepared)
    ) {
      throw new TypeError(
        "Only an adopted session-owned spatial skeleton publication can be finalized.",
      );
    }
    this.completeSkeletons.finishPublication(prepared.cache, reportError);
  }

  releaseFullSegmentNodeFetchOwner(owner: object) {
    return this.completeSkeletons.releaseFetchOwner(owner);
  }

  evictInactiveSegmentNodes(activeSegmentIds: Iterable<bigint>) {
    const activeSegmentIdSet = new Set(activeSegmentIds);
    for (const segmentId of this.editQueue?.getProtectedPreviewSegmentIds() ??
      []) {
      if (segmentId !== 0n) {
        activeSegmentIdSet.add(segmentId);
      }
    }
    return this.completeSkeletons.evictInactive(activeSegmentIdSet);
  }

  getFullSegmentNodes(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    segmentId: bigint,
    options: { retainWhileInactive?: boolean; requestOwner?: object } = {},
  ): Promise<SkeletonNode[]> {
    return this.completeSkeletons.fetchSegmentNodes(
      skeletonLayer,
      segmentId,
      options,
    );
  }

  disposed() {
    this.releaseEditQueue();
    super.disposed();
  }
}
