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
 * @file Applies one delta to a set of complete skeletons and returns the new
 * set with the inverse delta that undoes it.
 */

import type { SkeletonVector, SkeletonNode } from "#src/skeleton/api.js";
import type {
  CompleteSkeletonNodeChanges,
  CompleteSkeletonNodePatch,
  CompleteSkeleton,
} from "#src/skeleton/edit_queue/complete_skeleton.js";
import {
  createCompleteSkeleton,
  mergeCompleteSkeletons,
  patchCompleteSkeleton,
  splitCompleteSkeleton,
  remapCompleteSkeleton,
} from "#src/skeleton/edit_queue/complete_skeleton.js";
import type {
  SpatialSkeletonStableIdHandles,
  SpatialSkeletonStableNodeHandle,
  SpatialSkeletonStableSegmentHandle,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import { getSpatialSkeletonStableResourceKey } from "#src/skeleton/edit_queue/stable_id_handles.js";
import {
  getSkeletonNodeConfidence,
  getSkeletonNodeRadius,
  isSkeletonNodeTrueEnd,
  setSkeletonNodeAttributes,
} from "#src/skeleton/node_attributes.js";

export function materializeCompleteSkeletonSet(
  workspace: CompleteSkeletonSet,
  mappings: SpatialSkeletonStableIdHandles<bigint, bigint>,
) {
  const result = new Map<
    bigint,
    {
      readonly segment: SpatialSkeletonStableSegmentHandle;
      readonly snapshot: CompleteSkeleton;
    }
  >();
  for (const entry of workspace.segments) {
    const segmentId = mappings.resolveSegment(entry.segment);
    if (segmentId === undefined || segmentId === 0n) {
      throw new SpatialSkeletonEditValidationError(
        `Logical segment ${entry.segment.stableId} requires a nonzero id for publication.`,
      );
    }
    if (result.has(segmentId)) {
      throw new SpatialSkeletonEditValidationError(
        `Physical segment ${segmentId} has multiple active logical owners.`,
      );
    }
    result.set(segmentId, entry);
  }
  return result;
}

export function ownsPhysicalSpatialSkeletonSegment(
  workspace: CompleteSkeletonSet,
  mappings: SpatialSkeletonStableIdHandles<bigint, bigint>,
  segmentId: bigint,
) {
  return workspace.segments.some(
    ({ segment }) => mappings.resolveSegment(segment) === segmentId,
  );
}

export function remapCompleteSkeletonSet(
  workspace: CompleteSkeletonSet,
  nodeIds: ReadonlyMap<bigint, bigint>,
  segmentIds: ReadonlyMap<bigint, bigint>,
) {
  if (nodeIds.size === 0 && segmentIds.size === 0) return workspace;
  return new CompleteSkeletonSet(
    workspace.segments.map(({ segment, snapshot }) => ({
      segment,
      snapshot: remapCompleteSkeleton(snapshot, {
        nodeIds,
        segmentIds,
      }),
    })),
  );
}

export interface SpatialSkeletonEditNodeAttributes {
  readonly radius?: number;
  readonly confidence?: number;
  readonly description?: string;
  readonly isTrueEnd?: boolean;
}

export interface SpatialSkeletonEditAddDelta {
  readonly kind: "add";
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly node: SpatialSkeletonStableNodeHandle;
  readonly parent?: SpatialSkeletonStableNodeHandle;
  readonly position: SkeletonVector;
  readonly attributes?: SpatialSkeletonEditNodeAttributes;
}

export interface SpatialSkeletonEditMoveDelta {
  readonly kind: "move";
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly node: SpatialSkeletonStableNodeHandle;
  readonly position: SkeletonVector;
}

export interface SpatialSkeletonEditDeleteDelta {
  readonly kind: "delete";
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly node: SpatialSkeletonStableNodeHandle;
}

export interface SpatialSkeletonEditRerootDelta {
  readonly kind: "reroot";
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly node: SpatialSkeletonStableNodeHandle;
}

export type SpatialSkeletonEditAttributeChanges = Readonly<
  Partial<SpatialSkeletonEditNodeAttributes>
>;

export interface SpatialSkeletonEditNodeAttributesDelta {
  readonly kind: "node-attributes";
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly node: SpatialSkeletonStableNodeHandle;
  readonly changes: SpatialSkeletonEditAttributeChanges;
}

export interface SpatialSkeletonEditSplitDelta {
  readonly kind: "split";
  /** The side that keeps all ancestors of `node`. */
  readonly sourceSegment: SpatialSkeletonStableSegmentHandle;
  /** The new side containing `node` and all of its descendants. */
  readonly downstreamSegment: SpatialSkeletonStableSegmentHandle;
  readonly node: SpatialSkeletonStableNodeHandle;
}

export interface SpatialSkeletonEditMergeDelta {
  readonly kind: "merge";
  readonly firstSegment: SpatialSkeletonStableSegmentHandle;
  readonly secondSegment: SpatialSkeletonStableSegmentHandle;
  readonly resultSegment: SpatialSkeletonStableSegmentHandle;
  /** The attachment point in the first skeleton. */
  readonly firstNode: SpatialSkeletonStableNodeHandle;
  /** The second skeleton is rerooted here and attached to `firstNode`. */
  readonly secondNode: SpatialSkeletonStableNodeHandle;
}

interface SpatialSkeletonEditRestoredNode {
  readonly node: SpatialSkeletonStableNodeHandle;
  readonly parent: SpatialSkeletonStableNodeHandle | null;
  readonly position: SkeletonVector;
  readonly attributes: SpatialSkeletonEditNodeAttributes;
}

interface SpatialSkeletonEditRestoreDeleteDelta {
  readonly kind: "restore-delete";
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly snapshot: SpatialSkeletonEditRestoredNode;
  readonly children: readonly SpatialSkeletonStableNodeHandle[];
}

interface SpatialSkeletonEditTopologyPatch {
  readonly node: SpatialSkeletonStableNodeHandle;
  readonly parent: SpatialSkeletonStableNodeHandle | null;
  readonly confidence: number | undefined;
}

interface SpatialSkeletonEditRestoreTopologyDelta {
  readonly kind: "restore-topology";
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly patches: readonly SpatialSkeletonEditTopologyPatch[];
}

interface SpatialSkeletonEditJoinSplitDelta {
  readonly kind: "join-split";
  readonly sourceSegment: SpatialSkeletonStableSegmentHandle;
  readonly downstreamSegment: SpatialSkeletonStableSegmentHandle;
  readonly resultSegment: SpatialSkeletonStableSegmentHandle;
  readonly node: SpatialSkeletonStableNodeHandle;
  readonly formerParent: SpatialSkeletonStableNodeHandle;
}

interface SpatialSkeletonEditUnmergeDelta {
  readonly kind: "unmerge";
  readonly mergedSegment: SpatialSkeletonStableSegmentHandle;
  readonly firstSegment: SpatialSkeletonStableSegmentHandle;
  readonly secondSegment: SpatialSkeletonStableSegmentHandle;
  readonly firstNode: SpatialSkeletonStableNodeHandle;
  readonly secondNode: SpatialSkeletonStableNodeHandle;
  /** Exact pre-merge orientation/confidences; O(reroot path), not O(skeleton). */
  readonly formerSecondTopology: readonly SpatialSkeletonEditTopologyPatch[];
}

/** Semantic forward deltas accepted from command factories. */
export type SpatialSkeletonEditForwardDelta =
  | SpatialSkeletonEditAddDelta
  | SpatialSkeletonEditMoveDelta
  | SpatialSkeletonEditDeleteDelta
  | SpatialSkeletonEditRerootDelta
  | SpatialSkeletonEditNodeAttributesDelta
  | SpatialSkeletonEditSplitDelta
  | SpatialSkeletonEditMergeDelta;

/**
 * An inverse is itself reducer input.  The four private variants retain only
 * the path, cut edge, or deleted node required to restore topology; they never
 * retain a complete skeleton copy.
 */
export type SpatialSkeletonEditInverseDelta =
  | SpatialSkeletonEditForwardDelta
  | SpatialSkeletonEditRestoreDeleteDelta
  | SpatialSkeletonEditRestoreTopologyDelta
  | SpatialSkeletonEditJoinSplitDelta
  | SpatialSkeletonEditUnmergeDelta;

export type SpatialSkeletonEditDelta = SpatialSkeletonEditInverseDelta;

export interface SpatialSkeletonEditSegmentSnapshot {
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly snapshot: CompleteSkeleton;
}

export interface SpatialSkeletonEditSegmentChange {
  readonly segment: SpatialSkeletonStableSegmentHandle;
  readonly snapshot: CompleteSkeleton | undefined;
}

export interface SpatialSkeletonEditApplyResult {
  readonly edit: CompleteSkeletonSet;
  readonly inverseDelta: SpatialSkeletonEditInverseDelta;
}

/** Cache snapshot access used to capture the preview baseline. */
export interface SpatialSkeletonEditSnapshotHandleSource {
  getCachedSegmentSnapshotHandle(segmentId: bigint):
    | {
        readonly handle: CompleteSkeleton;
        readonly cacheRevision: number;
      }
    | undefined;
  getCachedSegmentRevision(segmentId: bigint): number;
}

export type SpatialSkeletonEditStableMappings = Pick<
  SpatialSkeletonStableIdHandles<bigint, bigint>,
  "resolveNode" | "resolveSegment" | "findNodes"
>;

type EditMappings = SpatialSkeletonEditStableMappings;

function segmentKey(segment: SpatialSkeletonStableSegmentHandle) {
  return getSpatialSkeletonStableResourceKey(segment);
}

function handlesEqual(
  a: SpatialSkeletonStableNodeHandle | SpatialSkeletonStableSegmentHandle,
  b: SpatialSkeletonStableNodeHandle | SpatialSkeletonStableSegmentHandle,
) {
  return a.kind === b.kind && a.stableId === b.stableId;
}

function requireNodeId(
  mappings: EditMappings,
  handle: SpatialSkeletonStableNodeHandle,
) {
  const nodeId = mappings.resolveNode(handle);
  if (nodeId === undefined) {
    throw new SpatialSkeletonEditValidationError(
      `Logical node ${handle.stableId} has no physical mapping.`,
    );
  }
  return nodeId;
}

function requireSegmentId(
  mappings: EditMappings,
  handle: SpatialSkeletonStableSegmentHandle,
) {
  const segmentId = mappings.resolveSegment(handle);
  if (segmentId === undefined) {
    throw new SpatialSkeletonEditValidationError(
      `Logical segment ${handle.stableId} has no physical mapping.`,
    );
  }
  return segmentId;
}

function requireNodeHandle(
  mappings: EditMappings,
  nodeId: bigint,
  context: string,
) {
  const handles = mappings.findNodes(nodeId);
  if (handles.length !== 1) {
    throw new SpatialSkeletonEditValidationError(
      `${context} node ${nodeId} must have exactly one logical handle; found ${handles.length}.`,
    );
  }
  return handles[0];
}

function cloneVector(value: SkeletonVector) {
  const result = Array.from(value);
  if (
    result.length === 0 ||
    result.some((component) => !Number.isFinite(component))
  ) {
    throw new SpatialSkeletonEditValidationError(
      "A skeleton node position must contain finite coordinates.",
    );
  }
  return Object.freeze(result);
}

function cloneAttributes(
  attributes: SpatialSkeletonEditNodeAttributes | undefined,
): SpatialSkeletonEditNodeAttributes {
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

function nodeAttributes(node: SkeletonNode): SpatialSkeletonEditNodeAttributes {
  return cloneAttributes({
    radius: getSkeletonNodeRadius(node),
    confidence: getSkeletonNodeConfidence(node),
    description: node.description,
    isTrueEnd: isSkeletonNodeTrueEnd(node),
  });
}

function withConfidence(
  node: SkeletonNode,
  confidence: number | undefined,
): CompleteSkeletonNodeChanges {
  return {
    attributes: setSkeletonNodeAttributes(node.attributes, { confidence }),
  };
}

export function getSkeletonNodeChanges(
  node: SkeletonNode | undefined,
  changes: SpatialSkeletonEditAttributeChanges,
): CompleteSkeletonNodeChanges {
  const { description, ...attributeChanges } = changes;
  return {
    ...(Object.hasOwn(changes, "description") ? { description } : {}),
    ...(Object.keys(attributeChanges).length === 0
      ? {}
      : {
          attributes: setSkeletonNodeAttributes(
            node?.attributes,
            attributeChanges,
          ),
        }),
  };
}

function validateAttributeValues(changes: SpatialSkeletonEditAttributeChanges) {
  if (
    Object.hasOwn(changes, "radius") &&
    changes.radius !== undefined &&
    !Number.isFinite(changes.radius)
  ) {
    throw new SpatialSkeletonEditValidationError(
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
    throw new SpatialSkeletonEditValidationError(
      "Skeleton node confidence must be between 0 and 100.",
    );
  }
  if (
    Object.hasOwn(changes, "description") &&
    changes.description !== undefined &&
    typeof changes.description !== "string"
  ) {
    throw new SpatialSkeletonEditValidationError(
      "Skeleton node description must be a string or undefined.",
    );
  }
  if (
    Object.hasOwn(changes, "isTrueEnd") &&
    changes.isTrueEnd !== undefined &&
    typeof changes.isTrueEnd !== "boolean"
  ) {
    throw new SpatialSkeletonEditValidationError(
      "Skeleton node true-end state must be boolean or undefined.",
    );
  }
}

export class SpatialSkeletonEditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpatialSkeletonEditValidationError";
  }
}

/** Immutable logical-segment to complete-snapshot map. */
export class CompleteSkeletonSet {
  private readonly snapshotBySegmentKey: ReadonlyMap<
    string,
    SpatialSkeletonEditSegmentSnapshot
  >;

  constructor(segments: readonly SpatialSkeletonEditSegmentSnapshot[]) {
    const snapshotBySegmentKey = new Map<
      string,
      SpatialSkeletonEditSegmentSnapshot
    >();
    for (const { segment, snapshot } of segments) {
      const key = segmentKey(segment);
      if (snapshotBySegmentKey.has(key)) {
        throw new SpatialSkeletonEditValidationError(
          `Preview contains duplicate logical segment ${segment.stableId}.`,
        );
      }
      snapshotBySegmentKey.set(key, Object.freeze({ segment, snapshot }));
    }
    this.snapshotBySegmentKey = snapshotBySegmentKey;
  }

  get segments(): readonly SpatialSkeletonEditSegmentSnapshot[] {
    return Object.freeze([...this.snapshotBySegmentKey.values()]);
  }

  getSegment(segment: SpatialSkeletonStableSegmentHandle) {
    return this.snapshotBySegmentKey.get(segmentKey(segment));
  }

  /**
   * Resolves a winner/loser alias after a physical remap without changing the
   * journal delta.  More than one matching preview is an invalid baseline.
   */
  resolveSegment(
    segment: SpatialSkeletonStableSegmentHandle,
    mappings: EditMappings,
  ) {
    const direct = this.getSegment(segment);
    if (direct !== undefined) return direct;
    const segmentId = requireSegmentId(mappings, segment);
    let result: SpatialSkeletonEditSegmentSnapshot | undefined;
    for (const entry of this.snapshotBySegmentKey.values()) {
      if (mappings.resolveSegment(entry.segment) !== segmentId) continue;
      if (result !== undefined) {
        throw new SpatialSkeletonEditValidationError(
          `Physical segment ${segmentId} has multiple preview owners.`,
        );
      }
      result = entry;
    }
    return result;
  }

  withChanges(
    changes: readonly SpatialSkeletonEditSegmentChange[],
  ): CompleteSkeletonSet {
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
    return new CompleteSkeletonSet([...next.values()]);
  }
}

function requireSegmentSnapshot(
  edit: CompleteSkeletonSet,
  segment: SpatialSkeletonStableSegmentHandle,
  mappings: EditMappings,
) {
  const entry = edit.resolveSegment(segment, mappings);
  if (entry === undefined) {
    throw new SpatialSkeletonEditValidationError(
      `Logical segment ${segment.stableId} is not present in the preview.`,
    );
  }
  return entry;
}

function requireNode(
  snapshot: CompleteSkeleton,
  handle: SpatialSkeletonStableNodeHandle,
  mappings: EditMappings,
) {
  const nodeId = requireNodeId(mappings, handle);
  const node = snapshot.getNode(nodeId);
  if (node === undefined) {
    throw new SpatialSkeletonEditValidationError(
      `Logical node ${handle.stableId} (${nodeId}) is not present in the expected segment.`,
    );
  }
  return node;
}

function getChildren(snapshot: CompleteSkeleton, parentNodeId: bigint) {
  const result: SkeletonNode[] = [];
  snapshot.forEachNode((node) => {
    if (node.parentNodeId === parentNodeId) result.push(node);
  });
  return result;
}

function getPathToRoot(snapshot: CompleteSkeleton, startNodeId: bigint) {
  const result: SkeletonNode[] = [];
  const seen = new Set<bigint>();
  let node = snapshot.getNode(startNodeId);
  while (node !== undefined) {
    if (seen.has(node.nodeId)) {
      throw new SpatialSkeletonEditValidationError(
        "A skeleton preview contains a cycle.",
      );
    }
    seen.add(node.nodeId);
    result.push(node);
    if (node.parentNodeId === undefined) break;
    node = snapshot.getNode(node.parentNodeId);
    if (node === undefined) {
      throw new SpatialSkeletonEditValidationError(
        "A skeleton preview contains a node whose parent is missing.",
      );
    }
  }
  return result;
}

function getSubtreeNodeIds(snapshot: CompleteSkeleton, rootNodeId: bigint) {
  if (snapshot.getNode(rootNodeId) === undefined) {
    throw new SpatialSkeletonEditValidationError(
      `Cannot collect a subtree rooted at missing node ${rootNodeId}.`,
    );
  }
  const childrenByParent = new Map<bigint, bigint[]>();
  snapshot.forEachNode((node) => {
    if (node.parentNodeId === undefined) return;
    let children = childrenByParent.get(node.parentNodeId);
    if (children === undefined) {
      children = [];
      childrenByParent.set(node.parentNodeId, children);
    }
    children.push(node.nodeId);
  });
  const result = new Set<bigint>();
  const pending = [rootNodeId];
  while (pending.length !== 0) {
    const nodeId = pending.pop()!;
    if (result.has(nodeId)) {
      throw new SpatialSkeletonEditValidationError(
        "A skeleton preview contains a topology cycle.",
      );
    }
    result.add(nodeId);
    pending.push(...(childrenByParent.get(nodeId) ?? []));
  }
  return result;
}

function rerootSnapshot(snapshot: CompleteSkeleton, targetNodeId: bigint) {
  const target = snapshot.getNode(targetNodeId);
  if (target === undefined) {
    throw new SpatialSkeletonEditValidationError(
      `Cannot reroot at missing node ${targetNodeId}.`,
    );
  }
  if (isSkeletonNodeTrueEnd(target)) {
    throw new SpatialSkeletonEditValidationError(
      "Cannot set a true end node as root. Clear the true end state first.",
    );
  }
  const path = getPathToRoot(snapshot, targetNodeId);
  // CATMAID leaves an already-root attachment and its confidence unchanged.
  if (path.length === 1) return { snapshot, path };
  const patches: CompleteSkeletonNodePatch[] = [];
  let downstreamConfidence = getSkeletonNodeConfidence(path[0]);
  patches.push({
    kind: "update",
    nodeId: path[0].nodeId,
    changes: { parentNodeId: undefined, ...withConfidence(path[0], 100) },
  });
  for (let index = 1; index < path.length; ++index) {
    const node = path[index];
    const previousConfidence = getSkeletonNodeConfidence(node);
    patches.push({
      kind: "update",
      nodeId: node.nodeId,
      changes: {
        parentNodeId: path[index - 1].nodeId,
        ...withConfidence(node, downstreamConfidence ?? previousConfidence),
      },
    });
    downstreamConfidence = previousConfidence;
  }
  return { snapshot: patchCompleteSkeleton(snapshot, patches), path };
}

function uniqueHandles<
  T extends
    | SpatialSkeletonStableNodeHandle
    | SpatialSkeletonStableSegmentHandle,
>(handles: Iterable<T>) {
  const byKey = new Map<string, T>();
  for (const handle of handles) {
    byKey.set(getSpatialSkeletonStableResourceKey(handle), handle);
  }
  return Object.freeze([...byKey.values()]);
}

function applyChanges(
  edit: CompleteSkeletonSet,
  inverseDelta: SpatialSkeletonEditInverseDelta,
  segmentChanges: readonly SpatialSkeletonEditSegmentChange[],
): SpatialSkeletonEditApplyResult {
  return Object.freeze({
    edit: edit.withChanges(segmentChanges),
    inverseDelta,
  });
}

function applyAdd(
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditAddDelta,
  mappings: EditMappings,
) {
  const nodeId = requireNodeId(mappings, delta.node);
  const segmentId = requireSegmentId(mappings, delta.segment);
  const existingEntry = edit.resolveSegment(delta.segment, mappings);
  let parentNodeId: bigint | undefined;
  if (delta.parent === undefined) {
    if (existingEntry !== undefined) {
      throw new SpatialSkeletonEditValidationError(
        "Cannot add a second root to an existing skeleton.",
      );
    }
  } else {
    if (existingEntry === undefined) {
      throw new SpatialSkeletonEditValidationError(
        "Cannot add a child to a missing skeleton.",
      );
    }
    const parent = requireNode(existingEntry.snapshot, delta.parent, mappings);
    if (isSkeletonNodeTrueEnd(parent)) {
      throw new SpatialSkeletonEditValidationError(
        "Cannot add a child under a true end node. Clear the true end state first.",
      );
    }
    parentNodeId = parent.nodeId;
  }
  if (
    edit.segments.some(({ snapshot }) => snapshot.getNode(nodeId) !== undefined)
  ) {
    throw new SpatialSkeletonEditValidationError(
      `Cannot add duplicate node ${nodeId}.`,
    );
  }
  const attributes = cloneAttributes(delta.attributes);
  validateAttributeValues(attributes);
  if (attributes.isTrueEnd === true && parentNodeId === undefined) {
    throw new SpatialSkeletonEditValidationError(
      "Cannot create a true end root node.",
    );
  }
  const node: SkeletonNode = {
    nodeId,
    segmentId,
    parentNodeId,
    position: cloneVector(delta.position),
    ...getSkeletonNodeChanges(undefined, attributes),
  };
  const snapshot =
    existingEntry === undefined
      ? createCompleteSkeleton([node])
      : patchCompleteSkeleton(existingEntry.snapshot, [
          { kind: "insert", node },
        ]);
  const segmentChanges: SpatialSkeletonEditSegmentChange[] = [
    ...(existingEntry !== undefined &&
    !handlesEqual(existingEntry.segment, delta.segment)
      ? [{ segment: existingEntry.segment, snapshot: undefined }]
      : []),
    { segment: delta.segment, snapshot },
  ];
  return applyChanges(
    edit,
    { kind: "delete", segment: delta.segment, node: delta.node },
    segmentChanges,
  );
}

function applyMove(
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditMoveDelta,
  mappings: EditMappings,
) {
  const position = cloneVector(delta.position);
  const entry = requireSegmentSnapshot(edit, delta.segment, mappings);
  const node = requireNode(entry.snapshot, delta.node, mappings);
  const snapshot = patchCompleteSkeleton(entry.snapshot, [
    {
      kind: "update",
      nodeId: node.nodeId,
      changes: { position },
    },
  ]);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonEditSegmentChange[];
  return applyChanges(
    edit,
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
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditDeleteDelta,
  mappings: EditMappings,
) {
  const entry = requireSegmentSnapshot(edit, delta.segment, mappings);
  const node = requireNode(entry.snapshot, delta.node, mappings);
  const children = getChildren(entry.snapshot, node.nodeId);
  if (node.parentNodeId === undefined && children.length !== 0) {
    throw new SpatialSkeletonEditValidationError(
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
    : patchCompleteSkeleton(entry.snapshot, patches);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonEditSegmentChange[];
  return applyChanges(
    edit,
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
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditNodeAttributesDelta,
  mappings: EditMappings,
) {
  const entry = requireSegmentSnapshot(edit, delta.segment, mappings);
  const node = requireNode(entry.snapshot, delta.node, mappings);
  validateAttributeValues(delta.changes);
  if (Object.keys(delta.changes).length === 0) {
    throw new SpatialSkeletonEditValidationError(
      "A node-attributes delta must change at least one attribute.",
    );
  }
  if (delta.changes.isTrueEnd === true) {
    if (node.parentNodeId === undefined) {
      throw new SpatialSkeletonEditValidationError(
        "Cannot set the root node as a true end.",
      );
    }
    if (getChildren(entry.snapshot, node.nodeId).length !== 0) {
      throw new SpatialSkeletonEditValidationError(
        "Only leaf nodes can be marked as true ends.",
      );
    }
  }
  const current = nodeAttributes(node);
  const before: {
    radius?: number;
    confidence?: number;
    description?: string;
    isTrueEnd?: boolean;
  } = {};
  for (const key of Object.keys(
    delta.changes,
  ) as (keyof SpatialSkeletonEditNodeAttributes)[]) {
    Object.assign(before, { [key]: current[key] });
  }
  const changes = getSkeletonNodeChanges(node, delta.changes);
  const snapshot = patchCompleteSkeleton(entry.snapshot, [
    { kind: "update", nodeId: node.nodeId, changes },
  ]);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonEditSegmentChange[];
  return applyChanges(
    edit,
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
  nodes: readonly SkeletonNode[],
  mappings: EditMappings,
): readonly SpatialSkeletonEditTopologyPatch[] {
  return Object.freeze(
    nodes.map((node) => ({
      node: requireNodeHandle(mappings, node.nodeId, "Topology path"),
      parent:
        node.parentNodeId === undefined
          ? null
          : requireNodeHandle(mappings, node.parentNodeId, "Topology parent"),
      confidence: getSkeletonNodeConfidence(node),
    })),
  );
}

function applyReroot(
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditRerootDelta,
  mappings: EditMappings,
) {
  const entry = requireSegmentSnapshot(edit, delta.segment, mappings);
  const node = requireNode(entry.snapshot, delta.node, mappings);
  const { snapshot, path } = rerootSnapshot(entry.snapshot, node.nodeId);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonEditSegmentChange[];
  return applyChanges(
    edit,
    {
      kind: "restore-topology",
      segment: entry.segment,
      patches: topologyPatchesFromNodes(path, mappings),
    },
    segmentChanges,
  );
}

function remapSingleSnapshotSegment(
  snapshot: CompleteSkeleton,
  segmentId: bigint,
  overrides: readonly {
    nodeId: bigint;
    changes: CompleteSkeletonNodeChanges;
  }[] = [],
) {
  return mergeCompleteSkeletons([{ snapshot, segmentId }], {
    overrides,
  });
}

function applySplit(
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditSplitDelta,
  mappings: EditMappings,
) {
  if (handlesEqual(delta.sourceSegment, delta.downstreamSegment)) {
    throw new SpatialSkeletonEditValidationError(
      "A split requires distinct source and downstream logical segments.",
    );
  }
  const entry = requireSegmentSnapshot(edit, delta.sourceSegment, mappings);
  if (edit.resolveSegment(delta.downstreamSegment, mappings) !== undefined) {
    throw new SpatialSkeletonEditValidationError(
      `Split result segment ${delta.downstreamSegment.stableId} already exists.`,
    );
  }
  const node = requireNode(entry.snapshot, delta.node, mappings);
  if (node.parentNodeId === undefined) {
    throw new SpatialSkeletonEditValidationError(
      "Cannot split at the root node.",
    );
  }
  if (isSkeletonNodeTrueEnd(node)) {
    throw new SpatialSkeletonEditValidationError(
      "Cannot split at a true end node because it would become a true end root.",
    );
  }
  const formerParent = requireNodeHandle(
    mappings,
    node.parentNodeId,
    "Split parent",
  );
  const downstreamNodeIds = getSubtreeNodeIds(entry.snapshot, node.nodeId);
  const views = splitCompleteSkeleton(entry.snapshot, downstreamNodeIds);
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
  const segmentChanges: SpatialSkeletonEditSegmentChange[] = [
    ...(handlesEqual(entry.segment, delta.sourceSegment)
      ? []
      : [{ segment: entry.segment, snapshot: undefined }]),
    { segment: delta.sourceSegment, snapshot: sourceSnapshot },
    { segment: delta.downstreamSegment, snapshot: downstreamSnapshot },
  ];
  return applyChanges(
    edit,
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
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditMergeDelta,
  mappings: EditMappings,
) {
  const firstEntry = requireSegmentSnapshot(edit, delta.firstSegment, mappings);
  const secondEntry = requireSegmentSnapshot(
    edit,
    delta.secondSegment,
    mappings,
  );
  if (firstEntry === secondEntry) {
    throw new SpatialSkeletonEditValidationError(
      "Cannot merge a skeleton with itself.",
    );
  }
  const existingResultEntry = edit.resolveSegment(
    delta.resultSegment,
    mappings,
  );
  if (
    existingResultEntry !== undefined &&
    existingResultEntry !== firstEntry &&
    existingResultEntry !== secondEntry
  ) {
    throw new SpatialSkeletonEditValidationError(
      `Merge result segment ${delta.resultSegment.stableId} is already owned by another skeleton.`,
    );
  }
  const firstNode = requireNode(firstEntry.snapshot, delta.firstNode, mappings);
  const secondNode = requireNode(
    secondEntry.snapshot,
    delta.secondNode,
    mappings,
  );
  if (isSkeletonNodeTrueEnd(firstNode)) {
    throw new SpatialSkeletonEditValidationError(
      "Cannot merge under a true end node. Clear the true end state first.",
    );
  }
  const rerooted = rerootSnapshot(secondEntry.snapshot, secondNode.nodeId);
  const resultSegmentId = requireSegmentId(mappings, delta.resultSegment);
  const snapshot = mergeCompleteSkeletons(
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
  const segmentChanges: SpatialSkeletonEditSegmentChange[] = [
    ...removedEntries
      .filter((segment) => !handlesEqual(segment, delta.resultSegment))
      .map((segment) => ({ segment, snapshot: undefined })),
    { segment: delta.resultSegment, snapshot },
  ];
  return applyChanges(
    edit,
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
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditRestoreDeleteDelta,
  mappings: EditMappings,
) {
  const existingEntry = edit.resolveSegment(delta.segment, mappings);
  const nodeId = requireNodeId(mappings, delta.snapshot.node);
  if (
    edit.segments.some(({ snapshot }) => snapshot.getNode(nodeId) !== undefined)
  ) {
    throw new SpatialSkeletonEditValidationError(
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
      throw new SpatialSkeletonEditValidationError(
        "Only a deleted root leaf can restore a missing skeleton.",
      );
    }
  } else {
    if (
      parentNodeId !== undefined &&
      existingEntry.snapshot.getNode(parentNodeId) === undefined
    ) {
      throw new SpatialSkeletonEditValidationError(
        `Cannot restore node ${nodeId} under missing parent ${parentNodeId}.`,
      );
    }
    for (const child of delta.children) {
      requireNode(existingEntry.snapshot, child, mappings);
    }
  }
  const restoredNode: SkeletonNode = {
    nodeId,
    segmentId,
    parentNodeId,
    position: cloneVector(delta.snapshot.position),
    ...getSkeletonNodeChanges(undefined, delta.snapshot.attributes),
  };
  const snapshot =
    existingEntry === undefined
      ? createCompleteSkeleton([restoredNode])
      : patchCompleteSkeleton(existingEntry.snapshot, [
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
  ] satisfies readonly SpatialSkeletonEditSegmentChange[];
  return applyChanges(
    edit,
    { kind: "delete", segment, node: delta.snapshot.node },
    segmentChanges,
  );
}

function applyRestoreTopology(
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditRestoreTopologyDelta,
  mappings: EditMappings,
) {
  const entry = requireSegmentSnapshot(edit, delta.segment, mappings);
  if (delta.patches.length === 0) {
    throw new SpatialSkeletonEditValidationError(
      "A topology restore requires at least one path patch.",
    );
  }
  const inversePatches: SpatialSkeletonEditTopologyPatch[] = [];
  const nodePatches: CompleteSkeletonNodePatch[] = [];
  for (const patch of delta.patches) {
    const node = requireNode(entry.snapshot, patch.node, mappings);
    inversePatches.push({
      node: patch.node,
      parent:
        node.parentNodeId === undefined
          ? null
          : requireNodeHandle(mappings, node.parentNodeId, "Restored parent"),
      confidence: getSkeletonNodeConfidence(node),
    });
    const parentNodeId =
      patch.parent === null ? undefined : requireNodeId(mappings, patch.parent);
    if (
      parentNodeId !== undefined &&
      entry.snapshot.getNode(parentNodeId) === undefined
    ) {
      throw new SpatialSkeletonEditValidationError(
        `Cannot restore topology through missing parent ${parentNodeId}.`,
      );
    }
    nodePatches.push({
      kind: "update",
      nodeId: node.nodeId,
      changes: { parentNodeId, ...withConfidence(node, patch.confidence) },
    });
  }
  const snapshot = patchCompleteSkeleton(entry.snapshot, nodePatches);
  const segmentChanges = [
    { segment: entry.segment, snapshot },
  ] satisfies readonly SpatialSkeletonEditSegmentChange[];
  return applyChanges(
    edit,
    {
      kind: "restore-topology",
      segment: entry.segment,
      patches: Object.freeze(inversePatches),
    },
    segmentChanges,
  );
}

function applyJoinSplit(
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditJoinSplitDelta,
  mappings: EditMappings,
) {
  const sourceEntry = requireSegmentSnapshot(
    edit,
    delta.sourceSegment,
    mappings,
  );
  const downstreamEntry = requireSegmentSnapshot(
    edit,
    delta.downstreamSegment,
    mappings,
  );
  if (sourceEntry === downstreamEntry) {
    throw new SpatialSkeletonEditValidationError(
      "Cannot join a split whose sides resolve to the same preview.",
    );
  }
  const existingResultEntry = edit.resolveSegment(
    delta.resultSegment,
    mappings,
  );
  if (
    existingResultEntry !== undefined &&
    existingResultEntry !== sourceEntry &&
    existingResultEntry !== downstreamEntry
  ) {
    throw new SpatialSkeletonEditValidationError(
      `Joined result segment ${delta.resultSegment.stableId} is already owned by another skeleton.`,
    );
  }
  const cutNode = requireNode(downstreamEntry.snapshot, delta.node, mappings);
  if (cutNode.parentNodeId !== undefined) {
    throw new SpatialSkeletonEditValidationError(
      "The downstream split node must still be a root before joining.",
    );
  }
  const formerParent = requireNode(
    sourceEntry.snapshot,
    delta.formerParent,
    mappings,
  );
  if (isSkeletonNodeTrueEnd(formerParent)) {
    throw new SpatialSkeletonEditValidationError(
      "Cannot restore a split below a true end parent.",
    );
  }
  const resultSegmentId = requireSegmentId(mappings, delta.resultSegment);
  const snapshot = mergeCompleteSkeletons(
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
  const segmentChanges: SpatialSkeletonEditSegmentChange[] = [
    ...removedEntries
      .filter((segment) => !handlesEqual(segment, delta.resultSegment))
      .map((segment) => ({ segment, snapshot: undefined })),
    { segment: delta.resultSegment, snapshot },
  ];
  return applyChanges(
    edit,
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
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditUnmergeDelta,
  mappings: EditMappings,
) {
  if (handlesEqual(delta.firstSegment, delta.secondSegment)) {
    throw new SpatialSkeletonEditValidationError(
      "An unmerge requires distinct result segments.",
    );
  }
  const entry = requireSegmentSnapshot(edit, delta.mergedSegment, mappings);
  for (const outputSegment of [delta.firstSegment, delta.secondSegment]) {
    const existingOutput = edit.resolveSegment(outputSegment, mappings);
    if (existingOutput !== undefined && existingOutput !== entry) {
      throw new SpatialSkeletonEditValidationError(
        `Unmerge output segment ${outputSegment.stableId} is already owned by another skeleton.`,
      );
    }
  }
  const firstNode = requireNode(entry.snapshot, delta.firstNode, mappings);
  const secondNode = requireNode(entry.snapshot, delta.secondNode, mappings);
  if (secondNode.parentNodeId !== firstNode.nodeId) {
    throw new SpatialSkeletonEditValidationError(
      "The merge attachment edge no longer exists in the previewed topology.",
    );
  }
  const secondNodeIds = getSubtreeNodeIds(entry.snapshot, secondNode.nodeId);
  const views = splitCompleteSkeleton(entry.snapshot, secondNodeIds);
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
  const secondSnapshot = patchCompleteSkeleton(
    detachedSecond,
    delta.formerSecondTopology.map((patch): CompleteSkeletonNodePatch => {
      const node = requireNode(detachedSecond, patch.node, mappings);
      return {
        kind: "update",
        nodeId: node.nodeId,
        changes: {
          parentNodeId:
            patch.parent === null
              ? undefined
              : requireNodeId(mappings, patch.parent),
          ...withConfidence(node, patch.confidence),
        },
      };
    }),
  );
  const segmentChanges: SpatialSkeletonEditSegmentChange[] = [
    ...(handlesEqual(entry.segment, delta.firstSegment) ||
    handlesEqual(entry.segment, delta.secondSegment)
      ? []
      : [{ segment: entry.segment, snapshot: undefined }]),
    { segment: delta.firstSegment, snapshot: firstSnapshot },
    { segment: delta.secondSegment, snapshot: secondSnapshot },
  ];
  return applyChanges(
    edit,
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

export function applySpatialSkeletonEditDelta(
  edit: CompleteSkeletonSet,
  delta: SpatialSkeletonEditDelta,
  mappings: EditMappings,
): SpatialSkeletonEditApplyResult {
  switch (delta.kind) {
    case "add":
      return applyAdd(edit, delta, mappings);
    case "move":
      return applyMove(edit, delta, mappings);
    case "delete":
      return applyDelete(edit, delta, mappings);
    case "reroot":
      return applyReroot(edit, delta, mappings);
    case "node-attributes":
      return applyNodeAttributes(edit, delta, mappings);
    case "split":
      return applySplit(edit, delta, mappings);
    case "merge":
      return applyMerge(edit, delta, mappings);
    case "restore-delete":
      return applyRestoreDelete(edit, delta, mappings);
    case "restore-topology":
      return applyRestoreTopology(edit, delta, mappings);
    case "join-split":
      return applyJoinSplit(edit, delta, mappings);
    case "unmerge":
      return applyUnmerge(edit, delta, mappings);
  }
}
