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
 * @file Downloads complete skeletons and caches them under revision fences.
 */

import type {
  SkeletonEdge,
  SkeletonFragmentNode,
  SkeletonFragmentSource,
  SkeletonNode,
  SkeletonNodeAttributes,
} from "#src/skeleton/api.js";
import type { SpatialSkeletonAction } from "#src/skeleton/edit_commands.js";
import { getSpatialSkeletonActionSupportLabel } from "#src/skeleton/edit_commands.js";
import type { CompleteSkeleton } from "#src/skeleton/edit_queue/complete_skeleton.js";
import { createCompleteSkeleton } from "#src/skeleton/edit_queue/complete_skeleton.js";
import type { SpatialSkeletonInspectionRequiredReason } from "#src/skeleton/edit_queue/edit_errors.js";
import { SpatialSkeletonInspectionRequiredError } from "#src/skeleton/edit_queue/edit_errors.js";
import type { SpatialSkeletonQueueInputRequirement } from "#src/skeleton/edit_queue/queue_input.js";
import { resolveSkeletonParents } from "#src/skeleton/skeleton_edges.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import { bigintCompare } from "#src/util/bigint.js";
import { PromiseConcurrencyLimiter } from "#src/util/promise_concurrency_limiter.js";

/**
 * A cloneable snapshot of a full cached segment.  `undefined` represents an
 * uncached segment, while an empty array represents a known empty segment.
 */
export type SpatialSkeletonCachedSegmentSnapshot =
  | readonly SkeletonNode[]
  | undefined;

/**
 * The immutable complete-skeleton handle currently represented by a cache
 * entry, paired with the manager revision at which it was published.
 *
 * `cacheRevision` fences asynchronous cache publication. The immutable handle
 * represents snapshot contents without a separate lineage counter.
 */
export interface SpatialSkeletonCachedSegmentSnapshotHandle {
  readonly handle: CompleteSkeleton;
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
  readonly segmentId: bigint;
  readonly snapshot: SpatialSkeletonCachedSegmentSnapshotHandle;
  isCurrent(): boolean;
  release(): void;
}

async function fetchCompleteSkeleton(
  source: SkeletonFragmentSource,
  segmentId: bigint,
  signal: AbortSignal,
): Promise<SkeletonNode[]> {
  const { fragmentKeys } = await source.getSkeletonManifest(segmentId, signal);
  const nodeIds = new Set<bigint>();
  const nodes: SkeletonFragmentNode[] = [];
  const edges: SkeletonEdge[] = [];
  // One request at a time, so that a limit on concurrent skeleton reads also limits requests.
  for (const fragmentKey of fragmentKeys) {
    signal.throwIfAborted();
    const fragment = await source.getSkeletonFragment(
      segmentId,
      fragmentKey,
      signal,
    );
    for (const node of fragment.nodes) {
      if (nodeIds.has(node.nodeId)) {
        throw new Error(
          `Skeleton ${segmentId} has node ${node.nodeId} in more than one fragment.`,
        );
      }
      nodeIds.add(node.nodeId);
      nodes.push(node);
    }
    edges.push(...fragment.edges);
  }
  return resolveSkeletonParents(segmentId, nodes, edges, source.edgeDirection);
}

function normalizeSkeletonNode(node: SkeletonNode): SkeletonNode | undefined {
  const x = Number(node.position[0]);
  const y = Number(node.position[1]);
  const z = Number(node.position[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return undefined;
  }
  return {
    ...node,
    position: new Float32Array([x, y, z]),
    description:
      typeof node.description === "string" && node.description.length > 0
        ? node.description
        : undefined,
  };
}

function cloneSkeletonNode(node: SkeletonNode): SkeletonNode {
  return {
    ...node,
    position: new Float32Array(node.position),
  };
}

function skeletonNodeAttributesEqual(
  a: SkeletonNodeAttributes | undefined,
  b: SkeletonNodeAttributes | undefined,
) {
  const aIds = Object.keys(a ?? {});
  if (aIds.length !== Object.keys(b ?? {}).length) return false;
  for (const id of aIds) {
    const aValue = a![id];
    const bValue = b?.[id];
    if (bValue === undefined || aValue.length !== bValue.length) return false;
    for (let i = 0; i < aValue.length; ++i) {
      if (aValue[i] !== bValue[i]) return false;
    }
  }
  return true;
}

function cachedSkeletonNodesEqual(a: SkeletonNode, b: SkeletonNode) {
  if (
    a.nodeId !== b.nodeId ||
    a.segmentId !== b.segmentId ||
    a.parentNodeId !== b.parentNodeId ||
    a.description !== b.description ||
    !skeletonNodeAttributesEqual(a.attributes, b.attributes) ||
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
  a: readonly SkeletonNode[] | undefined,
  b: readonly SkeletonNode[] | undefined,
) {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.length === b.length &&
    a.every((node, index) => cachedSkeletonNodesEqual(node, b[index]))
  );
}

interface SpatialSkeletonCachedSegmentReplacement {
  readonly nodes: readonly SkeletonNode[] | undefined;
  readonly handle: CompleteSkeleton | undefined;
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

/** Stores each finished download whose cache revision is still current. */
export interface CompleteSkeletonDownloadTarget {
  publishAuthoritativeReadSnapshots(
    snapshots: ReadonlyMap<bigint, readonly SkeletonNode[] | undefined>,
    options: { readonly expectedRevisions: ReadonlyMap<bigint, number> },
  ): boolean;
}

/** Replacement cache maps and revision fences, built in full before adoption. */
export interface CompleteSkeletonCachePublication {
  readonly expectedRevisionClock: number;
  readonly expectedRevisions: ReadonlyMap<bigint, number>;
  /** Planned post-adoption revisions of every published segment. */
  readonly cacheRevisions: ReadonlyMap<bigint, number>;
  readonly nextRevisionClock: number;
  readonly nextRevisions: Map<bigint, number>;
  readonly nextNodeCache: Map<bigint, SkeletonNode[]>;
  readonly nextSnapshotHandles: Map<
    bigint,
    SpatialSkeletonCachedSegmentSnapshotHandle
  >;
  readonly nextNodesById: Map<bigint, SkeletonNode>;
  readonly changedSegmentIds: readonly bigint[];
  readonly retiredSegmentIds: ReadonlySet<bigint>;
}

export class CompleteSkeletonCache {
  /** Complete node arrays for the current cached versions of skeletons. */
  private fullSegmentNodeCache = new Map<bigint, SkeletonNode[]>();
  /** Immutable views of those versions, paired with local cache revisions. */
  private fullSegmentSnapshotHandles = new Map<
    bigint,
    SpatialSkeletonCachedSegmentSnapshotHandle
  >();
  /**
   * Per-segment registrations that protect current snapshots from eviction.
   * Each acquisition adds its own token pointing to the snapshot and revision;
   * releasing that input reference removes only its token.
   */
  private queueInputReferenceRegistrations = new Map<
    bigint,
    Map<object, SpatialSkeletonCachedSegmentSnapshotHandle>
  >();
  /**
   * A monotonic revision fence for each complete segment cache entry.  The
   * floor represents a global cache invalidation without having to enumerate
   * every segment id that may have been captured by an outstanding read.
   */
  private fullSegmentNodeRevisionClock = 0;
  private fullSegmentNodeRevisionFloor = 0;
  private fullSegmentNodeRevisions = new Map<bigint, number>();
  private pendingFullSegmentNodeFetches = new Map<
    bigint,
    {
      promise: Promise<SkeletonNode[]>;
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
  private cachedNodesById = new Map<bigint, SkeletonNode>();

  constructor(
    private readonly downloadTarget: CompleteSkeletonDownloadTarget,
  ) {}

  get isEmpty() {
    return (
      this.fullSegmentNodeCache.size === 0 &&
      this.pendingFullSegmentNodeFetches.size === 0 &&
      this.cachedNodesById.size === 0
    );
  }

  getSegmentNodes(segmentId: bigint) {
    return this.fullSegmentNodeCache.get(segmentId);
  }

  /**
   * Returns the current local revision of a complete cached segment.  The
   * revision also changes when an uncached segment is explicitly invalidated,
   * allowing callers to fence asynchronous work without relying on cache
   * presence alone.
   */
  getSegmentRevision(segmentId: bigint) {
    if (segmentId === 0n) {
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
  getSnapshotHandle(
    segmentId: bigint,
  ): SpatialSkeletonCachedSegmentSnapshotHandle | undefined {
    if (segmentId === 0n) {
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
   * previewed snapshot without starting a read or changing cache state.
   */
  private getCachedQueueInputSegment(
    requirement: SpatialSkeletonQueueInputRequirement,
  ):
    | {
        readonly segmentId: bigint;
        readonly snapshot: SpatialSkeletonCachedSegmentSnapshotHandle;
      }
    | undefined {
    const { segmentId, nodeId } = requirement;
    if (nodeId === 0n) {
      throw new RangeError(`Invalid spatial skeleton node id: ${nodeId}`);
    }
    const snapshot = this.getSnapshotHandle(segmentId);
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
      const current = this.getSnapshotHandle(cachedInput.segmentId);
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
      this.getSnapshotHandle(requirement.segmentId) === undefined
        ? "snapshot-unavailable"
        : "node-unavailable";
    throw new SpatialSkeletonInspectionRequiredError(
      requirement,
      reason,
      action && getSpatialSkeletonActionSupportLabel(action),
    );
  }

  getNode(nodeId: bigint) {
    return this.cachedNodesById.get(nodeId);
  }

  /** Returns the segments whose snapshot changed. */
  replaceSnapshots(
    snapshots: Iterable<
      readonly [bigint, SpatialSkeletonCachedSegmentSnapshot]
    >,
    options: { expectedRevisions?: ReadonlyMap<bigint, number> },
  ): readonly bigint[] {
    const replacements = new Map<
      bigint,
      SpatialSkeletonCachedSegmentReplacement
    >();
    for (const [segmentId, snapshot] of snapshots) {
      if (segmentId === 0n) {
        throw new RangeError(
          `Invalid spatial skeleton segment id: ${segmentId}`,
        );
      }
      if (snapshot === undefined) {
        replacements.set(segmentId, {
          nodes: undefined,
          handle: undefined,
        });
        continue;
      }
      const clonedNodes: SkeletonNode[] = [];
      for (const node of snapshot) {
        if (node.nodeId === 0n) {
          throw new RangeError(
            `Invalid spatial skeleton node id: ${node.nodeId}`,
          );
        }
        clonedNodes.push(cloneSkeletonNode({ ...node, segmentId }));
      }
      replacements.set(segmentId, {
        nodes: clonedNodes,
        // Untrusted input remains defensively cloned above. The immutable
        // handle is the complete baseline used by inspection and preview.
        handle: createCompleteSkeleton(clonedNodes),
      });
    }
    return this.publishCachedSegmentSnapshotReplacements(replacements, options);
  }

  /**
   * Materializes lazy handles, validates node ownership, fences revisions and
   * builds the complete replacement maps. Returns `undefined` when a segment
   * no longer has its expected revision.
   */
  preparePublication(
    handles: ReadonlyMap<bigint, CompleteSkeleton | undefined>,
    retiredSegmentIds: ReadonlySet<bigint>,
    expectedRevisions: ReadonlyMap<bigint, number>,
  ): CompleteSkeletonCachePublication | undefined {
    for (const segmentId of handles.keys()) {
      if (
        expectedRevisions.get(segmentId) !==
        this.getCurrentCachedSegmentRevision(segmentId)
      ) {
        return undefined;
      }
    }

    const replacements = new Map<
      bigint,
      SpatialSkeletonCachedSegmentReplacement
    >();
    for (const [segmentId, handle] of handles) {
      if (handle === undefined) {
        replacements.set(segmentId, {
          nodes: undefined,
          handle: undefined,
        });
        continue;
      }
      const nodes = handle.materialize();
      for (const node of nodes) {
        if (node.nodeId === 0n) {
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
      });
    }

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
    const nextNodeCache = new Map(this.fullSegmentNodeCache);
    const nextSnapshotHandles = new Map(this.fullSegmentSnapshotHandles);
    const nextNodesById = new Map(this.cachedNodesById);

    for (const segmentId of changedSegmentIds) {
      for (const node of this.fullSegmentNodeCache.get(segmentId) ?? []) {
        if (nextNodesById.get(node.nodeId) === node) {
          nextNodesById.delete(node.nodeId);
        }
      }
    }
    for (const [segmentId, replacement] of replacements) {
      if (!changedSegmentIdSet.has(segmentId)) continue;
      for (const node of replacement.nodes ?? []) {
        const existing = nextNodesById.get(node.nodeId);
        if (existing !== undefined) {
          throw new Error(
            `Spatial skeleton node ${node.nodeId} is present in both segment ${existing.segmentId} and segment ${segmentId}.`,
          );
        }
        nextNodesById.set(node.nodeId, node);
      }
      if (replacement.nodes === undefined) {
        nextNodeCache.delete(segmentId);
      } else {
        nextNodeCache.set(segmentId, replacement.nodes as SkeletonNode[]);
      }
    }

    const expectedRevisionClock = this.fullSegmentNodeRevisionClock;
    let nextRevisionClock = expectedRevisionClock;
    const nextRevisions = new Map(this.fullSegmentNodeRevisions);
    const cacheRevisions = new Map<bigint, number>();
    for (const segmentId of changedSegmentIds) {
      const cacheRevision = ++nextRevisionClock;
      nextRevisions.set(segmentId, cacheRevision);
      const handle = replacements.get(segmentId)!.handle;
      if (handle === undefined) {
        nextSnapshotHandles.delete(segmentId);
      } else {
        nextSnapshotHandles.set(segmentId, { handle, cacheRevision });
      }
    }
    for (const segmentId of handles.keys()) {
      cacheRevisions.set(
        segmentId,
        Math.max(
          this.fullSegmentNodeRevisionFloor,
          nextRevisions.get(segmentId) ?? 0,
        ),
      );
    }
    return Object.freeze({
      expectedRevisionClock,
      expectedRevisions: new Map(expectedRevisions),
      cacheRevisions,
      nextRevisionClock,
      nextRevisions,
      nextNodeCache,
      nextSnapshotHandles,
      nextNodesById,
      changedSegmentIds: Object.freeze(changedSegmentIds),
      retiredSegmentIds,
    });
  }

  canAdoptPublication(publication: CompleteSkeletonCachePublication) {
    if (
      this.fullSegmentNodeRevisionClock !== publication.expectedRevisionClock
    ) {
      return false;
    }
    for (const [segmentId, expectedRevision] of publication.expectedRevisions) {
      if (
        this.getCurrentCachedSegmentRevision(segmentId) !== expectedRevision
      ) {
        return false;
      }
    }
    return true;
  }

  /** Installs a prepared publication using reference assignments only. */
  adoptPublication(publication: CompleteSkeletonCachePublication) {
    this.fullSegmentNodeRevisionClock = publication.nextRevisionClock;
    this.fullSegmentNodeRevisions = publication.nextRevisions;
    this.fullSegmentNodeCache = publication.nextNodeCache;
    this.fullSegmentSnapshotHandles = publication.nextSnapshotHandles;
    this.cachedNodesById = publication.nextNodesById;
  }

  /** Aborts the downloads that an adopted publication replaced. */
  finishPublication(
    publication: CompleteSkeletonCachePublication,
    reportError?: (error: unknown) => void,
  ) {
    for (const segmentId of publication.changedSegmentIds) {
      try {
        this.abortPendingFullSegmentNodeFetch(
          segmentId,
          publication.retiredSegmentIds.has(segmentId)
            ? "spatial skeleton full-segment inspection request retired after authoritative topology change"
            : "spatial skeleton full-segment inspection request replaced by atomic local cache update",
          { preserveRetained: !publication.retiredSegmentIds.has(segmentId) },
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
    replacements: ReadonlyMap<bigint, SpatialSkeletonCachedSegmentReplacement>,
    options: {
      expectedRevisions?: ReadonlyMap<bigint, number>;
    },
  ): readonly bigint[] {
    if (replacements.size === 0) return [];

    if (options.expectedRevisions !== undefined) {
      for (const segmentId of replacements.keys()) {
        if (
          options.expectedRevisions.get(segmentId) !==
          this.getCurrentCachedSegmentRevision(segmentId)
        ) {
          return [];
        }
      }
    }

    const changedSegmentIds: bigint[] = [];
    for (const [segmentId, replacement] of replacements) {
      if (
        !cachedSegmentSnapshotsEqual(
          this.fullSegmentNodeCache.get(segmentId),
          replacement.nodes,
        )
      ) {
        changedSegmentIds.push(segmentId);
      }
    }
    if (changedSegmentIds.length === 0) {
      return [];
    }
    const changedSegmentIdSet = new Set(changedSegmentIds);

    // Validate the prospective reverse-index entries before mutating either
    // cache.  The existing reverse index lets us check ownership against every
    // unaffected segment without walking or rebuilding their complete
    // snapshots.  Entries owned by changed segments are intentionally ignored:
    // those old entries are removed below before the validated replacements
    // are installed.  `nextChangedNodesById` additionally rejects duplicates
    // between (or within) the replacements themselves.
    const nextChangedNodesById = new Map<bigint, SkeletonNode>();
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
        this.fullSegmentNodeCache.set(
          segmentId,
          replacement.nodes as SkeletonNode[],
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
    return changedSegmentIds;
  }

  private deleteCachedSegment(segmentId: bigint) {
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
    segmentId: bigint,
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
  releaseFetchOwner(owner: object) {
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

  private getCurrentCachedSegmentRevision(segmentId: bigint) {
    return Math.max(
      this.fullSegmentNodeRevisionFloor,
      this.fullSegmentNodeRevisions.get(segmentId) ?? 0,
    );
  }

  private advanceCachedSegmentRevision(segmentId: bigint) {
    const revision = ++this.fullSegmentNodeRevisionClock;
    this.fullSegmentNodeRevisions.set(segmentId, revision);
    return revision;
  }

  evictInactive(activeSegmentIdSet: Set<bigint>) {
    for (const [segmentId, registrationsForSegment] of this
      .queueInputReferenceRegistrations) {
      const current = this.getSnapshotHandle(segmentId);
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

  async fetchSegmentNodes(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    segmentId: bigint,
    options: {
      retainWhileInactive?: boolean;
      /**
       * Opaque lease owner that can release this pending read on disposal.
       * An owned read starts before unowned reads waiting for a slot.
       */
      requestOwner?: object;
    } = {},
  ): Promise<SkeletonNode[]> {
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
    const skeletonSource = skeletonLayer.fragmentSource;
    if (skeletonSource === undefined) {
      throw new Error(
        "The active spatial skeleton source does not expose full skeleton inspection.",
      );
    }
    const fetchRevision = this.getSegmentRevision(segmentId);
    const abortController = new AbortController();
    const pendingFetch: {
      promise?: Promise<SkeletonNode[]>;
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
          const sourceRequest = fetchCompleteSkeleton(
            skeletonSource,
            segmentId,
            abortController.signal,
          );
          // If abort/deadline wins the race, the source may still resolve or
          // reject later because not every implementation observes its
          // signal. Keep that detached outcome observed.
          void sourceRequest.catch(() => undefined);
          let fetchedNodes: SkeletonNode[];
          try {
            fetchedNodes = await Promise.race([sourceRequest, aborted]);
          } finally {
            clearTimeout(timeout);
            abortController.signal.removeEventListener(
              "abort",
              rejectFromAbort,
            );
          }
          const normalizedNodes: SkeletonNode[] = [];
          for (const fetchedNode of fetchedNodes) {
            const mappedNode = normalizeSkeletonNode(fetchedNode);
            if (mappedNode === undefined) continue;
            normalizedNodes.push(mappedNode);
          }
          normalizedNodes.sort((a, b) => bigintCompare(a.nodeId, b.nodeId));
          if (
            this.getCurrentCachedSegmentRevision(segmentId) === fetchRevision &&
            pendingFetch.promise !== undefined &&
            this.pendingFullSegmentNodeFetches.get(segmentId)?.promise ===
              pendingFetch.promise
          ) {
            this.downloadTarget.publishAuthoritativeReadSnapshots(
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

  clear() {
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
}
