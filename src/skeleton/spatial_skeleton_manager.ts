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
  SpatialSkeletonSourceState,
  SpatiallyIndexedSkeletonSource,
} from "#src/skeleton/api.js";
import {
  getSpatialSkeletonEditCommandFactoryFromSource,
  getSpatialSkeletonEditCommandMetadata,
  isSpatialSkeletonEditCommandFactory,
  SPATIAL_SKELETON_EDIT_COMMAND_METADATA,
} from "#src/skeleton/command_factories.js";
import { SpatialSkeletonCommandHistory } from "#src/skeleton/command_history.js";
import type { SpatialSkeletonAction } from "#src/skeleton/command_protocol.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { PromiseConcurrencyLimiter } from "#src/util/promise_concurrency_limiter.js";

interface SpatialSkeletonSourceAccess {
  source: unknown;
}

export interface SpatialSkeletonOptimisticEditState {
  hasUnconfirmedOptimisticEdits(): boolean;
  canUndoOptimisticEdit(): boolean;
  undoLatestOptimisticEdit(): Promise<boolean>;
}

export function isSpatialSkeletonOptimisticEditState(
  value: unknown,
): value is SpatialSkeletonOptimisticEditState {
  return (
    hasFunction(value, "hasUnconfirmedOptimisticEdits") &&
    hasFunction(value, "canUndoOptimisticEdit") &&
    hasFunction(value, "undoLatestOptimisticEdit")
  );
}

export interface SpatialSkeletonOptimisticEditQueue {
  canUndo(): boolean;
  canQueueAction?(action: SpatialSkeletonAction): boolean;
  clear?(): boolean;
  dispose?(): boolean;
  hasUnconfirmedActions(): boolean;
  undoLatest(): Promise<boolean>;

  // Debug/inspection hooks used by the optimistic edit queue widget.
  clearSettled?(): boolean;
  getDebugSnapshot?(): readonly SpatialSkeletonOptimisticEditDebugEntry[];
}

export interface SpatialSkeletonOptimisticEditDebugEntry {
  readonly operationId?: number;
  readonly kind: string;
  readonly status: string;
  readonly tempNodeId?: number;
  readonly parentNodeId?: number;
  readonly parentTempNodeId?: number;
  readonly nodeId?: number;
  readonly segmentId?: number;
  readonly dependencies?: readonly number[];
  readonly tempSegmentId?: number;
  readonly secondNodeId?: number;
  readonly secondSegmentId?: number;
  readonly resultSegmentId?: number;
  readonly deletedSegmentId?: number;
}

/**
 * A cloneable snapshot of a full cached segment.  `undefined` represents an
 * uncached segment, while an empty array represents a known empty segment.
 */
export type SpatialSkeletonCachedSegmentSnapshot =
  | readonly SpatiallyIndexedSkeletonNode[]
  | undefined;

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
    ...(node.sourceState === undefined
      ? {}
      : { sourceState: node.sourceState }),
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
    a.sourceState !== b.sourceState ||
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

/**
 * Full-segment skeleton fetches bypass the chunk queue manager, so they are
 * capped separately at min(this, the concurrentDownloads viewer setting).
 */
const MAX_CONCURRENT_FULL_SEGMENT_NODE_FETCHES = 8;

export class SpatialSkeletonState
  extends RefCounted
  implements SpatialSkeletonOptimisticEditState
{
  readonly commandHistory = this.registerDisposer(
    new SpatialSkeletonCommandHistory(),
  );
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

  private pendingNodePositions = new Map<number, Float32Array>();
  private fullSkeletonCacheGeneration = 0;
  private fullSegmentNodeCache = new Map<
    number,
    SpatiallyIndexedSkeletonNode[]
  >();
  private pendingFullSegmentNodeFetches = new Map<
    number,
    {
      promise: Promise<SpatiallyIndexedSkeletonNode[]>;
      abortController: AbortController;
      retainWhileInactive: boolean;
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
  private optimisticEditQueue?: SpatialSkeletonOptimisticEditQueue;

  setOptimisticEditQueue(
    optimisticEditQueue: SpatialSkeletonOptimisticEditQueue | undefined,
  ) {
    if (this.optimisticEditQueue === optimisticEditQueue) {
      return false;
    }
    this.optimisticEditQueue = optimisticEditQueue;
    this.notifyOptimisticEditQueueChanged();
    return true;
  }

  notifyOptimisticEditQueueChanged() {
    this.optimisticEditQueueVersion.value =
      this.optimisticEditQueueVersion.value + 1;
  }

  hasUnconfirmedOptimisticEdits() {
    return this.optimisticEditQueue?.hasUnconfirmedActions() ?? false;
  }

  canQueueOptimisticAction(action: SpatialSkeletonAction) {
    return this.optimisticEditQueue?.canQueueAction?.(action) ?? false;
  }

  getOptimisticEditQueueDebugSnapshot() {
    return this.optimisticEditQueue?.getDebugSnapshot?.() ?? [];
  }

  clearSettledOptimisticEdits() {
    return this.optimisticEditQueue?.clearSettled?.() ?? false;
  }

  canUndoOptimisticEdit() {
    return this.optimisticEditQueue?.canUndo() ?? false;
  }

  undoLatestOptimisticEdit() {
    return this.optimisticEditQueue?.undoLatest() ?? Promise.resolve(false);
  }

  setNodeRadius(nodeId: number, radius: number) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    radius = Number(radius);
    if (normalizedNodeId === undefined || !Number.isFinite(radius)) {
      return false;
    }
    return this.updateCachedNode(normalizedNodeId, (node) => {
      if (node.radius === radius) {
        return node;
      }
      return {
        ...node,
        radius,
      };
    });
  }

  setNodeConfidence(nodeId: number, confidence: number) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    confidence = Number(confidence);
    if (normalizedNodeId === undefined || !Number.isFinite(confidence)) {
      return false;
    }
    return this.updateCachedNode(normalizedNodeId, (node) => {
      if (node.confidence === confidence) {
        return node;
      }
      return {
        ...node,
        confidence,
      };
    });
  }

  getPendingNodeIds() {
    return this.pendingNodePositions.keys();
  }

  getPendingNodePosition(nodeId: number) {
    return this.pendingNodePositions.get(nodeId);
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
    const existing = this.pendingNodePositions.get(normalizedNodeId);
    if (
      existing !== undefined &&
      existing[0] === x &&
      existing[1] === y &&
      existing[2] === z
    ) {
      return false;
    }
    this.pendingNodePositions.set(
      normalizedNodeId,
      new Float32Array([x, y, z]),
    );
    this.pendingNodePositionVersion.value =
      this.pendingNodePositionVersion.value + 1;
    return true;
  }

  clearPendingNodePosition(nodeId: number) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    if (
      normalizedNodeId === undefined ||
      !this.pendingNodePositions.delete(normalizedNodeId)
    ) {
      return false;
    }
    this.pendingNodePositionVersion.value =
      this.pendingNodePositionVersion.value + 1;
    return true;
  }

  clearPendingNodePositions() {
    if (this.pendingNodePositions.size === 0) {
      return false;
    }
    this.pendingNodePositions.clear();
    this.pendingNodePositionVersion.value =
      this.pendingNodePositionVersion.value + 1;
    return true;
  }

  updateCommandHistorySource(source: unknown) {
    return this.commandHistory.setSource(source);
  }

  clearInspectedSkeletonCache() {
    const cacheChanged =
      this.fullSegmentNodeCache.size !== 0 ||
      this.pendingFullSegmentNodeFetches.size !== 0 ||
      this.cachedNodesById.size !== 0;
    const pendingChanged = this.clearPendingNodePositions();
    if (!cacheChanged) {
      return pendingChanged;
    }
    this.clearFullSkeletonCache();
    this.nodeDataVersion.value = this.nodeDataVersion.value + 1;
    return true;
  }

  clearRuntimeState() {
    const optimisticQueue = this.optimisticEditQueue;
    const optimisticQueueChanged =
      optimisticQueue?.dispose?.() ?? optimisticQueue?.clear?.() ?? false;
    if (this.optimisticEditQueue !== undefined) {
      this.optimisticEditQueue = undefined;
      this.notifyOptimisticEditQueueChanged();
    }
    const cacheChanged =
      this.fullSegmentNodeCache.size !== 0 ||
      this.pendingFullSegmentNodeFetches.size !== 0 ||
      this.cachedNodesById.size !== 0;
    const pendingChanged = this.clearPendingNodePositions();
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
    const historyChanged = this.commandHistory.clear();
    if (cacheChanged) {
      this.clearFullSkeletonCache();
      this.nodeDataVersion.value = this.nodeDataVersion.value + 1;
    }
    return (
      cacheChanged ||
      pendingChanged ||
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
    this.nodeDataVersion.value = this.nodeDataVersion.value + 1;
  }

  getCachedSegmentNodes(segmentId: number) {
    return this.fullSegmentNodeCache.get(segmentId);
  }

  getCachedNode(nodeId: number) {
    return this.cachedNodesById.get(nodeId);
  }

  /**
   * Captures independent copies of complete cached segments for optimistic
   * topology edits and rollback.  Missing cache entries are retained as
   * `undefined`, so restoring the returned map recreates the exact cached /
   * uncached distinction.
   */
  snapshotCachedSegments(segmentIds: Iterable<number>) {
    const snapshots = new Map<number, SpatialSkeletonCachedSegmentSnapshot>();
    for (const segmentId of segmentIds) {
      const cachedNodes = this.fullSegmentNodeCache.get(segmentId);
      snapshots.set(
        segmentId,
        cachedNodes?.map(cloneSpatiallyIndexedSkeletonNode),
      );
    }
    return snapshots;
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
    options: { notify?: boolean } = {},
  ) {
    const replacements = new Map<
      number,
      SpatiallyIndexedSkeletonNode[] | undefined
    >();
    for (const [segmentId, snapshot] of snapshots) {
      if (!Number.isSafeInteger(segmentId) || segmentId <= 0) {
        throw new RangeError(
          `Invalid spatial skeleton segment id: ${segmentId}`,
        );
      }
      if (snapshot === undefined) {
        replacements.set(segmentId, undefined);
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
      replacements.set(segmentId, clonedNodes);
    }
    if (replacements.size === 0) return false;

    // Build the complete prospective reverse index before mutating either
    // cache.  Besides keeping the update atomic, this rejects accidentally
    // placing one node in multiple segments.
    const nextNodesById = new Map<number, SpatiallyIndexedSkeletonNode>();
    const addSegmentNodesToIndex = (
      segmentId: number,
      nodes: readonly SpatiallyIndexedSkeletonNode[],
    ) => {
      for (const node of nodes) {
        const existing = nextNodesById.get(node.nodeId);
        if (existing !== undefined) {
          throw new Error(
            `Spatial skeleton node ${node.nodeId} is present in both segment ${existing.segmentId} and segment ${segmentId}.`,
          );
        }
        nextNodesById.set(node.nodeId, node);
      }
    };
    for (const [segmentId, nodes] of this.fullSegmentNodeCache) {
      if (replacements.has(segmentId)) continue;
      addSegmentNodesToIndex(segmentId, nodes);
    }
    for (const [segmentId, nodes] of replacements) {
      if (nodes !== undefined) addSegmentNodesToIndex(segmentId, nodes);
    }

    let changed = false;
    for (const [segmentId, nodes] of replacements) {
      changed =
        !cachedSegmentSnapshotsEqual(
          this.fullSegmentNodeCache.get(segmentId),
          nodes,
        ) || changed;
    }

    for (const segmentId of replacements.keys()) {
      this.abortPendingFullSegmentNodeFetch(
        segmentId,
        "spatial skeleton full-segment inspection request replaced by atomic local cache update",
      );
    }
    if (!changed) return false;

    for (const [segmentId, nodes] of replacements) {
      if (nodes === undefined) {
        this.fullSegmentNodeCache.delete(segmentId);
      } else {
        this.fullSegmentNodeCache.set(segmentId, nodes);
      }
    }
    this.cachedNodesById.clear();
    for (const [nodeId, node] of nextNodesById) {
      this.cachedNodesById.set(nodeId, node);
    }
    if (options.notify ?? true) {
      this.markNodeDataChanged({ invalidateFullSkeletonCache: false });
    }
    return true;
  }

  private replaceCachedSegmentNodes(
    segmentId: number,
    nextSegmentNodes: readonly SpatiallyIndexedSkeletonNode[],
  ) {
    const previousSegmentNodes = this.fullSegmentNodeCache.get(segmentId);
    if (previousSegmentNodes !== undefined) {
      for (const node of previousSegmentNodes) {
        if (this.cachedNodesById.get(node.nodeId) === node) {
          this.cachedNodesById.delete(node.nodeId);
        }
      }
    }
    if (nextSegmentNodes.length === 0) {
      if (previousSegmentNodes === undefined) {
        // No previous entry, assume this is an empty segment
        this.fullSegmentNodeCache.set(segmentId, []);
      } else {
        // Previous entry exists, this is a segment being cleared
        this.fullSegmentNodeCache.delete(segmentId);
      }
      return true;
    }
    const normalizedSegmentNodes = [...nextSegmentNodes];
    this.fullSegmentNodeCache.set(segmentId, normalizedSegmentNodes);
    for (const node of normalizedSegmentNodes) {
      this.cachedNodesById.set(node.nodeId, node);
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
    return true;
  }

  private abortPendingFullSegmentNodeFetch(segmentId: number, message: string) {
    const pendingEntry = this.pendingFullSegmentNodeFetches.get(segmentId);
    if (pendingEntry === undefined) {
      return false;
    }
    pendingEntry.abortController.abort(new DOMException(message, "AbortError"));
    this.pendingFullSegmentNodeFetches.delete(segmentId);
    return true;
  }

  setCachedNodeSourceState(
    nodeId: number,
    sourceState: SpatialSkeletonSourceState | undefined,
  ) {
    if (sourceState === undefined) {
      return false;
    }
    return this.updateCachedNode(nodeId, (node) => {
      if (node.sourceState === sourceState) {
        return node;
      }
      return {
        ...node,
        sourceState,
      };
    });
  }

  setCachedNodeSourceStates(
    sourceStateUpdates: readonly {
      nodeId: number;
      sourceState: SpatialSkeletonSourceState;
    }[],
  ) {
    let changed = false;
    for (const update of sourceStateUpdates) {
      changed =
        this.setCachedNodeSourceState(update.nodeId, update.sourceState) ||
        changed;
    }
    return changed;
  }

  private getCachedSegmentIdForNode(nodeId: number) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    if (normalizedNodeId === undefined) {
      return undefined;
    }
    return this.cachedNodesById.get(normalizedNodeId)?.segmentId;
  }

  private updateCachedNodeInSegment(
    segmentId: number,
    nodeId: number,
    update: (
      node: SpatiallyIndexedSkeletonNode,
    ) => SpatiallyIndexedSkeletonNode,
  ) {
    const segmentNodes = this.fullSegmentNodeCache.get(segmentId);
    if (segmentNodes === undefined) {
      return false;
    }
    let segmentChanged = false;
    const nextSegmentNodes = segmentNodes.map((candidate) => {
      if (candidate.nodeId !== nodeId) return candidate;
      const updatedNode = update(candidate);
      segmentChanged ||= updatedNode !== candidate;
      return updatedNode;
    });
    if (!segmentChanged) {
      return false;
    }
    this.replaceCachedSegmentNodes(segmentId, nextSegmentNodes);
    return true;
  }

  private upsertCachedNodeInSegment(
    segmentId: number,
    node: SpatiallyIndexedSkeletonNode,
  ) {
    const segmentNodes = this.fullSegmentNodeCache.get(segmentId);
    if (segmentNodes === undefined) {
      return false;
    }
    const existingIndex = segmentNodes.findIndex(
      (candidate) => candidate.nodeId === node.nodeId,
    );
    if (existingIndex !== -1) {
      const nextSegmentNodes = segmentNodes.slice();
      nextSegmentNodes[existingIndex] = node;
      this.replaceCachedSegmentNodes(segmentId, nextSegmentNodes);
      return true;
    }
    const insertIndex = segmentNodes.findIndex(
      (candidate) => candidate.nodeId > node.nodeId,
    );
    const nextSegmentNodes = segmentNodes.slice();
    nextSegmentNodes.splice(
      insertIndex === -1 ? nextSegmentNodes.length : insertIndex,
      0,
      node,
    );
    this.replaceCachedSegmentNodes(segmentId, nextSegmentNodes);
    return true;
  }

  updateCachedNode(
    nodeId: number,
    update: (
      node: SpatiallyIndexedSkeletonNode,
    ) => SpatiallyIndexedSkeletonNode,
  ) {
    const segmentId = this.getCachedSegmentIdForNode(nodeId);
    if (segmentId === undefined) {
      return false;
    }
    return this.updateCachedNodeInSegment(segmentId, nodeId, update);
  }

  upsertCachedNode(
    node: SpatiallyIndexedSkeletonNode,
    options: { allowUncachedSegment?: boolean } = {},
  ) {
    const normalizedNode = cloneSpatiallyIndexedSkeletonNode(node);
    const targetSegmentCached = this.fullSegmentNodeCache.has(
      normalizedNode.segmentId,
    );
    const allowUncachedSegment = options.allowUncachedSegment ?? false;
    const existingSegmentId = this.getCachedSegmentIdForNode(
      normalizedNode.nodeId,
    );
    if (!targetSegmentCached && !allowUncachedSegment) {
      return false;
    }
    let changed = false;
    if (
      existingSegmentId !== undefined &&
      existingSegmentId !== normalizedNode.segmentId
    ) {
      const existingSegmentNodes =
        this.fullSegmentNodeCache.get(existingSegmentId);
      if (existingSegmentNodes !== undefined) {
        this.replaceCachedSegmentNodes(
          existingSegmentId,
          existingSegmentNodes.filter(
            (candidate) => candidate.nodeId !== normalizedNode.nodeId,
          ),
        );
        changed = true;
      }
    }
    if (!targetSegmentCached && allowUncachedSegment) {
      this.abortPendingFullSegmentNodeFetch(
        normalizedNode.segmentId,
        "spatial skeleton full-segment inspection request replaced by local segment cache update",
      );
      this.replaceCachedSegmentNodes(normalizedNode.segmentId, [
        normalizedNode,
      ]);
      return true;
    }
    return (
      this.upsertCachedNodeInSegment(
        normalizedNode.segmentId,
        normalizedNode,
      ) || changed
    );
  }

  moveCachedNode(nodeId: number, position: ArrayLike<number>) {
    const x = Number(position[0]);
    const y = Number(position[1]);
    const z = Number(position[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return false;
    }
    return this.updateCachedNode(nodeId, (node) => {
      if (
        node.position[0] === x &&
        node.position[1] === y &&
        node.position[2] === z
      ) {
        return node;
      }
      return {
        ...node,
        position: new Float32Array([x, y, z]),
      };
    });
  }

  removeCachedNode(
    nodeId: number,
    options: {
      parentNodeId?: number;
      childNodeIds?: Iterable<number>;
    } = {},
  ) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    if (normalizedNodeId === undefined) {
      return false;
    }
    const childNodeIds = options.childNodeIds
      ? new Set(
          [...options.childNodeIds]
            .map((value) => this.normalizeNodeId(Number(value)))
            .filter((value): value is number => value !== undefined),
        )
      : undefined;
    let segmentId = this.getCachedSegmentIdForNode(normalizedNodeId);
    if (segmentId === undefined && childNodeIds !== undefined) {
      for (const childNodeId of childNodeIds) {
        segmentId = this.getCachedSegmentIdForNode(childNodeId);
        if (segmentId !== undefined) {
          break;
        }
      }
    }
    if (segmentId === undefined) {
      return false;
    }
    const segmentNodes = this.fullSegmentNodeCache.get(segmentId);
    if (segmentNodes === undefined) {
      return false;
    }
    let segmentChanged = false;
    const nextSegmentNodes: SpatiallyIndexedSkeletonNode[] = [];
    for (const candidate of segmentNodes) {
      if (candidate.nodeId === normalizedNodeId) {
        segmentChanged = true;
        continue;
      }
      if (childNodeIds?.has(candidate.nodeId)) {
        nextSegmentNodes.push({
          ...candidate,
          parentNodeId: options.parentNodeId,
        });
        segmentChanged = true;
        continue;
      }
      nextSegmentNodes.push(candidate);
    }
    if (!segmentChanged) {
      return false;
    }
    this.replaceCachedSegmentNodes(segmentId, nextSegmentNodes);
    return true;
  }

  setCachedNodeParent(nodeId: number, parentNodeId: number | undefined) {
    return this.updateCachedNode(nodeId, (node) => {
      if (node.parentNodeId === parentNodeId) {
        return node;
      }
      return {
        ...node,
        parentNodeId,
      };
    });
  }

  rerootCachedSegment(nodeId: number) {
    const normalizedNodeId = this.normalizeNodeId(nodeId);
    if (normalizedNodeId === undefined) {
      return undefined;
    }
    const targetNode = this.cachedNodesById.get(normalizedNodeId);
    if (targetNode === undefined) {
      return undefined;
    }
    const segmentNodes = this.fullSegmentNodeCache.get(targetNode.segmentId);
    if (segmentNodes === undefined) {
      return undefined;
    }

    const nodeById = new Map<number, SpatiallyIndexedSkeletonNode>();
    for (const node of segmentNodes) {
      nodeById.set(node.nodeId, node);
    }
    const startNode = nodeById.get(normalizedNodeId);
    if (startNode === undefined) {
      return undefined;
    }
    if (startNode.parentNodeId === undefined) {
      return [startNode.nodeId];
    }

    const pathNodeIds: number[] = [];
    const seen = new Set<number>();
    let currentNode: SpatiallyIndexedSkeletonNode | undefined = startNode;
    while (currentNode !== undefined) {
      if (seen.has(currentNode.nodeId)) {
        return undefined;
      }
      seen.add(currentNode.nodeId);
      pathNodeIds.push(currentNode.nodeId);
      const parentNodeId = currentNode.parentNodeId;
      if (parentNodeId === undefined) {
        break;
      }
      currentNode = nodeById.get(parentNodeId);
      if (currentNode === undefined) {
        return undefined;
      }
    }

    const nextParentByNodeId = new Map<number, number | undefined>();
    const nextConfidenceByNodeId = new Map<number, number | undefined>();
    nextParentByNodeId.set(startNode.nodeId, undefined);
    nextConfidenceByNodeId.set(startNode.nodeId, 100);

    let downstreamConfidence = startNode.confidence;
    for (let i = 1; i < pathNodeIds.length; ++i) {
      const upstreamNodeId = pathNodeIds[i];
      const upstreamNode = nodeById.get(upstreamNodeId)!;
      nextParentByNodeId.set(upstreamNodeId, pathNodeIds[i - 1]);
      nextConfidenceByNodeId.set(
        upstreamNodeId,
        downstreamConfidence ?? upstreamNode.confidence,
      );
      downstreamConfidence = upstreamNode.confidence;
    }

    let changed = false;
    const nextSegmentNodes = segmentNodes.map((candidate) => {
      if (!nextParentByNodeId.has(candidate.nodeId)) {
        return candidate;
      }
      const nextParentNodeId = nextParentByNodeId.get(candidate.nodeId);
      const nextConfidence = nextConfidenceByNodeId.get(candidate.nodeId);
      if (
        candidate.parentNodeId === nextParentNodeId &&
        candidate.confidence === nextConfidence
      ) {
        return candidate;
      }
      changed = true;
      return {
        ...candidate,
        parentNodeId: nextParentNodeId,
        confidence: nextConfidence,
      };
    });
    if (!changed) {
      return pathNodeIds;
    }
    this.replaceCachedSegmentNodes(targetNode.segmentId, nextSegmentNodes);
    return pathNodeIds;
  }

  invalidateCachedSegments(segmentIds: Iterable<number>) {
    let changed = false;
    for (const segmentId of segmentIds) {
      const normalizedSegmentId = Math.round(Number(segmentId));
      if (
        !Number.isSafeInteger(normalizedSegmentId) ||
        normalizedSegmentId <= 0
      ) {
        continue;
      }
      changed = this.deleteCachedSegment(normalizedSegmentId) || changed;
      this.abortPendingFullSegmentNodeFetch(
        normalizedSegmentId,
        "spatial skeleton full-segment inspection request invalidated for segment",
      );
    }
    return changed;
  }

  evictInactiveSegmentNodes(activeSegmentIds: Iterable<number>) {
    const activeSegmentIdSet = new Set(activeSegmentIds);
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
      this.abortPendingFullSegmentNodeFetch(
        segmentId,
        "spatial skeleton full-segment inspection request evicted for inactive segment",
      );
    }
    return changed;
  }

  /**
   * Refreshes complete segments without removing their current cached values.
   * Successful fetches are published together after every request settles, so
   * renderers never observe an intermediate cache with those segments missing.
   */
  async refreshCachedSegments(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    segmentIds: readonly number[],
    options: { notify?: boolean } = {},
  ) {
    const refreshVersion = this.fullSkeletonCacheGeneration;
    const refreshedSegments = await Promise.allSettled(
      segmentIds.map(
        async (segmentId) =>
          [
            segmentId,
            await this.fetchFullSegmentNodes(skeletonLayer, segmentId, {
              forceRefresh: true,
              updateCache: false,
            }),
          ] as const,
      ),
    );
    if (this.fullSkeletonCacheGeneration !== refreshVersion) return false;
    const replacements = new Map<
      number,
      readonly SpatiallyIndexedSkeletonNode[]
    >();
    for (const refreshedSegment of refreshedSegments) {
      if (refreshedSegment.status !== "fulfilled") continue;
      replacements.set(...refreshedSegment.value);
    }
    return this.replaceCachedSegmentSnapshots(replacements, options);
  }

  getFullSegmentNodes(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    segmentId: number,
    options: { retainWhileInactive?: boolean } = {},
  ): Promise<SpatiallyIndexedSkeletonNode[]> {
    return this.fetchFullSegmentNodes(skeletonLayer, segmentId, options);
  }

  private async fetchFullSegmentNodes(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    segmentId: number,
    options: {
      forceRefresh?: boolean;
      retainWhileInactive?: boolean;
      updateCache?: boolean;
    } = {},
  ): Promise<SpatiallyIndexedSkeletonNode[]> {
    const cached = this.fullSegmentNodeCache.get(segmentId);
    if (cached !== undefined && !options.forceRefresh) {
      return cached;
    }
    const pendingEntry = this.pendingFullSegmentNodeFetches.get(segmentId);
    if (pendingEntry !== undefined) {
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
    const fetchVersion = this.fullSkeletonCacheGeneration;
    const abortController = new AbortController();
    const pendingFetch: {
      promise?: Promise<SpatiallyIndexedSkeletonNode[]>;
    } = {};
    this.fullSegmentNodeFetchLimitLayer = skeletonLayer;
    const fetchPromise = this.fullSegmentNodeFetchLimiter
      .run(
        async () => {
          const fetchedNodes = await skeletonSource.getSkeleton(segmentId, {
            signal: abortController.signal,
          });
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
            (options.updateCache ?? true) &&
            this.fullSkeletonCacheGeneration === fetchVersion &&
            pendingFetch.promise !== undefined &&
            this.pendingFullSegmentNodeFetches.get(segmentId)?.promise ===
              pendingFetch.promise
          ) {
            this.replaceCachedSegmentNodes(segmentId, normalizedNodes);
            this.markNodeDataChanged({ invalidateFullSkeletonCache: false });
          }
          return normalizedNodes;
        },
        { signal: abortController.signal },
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
    });
    return fetchPromise;
  }

  private clearFullSkeletonCache() {
    this.fullSkeletonCacheGeneration++;
    for (const segmentId of this.pendingFullSegmentNodeFetches.keys()) {
      this.abortPendingFullSegmentNodeFetch(
        segmentId,
        "stale spatial skeleton full-segment inspection request",
      );
    }
    this.fullSegmentNodeCache.clear();
    this.cachedNodesById.clear();
  }
}

export interface SpatialSkeletonLayerContext {
  getSpatiallyIndexedSkeletonLayer(): SpatiallyIndexedSkeletonLayer | undefined;
  readonly spatialSkeletonState: SpatialSkeletonState;
}
