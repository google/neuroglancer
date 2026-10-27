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
 * @file Maps each stable ID handle to its confirmed ID, with each intent's
 * provisional IDs layered on top until that intent commits or rolls back.
 */

export interface SpatialSkeletonStableNodeHandle {
  readonly kind: "node";
  readonly stableId: string;
}

export interface SpatialSkeletonStableSegmentHandle {
  readonly kind: "segment";
  readonly stableId: string;
}

export type SpatialSkeletonStableResourceHandle =
  | SpatialSkeletonStableNodeHandle
  | SpatialSkeletonStableSegmentHandle;

function normalizeStableId(stableId: string | number) {
  const result = String(stableId);
  if (result.length === 0) {
    throw new Error("A logical handle must have a non-empty stable id.");
  }
  return result;
}

export function spatialSkeletonStableNode(
  stableId: string | number,
): SpatialSkeletonStableNodeHandle {
  return Object.freeze({ kind: "node", stableId: normalizeStableId(stableId) });
}

export function spatialSkeletonStableSegment(
  stableId: string | number,
): SpatialSkeletonStableSegmentHandle {
  return Object.freeze({
    kind: "segment",
    stableId: normalizeStableId(stableId),
  });
}

export function getSpatialSkeletonStableResourceKey(
  handle: SpatialSkeletonStableResourceHandle,
) {
  return `${handle.kind === "node" ? "n" : "s"}:${handle.stableId}`;
}

export interface SpatialSkeletonStableIdHandlesSnapshot<NodeId, SegmentId> {
  readonly baselineNodes: readonly (readonly [string, NodeId])[];
  readonly baselineSegments: readonly (readonly [string, SegmentId])[];
  readonly overlays: readonly SpatialSkeletonStableIdMappingOverlaySnapshot<
    NodeId,
    SegmentId
  >[];
}

export interface SpatialSkeletonStableIdMappingOverlaySnapshot<
  NodeId,
  SegmentId,
> {
  readonly sequence: number;
  readonly tokenRevision: number;
  readonly nodes: readonly (readonly [string, NodeId])[];
  readonly segments: readonly (readonly [string, SegmentId])[];
}

export interface SpatialSkeletonStableIdMappingUpdate<NodeId, SegmentId> {
  readonly nodes?: readonly (readonly [
    SpatialSkeletonStableNodeHandle,
    NodeId,
  ])[];
  readonly segments?: readonly (readonly [
    SpatialSkeletonStableSegmentHandle,
    SegmentId,
  ])[];
}

export interface SpatialSkeletonStableIdMappingToken {
  readonly sequence: number;
  readonly tokenRevision: number;
}

export type SpatialSkeletonStableIdMappingResolution<PhysicalId> =
  | { readonly state: "unbound" }
  | { readonly state: "authoritative"; readonly physicalId: PhysicalId }
  | {
      readonly state: "provisional";
      readonly physicalId: PhysicalId;
      readonly ownerSequence: number;
    };

interface SpatialSkeletonStableIdMappingOverlay<NodeId, SegmentId> {
  readonly token: SpatialSkeletonStableIdMappingToken;
  readonly nodeIds: Map<string, NodeId>;
  readonly segmentIds: Map<string, SegmentId>;
}

/** Mapping storage that is independent from journal snapshots and deltas. */
export class SpatialSkeletonStableIdHandles<NodeId, SegmentId> {
  private baselineNodeIds = new Map<string, NodeId>();
  private baselineSegmentIds = new Map<string, SegmentId>();
  private nodeIds = new Map<string, NodeId>();
  private segmentIds = new Map<string, SegmentId>();
  private overlays = new Map<
    number,
    SpatialSkeletonStableIdMappingOverlay<NodeId, SegmentId>
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

  resolveNode(handle: SpatialSkeletonStableNodeHandle) {
    return this.nodeIds.get(handle.stableId);
  }

  resolveSegment(handle: SpatialSkeletonStableSegmentHandle) {
    return this.segmentIds.get(handle.stableId);
  }

  /** Server-confirmed identity, independent of later preview overlays. */
  resolveAuthoritativeNode(handle: SpatialSkeletonStableNodeHandle) {
    return this.baselineNodeIds.get(handle.stableId);
  }

  resolveAuthoritativeSegment(handle: SpatialSkeletonStableSegmentHandle) {
    return this.baselineSegmentIds.get(handle.stableId);
  }

  resolveNodeTarget(
    handle: SpatialSkeletonStableNodeHandle,
  ): SpatialSkeletonStableIdMappingResolution<NodeId> {
    return this.resolveTarget(
      handle.stableId,
      this.nodeIds,
      (overlay) => overlay.nodeIds,
    );
  }

  resolveSegmentTarget(
    handle: SpatialSkeletonStableSegmentHandle,
  ): SpatialSkeletonStableIdMappingResolution<SegmentId> {
    return this.resolveTarget(
      handle.stableId,
      this.segmentIds,
      (overlay) => overlay.segmentIds,
    );
  }

  resolve(
    handle: SpatialSkeletonStableResourceHandle,
  ): NodeId | SegmentId | undefined {
    return handle.kind === "node"
      ? this.nodeIds.get(handle.stableId)
      : this.segmentIds.get(handle.stableId);
  }

  /** Binds a complete node set with one mapping revision and one rebuild. */
  bindNodes(
    bindings: Iterable<readonly [SpatialSkeletonStableNodeHandle, NodeId]>,
  ) {
    return this.apply({ nodes: [...bindings] });
  }

  bindSegment(
    handle: SpatialSkeletonStableSegmentHandle,
    physicalId: SegmentId,
  ) {
    return this.apply({ segments: [[handle, physicalId]] });
  }

  /**
   * Applies a remap atomically from an observer's perspective and increments
   * the revision once, even if a reversed merge changes several handles.
   */
  apply(update: SpatialSkeletonStableIdMappingUpdate<NodeId, SegmentId>) {
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
    update: SpatialSkeletonStableIdMappingUpdate<NodeId, SegmentId>,
  ): SpatialSkeletonStableIdMappingToken {
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
    token: SpatialSkeletonStableIdMappingToken,
    authoritativeUpdate?: SpatialSkeletonStableIdMappingUpdate<
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
          [spatialSkeletonStableNode(stableId), physicalId] as const,
      );
    const segmentUpdates =
      authoritativeUpdate?.segments ??
      [...overlay.segmentIds].map(
        ([stableId, physicalId]) =>
          [spatialSkeletonStableSegment(stableId), physicalId] as const,
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

  rollback(token: SpatialSkeletonStableIdMappingToken) {
    if (this.getOwnedOverlay(token) === undefined) return false;
    this.overlays.delete(token.sequence);
    this.rebuildEffectiveMappings();
    return true;
  }

  findNodes(physicalId: NodeId) {
    const result: SpatialSkeletonStableNodeHandle[] = [];
    for (const [stableId, candidate] of this.nodeIds) {
      if (Object.is(candidate, physicalId)) {
        result.push(spatialSkeletonStableNode(stableId));
      }
    }
    return result;
  }

  /** Resolves the first logical owner for many physical node ids in one scan. */
  findFirstNodes(physicalIds: Iterable<NodeId>) {
    const requested = new Set(physicalIds);
    const result = new Map<NodeId, SpatialSkeletonStableNodeHandle>();
    if (requested.size === 0) return result;
    for (const [stableId, physicalId] of this.nodeIds) {
      if (!requested.has(physicalId) || result.has(physicalId)) continue;
      result.set(physicalId, spatialSkeletonStableNode(stableId));
      if (result.size === requested.size) break;
    }
    return result;
  }

  findSegments(physicalId: SegmentId) {
    const result: SpatialSkeletonStableSegmentHandle[] = [];
    for (const [stableId, candidate] of this.segmentIds) {
      if (Object.is(candidate, physicalId)) {
        result.push(spatialSkeletonStableSegment(stableId));
      }
    }
    return result;
  }

  /** Isolated candidate with overlays only through the requested sequence. */
  clone(throughSequence = Infinity) {
    const result = new SpatialSkeletonStableIdHandles<NodeId, SegmentId>();
    const snapshot = this.cloneSnapshot();
    result.restoreSnapshot({
      ...snapshot,
      overlays: snapshot.overlays.filter(
        ({ sequence }) => sequence <= throughSequence,
      ),
    });
    return result;
  }

  cloneSnapshot(): SpatialSkeletonStableIdHandlesSnapshot<NodeId, SegmentId> {
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
    snapshot: SpatialSkeletonStableIdHandlesSnapshot<NodeId, SegmentId>,
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
      overlay: SpatialSkeletonStableIdMappingOverlay<NodeId, SegmentId>,
    ) => ReadonlyMap<string, PhysicalId>,
  ): SpatialSkeletonStableIdMappingResolution<PhysicalId> {
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

  private getOwnedOverlay(token: SpatialSkeletonStableIdMappingToken) {
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
      SpatialSkeletonStableIdMappingOverlay<NodeId, SegmentId>
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
