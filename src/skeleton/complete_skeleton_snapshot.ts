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
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";

export type CompleteSkeletonSnapshotKind =
  | "base"
  | "patch"
  | "split-view"
  | "merge"
  | "remap";

export type CompleteSkeletonNodeChanges = Readonly<
  Partial<Omit<SpatiallyIndexedSkeletonNode, "nodeId">>
>;

export type CompleteSkeletonNodePatch =
  | {
      readonly kind: "update";
      readonly nodeId: number;
      readonly changes: CompleteSkeletonNodeChanges;
    }
  | {
      readonly kind: "insert";
      readonly node: SpatiallyIndexedSkeletonNode;
    }
  | {
      readonly kind: "delete";
      readonly nodeId: number;
    };

export interface CompleteSkeletonNodeOverride {
  readonly nodeId: number;
  readonly changes: CompleteSkeletonNodeChanges;
}

export interface CompleteSkeletonSnapshotMergeComponent {
  /** A complete snapshot or a complete membership view of one. */
  readonly snapshot: CompleteSkeletonSnapshotHandle;
  /**
   * Lazily substitutes the segment id for this entire component.  This is
   * substantially smaller than storing one node patch per node in the losing
   * skeleton of a merge.
   */
  readonly segmentId?: number;
}

export interface CompleteSkeletonSnapshotSplit {
  /** Nodes whose ids were supplied to `splitCompleteSkeletonSnapshot`. */
  readonly selected: CompleteSkeletonSnapshotHandle;
  /** Every other node in the source snapshot. */
  readonly remainder: CompleteSkeletonSnapshotHandle;
}

interface SnapshotProjection {
  readonly nodeCount: number;
  getNode(nodeId: number): SpatiallyIndexedSkeletonNode | undefined;
  forEachNode(callback: (node: SpatiallyIndexedSkeletonNode) => void): void;
}

/** Private implementation bound, independent of queue and history limits. */
const COMPLETE_SKELETON_PROJECTION_REBASE_DEPTH = 64;

export interface CompleteSkeletonSnapshotRemapping {
  /** Physical node-id substitutions. Parent references are remapped too. */
  readonly nodeIds?: ReadonlyMap<number, number>;
  /** Physical segment-id substitutions. */
  readonly segmentIds?: ReadonlyMap<number, number>;
}

function cloneSpatialSkeletonVector(
  value: SpatialSkeletonVector,
): SpatialSkeletonVector {
  return Object.freeze(Array.from(value));
}

function cloneNode(
  node: SpatiallyIndexedSkeletonNode,
): SpatiallyIndexedSkeletonNode {
  const copy: SpatiallyIndexedSkeletonNode = {
    ...node,
    position: cloneSpatialSkeletonVector(node.position),
  };
  return Object.freeze(copy);
}

function updateNode(
  node: SpatiallyIndexedSkeletonNode,
  changes: CompleteSkeletonNodeChanges,
): SpatiallyIndexedSkeletonNode {
  const copy: SpatiallyIndexedSkeletonNode = {
    ...node,
    ...changes,
    nodeId: node.nodeId,
  };
  if (Object.hasOwn(changes, "position")) {
    if (changes.position === undefined) {
      throw new Error("A complete skeleton node position cannot be undefined.");
    }
    copy.position = cloneSpatialSkeletonVector(changes.position);
  }
  return Object.freeze(copy);
}

class BaseSnapshotProjection implements SnapshotProjection {
  readonly nodeCount: number;
  readonly nodes: readonly SpatiallyIndexedSkeletonNode[];
  private readonly nodeById = new Map<number, SpatiallyIndexedSkeletonNode>();

  constructor(nodes: readonly SpatiallyIndexedSkeletonNode[]) {
    const copiedNodes: SpatiallyIndexedSkeletonNode[] = [];
    for (const node of nodes) {
      if (this.nodeById.has(node.nodeId)) {
        throw new Error(
          `Complete skeleton snapshot contains duplicate node ${node.nodeId}.`,
        );
      }
      const copiedNode = cloneNode(node);
      copiedNodes.push(copiedNode);
      this.nodeById.set(copiedNode.nodeId, copiedNode);
    }
    this.nodes = Object.freeze(copiedNodes);
    this.nodeCount = copiedNodes.length;
  }

  getNode(nodeId: number) {
    return this.nodeById.get(nodeId);
  }

  forEachNode(callback: (node: SpatiallyIndexedSkeletonNode) => void) {
    for (const node of this.nodes) callback(node);
  }
}

/** Indexed flat storage which reuses an already-frozen materialized array. */
class FlatSnapshotProjection implements SnapshotProjection {
  readonly nodeCount: number;
  private readonly nodeById = new Map<number, SpatiallyIndexedSkeletonNode>();

  constructor(readonly nodes: readonly SpatiallyIndexedSkeletonNode[]) {
    for (const node of nodes) {
      if (this.nodeById.has(node.nodeId)) {
        throw new Error(
          `Complete skeleton snapshot contains duplicate node ${node.nodeId}.`,
        );
      }
      this.nodeById.set(node.nodeId, node);
    }
    this.nodeCount = nodes.length;
  }

  getNode(nodeId: number) {
    return this.nodeById.get(nodeId);
  }

  forEachNode(callback: (node: SpatiallyIndexedSkeletonNode) => void) {
    for (const node of this.nodes) callback(node);
  }
}

class PatchSnapshotProjection implements SnapshotProjection {
  readonly nodeCount: number;
  private readonly patchedNodeById = new Map<
    number,
    SpatiallyIndexedSkeletonNode | undefined
  >();
  private readonly insertedNodeIds: readonly number[];

  constructor(
    private readonly source: SnapshotProjection,
    patches: readonly CompleteSkeletonNodePatch[],
  ) {
    const insertedNodeIds: number[] = [];
    const insertedNodeIdSet = new Set<number>();

    for (const patch of patches) {
      const nodeId = patch.kind === "insert" ? patch.node.nodeId : patch.nodeId;
      const currentNode = this.patchedNodeById.has(nodeId)
        ? this.patchedNodeById.get(nodeId)
        : source.getNode(nodeId);
      switch (patch.kind) {
        case "update":
          if (currentNode === undefined) {
            throw new Error(
              `Cannot update missing complete skeleton node ${nodeId}.`,
            );
          }
          this.patchedNodeById.set(
            nodeId,
            updateNode(currentNode, patch.changes),
          );
          break;
        case "insert":
          if (currentNode !== undefined) {
            throw new Error(
              `Cannot insert duplicate complete skeleton node ${nodeId}.`,
            );
          }
          this.patchedNodeById.set(nodeId, cloneNode(patch.node));
          if (!source.getNode(nodeId) && !insertedNodeIdSet.has(nodeId)) {
            insertedNodeIdSet.add(nodeId);
            insertedNodeIds.push(nodeId);
          }
          break;
        case "delete":
          if (currentNode === undefined) {
            throw new Error(
              `Cannot delete missing complete skeleton node ${nodeId}.`,
            );
          }
          this.patchedNodeById.set(nodeId, undefined);
          break;
      }
    }

    let nodeCount = source.nodeCount;
    for (const [nodeId, patchedNode] of this.patchedNodeById) {
      const sourceHasNode = source.getNode(nodeId) !== undefined;
      if (sourceHasNode && patchedNode === undefined) --nodeCount;
      if (!sourceHasNode && patchedNode !== undefined) ++nodeCount;
    }
    this.nodeCount = nodeCount;
    this.insertedNodeIds = Object.freeze(insertedNodeIds);
  }

  getNode(nodeId: number) {
    return this.patchedNodeById.has(nodeId)
      ? this.patchedNodeById.get(nodeId)
      : this.source.getNode(nodeId);
  }

  forEachNode(callback: (node: SpatiallyIndexedSkeletonNode) => void) {
    this.source.forEachNode((sourceNode) => {
      if (!this.patchedNodeById.has(sourceNode.nodeId)) {
        callback(sourceNode);
        return;
      }
      const patchedNode = this.patchedNodeById.get(sourceNode.nodeId);
      if (patchedNode !== undefined) callback(patchedNode);
    });
    for (const nodeId of this.insertedNodeIds) {
      const node = this.patchedNodeById.get(nodeId);
      if (node !== undefined) callback(node);
    }
  }
}

interface MembershipPartition {
  readonly selectedNodeIds: ReadonlySet<number>;
}

class MembershipSnapshotProjection implements SnapshotProjection {
  readonly nodeCount: number;

  constructor(
    private readonly source: SnapshotProjection,
    private readonly partition: MembershipPartition,
    private readonly selectMembers: boolean,
  ) {
    this.nodeCount = selectMembers
      ? partition.selectedNodeIds.size
      : source.nodeCount - partition.selectedNodeIds.size;
  }

  private includes(nodeId: number) {
    return this.partition.selectedNodeIds.has(nodeId) === this.selectMembers;
  }

  getNode(nodeId: number) {
    return this.includes(nodeId) ? this.source.getNode(nodeId) : undefined;
  }

  forEachNode(callback: (node: SpatiallyIndexedSkeletonNode) => void) {
    this.source.forEachNode((node) => {
      if (this.includes(node.nodeId)) callback(node);
    });
  }
}

/**
 * A lazy physical-id substitution over a complete snapshot.
 *
 * Remapping has to inspect node ids once in order to reject collisions before
 * the handle can be published, but it does not clone nodes or construct a
 * concrete node array. Remapped node objects are created only when requested.
 */
class RemapSnapshotProjection implements SnapshotProjection {
  readonly nodeCount: number;
  private readonly sourceNodeIdByRemappedNodeId = new Map<number, number>();
  private readonly remappedNodeBySourceNodeId = new Map<
    number,
    SpatiallyIndexedSkeletonNode
  >();
  private readonly nodeIdRemappings: ReadonlyMap<number, number>;
  private readonly segmentIdRemappings: ReadonlyMap<number, number>;

  constructor(
    private readonly source: SnapshotProjection,
    remappings: CompleteSkeletonSnapshotRemapping,
  ) {
    // Copy even ReadonlyMaps: callers can still hold a mutable Map reference,
    // while complete snapshot handles must remain immutable after creation.
    this.nodeIdRemappings = new Map(remappings.nodeIds);
    this.segmentIdRemappings = new Map(remappings.segmentIds);
    this.nodeCount = source.nodeCount;
    source.forEachNode((node) => {
      const remappedNodeId = this.remapNodeId(node.nodeId);
      const previousSourceNodeId =
        this.sourceNodeIdByRemappedNodeId.get(remappedNodeId);
      if (previousSourceNodeId !== undefined) {
        throw new Error(
          `Cannot remap complete skeleton nodes ${previousSourceNodeId} and ${node.nodeId} to duplicate node ${remappedNodeId}.`,
        );
      }
      this.sourceNodeIdByRemappedNodeId.set(remappedNodeId, node.nodeId);
    });
  }

  private remapNodeId(nodeId: number) {
    return this.nodeIdRemappings.get(nodeId) ?? nodeId;
  }

  private resolveNode(node: SpatiallyIndexedSkeletonNode) {
    const nodeId = this.remapNodeId(node.nodeId);
    const parentNodeId =
      node.parentNodeId === undefined
        ? undefined
        : this.remapNodeId(node.parentNodeId);
    const segmentId =
      this.segmentIdRemappings.get(node.segmentId) ?? node.segmentId;
    if (
      nodeId === node.nodeId &&
      parentNodeId === node.parentNodeId &&
      segmentId === node.segmentId
    ) {
      return node;
    }
    let remappedNode = this.remappedNodeBySourceNodeId.get(node.nodeId);
    if (remappedNode === undefined) {
      remappedNode = cloneNode({
        ...node,
        nodeId,
        parentNodeId,
        segmentId,
      });
      this.remappedNodeBySourceNodeId.set(node.nodeId, remappedNode);
    }
    return remappedNode;
  }

  getNode(nodeId: number) {
    const sourceNodeId = this.sourceNodeIdByRemappedNodeId.get(nodeId);
    if (sourceNodeId === undefined) return undefined;
    const node = this.source.getNode(sourceNodeId);
    return node === undefined ? undefined : this.resolveNode(node);
  }

  forEachNode(callback: (node: SpatiallyIndexedSkeletonNode) => void) {
    this.source.forEachNode((node) => callback(this.resolveNode(node)));
  }
}

interface NormalizedMergeComponent {
  readonly projection: SnapshotProjection;
  readonly segmentId?: number;
  readonly remappedNodeById: Map<number, SpatiallyIndexedSkeletonNode>;
}

class MergeSnapshotProjection implements SnapshotProjection {
  readonly nodeCount: number;
  private readonly componentIndexByNodeId = new Map<number, number>();

  constructor(
    private readonly components: readonly NormalizedMergeComponent[],
  ) {
    let nodeCount = 0;
    components.forEach((component, componentIndex) => {
      nodeCount += component.projection.nodeCount;
      component.projection.forEachNode((node) => {
        if (this.componentIndexByNodeId.has(node.nodeId)) {
          throw new Error(
            `Cannot merge complete skeleton snapshots containing duplicate node ${node.nodeId}.`,
          );
        }
        this.componentIndexByNodeId.set(node.nodeId, componentIndex);
      });
    });
    this.nodeCount = nodeCount;
  }

  private resolveNode(
    component: NormalizedMergeComponent,
    node: SpatiallyIndexedSkeletonNode,
  ) {
    const segmentId = component.segmentId;
    if (segmentId === undefined || segmentId === node.segmentId) return node;
    let remappedNode = component.remappedNodeById.get(node.nodeId);
    if (remappedNode === undefined) {
      remappedNode = Object.freeze({ ...node, segmentId });
      component.remappedNodeById.set(node.nodeId, remappedNode);
    }
    return remappedNode;
  }

  getNode(nodeId: number) {
    const componentIndex = this.componentIndexByNodeId.get(nodeId);
    if (componentIndex === undefined) return undefined;
    const component = this.components[componentIndex];
    const node = component.projection.getNode(nodeId);
    return node === undefined ? undefined : this.resolveNode(component, node);
  }

  forEachNode(callback: (node: SpatiallyIndexedSkeletonNode) => void) {
    for (const component of this.components) {
      component.projection.forEachNode((node) =>
        callback(this.resolveNode(component, node)),
      );
    }
  }
}

/**
 * Immutable view of a complete skeleton.
 *
 * Derived handles retain projections rather than concrete arrays. Calling
 * `materialize` constructs at most one array for this handle. Deriving beyond
 * the private depth bound may materialize and flatten the boundary source;
 * unchanged node objects and any previously returned array remain shared.
 */
export class CompleteSkeletonSnapshotHandle {
  readonly kind: CompleteSkeletonSnapshotKind;
  private materializedNodes:
    | readonly SpatiallyIndexedSkeletonNode[]
    | undefined;
  private materializationBuildCountValue = 0;
  private projectionDepth: number;

  private constructor(
    private projection: SnapshotProjection,
    kind: CompleteSkeletonSnapshotKind,
    projectionDepth: number,
    materializedNodes?: readonly SpatiallyIndexedSkeletonNode[],
  ) {
    this.kind = kind;
    this.projectionDepth = projectionDepth;
    if (materializedNodes !== undefined) {
      this.materializedNodes = materializedNodes;
      this.materializationBuildCountValue = 1;
    }
  }

  static create(nodes: readonly SpatiallyIndexedSkeletonNode[]) {
    const projection = new BaseSnapshotProjection(nodes);
    return new CompleteSkeletonSnapshotHandle(
      projection,
      "base",
      0,
      projection.nodes,
    );
  }

  /**
   * A boundary source must be flat before another lazy projection captures it.
   * This keeps every newly-created chain bounded even when callers never
   * explicitly materialize their intermediate handles.
   */
  private prepareForDerivation() {
    if (this.projectionDepth >= COMPLETE_SKELETON_PROJECTION_REBASE_DEPTH) {
      this.materialize();
    }
  }

  static patch(
    source: CompleteSkeletonSnapshotHandle,
    patches: readonly CompleteSkeletonNodePatch[],
  ) {
    source.prepareForDerivation();
    return new CompleteSkeletonSnapshotHandle(
      new PatchSnapshotProjection(source.projection, patches),
      "patch",
      source.projectionDepth + 1,
    );
  }

  static split(
    source: CompleteSkeletonSnapshotHandle,
    selectedNodeIds: Iterable<number>,
  ): CompleteSkeletonSnapshotSplit {
    source.prepareForDerivation();
    const selectedNodeIdSet = new Set(selectedNodeIds);
    for (const nodeId of selectedNodeIdSet) {
      if (source.projection.getNode(nodeId) === undefined) {
        throw new Error(
          `Cannot select missing complete skeleton node ${nodeId} for a split view.`,
        );
      }
    }
    const partition: MembershipPartition = {
      selectedNodeIds: selectedNodeIdSet,
    };
    return {
      selected: new CompleteSkeletonSnapshotHandle(
        new MembershipSnapshotProjection(source.projection, partition, true),
        "split-view",
        source.projectionDepth + 1,
      ),
      remainder: new CompleteSkeletonSnapshotHandle(
        new MembershipSnapshotProjection(source.projection, partition, false),
        "split-view",
        source.projectionDepth + 1,
      ),
    };
  }

  static merge(
    components: readonly CompleteSkeletonSnapshotMergeComponent[],
    options: {
      overrides?: readonly CompleteSkeletonNodeOverride[];
    } = {},
  ) {
    if (components.length === 0) {
      throw new Error(
        "A complete skeleton merge requires at least one component.",
      );
    }
    for (const { snapshot } of components) snapshot.prepareForDerivation();
    const normalizedComponents = components.map(({ snapshot, segmentId }) => ({
      projection: snapshot.projection,
      segmentId,
      remappedNodeById: new Map<number, SpatiallyIndexedSkeletonNode>(),
    }));
    let projection: SnapshotProjection = new MergeSnapshotProjection(
      normalizedComponents,
    );
    const overrides = options.overrides ?? [];
    if (overrides.length !== 0) {
      projection = new PatchSnapshotProjection(
        projection,
        overrides.map(({ nodeId, changes }) => ({
          kind: "update" as const,
          nodeId,
          changes,
        })),
      );
    }
    return new CompleteSkeletonSnapshotHandle(
      projection,
      "merge",
      Math.max(...components.map(({ snapshot }) => snapshot.projectionDepth)) +
        1 +
        (overrides.length === 0 ? 0 : 1),
    );
  }

  static remap(
    source: CompleteSkeletonSnapshotHandle,
    remappings: CompleteSkeletonSnapshotRemapping,
  ) {
    source.prepareForDerivation();
    return new CompleteSkeletonSnapshotHandle(
      new RemapSnapshotProjection(source.projection, remappings),
      "remap",
      source.projectionDepth + 1,
    );
  }

  get nodeCount() {
    return this.projection.nodeCount;
  }

  /** Number of concrete arrays ever built for this handle (always 0 or 1). */
  get materializationCount() {
    return this.materializationBuildCountValue;
  }

  /** Resolves a node without constructing a concrete snapshot array. */
  getNode(nodeId: number) {
    return this.projection.getNode(nodeId);
  }

  /** Iterates this projection without constructing a concrete snapshot array. */
  forEachNode(callback: (node: SpatiallyIndexedSkeletonNode) => void) {
    this.projection.forEachNode(callback);
  }

  /**
   * Returns a stable concrete array.  Subsequent calls return the same object.
   */
  materialize(): readonly SpatiallyIndexedSkeletonNode[] {
    if (this.materializedNodes === undefined) {
      const nodes: SpatiallyIndexedSkeletonNode[] = [];
      this.projection.forEachNode((node) => nodes.push(node));
      if (nodes.length !== this.projection.nodeCount) {
        throw new Error(
          `Complete skeleton projection expected ${this.projection.nodeCount} nodes but produced ${nodes.length}.`,
        );
      }
      this.materializedNodes = Object.freeze(nodes);
      this.materializationBuildCountValue = 1;
    }
    if (this.projectionDepth >= COMPLETE_SKELETON_PROJECTION_REBASE_DEPTH) {
      // The public value remains immutable. Only the private way this handle
      // answers future reads changes, and it reuses the exact frozen array and
      // node objects already returned to callers.
      this.projection = new FlatSnapshotProjection(this.materializedNodes);
      this.projectionDepth = 0;
    }
    return this.materializedNodes;
  }
}

export function createCompleteSkeletonSnapshot(
  nodes: readonly SpatiallyIndexedSkeletonNode[],
) {
  return CompleteSkeletonSnapshotHandle.create(nodes);
}

export function patchCompleteSkeletonSnapshot(
  source: CompleteSkeletonSnapshotHandle,
  patches: readonly CompleteSkeletonNodePatch[],
) {
  return CompleteSkeletonSnapshotHandle.patch(source, patches);
}

export function splitCompleteSkeletonSnapshot(
  source: CompleteSkeletonSnapshotHandle,
  selectedNodeIds: Iterable<number>,
) {
  return CompleteSkeletonSnapshotHandle.split(source, selectedNodeIds);
}

export function mergeCompleteSkeletonSnapshots(
  components: readonly CompleteSkeletonSnapshotMergeComponent[],
  options: {
    overrides?: readonly CompleteSkeletonNodeOverride[];
  } = {},
) {
  return CompleteSkeletonSnapshotHandle.merge(components, options);
}

export function remapCompleteSkeletonSnapshot(
  source: CompleteSkeletonSnapshotHandle,
  remappings: CompleteSkeletonSnapshotRemapping,
) {
  return CompleteSkeletonSnapshotHandle.remap(source, remappings);
}
