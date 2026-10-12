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
  SpatialSkeletonVector,
  SpatiallyIndexedSkeletonNode,
} from "#src/skeleton/api.js";
import {
  createCompleteSkeletonSnapshot,
  mergeCompleteSkeletonSnapshots,
  patchCompleteSkeletonSnapshot,
  splitCompleteSkeletonSnapshot,
  type CompleteSkeletonNodeChanges,
  type CompleteSkeletonNodePatch,
  type CompleteSkeletonSnapshotHandle,
} from "#src/skeleton/complete_skeleton_snapshot.js";
import {
  getSpatialSkeletonLogicalResourceKey,
  type SpatialSkeletonLogicalHandleMappings,
  type SpatialSkeletonLogicalNodeHandle,
  type SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";

export interface SpatialSkeletonProjectionNodeAttributes {
  readonly radius?: number;
  readonly confidence?: number;
  readonly description?: string;
  readonly isTrueEnd?: boolean;
}

export interface SpatialSkeletonProjectionAddDelta {
  readonly kind: "add";
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly node: SpatialSkeletonLogicalNodeHandle;
  readonly parent?: SpatialSkeletonLogicalNodeHandle;
  readonly position: SpatialSkeletonVector;
  readonly attributes?: SpatialSkeletonProjectionNodeAttributes;
}

export interface SpatialSkeletonProjectionMoveDelta {
  readonly kind: "move";
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly node: SpatialSkeletonLogicalNodeHandle;
  readonly position: SpatialSkeletonVector;
}

export interface SpatialSkeletonProjectionDeleteDelta {
  readonly kind: "delete";
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly node: SpatialSkeletonLogicalNodeHandle;
}

export interface SpatialSkeletonProjectionRerootDelta {
  readonly kind: "reroot";
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly node: SpatialSkeletonLogicalNodeHandle;
}

export type SpatialSkeletonProjectionAttributeChanges = Readonly<
  Partial<SpatialSkeletonProjectionNodeAttributes>
>;

export interface SpatialSkeletonProjectionNodeAttributesDelta {
  readonly kind: "node-attributes";
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly node: SpatialSkeletonLogicalNodeHandle;
  readonly changes: SpatialSkeletonProjectionAttributeChanges;
}

export interface SpatialSkeletonProjectionSplitDelta {
  readonly kind: "split";
  /** The side that keeps all ancestors of `node`. */
  readonly sourceSegment: SpatialSkeletonLogicalSegmentHandle;
  /** The new side containing `node` and all of its descendants. */
  readonly downstreamSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly node: SpatialSkeletonLogicalNodeHandle;
}

export interface SpatialSkeletonProjectionMergeDelta {
  readonly kind: "merge";
  readonly firstSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly secondSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly resultSegment: SpatialSkeletonLogicalSegmentHandle;
  /** The attachment point in the first skeleton. */
  readonly firstNode: SpatialSkeletonLogicalNodeHandle;
  /** The second skeleton is rerooted here and attached to `firstNode`. */
  readonly secondNode: SpatialSkeletonLogicalNodeHandle;
}

interface SpatialSkeletonProjectionRestoredNode {
  readonly node: SpatialSkeletonLogicalNodeHandle;
  readonly parent: SpatialSkeletonLogicalNodeHandle | null;
  readonly position: SpatialSkeletonVector;
  readonly attributes: SpatialSkeletonProjectionNodeAttributes;
}

interface SpatialSkeletonProjectionRestoreDeleteDelta {
  readonly kind: "restore-delete";
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly snapshot: SpatialSkeletonProjectionRestoredNode;
  readonly children: readonly SpatialSkeletonLogicalNodeHandle[];
}

interface SpatialSkeletonProjectionTopologyPatch {
  readonly node: SpatialSkeletonLogicalNodeHandle;
  readonly parent: SpatialSkeletonLogicalNodeHandle | null;
  readonly confidence: number | undefined;
}

interface SpatialSkeletonProjectionRestoreTopologyDelta {
  readonly kind: "restore-topology";
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly patches: readonly SpatialSkeletonProjectionTopologyPatch[];
}

interface SpatialSkeletonProjectionJoinSplitDelta {
  readonly kind: "join-split";
  readonly sourceSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly downstreamSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly resultSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly node: SpatialSkeletonLogicalNodeHandle;
  readonly formerParent: SpatialSkeletonLogicalNodeHandle;
}

interface SpatialSkeletonProjectionUnmergeDelta {
  readonly kind: "unmerge";
  readonly mergedSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly firstSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly secondSegment: SpatialSkeletonLogicalSegmentHandle;
  readonly firstNode: SpatialSkeletonLogicalNodeHandle;
  readonly secondNode: SpatialSkeletonLogicalNodeHandle;
  /** Exact pre-merge orientation/confidences; O(reroot path), not O(skeleton). */
  readonly formerSecondTopology: readonly SpatialSkeletonProjectionTopologyPatch[];
}

/** Semantic forward deltas accepted from command factories. */
export type SpatialSkeletonProjectionForwardDelta =
  | SpatialSkeletonProjectionAddDelta
  | SpatialSkeletonProjectionMoveDelta
  | SpatialSkeletonProjectionDeleteDelta
  | SpatialSkeletonProjectionRerootDelta
  | SpatialSkeletonProjectionNodeAttributesDelta
  | SpatialSkeletonProjectionSplitDelta
  | SpatialSkeletonProjectionMergeDelta;

/**
 * An inverse is itself reducer input.  The four private variants retain only
 * the path, cut edge, or deleted node required to restore topology; they never
 * retain a complete skeleton copy.
 */
export type SpatialSkeletonProjectionInverseDelta =
  | SpatialSkeletonProjectionForwardDelta
  | SpatialSkeletonProjectionRestoreDeleteDelta
  | SpatialSkeletonProjectionRestoreTopologyDelta
  | SpatialSkeletonProjectionJoinSplitDelta
  | SpatialSkeletonProjectionUnmergeDelta;

export type SpatialSkeletonProjectionDelta =
  SpatialSkeletonProjectionInverseDelta;

export interface SpatialSkeletonProjectionSegmentSnapshot {
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly snapshot: CompleteSkeletonSnapshotHandle;
}

export interface SpatialSkeletonProjectionSegmentChange {
  readonly segment: SpatialSkeletonLogicalSegmentHandle;
  readonly snapshot: CompleteSkeletonSnapshotHandle | undefined;
}

export interface SpatialSkeletonProjectionApplyResult {
  readonly projection: SpatialSkeletonProjectionWorkspace;
  readonly inverseDelta: SpatialSkeletonProjectionInverseDelta;
}

/** Cache snapshot access used to capture the projection baseline. */
export interface SpatialSkeletonProjectionSnapshotHandleSource {
  getCachedSegmentSnapshotHandle(segmentId: number):
    | {
        readonly handle: CompleteSkeletonSnapshotHandle;
        readonly cacheRevision: number;
      }
    | undefined;
  getCachedSegmentRevision(segmentId: number): number;
}

export type SpatialSkeletonProjectionLogicalMappings = Pick<
  SpatialSkeletonLogicalHandleMappings<number, number>,
  "resolveNode" | "resolveSegment" | "findNodes"
>;

type ProjectionMappings = SpatialSkeletonProjectionLogicalMappings;

function segmentKey(segment: SpatialSkeletonLogicalSegmentHandle) {
  return getSpatialSkeletonLogicalResourceKey(segment);
}

function handlesEqual(
  a: SpatialSkeletonLogicalNodeHandle | SpatialSkeletonLogicalSegmentHandle,
  b: SpatialSkeletonLogicalNodeHandle | SpatialSkeletonLogicalSegmentHandle,
) {
  return a.kind === b.kind && a.stableId === b.stableId;
}

function requireNodeId(
  mappings: ProjectionMappings,
  handle: SpatialSkeletonLogicalNodeHandle,
) {
  const nodeId = mappings.resolveNode(handle);
  if (nodeId === undefined) {
    throw new SpatialSkeletonProjectionValidationError(
      `Logical node ${handle.stableId} has no physical mapping.`,
    );
  }
  if (!Number.isSafeInteger(nodeId)) {
    throw new SpatialSkeletonProjectionValidationError(
      `Logical node ${handle.stableId} maps to invalid node id ${nodeId}.`,
    );
  }
  return nodeId;
}

function requireSegmentId(
  mappings: ProjectionMappings,
  handle: SpatialSkeletonLogicalSegmentHandle,
) {
  const segmentId = mappings.resolveSegment(handle);
  if (segmentId === undefined) {
    throw new SpatialSkeletonProjectionValidationError(
      `Logical segment ${handle.stableId} has no physical mapping.`,
    );
  }
  if (!Number.isSafeInteger(segmentId)) {
    throw new SpatialSkeletonProjectionValidationError(
      `Logical segment ${handle.stableId} maps to invalid segment id ${segmentId}.`,
    );
  }
  return segmentId;
}

function requireNodeHandle(
  mappings: ProjectionMappings,
  nodeId: number,
  context: string,
) {
  const handles = mappings.findNodes(nodeId);
  if (handles.length !== 1) {
    throw new SpatialSkeletonProjectionValidationError(
      `${context} node ${nodeId} must have exactly one logical handle; found ${handles.length}.`,
    );
  }
  return handles[0];
}

function cloneVector(value: SpatialSkeletonVector) {
  const result = Array.from(value);
  if (
    result.length === 0 ||
    result.some((component) => !Number.isFinite(component))
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      "A skeleton node position must contain finite coordinates.",
    );
  }
  return Object.freeze(result);
}

function cloneAttributes(
  attributes: SpatialSkeletonProjectionNodeAttributes | undefined,
): SpatialSkeletonProjectionNodeAttributes {
  if (attributes === undefined) return Object.freeze({});
  const result: {
    radius?: number;
    confidence?: number;
    description?: string;
    isTrueEnd?: boolean;
  } = {};
  if (Object.hasOwn(attributes, "radius")) result.radius = attributes.radius;
  if (Object.hasOwn(attributes, "confidence")) {
    result.confidence = attributes.confidence;
  }
  if (Object.hasOwn(attributes, "description")) {
    result.description = attributes.description;
  }
  if (Object.hasOwn(attributes, "isTrueEnd")) {
    result.isTrueEnd = attributes.isTrueEnd;
  }
  return Object.freeze(result);
}

function nodeAttributes(
  node: SpatiallyIndexedSkeletonNode,
): SpatialSkeletonProjectionNodeAttributes {
  return cloneAttributes({
    radius: node.radius,
    confidence: node.confidence,
    description: node.description,
    isTrueEnd: node.isTrueEnd,
  });
}

function validateAttributeValues(
  changes: SpatialSkeletonProjectionAttributeChanges,
) {
  if (
    Object.hasOwn(changes, "radius") &&
    changes.radius !== undefined &&
    !Number.isFinite(changes.radius)
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      "Skeleton node radius must be finite.",
    );
  }
  if (
    Object.hasOwn(changes, "confidence") &&
    changes.confidence !== undefined &&
    (!Number.isFinite(changes.confidence) ||
      changes.confidence < 0 ||
      changes.confidence > 100)
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      "Skeleton node confidence must be between 0 and 100.",
    );
  }
  if (
    Object.hasOwn(changes, "description") &&
    changes.description !== undefined &&
    typeof changes.description !== "string"
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      "Skeleton node description must be a string or undefined.",
    );
  }
  if (
    Object.hasOwn(changes, "isTrueEnd") &&
    changes.isTrueEnd !== undefined &&
    typeof changes.isTrueEnd !== "boolean"
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      "Skeleton node true-end state must be boolean or undefined.",
    );
  }
}

export class SpatialSkeletonProjectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialSkeletonProjectionValidationError";
  }
}

/** Immutable logical-segment to complete-snapshot map. */
export class SpatialSkeletonProjectionWorkspace {
  private readonly snapshotBySegmentKey: ReadonlyMap<
    string,
    SpatialSkeletonProjectionSegmentSnapshot
  >;

  constructor(segments: readonly SpatialSkeletonProjectionSegmentSnapshot[]) {
    const snapshotBySegmentKey = new Map<
      string,
      SpatialSkeletonProjectionSegmentSnapshot
    >();
    for (const { segment, snapshot } of segments) {
      const key = segmentKey(segment);
      if (snapshotBySegmentKey.has(key)) {
        throw new SpatialSkeletonProjectionValidationError(
          `Projection contains duplicate logical segment ${segment.stableId}.`,
        );
      }
      snapshotBySegmentKey.set(key, Object.freeze({ segment, snapshot }));
    }
    this.snapshotBySegmentKey = snapshotBySegmentKey;
  }

  get segments(): readonly SpatialSkeletonProjectionSegmentSnapshot[] {
    return Object.freeze([...this.snapshotBySegmentKey.values()]);
  }

  getSegment(segment: SpatialSkeletonLogicalSegmentHandle) {
    return this.snapshotBySegmentKey.get(segmentKey(segment));
  }

  /**
   * Resolves a winner/loser alias after a physical remap without changing the
   * journal delta.  More than one matching projection is an invalid baseline.
   */
  resolveSegment(
    segment: SpatialSkeletonLogicalSegmentHandle,
    mappings: ProjectionMappings,
  ) {
    const direct = this.getSegment(segment);
    if (direct !== undefined) return direct;
    const segmentId = requireSegmentId(mappings, segment);
    let result: SpatialSkeletonProjectionSegmentSnapshot | undefined;
    for (const entry of this.snapshotBySegmentKey.values()) {
      if (mappings.resolveSegment(entry.segment) !== segmentId) continue;
      if (result !== undefined) {
        throw new SpatialSkeletonProjectionValidationError(
          `Physical segment ${segmentId} has multiple projection owners.`,
        );
      }
      result = entry;
    }
    return result;
  }

  withChanges(
    changes: readonly SpatialSkeletonProjectionSegmentChange[],
  ): SpatialSkeletonProjectionWorkspace {
    const next = new Map(this.snapshotBySegmentKey);
    for (const change of changes) {
      const key = segmentKey(change.segment);
      if (change.snapshot === undefined) {
        next.delete(key);
      } else {
        next.set(
          key,
          Object.freeze({ segment: change.segment, snapshot: change.snapshot }),
        );
      }
    }
    return new SpatialSkeletonProjectionWorkspace([...next.values()]);
  }
}

function requireSegmentSnapshot(
  projection: SpatialSkeletonProjectionWorkspace,
  segment: SpatialSkeletonLogicalSegmentHandle,
  mappings: ProjectionMappings,
) {
  const entry = projection.resolveSegment(segment, mappings);
  if (entry === undefined) {
    throw new SpatialSkeletonProjectionValidationError(
      `Logical segment ${segment.stableId} is not present in the projection.`,
    );
  }
  return entry;
}

function requireNode(
  snapshot: CompleteSkeletonSnapshotHandle,
  handle: SpatialSkeletonLogicalNodeHandle,
  mappings: ProjectionMappings,
) {
  const nodeId = requireNodeId(mappings, handle);
  const node = snapshot.getNode(nodeId);
  if (node === undefined) {
    throw new SpatialSkeletonProjectionValidationError(
      `Logical node ${handle.stableId} (${nodeId}) is not present in the expected segment.`,
    );
  }
  return node;
}

function getChildren(
  snapshot: CompleteSkeletonSnapshotHandle,
  parentNodeId: number,
) {
  const result: SpatiallyIndexedSkeletonNode[] = [];
  snapshot.forEachNode((node) => {
    if (node.parentNodeId === parentNodeId) result.push(node);
  });
  return result;
}

function getPathToRoot(
  snapshot: CompleteSkeletonSnapshotHandle,
  startNodeId: number,
) {
  const result: SpatiallyIndexedSkeletonNode[] = [];
  const seen = new Set<number>();
  let node = snapshot.getNode(startNodeId);
  while (node !== undefined) {
    if (seen.has(node.nodeId)) {
      throw new SpatialSkeletonProjectionValidationError(
        "A skeleton projection contains a cycle.",
      );
    }
    seen.add(node.nodeId);
    result.push(node);
    if (node.parentNodeId === undefined) break;
    node = snapshot.getNode(node.parentNodeId);
    if (node === undefined) {
      throw new SpatialSkeletonProjectionValidationError(
        "A skeleton projection contains a node whose parent is missing.",
      );
    }
  }
  return result;
}

function getSubtreeNodeIds(
  snapshot: CompleteSkeletonSnapshotHandle,
  rootNodeId: number,
) {
  if (snapshot.getNode(rootNodeId) === undefined) {
    throw new SpatialSkeletonProjectionValidationError(
      `Cannot collect a subtree rooted at missing node ${rootNodeId}.`,
    );
  }
  const childrenByParent = new Map<number, number[]>();
  snapshot.forEachNode((node) => {
    if (node.parentNodeId === undefined) return;
    let children = childrenByParent.get(node.parentNodeId);
    if (children === undefined) {
      children = [];
      childrenByParent.set(node.parentNodeId, children);
    }
    children.push(node.nodeId);
  });
  const result = new Set<number>();
  const pending = [rootNodeId];
  while (pending.length !== 0) {
    const nodeId = pending.pop()!;
    if (result.has(nodeId)) {
      throw new SpatialSkeletonProjectionValidationError(
        "A skeleton projection contains a topology cycle.",
      );
    }
    result.add(nodeId);
    pending.push(...(childrenByParent.get(nodeId) ?? []));
  }
  return result;
}

function rerootSnapshot(
  snapshot: CompleteSkeletonSnapshotHandle,
  targetNodeId: number,
) {
  const target = snapshot.getNode(targetNodeId);
  if (target === undefined) {
    throw new SpatialSkeletonProjectionValidationError(
      `Cannot reroot at missing node ${targetNodeId}.`,
    );
  }
  if (target.isTrueEnd === true) {
    throw new SpatialSkeletonProjectionValidationError(
      "Cannot set a true end node as root. Clear the true end state first.",
    );
  }
  const path = getPathToRoot(snapshot, targetNodeId);
  // CATMAID leaves an already-root attachment and its confidence unchanged.
  if (path.length === 1) return { snapshot, path };
  const patches: CompleteSkeletonNodePatch[] = [];
  let downstreamConfidence = path[0].confidence;
  patches.push({
    kind: "update",
    nodeId: path[0].nodeId,
    changes: { parentNodeId: undefined, confidence: 100 },
  });
  for (let index = 1; index < path.length; ++index) {
    const node = path[index];
    const previousConfidence = node.confidence;
    patches.push({
      kind: "update",
      nodeId: node.nodeId,
      changes: {
        parentNodeId: path[index - 1].nodeId,
        confidence: downstreamConfidence ?? node.confidence,
      },
    });
    downstreamConfidence = previousConfidence;
  }
  return { snapshot: patchCompleteSkeletonSnapshot(snapshot, patches), path };
}

function uniqueHandles<
  T extends
    | SpatialSkeletonLogicalNodeHandle
    | SpatialSkeletonLogicalSegmentHandle,
>(handles: Iterable<T>) {
  const byKey = new Map<string, T>();
  for (const handle of handles) {
    byKey.set(getSpatialSkeletonLogicalResourceKey(handle), handle);
  }
  return Object.freeze([...byKey.values()]);
}

function applyChanges(
  projection: SpatialSkeletonProjectionWorkspace,
  inverseDelta: SpatialSkeletonProjectionInverseDelta,
  segmentChanges: readonly SpatialSkeletonProjectionSegmentChange[],
): SpatialSkeletonProjectionApplyResult {
  return Object.freeze({
    projection: projection.withChanges(segmentChanges),
    inverseDelta,
  });
}

function applyAdd(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionAddDelta,
  mappings: ProjectionMappings,
) {
  const nodeId = requireNodeId(mappings, delta.node);
  const segmentId = requireSegmentId(mappings, delta.segment);
  const existingEntry = projection.resolveSegment(delta.segment, mappings);
  let parentNodeId: number | undefined;
  if (delta.parent === undefined) {
    if (existingEntry !== undefined) {
      throw new SpatialSkeletonProjectionValidationError(
        "Cannot add a second root to an existing skeleton.",
      );
    }
  } else {
    if (existingEntry === undefined) {
      throw new SpatialSkeletonProjectionValidationError(
        "Cannot add a child to a missing skeleton.",
      );
    }
    const parent = requireNode(existingEntry.snapshot, delta.parent, mappings);
    if (parent.isTrueEnd === true) {
      throw new SpatialSkeletonProjectionValidationError(
        "Cannot add a child under a true end node. Clear the true end state first.",
      );
    }
    parentNodeId = parent.nodeId;
  }
  if (
    projection.segments.some(
      ({ snapshot }) => snapshot.getNode(nodeId) !== undefined,
    )
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      `Cannot add duplicate node ${nodeId}.`,
    );
  }
  const attributes = cloneAttributes(delta.attributes);
  validateAttributeValues(attributes);
  if (attributes.isTrueEnd === true && parentNodeId === undefined) {
    throw new SpatialSkeletonProjectionValidationError(
      "Cannot create a true end root node.",
    );
  }
  const node: SpatiallyIndexedSkeletonNode = {
    nodeId,
    segmentId,
    parentNodeId,
    position: cloneVector(delta.position),
    ...attributes,
  };
  const snapshot =
    existingEntry === undefined
      ? createCompleteSkeletonSnapshot([node])
      : patchCompleteSkeletonSnapshot(existingEntry.snapshot, [
          { kind: "insert", node },
        ]);
  const segmentChanges: SpatialSkeletonProjectionSegmentChange[] = [
    ...(existingEntry !== undefined &&
    !handlesEqual(existingEntry.segment, delta.segment)
      ? [{ segment: existingEntry.segment, snapshot: undefined }]
      : []),
    { segment: delta.segment, snapshot },
  ];
  return applyChanges(
    projection,
    { kind: "delete", segment: delta.segment, node: delta.node },
    segmentChanges,
  );
}

function applyMove(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionMoveDelta,
  mappings: ProjectionMappings,
) {
  const position = cloneVector(delta.position);
  const entry = requireSegmentSnapshot(projection, delta.segment, mappings);
  const node = requireNode(entry.snapshot, delta.node, mappings);
  const snapshot = patchCompleteSkeletonSnapshot(entry.snapshot, [
    {
      kind: "update",
      nodeId: node.nodeId,
      changes: { position },
    },
  ]);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonProjectionSegmentChange[];
  return applyChanges(
    projection,
    {
      kind: "move",
      segment: entry.segment,
      node: delta.node,
      position: cloneVector(node.position),
    },
    segmentChanges,
  );
}

function applyDelete(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionDeleteDelta,
  mappings: ProjectionMappings,
) {
  const entry = requireSegmentSnapshot(projection, delta.segment, mappings);
  const node = requireNode(entry.snapshot, delta.node, mappings);
  const children = getChildren(entry.snapshot, node.nodeId);
  if (node.parentNodeId === undefined && children.length !== 0) {
    throw new SpatialSkeletonProjectionValidationError(
      "Deleting a root node with children is blocked. Reroot the skeleton before deleting it.",
    );
  }
  const parentHandle =
    node.parentNodeId === undefined
      ? null
      : requireNodeHandle(mappings, node.parentNodeId, "Deleted parent");
  const childHandles = children.map((child) =>
    requireNodeHandle(mappings, child.nodeId, "Deleted child"),
  );
  const patches: CompleteSkeletonNodePatch[] = [
    ...children.map(
      (child): CompleteSkeletonNodePatch => ({
        kind: "update",
        nodeId: child.nodeId,
        changes: { parentNodeId: node.parentNodeId },
      }),
    ),
    { kind: "delete", nodeId: node.nodeId },
  ];
  const removesSegment = entry.snapshot.nodeCount === 1;
  const snapshot = removesSegment
    ? undefined
    : patchCompleteSkeletonSnapshot(entry.snapshot, patches);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonProjectionSegmentChange[];
  return applyChanges(
    projection,
    {
      kind: "restore-delete",
      segment: entry.segment,
      snapshot: {
        node: delta.node,
        parent: parentHandle,
        position: cloneVector(node.position),
        attributes: nodeAttributes(node),
      },
      children: childHandles,
    },
    segmentChanges,
  );
}

function applyNodeAttributes(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionNodeAttributesDelta,
  mappings: ProjectionMappings,
) {
  const entry = requireSegmentSnapshot(projection, delta.segment, mappings);
  const node = requireNode(entry.snapshot, delta.node, mappings);
  validateAttributeValues(delta.changes);
  if (Object.keys(delta.changes).length === 0) {
    throw new SpatialSkeletonProjectionValidationError(
      "A node-attributes delta must change at least one attribute.",
    );
  }
  if (delta.changes.isTrueEnd === true) {
    if (node.parentNodeId === undefined) {
      throw new SpatialSkeletonProjectionValidationError(
        "Cannot set the root node as a true end.",
      );
    }
    if (getChildren(entry.snapshot, node.nodeId).length !== 0) {
      throw new SpatialSkeletonProjectionValidationError(
        "Only leaf nodes can be marked as true ends.",
      );
    }
  }
  const before: {
    radius?: number;
    confidence?: number;
    description?: string;
    isTrueEnd?: boolean;
  } = {};
  for (const key of Object.keys(
    delta.changes,
  ) as (keyof SpatialSkeletonProjectionNodeAttributes)[]) {
    Object.assign(before, { [key]: node[key] });
  }
  const changes: CompleteSkeletonNodeChanges = {
    ...delta.changes,
  };
  const snapshot = patchCompleteSkeletonSnapshot(entry.snapshot, [
    { kind: "update", nodeId: node.nodeId, changes },
  ]);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonProjectionSegmentChange[];
  return applyChanges(
    projection,
    {
      kind: "node-attributes",
      segment: entry.segment,
      node: delta.node,
      changes: Object.freeze(before),
    },
    segmentChanges,
  );
}

function topologyPatchesFromNodes(
  nodes: readonly SpatiallyIndexedSkeletonNode[],
  mappings: ProjectionMappings,
): readonly SpatialSkeletonProjectionTopologyPatch[] {
  return Object.freeze(
    nodes.map((node) => ({
      node: requireNodeHandle(mappings, node.nodeId, "Topology path"),
      parent:
        node.parentNodeId === undefined
          ? null
          : requireNodeHandle(mappings, node.parentNodeId, "Topology parent"),
      confidence: node.confidence,
    })),
  );
}

function applyReroot(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionRerootDelta,
  mappings: ProjectionMappings,
) {
  const entry = requireSegmentSnapshot(projection, delta.segment, mappings);
  const node = requireNode(entry.snapshot, delta.node, mappings);
  const { snapshot, path } = rerootSnapshot(entry.snapshot, node.nodeId);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonProjectionSegmentChange[];
  return applyChanges(
    projection,
    {
      kind: "restore-topology",
      segment: entry.segment,
      patches: topologyPatchesFromNodes(path, mappings),
    },
    segmentChanges,
  );
}

function remapSingleSnapshotSegment(
  snapshot: CompleteSkeletonSnapshotHandle,
  segmentId: number,
  overrides: readonly {
    nodeId: number;
    changes: CompleteSkeletonNodeChanges;
  }[] = [],
) {
  return mergeCompleteSkeletonSnapshots([{ snapshot, segmentId }], {
    overrides,
  });
}

function applySplit(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionSplitDelta,
  mappings: ProjectionMappings,
) {
  if (handlesEqual(delta.sourceSegment, delta.downstreamSegment)) {
    throw new SpatialSkeletonProjectionValidationError(
      "A split requires distinct source and downstream logical segments.",
    );
  }
  const entry = requireSegmentSnapshot(
    projection,
    delta.sourceSegment,
    mappings,
  );
  if (
    projection.resolveSegment(delta.downstreamSegment, mappings) !== undefined
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      `Split result segment ${delta.downstreamSegment.stableId} already exists.`,
    );
  }
  const node = requireNode(entry.snapshot, delta.node, mappings);
  if (node.parentNodeId === undefined) {
    throw new SpatialSkeletonProjectionValidationError(
      "Cannot split at the root node.",
    );
  }
  if (node.isTrueEnd === true) {
    throw new SpatialSkeletonProjectionValidationError(
      "Cannot split at a true end node because it would become a true end root.",
    );
  }
  const formerParent = requireNodeHandle(
    mappings,
    node.parentNodeId,
    "Split parent",
  );
  const downstreamNodeIds = getSubtreeNodeIds(entry.snapshot, node.nodeId);
  const views = splitCompleteSkeletonSnapshot(
    entry.snapshot,
    downstreamNodeIds,
  );
  const sourceSegmentId = requireSegmentId(mappings, delta.sourceSegment);
  const downstreamSegmentId = requireSegmentId(
    mappings,
    delta.downstreamSegment,
  );
  const sourceSnapshot = remapSingleSnapshotSegment(
    views.remainder,
    sourceSegmentId,
  );
  const downstreamSnapshot = remapSingleSnapshotSegment(
    views.selected,
    downstreamSegmentId,
    [{ nodeId: node.nodeId, changes: { parentNodeId: undefined } }],
  );
  const segmentChanges: SpatialSkeletonProjectionSegmentChange[] = [
    ...(handlesEqual(entry.segment, delta.sourceSegment)
      ? []
      : [{ segment: entry.segment, snapshot: undefined }]),
    { segment: delta.sourceSegment, snapshot: sourceSnapshot },
    { segment: delta.downstreamSegment, snapshot: downstreamSnapshot },
  ];
  return applyChanges(
    projection,
    {
      kind: "join-split",
      sourceSegment: delta.sourceSegment,
      downstreamSegment: delta.downstreamSegment,
      resultSegment: delta.sourceSegment,
      node: delta.node,
      formerParent,
    },
    segmentChanges,
  );
}

function applyMerge(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionMergeDelta,
  mappings: ProjectionMappings,
) {
  const firstEntry = requireSegmentSnapshot(
    projection,
    delta.firstSegment,
    mappings,
  );
  const secondEntry = requireSegmentSnapshot(
    projection,
    delta.secondSegment,
    mappings,
  );
  if (firstEntry === secondEntry) {
    throw new SpatialSkeletonProjectionValidationError(
      "Cannot merge a skeleton with itself.",
    );
  }
  const existingResultEntry = projection.resolveSegment(
    delta.resultSegment,
    mappings,
  );
  if (
    existingResultEntry !== undefined &&
    existingResultEntry !== firstEntry &&
    existingResultEntry !== secondEntry
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      `Merge result segment ${delta.resultSegment.stableId} is already owned by another skeleton.`,
    );
  }
  const firstNode = requireNode(firstEntry.snapshot, delta.firstNode, mappings);
  const secondNode = requireNode(
    secondEntry.snapshot,
    delta.secondNode,
    mappings,
  );
  if (firstNode.isTrueEnd === true) {
    throw new SpatialSkeletonProjectionValidationError(
      "Cannot merge under a true end node. Clear the true end state first.",
    );
  }
  const rerooted = rerootSnapshot(secondEntry.snapshot, secondNode.nodeId);
  const resultSegmentId = requireSegmentId(mappings, delta.resultSegment);
  const snapshot = mergeCompleteSkeletonSnapshots(
    [
      { snapshot: firstEntry.snapshot, segmentId: resultSegmentId },
      { snapshot: rerooted.snapshot, segmentId: resultSegmentId },
    ],
    {
      overrides: [
        {
          nodeId: secondNode.nodeId,
          changes: { parentNodeId: firstNode.nodeId },
        },
      ],
    },
  );
  const removedEntries = uniqueHandles([
    firstEntry.segment,
    secondEntry.segment,
  ]);
  const segmentChanges: SpatialSkeletonProjectionSegmentChange[] = [
    ...removedEntries
      .filter((segment) => !handlesEqual(segment, delta.resultSegment))
      .map((segment) => ({ segment, snapshot: undefined })),
    { segment: delta.resultSegment, snapshot },
  ];
  return applyChanges(
    projection,
    {
      kind: "unmerge",
      mergedSegment: delta.resultSegment,
      firstSegment: delta.firstSegment,
      secondSegment: delta.secondSegment,
      firstNode: delta.firstNode,
      secondNode: delta.secondNode,
      formerSecondTopology: topologyPatchesFromNodes(rerooted.path, mappings),
    },
    segmentChanges,
  );
}

function applyRestoreDelete(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionRestoreDeleteDelta,
  mappings: ProjectionMappings,
) {
  const existingEntry = projection.resolveSegment(delta.segment, mappings);
  const nodeId = requireNodeId(mappings, delta.snapshot.node);
  if (
    projection.segments.some(
      ({ snapshot }) => snapshot.getNode(nodeId) !== undefined,
    )
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      `Cannot restore duplicate node ${nodeId}.`,
    );
  }
  const segmentId = requireSegmentId(mappings, delta.segment);
  const parentNodeId =
    delta.snapshot.parent === null
      ? undefined
      : requireNodeId(mappings, delta.snapshot.parent);
  if (existingEntry === undefined) {
    if (parentNodeId !== undefined || delta.children.length !== 0) {
      throw new SpatialSkeletonProjectionValidationError(
        "Only a deleted root leaf can restore a missing skeleton.",
      );
    }
  } else {
    if (
      parentNodeId !== undefined &&
      existingEntry.snapshot.getNode(parentNodeId) === undefined
    ) {
      throw new SpatialSkeletonProjectionValidationError(
        `Cannot restore node ${nodeId} under missing parent ${parentNodeId}.`,
      );
    }
    for (const child of delta.children) {
      requireNode(existingEntry.snapshot, child, mappings);
    }
  }
  const restoredNode: SpatiallyIndexedSkeletonNode = {
    nodeId,
    segmentId,
    parentNodeId,
    position: cloneVector(delta.snapshot.position),
    ...cloneAttributes(delta.snapshot.attributes),
  };
  const snapshot =
    existingEntry === undefined
      ? createCompleteSkeletonSnapshot([restoredNode])
      : patchCompleteSkeletonSnapshot(existingEntry.snapshot, [
          { kind: "insert", node: restoredNode },
          ...delta.children.map(
            (child): CompleteSkeletonNodePatch => ({
              kind: "update",
              nodeId: requireNodeId(mappings, child),
              changes: { parentNodeId: nodeId },
            }),
          ),
        ]);
  const segment = existingEntry?.segment ?? delta.segment;
  const segmentChanges = [
    { segment, snapshot },
  ] satisfies readonly SpatialSkeletonProjectionSegmentChange[];
  return applyChanges(
    projection,
    { kind: "delete", segment, node: delta.snapshot.node },
    segmentChanges,
  );
}

function applyRestoreTopology(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionRestoreTopologyDelta,
  mappings: ProjectionMappings,
) {
  const entry = requireSegmentSnapshot(projection, delta.segment, mappings);
  if (delta.patches.length === 0) {
    throw new SpatialSkeletonProjectionValidationError(
      "A topology restore requires at least one path patch.",
    );
  }
  const inversePatches: SpatialSkeletonProjectionTopologyPatch[] = [];
  const nodePatches: CompleteSkeletonNodePatch[] = [];
  for (const patch of delta.patches) {
    const node = requireNode(entry.snapshot, patch.node, mappings);
    inversePatches.push({
      node: patch.node,
      parent:
        node.parentNodeId === undefined
          ? null
          : requireNodeHandle(mappings, node.parentNodeId, "Restored parent"),
      confidence: node.confidence,
    });
    const parentNodeId =
      patch.parent === null ? undefined : requireNodeId(mappings, patch.parent);
    if (
      parentNodeId !== undefined &&
      entry.snapshot.getNode(parentNodeId) === undefined
    ) {
      throw new SpatialSkeletonProjectionValidationError(
        `Cannot restore topology through missing parent ${parentNodeId}.`,
      );
    }
    nodePatches.push({
      kind: "update",
      nodeId: node.nodeId,
      changes: { parentNodeId, confidence: patch.confidence },
    });
  }
  const snapshot = patchCompleteSkeletonSnapshot(entry.snapshot, nodePatches);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonProjectionSegmentChange[];
  return applyChanges(
    projection,
    {
      kind: "restore-topology",
      segment: entry.segment,
      patches: Object.freeze(inversePatches),
    },
    segmentChanges,
  );
}

function applyJoinSplit(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionJoinSplitDelta,
  mappings: ProjectionMappings,
) {
  const sourceEntry = requireSegmentSnapshot(
    projection,
    delta.sourceSegment,
    mappings,
  );
  const downstreamEntry = requireSegmentSnapshot(
    projection,
    delta.downstreamSegment,
    mappings,
  );
  if (sourceEntry === downstreamEntry) {
    throw new SpatialSkeletonProjectionValidationError(
      "Cannot join a split whose sides resolve to the same projection.",
    );
  }
  const existingResultEntry = projection.resolveSegment(
    delta.resultSegment,
    mappings,
  );
  if (
    existingResultEntry !== undefined &&
    existingResultEntry !== sourceEntry &&
    existingResultEntry !== downstreamEntry
  ) {
    throw new SpatialSkeletonProjectionValidationError(
      `Joined result segment ${delta.resultSegment.stableId} is already owned by another skeleton.`,
    );
  }
  const cutNode = requireNode(downstreamEntry.snapshot, delta.node, mappings);
  if (cutNode.parentNodeId !== undefined) {
    throw new SpatialSkeletonProjectionValidationError(
      "The downstream split node must still be a root before joining.",
    );
  }
  const formerParent = requireNode(
    sourceEntry.snapshot,
    delta.formerParent,
    mappings,
  );
  if (formerParent.isTrueEnd === true) {
    throw new SpatialSkeletonProjectionValidationError(
      "Cannot restore a split below a true end parent.",
    );
  }
  const resultSegmentId = requireSegmentId(mappings, delta.resultSegment);
  const snapshot = mergeCompleteSkeletonSnapshots(
    [
      { snapshot: sourceEntry.snapshot, segmentId: resultSegmentId },
      { snapshot: downstreamEntry.snapshot, segmentId: resultSegmentId },
    ],
    {
      overrides: [
        {
          nodeId: cutNode.nodeId,
          changes: { parentNodeId: formerParent.nodeId },
        },
      ],
    },
  );
  const removedEntries = uniqueHandles([
    sourceEntry.segment,
    downstreamEntry.segment,
  ]);
  const segmentChanges: SpatialSkeletonProjectionSegmentChange[] = [
    ...removedEntries
      .filter((segment) => !handlesEqual(segment, delta.resultSegment))
      .map((segment) => ({ segment, snapshot: undefined })),
    { segment: delta.resultSegment, snapshot },
  ];
  return applyChanges(
    projection,
    {
      kind: "split",
      sourceSegment: delta.resultSegment,
      downstreamSegment: delta.downstreamSegment,
      node: delta.node,
    },
    segmentChanges,
  );
}

function applyUnmerge(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionUnmergeDelta,
  mappings: ProjectionMappings,
) {
  if (handlesEqual(delta.firstSegment, delta.secondSegment)) {
    throw new SpatialSkeletonProjectionValidationError(
      "An unmerge requires distinct result segments.",
    );
  }
  const entry = requireSegmentSnapshot(
    projection,
    delta.mergedSegment,
    mappings,
  );
  for (const outputSegment of [delta.firstSegment, delta.secondSegment]) {
    const existingOutput = projection.resolveSegment(outputSegment, mappings);
    if (existingOutput !== undefined && existingOutput !== entry) {
      throw new SpatialSkeletonProjectionValidationError(
        `Unmerge output segment ${outputSegment.stableId} is already owned by another skeleton.`,
      );
    }
  }
  const firstNode = requireNode(entry.snapshot, delta.firstNode, mappings);
  const secondNode = requireNode(entry.snapshot, delta.secondNode, mappings);
  if (secondNode.parentNodeId !== firstNode.nodeId) {
    throw new SpatialSkeletonProjectionValidationError(
      "The merge attachment edge no longer exists in the projected topology.",
    );
  }
  const secondNodeIds = getSubtreeNodeIds(entry.snapshot, secondNode.nodeId);
  const views = splitCompleteSkeletonSnapshot(entry.snapshot, secondNodeIds);
  const firstSegmentId = requireSegmentId(mappings, delta.firstSegment);
  const secondSegmentId = requireSegmentId(mappings, delta.secondSegment);
  const firstSnapshot = remapSingleSnapshotSegment(
    views.remainder,
    firstSegmentId,
  );
  const detachedSecond = remapSingleSnapshotSegment(
    views.selected,
    secondSegmentId,
    [{ nodeId: secondNode.nodeId, changes: { parentNodeId: undefined } }],
  );
  const secondSnapshot = patchCompleteSkeletonSnapshot(
    detachedSecond,
    delta.formerSecondTopology.map(
      (patch): CompleteSkeletonNodePatch => ({
        kind: "update",
        nodeId: requireNodeId(mappings, patch.node),
        changes: {
          parentNodeId:
            patch.parent === null
              ? undefined
              : requireNodeId(mappings, patch.parent),
          confidence: patch.confidence,
        },
      }),
    ),
  );
  const segmentChanges: SpatialSkeletonProjectionSegmentChange[] = [
    ...(handlesEqual(entry.segment, delta.firstSegment) ||
    handlesEqual(entry.segment, delta.secondSegment)
      ? []
      : [{ segment: entry.segment, snapshot: undefined }]),
    { segment: delta.firstSegment, snapshot: firstSnapshot },
    { segment: delta.secondSegment, snapshot: secondSnapshot },
  ];
  return applyChanges(
    projection,
    {
      kind: "merge",
      firstSegment: delta.firstSegment,
      secondSegment: delta.secondSegment,
      resultSegment: delta.mergedSegment,
      firstNode: delta.firstNode,
      secondNode: delta.secondNode,
    },
    segmentChanges,
  );
}

export function applySpatialSkeletonProjectionDelta(
  projection: SpatialSkeletonProjectionWorkspace,
  delta: SpatialSkeletonProjectionDelta,
  mappings: ProjectionMappings,
): SpatialSkeletonProjectionApplyResult {
  switch (delta.kind) {
    case "add":
      return applyAdd(projection, delta, mappings);
    case "move":
      return applyMove(projection, delta, mappings);
    case "delete":
      return applyDelete(projection, delta, mappings);
    case "reroot":
      return applyReroot(projection, delta, mappings);
    case "node-attributes":
      return applyNodeAttributes(projection, delta, mappings);
    case "split":
      return applySplit(projection, delta, mappings);
    case "merge":
      return applyMerge(projection, delta, mappings);
    case "restore-delete":
      return applyRestoreDelete(projection, delta, mappings);
    case "restore-topology":
      return applyRestoreTopology(projection, delta, mappings);
    case "join-split":
      return applyJoinSplit(projection, delta, mappings);
    case "unmerge":
      return applyUnmerge(projection, delta, mappings);
  }
}
