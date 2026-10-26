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

import type { VisibleSegmentsState } from "#src/segmentation_display_state/base.js";
import { getVisibleSegments } from "#src/segmentation_display_state/base.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import type {
  SpatialSkeletonDisplaySnapshot,
  SpatialSkeletonEditSession,
} from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";
import { bigintCompare } from "#src/util/bigint.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

export interface SpatiallyIndexedSkeletonOverlayNodeLike {
  nodeId: bigint;
  segmentId: bigint;
  position: ArrayLike<number>;
  parentNodeId?: bigint;
}

export interface SpatiallyIndexedSkeletonOverlayGeometry {
  positions: Float32Array;
  segmentIds: BigUint64Array;
  nodeIds: BigUint64Array;
  indices: Uint32Array;
  numVertices: number;
  // Maps nodeId to its packed vertex index. Retained by the overlay chunk so a
  // live node drag can override just the moving vertex's position via a shader
  // uniform, rather than rebuilding or re-uploading the geometry.
  nodeIndex: ReadonlyMap<bigint, number>;
}

// Writes xyz node positions (one vertex per node, in `orderedNodes` order) into
// `positions`, applying any pending (dragged) position override so the built
// texture is correct at build time. Live-drag position changes between builds
// are applied at render time via a shader uniform, not here.
function writeSpatiallyIndexedSkeletonOverlayNodePositions(
  orderedNodes: readonly SpatiallyIndexedSkeletonOverlayNodeLike[],
  positions: Float32Array,
  getPendingNodePosition?: (nodeId: bigint) => ArrayLike<number> | undefined,
) {
  for (let index = 0; index < orderedNodes.length; ++index) {
    const node = orderedNodes[index];
    const position = getPendingNodePosition?.(node.nodeId) ?? node.position;
    const baseOffset = index * 3;
    positions[baseOffset] = Number(position[0] ?? 0);
    positions[baseOffset + 1] = Number(position[1] ?? 0);
    positions[baseOffset + 2] = Number(position[2] ?? 0);
  }
}

export function buildSpatiallyIndexedSkeletonOverlayGeometry(
  segmentNodeSets: readonly (readonly SpatiallyIndexedSkeletonOverlayNodeLike[])[],
  options: {
    getPendingNodePosition?: (nodeId: bigint) => ArrayLike<number> | undefined;
  } = {},
): SpatiallyIndexedSkeletonOverlayGeometry {
  const { getPendingNodePosition } = options;
  const nodeIndex = new Map<bigint, number>();
  const orderedNodes: SpatiallyIndexedSkeletonOverlayNodeLike[] = [];

  for (const segmentNodes of segmentNodeSets) {
    for (const node of segmentNodes) {
      if (nodeIndex.has(node.nodeId)) continue;
      nodeIndex.set(node.nodeId, orderedNodes.length);
      orderedNodes.push(node);
    }
  }

  const numVertices = orderedNodes.length;
  const positions = new Float32Array(numVertices * 3);
  const nodeIds = new BigUint64Array(numVertices);
  const segmentIds = new BigUint64Array(numVertices);
  writeSpatiallyIndexedSkeletonOverlayNodePositions(
    orderedNodes,
    positions,
    getPendingNodePosition,
  );
  orderedNodes.forEach((node, index) => {
    segmentIds[index] = node.segmentId;
    nodeIds[index] = node.nodeId;
  });

  const indices: number[] = [];
  orderedNodes.forEach((node, childIndex) => {
    if (node.parentNodeId === undefined) return;
    const parentIndex = nodeIndex.get(node.parentNodeId);
    if (parentIndex === undefined) return;
    indices.push(childIndex, parentIndex);
  });

  return {
    positions,
    segmentIds,
    nodeIds,
    indices: new Uint32Array(indices),
    numVertices,
    nodeIndex,
  };
}

const MAX_RETAINED_OVERLAY_SEGMENTS = 24;

function mergeSpatiallyIndexedSkeletonOverlaySegmentIds(
  activeSegmentIds: readonly bigint[],
  retainedSegmentIds: readonly bigint[],
) {
  const mergedSegmentIds = new Set<bigint>();
  for (const segmentId of [...activeSegmentIds, ...retainedSegmentIds]) {
    if (segmentId === 0n) continue;
    mergedSegmentIds.add(segmentId);
  }
  return [...mergedSegmentIds].sort(bigintCompare);
}

/**
 * Trims to `maxRetained` entries, evicting the oldest (smallest counter)
 * entries first.
 */
function trimRetainedOverlaySegments(
  retainedSegments: Map<bigint, number>,
  maxRetained: number,
): Map<bigint, number> {
  const excess = retainedSegments.size - maxRetained;
  if (excess <= 0) {
    return retainedSegments;
  }
  const oldestSegmentIdsFirst = [...retainedSegments.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([candidateSegmentId]) => candidateSegmentId);
  const nextRetainedSegments = new Map(retainedSegments);
  for (const candidateSegmentId of oldestSegmentIdsFirst.slice(0, excess)) {
    nextRetainedSegments.delete(candidateSegmentId);
  }
  return nextRetainedSegments;
}

/** Only the relative order of `touchCounter` values matters. */
function retainSpatiallyIndexedSkeletonOverlaySegment(
  retainedSegments: ReadonlyMap<bigint, number>,
  segmentId: bigint,
  touchCounter: number,
): Map<bigint, number> {
  if (segmentId === 0n) {
    return new Map(retainedSegments);
  }
  const nextRetainedSegments = new Map(retainedSegments);
  nextRetainedSegments.set(segmentId, touchCounter);
  return trimRetainedOverlaySegments(
    nextRetainedSegments,
    MAX_RETAINED_OVERLAY_SEGMENTS,
  );
}

/** Assumes only one node is dragged at a time. */
export function getPendingNodeOverride(
  nodeIndex: ReadonlyMap<bigint, number>,
  editSession: Pick<
    SpatialSkeletonEditSession,
    "getPendingNodeIds" | "getPendingNodePosition"
  >,
): { vertexIndex: number; position: ArrayLike<number> } | undefined {
  for (const nodeId of editSession.getPendingNodeIds()) {
    const vertexIndex = nodeIndex.get(nodeId);
    if (vertexIndex === undefined) continue;
    const position = editSession.getPendingNodePosition(nodeId);
    if (position === undefined) continue;
    return { vertexIndex, position };
  }
  return undefined;
}

export type SkeletonOverlaySegmentsEditSession = Pick<
  SpatialSkeletonEditSession,
  | "nodeDataVersion"
  | "spatialSkeletonDisplay"
  | "pendingNodePositionVersion"
  | "getPendingNodePosition"
  | "getCachedSegmentNodes"
  | "evictInactiveSegmentNodes"
  | "getFullSegmentNodes"
>;

export interface SkeletonOverlaySegmentsOptions {
  readonly segmentationGroupState: WatchableValueInterface<VisibleSegmentsState>;
  readonly editSession: SkeletonOverlaySegmentsEditSession;
}

interface OverlaySegmentEntry {
  readonly nodes: readonly SkeletonNode[];
  readonly pendingPositionKey: string;
}

export class SkeletonOverlaySegments extends RefCounted {
  readonly changed = new NullarySignal();
  readonly browseExcludedSegments = this.registerDisposer(new Uint64Set());
  /** Segment ID to the counter value of its most recent edit. */
  private retainedSegments = new Map<bigint, number>();
  private touchCounter = 0;
  private readonly temporaryBrowseExclusions = new Set<{ segmentId: bigint }>();
  private readonly pendingLoads = new Set<bigint>();
  private readonly entries = new Map<bigint, OverlaySegmentEntry>();
  private readonly pendingPositionKeys = new Map<
    bigint,
    {
      readonly nodes: readonly SkeletonNode[];
      readonly pendingNodePositionVersion: number;
      readonly key: string;
    }
  >();
  private readonly geometries = new Map<
    bigint,
    SpatiallyIndexedSkeletonOverlayGeometry
  >();
  /** Advances when the pool, an exclusion or the set of built geometries changes. */
  private membershipVersion = 0;
  private geometriesFrameNumber = -1;
  private renderSegmentIds: bigint[] = [];
  private renderSegmentIdsKey:
    | {
        readonly visibleSegments: Uint64Set;
        readonly generation: number;
        readonly membershipVersion: number;
      }
    | undefined;
  private browseExclusionKey:
    | {
        readonly visibleSegments: Uint64Set;
        readonly generation: number;
        readonly membershipVersion: number;
        readonly nodeDataVersion: number;
        readonly presentation: SpatialSkeletonDisplaySnapshot;
      }
    | undefined;

  constructor(private readonly options: SkeletonOverlaySegmentsOptions) {
    super();
  }

  retain(segmentId: bigint): void {
    if (segmentId === 0n) return;
    this.setRetainedSegments(
      retainSpatiallyIndexedSkeletonOverlaySegment(
        this.retainedSegments,
        segmentId,
        ++this.touchCounter,
      ),
    );
  }

  remap(remappings: ReadonlyMap<bigint, bigint>): void {
    if (remappings.size === 0) return;
    // A destination may also be a source for another skeleton in this batch.
    const resolve = (segmentId: bigint) => {
      const next = remappings.get(segmentId);
      return next !== undefined && next !== 0n ? next : segmentId;
    };
    let changed = false;
    for (const exclusion of this.temporaryBrowseExclusions) {
      const resolved = resolve(exclusion.segmentId);
      if (resolved === exclusion.segmentId) continue;
      exclusion.segmentId = resolved;
      changed = true;
    }
    // Two provisional skeletons may become one. The newer edit decides its place in the pool.
    const touchCounters = new Map<bigint, number>();
    for (const [segmentId, touchCounter] of this.retainedSegments) {
      const resolved = resolve(segmentId);
      const previous = touchCounters.get(resolved);
      if (previous === undefined || touchCounter > previous) {
        touchCounters.set(resolved, touchCounter);
      }
    }
    let nextRetainedSegments = new Map<bigint, number>();
    for (const [segmentId, touchCounter] of touchCounters) {
      nextRetainedSegments = retainSpatiallyIndexedSkeletonOverlaySegment(
        nextRetainedSegments,
        segmentId,
        touchCounter,
      );
    }
    for (const sourceSegmentId of remappings.keys()) {
      changed = this.pendingLoads.delete(sourceSegmentId) || changed;
    }
    if (changed) ++this.membershipVersion;
    if (!this.setRetainedSegments(nextRetainedSegments) && changed) {
      this.changed.dispatch();
    }
  }

  /** Forgets every skeleton, for a new data source. */
  clear(): void {
    this.retainedSegments = new Map();
    this.temporaryBrowseExclusions.clear();
    this.pendingLoads.clear();
    this.entries.clear();
    this.geometries.clear();
    this.pendingPositionKeys.clear();
    this.geometriesFrameNumber = -1;
    this.markMembershipChanged();
  }

  getRetainedSegmentIds(): bigint[] {
    return [...this.retainedSegments.keys()];
  }

  /** Hides the browse copy without adding the skeleton to the pool. */
  beginTemporaryBrowseExclusion(segmentId: bigint): () => void {
    if (segmentId === 0n) return () => {};
    const exclusion = { segmentId };
    this.temporaryBrowseExclusions.add(exclusion);
    this.markMembershipChanged();
    return () => {
      if (this.temporaryBrowseExclusions.delete(exclusion)) {
        this.markMembershipChanged();
      }
    };
  }

  /**
   * Rebuilds at most once per frame, and loads missing nodes through `skeletonLayer`.
   * Each geometry keeps its identity until its segment's nodes or pending positions change.
   */
  updateGeometries(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    frameNumber: number,
  ): ReadonlyMap<bigint, SpatiallyIndexedSkeletonOverlayGeometry> {
    if (frameNumber === this.geometriesFrameNumber) return this.geometries;
    this.geometriesFrameNumber = frameNumber;
    const { editSession } = this.options;
    const segmentIds = this.getRenderSegmentIds();
    if (segmentIds.length !== 0) {
      editSession.evictInactiveSegmentNodes(segmentIds);
    }
    const removedSegmentIds = new Set(
      editSession.spatialSkeletonDisplay.value.removedSegmentIds,
    );
    const desiredSegmentIds = new Set(
      segmentIds.filter((segmentId) => !removedSegmentIds.has(segmentId)),
    );
    for (const segmentId of this.entries.keys()) {
      if (desiredSegmentIds.has(segmentId)) continue;
      this.entries.delete(segmentId);
      this.geometries.delete(segmentId);
      this.pendingPositionKeys.delete(segmentId);
      ++this.membershipVersion;
    }
    for (const segmentId of desiredSegmentIds) {
      const nodes = editSession.getCachedSegmentNodes(segmentId);
      if (nodes === undefined) {
        // The last geometry stays drawn while refreshed nodes load.
        this.requestLoad(skeletonLayer, segmentId);
        continue;
      }
      const entry = this.entries.get(segmentId);
      const pendingPositionKey = this.getPendingPositionKey(segmentId, nodes);
      if (
        entry !== undefined &&
        entry.nodes === nodes &&
        entry.pendingPositionKey === pendingPositionKey
      ) {
        continue;
      }
      if (entry === undefined) ++this.membershipVersion;
      this.entries.set(segmentId, { nodes, pendingPositionKey });
      this.geometries.set(
        segmentId,
        buildSpatiallyIndexedSkeletonOverlayGeometry([nodes], {
          getPendingNodePosition: (nodeId) =>
            editSession.getPendingNodePosition(nodeId),
        }),
      );
    }
    return this.geometries;
  }

  /** Returns whether any skeleton is excluded from the browse pass. */
  updateBrowseExcludedSegments(): boolean {
    const { editSession, segmentationGroupState } = this.options;
    const visibleSegments = getVisibleSegments(segmentationGroupState.value);
    const presentation = editSession.spatialSkeletonDisplay.value;
    const key = {
      visibleSegments,
      generation: visibleSegments.hashTable.generation,
      membershipVersion: this.membershipVersion,
      nodeDataVersion: editSession.nodeDataVersion.value,
      presentation,
    };
    const previous = this.browseExclusionKey;
    if (
      previous === undefined ||
      previous.visibleSegments !== key.visibleSegments ||
      previous.generation !== key.generation ||
      previous.membershipVersion !== key.membershipVersion ||
      previous.nodeDataVersion !== key.nodeDataVersion ||
      previous.presentation !== key.presentation
    ) {
      this.browseExclusionKey = key;
      // Pooled skeletons own their full copy even off-screen.
      const segmentIds = new Set([
        ...this.retainedSegments.keys(),
        ...presentation.removedSegmentIds,
      ]);
      for (const exclusion of this.temporaryBrowseExclusions) {
        segmentIds.add(exclusion.segmentId);
      }
      // A visible skeleton keeps its browse copy until its full copy can be drawn.
      for (const segmentId of this.getVisibleSegmentIds()) {
        if (
          this.entries.has(segmentId) ||
          editSession.getCachedSegmentNodes(segmentId) !== undefined
        ) {
          segmentIds.add(segmentId);
        }
      }
      this.browseExcludedSegments.clear();
      if (segmentIds.size !== 0) {
        this.browseExcludedSegments.add([...segmentIds].sort(bigintCompare));
      }
    }
    return this.browseExcludedSegments.size !== 0;
  }

  private setRetainedSegments(nextRetainedSegments: Map<bigint, number>) {
    const previous = this.retainedSegments;
    this.retainedSegments = nextRetainedSegments;
    if (
      nextRetainedSegments.size === previous.size &&
      [...nextRetainedSegments.keys()].every((segmentId) =>
        previous.has(segmentId),
      )
    ) {
      return false;
    }
    this.markMembershipChanged();
    return true;
  }

  private markMembershipChanged() {
    ++this.membershipVersion;
    this.changed.dispatch();
  }

  private getVisibleSegmentIds() {
    const segmentIds: bigint[] = [];
    for (const segmentId of getVisibleSegments(
      this.options.segmentationGroupState.value,
    ).keys()) {
      if (segmentId !== 0n) segmentIds.push(segmentId);
    }
    return segmentIds;
  }

  private getRenderSegmentIds() {
    const visibleSegments = getVisibleSegments(
      this.options.segmentationGroupState.value,
    );
    const previous = this.renderSegmentIdsKey;
    const generation = visibleSegments.hashTable.generation;
    if (
      previous === undefined ||
      previous.visibleSegments !== visibleSegments ||
      previous.generation !== generation ||
      previous.membershipVersion !== this.membershipVersion
    ) {
      this.renderSegmentIdsKey = {
        visibleSegments,
        generation,
        membershipVersion: this.membershipVersion,
      };
      this.renderSegmentIds = mergeSpatiallyIndexedSkeletonOverlaySegmentIds(
        this.getVisibleSegmentIds(),
        [...this.retainedSegments.keys()],
      );
    }
    return this.renderSegmentIds;
  }

  private getPendingPositionKey(
    segmentId: bigint,
    nodes: readonly SkeletonNode[],
  ) {
    const { editSession } = this.options;
    const pendingNodePositionVersion =
      editSession.pendingNodePositionVersion.value;
    const cached = this.pendingPositionKeys.get(segmentId);
    if (
      cached !== undefined &&
      cached.nodes === nodes &&
      cached.pendingNodePositionVersion === pendingNodePositionVersion
    ) {
      return cached.key;
    }
    const pendingPositions: string[] = [];
    for (const node of nodes) {
      const position = editSession.getPendingNodePosition(node.nodeId);
      if (position === undefined) continue;
      pendingPositions.push(
        `${node.nodeId}:${position[0]},${position[1]},${position[2]}`,
      );
    }
    const key = pendingPositions.join(";");
    this.pendingPositionKeys.set(segmentId, {
      nodes,
      pendingNodePositionVersion,
      key,
    });
    return key;
  }

  private requestLoad(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    segmentId: bigint,
  ) {
    if (this.pendingLoads.has(segmentId)) return;
    this.pendingLoads.add(segmentId);
    void this.options.editSession
      .getFullSegmentNodes(skeletonLayer, segmentId)
      .catch(() => {})
      .finally(() => {
        if (this.wasDisposed) return;
        this.pendingLoads.delete(segmentId);
        this.changed.dispatch();
      });
  }
}
