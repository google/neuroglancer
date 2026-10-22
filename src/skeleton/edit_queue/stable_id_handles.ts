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
 * Stable identities used by optimistic reducers.
 *
 * A handle is deliberately not a CATMAID id.  Its physical id may change when
 * a temporary node is created, a split id is assigned, or CATMAID reverses a
 * merge winner.  Journal entries keep the handle and the mapping is updated in
 * one place.
 */
export interface SpatialSkeletonLogicalNodeHandle {
  readonly kind: "node";
  readonly stableId: string;
}

export interface SpatialSkeletonLogicalSegmentHandle {
  readonly kind: "segment";
  readonly stableId: string;
}

export type SpatialSkeletonLogicalResourceHandle =
  | SpatialSkeletonLogicalNodeHandle
  | SpatialSkeletonLogicalSegmentHandle;

function normalizeStableId(stableId: string | number) {
  const result = String(stableId);
  if (result.length === 0) {
    throw new Error("A logical handle must have a non-empty stable id.");
  }
  return result;
}

export function spatialSkeletonLogicalNode(
  stableId: string | number,
): SpatialSkeletonLogicalNodeHandle {
  return Object.freeze({ kind: "node", stableId: normalizeStableId(stableId) });
}

export function spatialSkeletonLogicalSegment(
  stableId: string | number,
): SpatialSkeletonLogicalSegmentHandle {
  return Object.freeze({
    kind: "segment",
    stableId: normalizeStableId(stableId),
  });
}

export function getSpatialSkeletonLogicalResourceKey(
  handle: SpatialSkeletonLogicalResourceHandle,
) {
  return `${handle.kind === "node" ? "n" : "s"}:${handle.stableId}`;
}

export interface SpatialSkeletonLogicalHandleMappingsSnapshot<
  NodeId,
  SegmentId,
> {
  readonly baselineNodes: readonly (readonly [string, NodeId])[];
  readonly baselineSegments: readonly (readonly [string, SegmentId])[];
  readonly overlays: readonly SpatialSkeletonLogicalHandleMappingOverlaySnapshot<
    NodeId,
    SegmentId
  >[];
}

export interface SpatialSkeletonLogicalHandleMappingOverlaySnapshot<
  NodeId,
  SegmentId,
> {
  readonly sequence: number;
  readonly tokenRevision: number;
  readonly nodes: readonly (readonly [string, NodeId])[];
  readonly segments: readonly (readonly [string, SegmentId])[];
}

export interface SpatialSkeletonLogicalHandleMappingUpdate<NodeId, SegmentId> {
  readonly nodes?: readonly (readonly [
    SpatialSkeletonLogicalNodeHandle,
    NodeId,
  ])[];
  readonly segments?: readonly (readonly [
    SpatialSkeletonLogicalSegmentHandle,
    SegmentId,
  ])[];
}

export interface SpatialSkeletonLogicalHandleMappingToken {
  readonly sequence: number;
  readonly tokenRevision: number;
}

export type SpatialSkeletonLogicalHandleMappingResolution<PhysicalId> =
  | { readonly state: "unbound" }
  | { readonly state: "authoritative"; readonly physicalId: PhysicalId }
  | {
      readonly state: "provisional";
      readonly physicalId: PhysicalId;
      readonly ownerSequence: number;
    };

interface SpatialSkeletonLogicalHandleMappingOverlay<NodeId, SegmentId> {
  readonly token: SpatialSkeletonLogicalHandleMappingToken;
  readonly nodeIds: Map<string, NodeId>;
  readonly segmentIds: Map<string, SegmentId>;
}

/** Mapping storage that is independent from journal snapshots and deltas. */
export class SpatialSkeletonLogicalHandleMappings<NodeId, SegmentId> {
  private baselineNodeIds = new Map<string, NodeId>();
  private baselineSegmentIds = new Map<string, SegmentId>();
  private nodeIds = new Map<string, NodeId>();
  private segmentIds = new Map<string, SegmentId>();
  private overlays = new Map<
    number,
    SpatialSkeletonLogicalHandleMappingOverlay<NodeId, SegmentId>
  >();
  private mappingRevision = 0;
  private nextTokenRevision = 1;

  get revision() {
    return this.mappingRevision;
  }

  /** Immutable ownership token for a currently staged overlay. */
  getOverlayToken(sequence: number) {
    return this.overlays.get(sequence)?.token;
  }

  resolveNode(handle: SpatialSkeletonLogicalNodeHandle) {
    return this.nodeIds.get(handle.stableId);
  }

  resolveSegment(handle: SpatialSkeletonLogicalSegmentHandle) {
    return this.segmentIds.get(handle.stableId);
  }

  /** Server-confirmed identity, independent of later preview overlays. */
  resolveAuthoritativeNode(handle: SpatialSkeletonLogicalNodeHandle) {
    return this.baselineNodeIds.get(handle.stableId);
  }

  resolveAuthoritativeSegment(handle: SpatialSkeletonLogicalSegmentHandle) {
    return this.baselineSegmentIds.get(handle.stableId);
  }

  resolveNodeTarget(
    handle: SpatialSkeletonLogicalNodeHandle,
  ): SpatialSkeletonLogicalHandleMappingResolution<NodeId> {
    return this.resolveTarget(
      handle.stableId,
      this.nodeIds,
      (overlay) => overlay.nodeIds,
    );
  }

  resolveSegmentTarget(
    handle: SpatialSkeletonLogicalSegmentHandle,
  ): SpatialSkeletonLogicalHandleMappingResolution<SegmentId> {
    return this.resolveTarget(
      handle.stableId,
      this.segmentIds,
      (overlay) => overlay.segmentIds,
    );
  }

  resolve(
    handle: SpatialSkeletonLogicalResourceHandle,
  ): NodeId | SegmentId | undefined {
    return handle.kind === "node"
      ? this.nodeIds.get(handle.stableId)
      : this.segmentIds.get(handle.stableId);
  }

  /** Binds a complete node set with one mapping revision and one rebuild. */
  bindNodes(
    bindings: Iterable<readonly [SpatialSkeletonLogicalNodeHandle, NodeId]>,
  ) {
    return this.apply({ nodes: [...bindings] });
  }

  bindSegment(
    handle: SpatialSkeletonLogicalSegmentHandle,
    physicalId: SegmentId,
  ) {
    return this.apply({ segments: [[handle, physicalId]] });
  }

  /**
   * Applies a remap atomically from an observer's perspective and increments
   * the revision once, even if a reversed merge changes several handles.
   */
  apply(update: SpatialSkeletonLogicalHandleMappingUpdate<NodeId, SegmentId>) {
    let changed = false;
    let nextNodeIds = this.baselineNodeIds;
    let nextSegmentIds = this.baselineSegmentIds;
    for (const [handle, physicalId] of update.nodes ?? []) {
      if (handle.kind !== "node") {
        throw new Error(
          "A node mapping update requires a logical node handle.",
        );
      }
      if (
        !nextNodeIds.has(handle.stableId) ||
        !Object.is(nextNodeIds.get(handle.stableId), physicalId)
      ) {
        if (nextNodeIds === this.baselineNodeIds) {
          nextNodeIds = new Map(this.baselineNodeIds);
        }
        nextNodeIds.set(handle.stableId, physicalId);
        changed = true;
      }
    }
    for (const [handle, physicalId] of update.segments ?? []) {
      if (handle.kind !== "segment") {
        throw new Error(
          "A segment mapping update requires a logical segment handle.",
        );
      }
      if (
        !nextSegmentIds.has(handle.stableId) ||
        !Object.is(nextSegmentIds.get(handle.stableId), physicalId)
      ) {
        if (nextSegmentIds === this.baselineSegmentIds) {
          nextSegmentIds = new Map(this.baselineSegmentIds);
        }
        nextSegmentIds.set(handle.stableId, physicalId);
        changed = true;
      }
    }
    if (!changed) return false;
    this.baselineNodeIds = nextNodeIds;
    this.baselineSegmentIds = nextSegmentIds;
    this.rebuildEffectiveMappings();
    return true;
  }

  /**
   * Stages provisional bindings owned by one ordered journal intent. A later
   * rollback removes only that owner's overlay and then replays surviving
   * overlays in sequence order.
   */
  stage(
    sequence: number,
    update: SpatialSkeletonLogicalHandleMappingUpdate<NodeId, SegmentId>,
  ): SpatialSkeletonLogicalHandleMappingToken {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new Error(
        "A logical mapping overlay requires a positive sequence.",
      );
    }
    if (this.overlays.has(sequence)) {
      throw new Error(
        `Logical mapping overlay ${sequence} has already been staged.`,
      );
    }
    const token = Object.freeze({
      sequence,
      tokenRevision: this.nextTokenRevision++,
    });
    this.overlays.set(sequence, {
      token,
      nodeIds: new Map(
        (update.nodes ?? []).map(([handle, physicalId]) => [
          handle.stableId,
          physicalId,
        ]),
      ),
      segmentIds: new Map(
        (update.segments ?? []).map(([handle, physicalId]) => [
          handle.stableId,
          physicalId,
        ]),
      ),
    });
    this.rebuildEffectiveMappings();
    return token;
  }

  commit(
    token: SpatialSkeletonLogicalHandleMappingToken,
    authoritativeUpdate?: SpatialSkeletonLogicalHandleMappingUpdate<
      NodeId,
      SegmentId
    >,
  ) {
    const overlay = this.getOwnedOverlay(token);
    if (overlay === undefined) return false;
    const nodeUpdates =
      authoritativeUpdate?.nodes ??
      [...overlay.nodeIds].map(
        ([stableId, physicalId]) =>
          [spatialSkeletonLogicalNode(stableId), physicalId] as const,
      );
    const segmentUpdates =
      authoritativeUpdate?.segments ??
      [...overlay.segmentIds].map(
        ([stableId, physicalId]) =>
          [spatialSkeletonLogicalSegment(stableId), physicalId] as const,
      );
    for (const [handle, physicalId] of nodeUpdates) {
      this.baselineNodeIds.set(handle.stableId, physicalId);
    }
    for (const [handle, physicalId] of segmentUpdates) {
      this.baselineSegmentIds.set(handle.stableId, physicalId);
    }
    this.overlays.delete(token.sequence);
    this.rebuildEffectiveMappings();
    return true;
  }

  rollback(token: SpatialSkeletonLogicalHandleMappingToken) {
    if (this.getOwnedOverlay(token) === undefined) return false;
    this.overlays.delete(token.sequence);
    this.rebuildEffectiveMappings();
    return true;
  }

  findNodes(physicalId: NodeId) {
    const result: SpatialSkeletonLogicalNodeHandle[] = [];
    for (const [stableId, candidate] of this.nodeIds) {
      if (Object.is(candidate, physicalId)) {
        result.push(spatialSkeletonLogicalNode(stableId));
      }
    }
    return result;
  }

  /** Resolves the first logical owner for many physical node ids in one scan. */
  findFirstNodes(physicalIds: Iterable<NodeId>) {
    const requested = new Set(physicalIds);
    const result = new Map<NodeId, SpatialSkeletonLogicalNodeHandle>();
    if (requested.size === 0) return result;
    for (const [stableId, physicalId] of this.nodeIds) {
      if (!requested.has(physicalId) || result.has(physicalId)) continue;
      result.set(physicalId, spatialSkeletonLogicalNode(stableId));
      if (result.size === requested.size) break;
    }
    return result;
  }

  findSegments(physicalId: SegmentId) {
    const result: SpatialSkeletonLogicalSegmentHandle[] = [];
    for (const [stableId, candidate] of this.segmentIds) {
      if (Object.is(candidate, physicalId)) {
        result.push(spatialSkeletonLogicalSegment(stableId));
      }
    }
    return result;
  }

  /** Isolated candidate with overlays only through the requested sequence. */
  clone(throughSequence = Infinity) {
    const result = new SpatialSkeletonLogicalHandleMappings<
      NodeId,
      SegmentId
    >();
    const snapshot = this.cloneSnapshot();
    result.restoreSnapshot({
      ...snapshot,
      overlays: snapshot.overlays.filter(
        ({ sequence }) => sequence <= throughSequence,
      ),
    });
    return result;
  }

  cloneSnapshot(): SpatialSkeletonLogicalHandleMappingsSnapshot<
    NodeId,
    SegmentId
  > {
    return {
      baselineNodes: [...this.baselineNodeIds],
      baselineSegments: [...this.baselineSegmentIds],
      overlays: [...this.overlays.values()].map((overlay) => ({
        sequence: overlay.token.sequence,
        tokenRevision: overlay.token.tokenRevision,
        nodes: [...overlay.nodeIds],
        segments: [...overlay.segmentIds],
      })),
    };
  }

  restoreSnapshot(
    snapshot: SpatialSkeletonLogicalHandleMappingsSnapshot<NodeId, SegmentId>,
  ) {
    const nextBaselineNodeIds = new Map(snapshot.baselineNodes);
    const nextBaselineSegmentIds = new Map(snapshot.baselineSegments);
    const nextOverlays = new Map(
      snapshot.overlays.map((overlay) => [
        overlay.sequence,
        {
          token: Object.freeze({
            sequence: overlay.sequence,
            tokenRevision: overlay.tokenRevision,
          }),
          nodeIds: new Map(overlay.nodes),
          segmentIds: new Map(overlay.segments),
        },
      ]),
    );
    if (
      mapsEqual(this.baselineNodeIds, nextBaselineNodeIds) &&
      mapsEqual(this.baselineSegmentIds, nextBaselineSegmentIds) &&
      this.overlaysEqual(nextOverlays)
    ) {
      return false;
    }
    this.baselineNodeIds = nextBaselineNodeIds;
    this.baselineSegmentIds = nextBaselineSegmentIds;
    this.overlays = nextOverlays;
    this.nextTokenRevision = Math.max(
      this.nextTokenRevision,
      1 +
        Math.max(
          0,
          ...snapshot.overlays.map(({ tokenRevision }) => tokenRevision),
        ),
    );
    this.rebuildEffectiveMappings(false);
    // Restoring an older mapping must invalidate publications prepared against
    // the newer mapping.
    ++this.mappingRevision;
    return true;
  }

  private resolveTarget<PhysicalId>(
    stableId: string,
    values: ReadonlyMap<string, PhysicalId>,
    getOverlayValues: (
      overlay: SpatialSkeletonLogicalHandleMappingOverlay<NodeId, SegmentId>,
    ) => ReadonlyMap<string, PhysicalId>,
  ): SpatialSkeletonLogicalHandleMappingResolution<PhysicalId> {
    let provisionalOwner: number | undefined;
    for (const [sequence, overlay] of [...this.overlays].sort(
      ([first], [second]) => second - first,
    )) {
      if (getOverlayValues(overlay).has(stableId)) {
        provisionalOwner = sequence;
        break;
      }
    }
    if (!values.has(stableId)) return { state: "unbound" };
    const physicalId = values.get(stableId)!;
    return provisionalOwner === undefined
      ? { state: "authoritative", physicalId }
      : { state: "provisional", physicalId, ownerSequence: provisionalOwner };
  }

  private getOwnedOverlay(token: SpatialSkeletonLogicalHandleMappingToken) {
    const overlay = this.overlays.get(token.sequence);
    return overlay?.token.tokenRevision === token.tokenRevision
      ? overlay
      : undefined;
  }

  private rebuildEffectiveMappings(incrementRevision = true) {
    const nextNodeIds = new Map(this.baselineNodeIds);
    const nextSegmentIds = new Map(this.baselineSegmentIds);
    for (const [, overlay] of [...this.overlays].sort(
      ([first], [second]) => first - second,
    )) {
      for (const [stableId, physicalId] of overlay.nodeIds) {
        nextNodeIds.set(stableId, physicalId);
      }
      for (const [stableId, physicalId] of overlay.segmentIds) {
        nextSegmentIds.set(stableId, physicalId);
      }
    }
    const changed =
      !mapsEqual(this.nodeIds, nextNodeIds) ||
      !mapsEqual(this.segmentIds, nextSegmentIds);
    this.nodeIds = nextNodeIds;
    this.segmentIds = nextSegmentIds;
    if (incrementRevision && changed) ++this.mappingRevision;
    return changed;
  }

  private overlaysEqual(
    other: Map<
      number,
      SpatialSkeletonLogicalHandleMappingOverlay<NodeId, SegmentId>
    >,
  ) {
    if (this.overlays.size !== other.size) return false;
    for (const [sequence, overlay] of this.overlays) {
      const candidate = other.get(sequence);
      if (
        candidate === undefined ||
        candidate.token.tokenRevision !== overlay.token.tokenRevision ||
        !mapsEqual(candidate.nodeIds, overlay.nodeIds) ||
        !mapsEqual(candidate.segmentIds, overlay.segmentIds)
      ) {
        return false;
      }
    }
    return true;
  }
}

function mapsEqual<Key, Value>(a: Map<Key, Value>, b: Map<Key, Value>) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || !Object.is(b.get(key), value)) return false;
  }
  return true;
}
