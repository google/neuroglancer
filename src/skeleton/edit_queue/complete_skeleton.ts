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
 * @file Stores complete skeletons as immutable handles whose edits, splits,
 * merges and renumberings share nodes with their source instead of copying
 * them.
 */

import type { SkeletonNode, SkeletonVector } from "#src/skeleton/api.js";

export type CompleteSkeletonKind =
  | "base"
  | "patch"
  | "split-view"
  | "merge"
  | "remap";

export type CompleteSkeletonNodeChanges = Readonly<
  Partial<Omit<SkeletonNode, "nodeId">>
>;

export type CompleteSkeletonNodePatch =
  | {
      readonly kind: "update";
      readonly nodeId: bigint;
      readonly changes: CompleteSkeletonNodeChanges;
    }
  | {
      readonly kind: "insert";
      readonly node: SkeletonNode;
    }
  | {
      readonly kind: "delete";
      readonly nodeId: bigint;
    };

export interface CompleteSkeletonNodeOverride {
  readonly nodeId: bigint;
  readonly changes: CompleteSkeletonNodeChanges;
}

export interface CompleteSkeletonMergeComponent {
  /** A complete snapshot or a complete membership view of one. */
  readonly snapshot: CompleteSkeleton;
  /**
   * Lazily substitutes the segment id for this entire component.  This is
   * substantially smaller than storing one node patch per node in the losing
   * skeleton of a merge.
   */
  readonly segmentId?: bigint;
}

export interface CompleteSkeletonSplit {
  /** Nodes whose ids were supplied to `splitCompleteSkeleton`. */
  readonly selected: CompleteSkeleton;
  /** Every other node in the source snapshot. */
  readonly remainder: CompleteSkeleton;
}

interface SnapshotNodeView {
  readonly nodeCount: number;
  getNode(nodeId: bigint): SkeletonNode | undefined;
  forEachNode(callback: (node: SkeletonNode) => void): void;
}

/** Private implementation bound, independent of queue and history limits. */
const COMPLETE_SKELETON_NODE_VIEW_REBASE_DEPTH = 64;

export interface CompleteSkeletonRemapping {
  /** Physical node-id substitutions. Parent references are remapped too. */
  readonly nodeIds?: ReadonlyMap<bigint, bigint>;
  /** Physical segment-id substitutions. */
  readonly segmentIds?: ReadonlyMap<bigint, bigint>;
}

function cloneSkeletonVector(value: SkeletonVector): SkeletonVector {
  return Object.freeze(Array.from(value));
}

function cloneNode(node: SkeletonNode): SkeletonNode {
  const copy: SkeletonNode = {
    ...node,
    position: cloneSkeletonVector(node.position),
  };
  return Object.freeze(copy);
}

function updateNode(
  node: SkeletonNode,
  changes: CompleteSkeletonNodeChanges,
): SkeletonNode {
  if (Object.hasOwn(changes, "position") && changes.position === undefined) {
    throw new Error("A complete skeleton node position cannot be undefined.");
  }
  return Object.freeze({
    ...node,
    ...changes,
    nodeId: node.nodeId,
    position:
      changes.position === undefined
        ? node.position
        : cloneSkeletonVector(changes.position),
  });
}

class BaseSnapshotNodeView implements SnapshotNodeView {
  readonly nodeCount: number;
  readonly nodes: readonly SkeletonNode[];
  private readonly nodeById = new Map<bigint, SkeletonNode>();

  constructor(nodes: readonly SkeletonNode[]) {
    const copiedNodes: SkeletonNode[] = [];
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

  getNode(nodeId: bigint) {
    return this.nodeById.get(nodeId);
  }

  forEachNode(callback: (node: SkeletonNode) => void) {
    for (const node of this.nodes) callback(node);
  }
}

/** Indexed flat storage which reuses an already-frozen materialized array. */
class FlatSnapshotNodeView implements SnapshotNodeView {
  readonly nodeCount: number;
  private readonly nodeById = new Map<bigint, SkeletonNode>();

  constructor(readonly nodes: readonly SkeletonNode[]) {
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

  getNode(nodeId: bigint) {
    return this.nodeById.get(nodeId);
  }

  forEachNode(callback: (node: SkeletonNode) => void) {
    for (const node of this.nodes) callback(node);
  }
}

class PatchSnapshotNodeView implements SnapshotNodeView {
  readonly nodeCount: number;
  private readonly patchedNodeById = new Map<
    bigint,
    SkeletonNode | undefined
  >();
  private readonly insertedNodeIds: readonly bigint[];

  constructor(
    private readonly source: SnapshotNodeView,
    patches: readonly CompleteSkeletonNodePatch[],
  ) {
    const insertedNodeIds: bigint[] = [];
    const insertedNodeIdSet = new Set<bigint>();

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

  getNode(nodeId: bigint) {
    return this.patchedNodeById.has(nodeId)
      ? this.patchedNodeById.get(nodeId)
      : this.source.getNode(nodeId);
  }

  forEachNode(callback: (node: SkeletonNode) => void) {
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
  readonly selectedNodeIds: ReadonlySet<bigint>;
}

class MembershipSnapshotNodeView implements SnapshotNodeView {
  readonly nodeCount: number;

  constructor(
    private readonly source: SnapshotNodeView,
    private readonly partition: MembershipPartition,
    private readonly selectMembers: boolean,
  ) {
    this.nodeCount = selectMembers
      ? partition.selectedNodeIds.size
      : source.nodeCount - partition.selectedNodeIds.size;
  }

  private includes(nodeId: bigint) {
    return this.partition.selectedNodeIds.has(nodeId) === this.selectMembers;
  }

  getNode(nodeId: bigint) {
    return this.includes(nodeId) ? this.source.getNode(nodeId) : undefined;
  }

  forEachNode(callback: (node: SkeletonNode) => void) {
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
class RemapSnapshotNodeView implements SnapshotNodeView {
  readonly nodeCount: number;
  private readonly sourceNodeIdByRemappedNodeId = new Map<bigint, bigint>();
  private readonly remappedNodeBySourceNodeId = new Map<bigint, SkeletonNode>();
  private readonly nodeIdRemappings: ReadonlyMap<bigint, bigint>;
  private readonly segmentIdRemappings: ReadonlyMap<bigint, bigint>;

  constructor(
    private readonly source: SnapshotNodeView,
    remappings: CompleteSkeletonRemapping,
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

  private remapNodeId(nodeId: bigint) {
    return this.nodeIdRemappings.get(nodeId) ?? nodeId;
  }

  private resolveNode(node: SkeletonNode) {
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

  getNode(nodeId: bigint) {
    const sourceNodeId = this.sourceNodeIdByRemappedNodeId.get(nodeId);
    if (sourceNodeId === undefined) return undefined;
    const node = this.source.getNode(sourceNodeId);
    return node === undefined ? undefined : this.resolveNode(node);
  }

  forEachNode(callback: (node: SkeletonNode) => void) {
    this.source.forEachNode((node) => callback(this.resolveNode(node)));
  }
}

interface NormalizedMergeComponent {
  readonly nodeView: SnapshotNodeView;
  readonly segmentId?: bigint;
  readonly remappedNodeById: Map<bigint, SkeletonNode>;
}

class MergeSnapshotNodeView implements SnapshotNodeView {
  readonly nodeCount: number;
  private readonly componentIndexByNodeId = new Map<bigint, number>();

  constructor(
    private readonly components: readonly NormalizedMergeComponent[],
  ) {
    let nodeCount = 0;
    components.forEach((component, componentIndex) => {
      nodeCount += component.nodeView.nodeCount;
      component.nodeView.forEachNode((node) => {
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

  private resolveNode(component: NormalizedMergeComponent, node: SkeletonNode) {
    const { segmentId } = component;
    if (segmentId === undefined || segmentId === node.segmentId) return node;
    let remappedNode = component.remappedNodeById.get(node.nodeId);
    if (remappedNode === undefined) {
      remappedNode = Object.freeze({ ...node, segmentId });
      component.remappedNodeById.set(node.nodeId, remappedNode);
    }
    return remappedNode;
  }

  getNode(nodeId: bigint) {
    const componentIndex = this.componentIndexByNodeId.get(nodeId);
    if (componentIndex === undefined) return undefined;
    const component = this.components[componentIndex];
    const node = component.nodeView.getNode(nodeId);
    return node === undefined ? undefined : this.resolveNode(component, node);
  }

  forEachNode(callback: (node: SkeletonNode) => void) {
    for (const component of this.components) {
      component.nodeView.forEachNode((node) =>
        callback(this.resolveNode(component, node)),
      );
    }
  }
}

/**
 * Immutable view of a complete skeleton.
 *
 * Derived handles retain node views rather than concrete arrays. Calling
 * `materialize` constructs at most one array for this handle. Deriving beyond
 * the private depth bound may materialize and flatten the boundary source;
 * unchanged node objects and any previously returned array remain shared.
 */
export class CompleteSkeleton {
  readonly kind: CompleteSkeletonKind;
  private materializedNodes: readonly SkeletonNode[] | undefined;
  private materializationBuildCountValue = 0;
  private nodeViewDepth: number;

  private constructor(
    private nodeView: SnapshotNodeView,
    kind: CompleteSkeletonKind,
    nodeViewDepth: number,
    materializedNodes?: readonly SkeletonNode[],
  ) {
    this.kind = kind;
    this.nodeViewDepth = nodeViewDepth;
    if (materializedNodes !== undefined) {
      this.materializedNodes = materializedNodes;
      this.materializationBuildCountValue = 1;
    }
  }

  static create(nodes: readonly SkeletonNode[]) {
    const nodeView = new BaseSnapshotNodeView(nodes);
    return new CompleteSkeleton(nodeView, "base", 0, nodeView.nodes);
  }

  /**
   * A boundary source must be flat before another lazy node view captures it.
   * This keeps every newly-created chain bounded even when callers never
   * explicitly materialize their intermediate handles.
   */
  private prepareForDerivation() {
    if (this.nodeViewDepth >= COMPLETE_SKELETON_NODE_VIEW_REBASE_DEPTH) {
      this.materialize();
    }
  }

  static patch(
    source: CompleteSkeleton,
    patches: readonly CompleteSkeletonNodePatch[],
  ) {
    source.prepareForDerivation();
    return new CompleteSkeleton(
      new PatchSnapshotNodeView(source.nodeView, patches),
      "patch",
      source.nodeViewDepth + 1,
    );
  }

  static split(
    source: CompleteSkeleton,
    selectedNodeIds: Iterable<bigint>,
  ): CompleteSkeletonSplit {
    source.prepareForDerivation();
    const selectedNodeIdSet = new Set(selectedNodeIds);
    for (const nodeId of selectedNodeIdSet) {
      if (source.nodeView.getNode(nodeId) === undefined) {
        throw new Error(
          `Cannot select missing complete skeleton node ${nodeId} for a split view.`,
        );
      }
    }
    const partition: MembershipPartition = {
      selectedNodeIds: selectedNodeIdSet,
    };
    return {
      selected: new CompleteSkeleton(
        new MembershipSnapshotNodeView(source.nodeView, partition, true),
        "split-view",
        source.nodeViewDepth + 1,
      ),
      remainder: new CompleteSkeleton(
        new MembershipSnapshotNodeView(source.nodeView, partition, false),
        "split-view",
        source.nodeViewDepth + 1,
      ),
    };
  }

  static merge(
    components: readonly CompleteSkeletonMergeComponent[],
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
      nodeView: snapshot.nodeView,
      segmentId,
      remappedNodeById: new Map<bigint, SkeletonNode>(),
    }));
    let nodeView: SnapshotNodeView = new MergeSnapshotNodeView(
      normalizedComponents,
    );
    const overrides = options.overrides ?? [];
    if (overrides.length !== 0) {
      nodeView = new PatchSnapshotNodeView(
        nodeView,
        overrides.map(({ nodeId, changes }) => ({
          kind: "update" as const,
          nodeId,
          changes,
        })),
      );
    }
    return new CompleteSkeleton(
      nodeView,
      "merge",
      Math.max(...components.map(({ snapshot }) => snapshot.nodeViewDepth)) +
        1 +
        (overrides.length === 0 ? 0 : 1),
    );
  }

  static remap(
    source: CompleteSkeleton,
    remappings: CompleteSkeletonRemapping,
  ) {
    source.prepareForDerivation();
    return new CompleteSkeleton(
      new RemapSnapshotNodeView(source.nodeView, remappings),
      "remap",
      source.nodeViewDepth + 1,
    );
  }

  get nodeCount() {
    return this.nodeView.nodeCount;
  }

  /** Number of concrete arrays ever built for this handle (always 0 or 1). */
  get materializationCount() {
    return this.materializationBuildCountValue;
  }

  /** Resolves a node without constructing a concrete snapshot array. */
  getNode(nodeId: bigint) {
    return this.nodeView.getNode(nodeId);
  }

  /** Iterates this node view without constructing a concrete snapshot array. */
  forEachNode(callback: (node: SkeletonNode) => void) {
    this.nodeView.forEachNode(callback);
  }

  /**
   * Returns a stable concrete array.  Subsequent calls return the same object.
   */
  materialize(): readonly SkeletonNode[] {
    if (this.materializedNodes === undefined) {
      const nodes: SkeletonNode[] = [];
      this.nodeView.forEachNode((node) => nodes.push(node));
      if (nodes.length !== this.nodeView.nodeCount) {
        throw new Error(
          `Complete skeleton node view expected ${this.nodeView.nodeCount} nodes but produced ${nodes.length}.`,
        );
      }
      this.materializedNodes = Object.freeze(nodes);
      this.materializationBuildCountValue = 1;
    }
    if (this.nodeViewDepth >= COMPLETE_SKELETON_NODE_VIEW_REBASE_DEPTH) {
      // The public value remains immutable. Only the private way this handle
      // answers future reads changes, and it reuses the exact frozen array and
      // node objects already returned to callers.
      this.nodeView = new FlatSnapshotNodeView(this.materializedNodes);
      this.nodeViewDepth = 0;
    }
    return this.materializedNodes;
  }
}

export function createCompleteSkeleton(nodes: readonly SkeletonNode[]) {
  return CompleteSkeleton.create(nodes);
}

export function patchCompleteSkeleton(
  source: CompleteSkeleton,
  patches: readonly CompleteSkeletonNodePatch[],
) {
  return CompleteSkeleton.patch(source, patches);
}

export function splitCompleteSkeleton(
  source: CompleteSkeleton,
  selectedNodeIds: Iterable<bigint>,
) {
  return CompleteSkeleton.split(source, selectedNodeIds);
}

export function mergeCompleteSkeletons(
  components: readonly CompleteSkeletonMergeComponent[],
  options: {
    overrides?: readonly CompleteSkeletonNodeOverride[];
  } = {},
) {
  return CompleteSkeleton.merge(components, options);
}

export function remapCompleteSkeleton(
  source: CompleteSkeleton,
  remappings: CompleteSkeletonRemapping,
) {
  return CompleteSkeleton.remap(source, remappings);
}
