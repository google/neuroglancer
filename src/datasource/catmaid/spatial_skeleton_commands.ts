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

import {
  toCatmaidPositionInModelSpace,
  type CatmaidClient,
} from "#src/datasource/catmaid/api.js";
import {
  buildCatmaidInsertEditContext,
  buildCatmaidMultiNodeEditContext,
  buildCatmaidNeighborhoodEditContext,
  buildCatmaidNodeEditContext,
  buildCatmaidRerootEditContext,
} from "#src/datasource/catmaid/edit_state.js";
import type {
  CatmaidSpatialSkeletonAddNodeRequest,
  CatmaidSpatialSkeletonAddNodeResult,
  CatmaidSpatialSkeletonConfidenceUpdateRequest,
  CatmaidSpatialSkeletonDeleteNodeRequest,
  CatmaidSpatialSkeletonDeleteNodeResult,
  CatmaidSpatialSkeletonDescriptionUpdateRequest,
  CatmaidSpatialSkeletonDescriptionUpdateResult,
  CatmaidSpatialSkeletonInsertNodeRequest,
  CatmaidSpatialSkeletonInsertNodeResult,
  CatmaidSpatialSkeletonMergeRequest,
  CatmaidSpatialSkeletonMergeResult,
  CatmaidSpatialSkeletonMoveNodeRequest,
  CatmaidSpatialSkeletonNodeSourceStateResult,
  CatmaidSpatialSkeletonNodeSourceStateUpdate,
  CatmaidSpatialSkeletonRadiusUpdateRequest,
  CatmaidSpatialSkeletonRerootRequest,
  CatmaidSpatialSkeletonRerootResult,
  CatmaidSpatialSkeletonSplitRequest,
  CatmaidSpatialSkeletonSplitResult,
  CatmaidSpatialSkeletonTrueEndUpdateRequest,
} from "#src/datasource/catmaid/spatial_skeleton_edit_api.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import {
  addSegmentToVisibleSets,
  removeSegmentFromVisibleSets,
} from "#src/segmentation_display_state/base.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonSourceState,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";
import type { SpatialSkeletonEditCommandFactory } from "#src/skeleton/command_factories.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
  type SpatialSkeletonCommand,
  type SpatialSkeletonCommandContext,
} from "#src/skeleton/command_protocol.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/frontend.js";
import {
  findSpatiallyIndexedSkeletonNode,
  getSpatiallyIndexedSkeletonDirectChildren,
  getSpatiallyIndexedSkeletonNodeParent,
  getSpatiallyIndexedSkeletonPathToRoot,
  getSpatiallyIndexedSkeletonSubtreeNodes,
} from "#src/skeleton/node_traversal.js";
import {
  getEditableSpatiallyIndexedSkeletonSource,
  type SpatialSkeletonOptimisticEditQueue,
} from "#src/skeleton/spatial_skeleton_manager.js";
import { StatusMessage } from "#src/status.js";
import { formatErrorMessage } from "#src/util/error.js";

interface CatmaidSpatialSkeletonAddNodeCommandOptions {
  skeletonId: number;
  parentNodeId: number | undefined;
  positionInModelSpace: SpatialSkeletonVector;
}

interface CatmaidSpatialSkeletonInsertNodeCommandOptions {
  skeletonId: number;
  parentNodeId: number;
  childNodeIds: readonly number[];
  positionInModelSpace: SpatialSkeletonVector;
}

interface CatmaidSpatialSkeletonMoveNodeCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextPositionInModelSpace: SpatialSkeletonVector;
}

interface CatmaidSpatialSkeletonNodeDescriptionCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextDescription?: string;
}

interface CatmaidSpatialSkeletonNodeTrueEndCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextIsTrueEnd: boolean;
}

interface CatmaidSpatialSkeletonNodeRadiusCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextRadius: number;
}

interface CatmaidSpatialSkeletonNodeConfidenceCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  nextConfidence: number;
}

interface CatmaidSpatialSkeletonMergeEndpoint {
  nodeId: number;
  segmentId: number;
  position?: SpatialSkeletonVector;
  sourceState?: SpatialSkeletonSourceState;
}

interface CatmaidSpatialSkeletonMergeCommandPayload {
  firstNode: CatmaidSpatialSkeletonMergeEndpoint;
  secondNode: CatmaidSpatialSkeletonMergeEndpoint;
}

export interface CatmaidSpatialSkeletonEditCommandContext {
  getClient(): CatmaidClient;
  getOptimisticSkeletonEdits?(layer: SegmentationUserLayer): boolean;
}

interface CatmaidSpatialSkeletonEditOperations {
  commitAddNode(
    request: CatmaidSpatialSkeletonAddNodeRequest,
  ): Promise<CatmaidSpatialSkeletonAddNodeResult>;
  commitInsertNode(
    request: CatmaidSpatialSkeletonInsertNodeRequest,
  ): Promise<CatmaidSpatialSkeletonInsertNodeResult>;
  commitMoveNode(
    request: CatmaidSpatialSkeletonMoveNodeRequest,
  ): Promise<CatmaidSpatialSkeletonNodeSourceStateResult>;
  commitDeleteNode(
    request: CatmaidSpatialSkeletonDeleteNodeRequest,
  ): Promise<CatmaidSpatialSkeletonDeleteNodeResult>;
  commitReroot(
    request: CatmaidSpatialSkeletonRerootRequest,
  ): Promise<CatmaidSpatialSkeletonRerootResult>;
  commitDescription(
    request: CatmaidSpatialSkeletonDescriptionUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonDescriptionUpdateResult>;
  commitTrueEnd(
    request: CatmaidSpatialSkeletonTrueEndUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonNodeSourceStateResult>;
  commitRadius(
    request: CatmaidSpatialSkeletonRadiusUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonNodeSourceStateResult>;
  commitConfidence(
    request: CatmaidSpatialSkeletonConfidenceUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonNodeSourceStateResult>;
  commitMerge(
    request: CatmaidSpatialSkeletonMergeRequest,
  ): Promise<CatmaidSpatialSkeletonMergeResult>;
  commitSplit(
    request: CatmaidSpatialSkeletonSplitRequest,
  ): Promise<CatmaidSpatialSkeletonSplitResult>;
}

function isFiniteNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: number | undefined) {
  return value === undefined || isFiniteNumber(value);
}

function isSpatialSkeletonVector(
  value: object | undefined,
): value is SpatialSkeletonVector {
  return (
    value !== undefined && isFiniteNumber((value as { length?: number }).length)
  );
}

function areFiniteNumbers(values: readonly number[] | undefined) {
  return values !== undefined && values.every((value) => isFiniteNumber(value));
}

function isSpatiallyIndexedSkeletonNodePayload(
  value: object | undefined,
): value is SpatiallyIndexedSkeletonNode {
  if (value === undefined) return false;
  const candidate = value as {
    nodeId?: number;
    segmentId?: number;
    position?: object;
    parentNodeId?: number;
    radius?: number;
    confidence?: number;
    description?: string;
    isTrueEnd?: boolean;
  };
  return (
    isFiniteNumber(candidate.nodeId) &&
    isFiniteNumber(candidate.segmentId) &&
    isSpatialSkeletonVector(candidate.position) &&
    isOptionalFiniteNumber(candidate.parentNodeId) &&
    isOptionalFiniteNumber(candidate.radius) &&
    isOptionalFiniteNumber(candidate.confidence) &&
    (candidate.description === undefined ||
      typeof candidate.description === "string") &&
    (candidate.isTrueEnd === undefined ||
      typeof candidate.isTrueEnd === "boolean")
  );
}

function isCatmaidMergeEndpoint(
  value: object | undefined,
): value is CatmaidSpatialSkeletonMergeEndpoint {
  if (value === undefined) return false;
  const candidate = value as {
    nodeId?: number;
    segmentId?: number;
    position?: object;
  };
  return (
    isFiniteNumber(candidate.nodeId) &&
    isFiniteNumber(candidate.segmentId) &&
    (candidate.position === undefined ||
      isSpatialSkeletonVector(candidate.position))
  );
}

function requireCatmaidCommandPayload<T extends object>(
  payload: object,
  label: string,
  isValid: (payload: object) => payload is T,
) {
  if (!isValid(payload)) {
    throw new Error(`CATMAID ${label} command received an invalid payload.`);
  }
  return payload;
}

function requireCatmaidAddNodeCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "add-node",
    (candidate): candidate is CatmaidSpatialSkeletonAddNodeCommandOptions => {
      const options = candidate as {
        skeletonId?: number;
        parentNodeId?: number;
        positionInModelSpace?: object;
      };
      return (
        isFiniteNumber(options.skeletonId) &&
        isOptionalFiniteNumber(options.parentNodeId) &&
        isSpatialSkeletonVector(options.positionInModelSpace)
      );
    },
  );
}

function requireCatmaidInsertNodeCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "insert-node",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonInsertNodeCommandOptions => {
      const options = candidate as {
        skeletonId?: number;
        parentNodeId?: number;
        childNodeIds?: readonly number[];
        positionInModelSpace?: object;
      };
      return (
        isFiniteNumber(options.skeletonId) &&
        isFiniteNumber(options.parentNodeId) &&
        areFiniteNumbers(options.childNodeIds) &&
        isSpatialSkeletonVector(options.positionInModelSpace)
      );
    },
  );
}

function requireCatmaidMoveNodeCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "move-node",
    (candidate): candidate is CatmaidSpatialSkeletonMoveNodeCommandOptions => {
      const options = candidate as {
        node?: object;
        nextPositionInModelSpace?: object;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        isSpatialSkeletonVector(options.nextPositionInModelSpace)
      );
    },
  );
}

function requireCatmaidDeleteNodeCommandPayload(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "delete-node",
    isSpatiallyIndexedSkeletonNodePayload,
  );
}

function requireCatmaidNodeDescriptionCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "node-description",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonNodeDescriptionCommandOptions => {
      const options = candidate as {
        node?: object;
        nextDescription?: string;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        (options.nextDescription === undefined ||
          typeof options.nextDescription === "string")
      );
    },
  );
}

function requireCatmaidNodeTrueEndCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "node-true-end",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonNodeTrueEndCommandOptions => {
      const options = candidate as {
        node?: object;
        nextIsTrueEnd?: boolean;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        typeof options.nextIsTrueEnd === "boolean"
      );
    },
  );
}

function requireCatmaidNodeRadiusCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "node-radius",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonNodeRadiusCommandOptions => {
      const options = candidate as {
        node?: object;
        nextRadius?: number;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        isFiniteNumber(options.nextRadius)
      );
    },
  );
}

function requireCatmaidNodeConfidenceCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "node-confidence",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonNodeConfidenceCommandOptions => {
      const options = candidate as {
        node?: object;
        nextConfidence?: number;
      };
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        isFiniteNumber(options.nextConfidence)
      );
    },
  );
}

function requireCatmaidRerootCommandPayload(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "reroot",
    (
      candidate,
    ): candidate is Pick<
      SpatiallyIndexedSkeletonNode,
      "nodeId" | "segmentId" | "parentNodeId"
    > => {
      const node = candidate as {
        nodeId?: number;
        segmentId?: number;
        parentNodeId?: number;
      };
      return (
        isFiniteNumber(node.nodeId) &&
        isFiniteNumber(node.segmentId) &&
        isOptionalFiniteNumber(node.parentNodeId)
      );
    },
  );
}

function requireCatmaidSplitCommandPayload(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "split",
    (
      candidate,
    ): candidate is Pick<
      SpatiallyIndexedSkeletonNode,
      "nodeId" | "segmentId"
    > => {
      const node = candidate as {
        nodeId?: number;
        segmentId?: number;
      };
      return isFiniteNumber(node.nodeId) && isFiniteNumber(node.segmentId);
    },
  );
}

function requireCatmaidMergeCommandPayload(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "merge",
    (candidate): candidate is CatmaidSpatialSkeletonMergeCommandPayload => {
      const options = candidate as {
        firstNode?: object;
        secondNode?: object;
      };
      return (
        isCatmaidMergeEndpoint(options.firstNode) &&
        isCatmaidMergeEndpoint(options.secondNode)
      );
    },
  );
}

function cloneNodeSnapshot(
  node: SpatiallyIndexedSkeletonNode,
): SpatiallyIndexedSkeletonNode {
  return {
    nodeId: node.nodeId,
    segmentId: node.segmentId,
    position: toCatmaidPositionInModelSpace(node.position, "node position"),
    parentNodeId: node.parentNodeId,
    radius: node.radius,
    confidence: node.confidence,
    description: node.description,
    isTrueEnd: node.isTrueEnd ?? false,
    sourceState: node.sourceState,
  };
}

function rerootSegmentNodeSnapshots(
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[],
  targetNodeId: number,
) {
  const nodes = segmentNodes.map(cloneNodeSnapshot);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const targetNode = nodeById.get(targetNodeId);
  if (targetNode === undefined) {
    throw new Error(
      `Unable to reroot preview at missing node ${targetNodeId}.`,
    );
  }
  const path: SpatiallyIndexedSkeletonNode[] = [];
  const seen = new Set<number>();
  let current: SpatiallyIndexedSkeletonNode | undefined = targetNode;
  while (current !== undefined) {
    if (seen.has(current.nodeId)) {
      throw new Error("Unable to reroot cyclic skeleton preview.");
    }
    seen.add(current.nodeId);
    path.push(current);
    current =
      current.parentNodeId === undefined
        ? undefined
        : nodeById.get(current.parentNodeId);
    if (path.at(-1)?.parentNodeId !== undefined && current === undefined) {
      throw new Error("Unable to reroot incomplete skeleton preview.");
    }
  }
  let downstreamConfidence = path[0].confidence;
  path[0].parentNodeId = undefined;
  path[0].confidence = 100;
  for (let index = 1; index < path.length; ++index) {
    const node = path[index];
    const previousConfidence = node.confidence;
    node.parentNodeId = path[index - 1].nodeId;
    node.confidence = downstreamConfidence ?? node.confidence;
    downstreamConfidence = previousConfidence;
  }
  return nodes;
}

function getEditableSkeletonSourceForLayer(layer: SegmentationUserLayer): {
  skeletonLayer: SpatiallyIndexedSkeletonLayer;
} {
  const skeletonLayer = layer.getSpatiallyIndexedSkeletonLayer();
  if (skeletonLayer === undefined) {
    throw new Error(
      "No spatially indexed skeleton source is currently loaded.",
    );
  }
  if (getEditableSpatiallyIndexedSkeletonSource(skeletonLayer) === undefined) {
    throw new Error(
      "Unable to resolve editable skeleton source for the active layer.",
    );
  }
  return { skeletonLayer };
}

function normalizePositiveSegmentId(segmentId: number | undefined) {
  if (segmentId === undefined) {
    return undefined;
  }
  const normalizedSegmentId = Math.round(Number(segmentId));
  return Number.isSafeInteger(normalizedSegmentId) && normalizedSegmentId > 0
    ? normalizedSegmentId
    : undefined;
}

function ensureVisibleSegment(
  layer: SegmentationUserLayer,
  segmentId: number | undefined,
) {
  const normalizedSegmentId = normalizePositiveSegmentId(segmentId);
  if (normalizedSegmentId === undefined) {
    return;
  }
  addSegmentToVisibleSets(
    layer.displayState.segmentationGroupState.value,
    BigInt(normalizedSegmentId),
  );
}

function selectSegment(
  layer: SegmentationUserLayer,
  segmentId: number | undefined,
  pin: boolean,
) {
  const normalizedSegmentId = normalizePositiveSegmentId(segmentId);
  if (normalizedSegmentId === undefined) {
    return;
  }
  layer.selectSegment(BigInt(normalizedSegmentId), pin);
}

function removeVisibleSegment(
  layer: SegmentationUserLayer,
  segmentId: number | undefined,
  options: {
    deselect?: boolean;
  } = {},
) {
  const normalizedSegmentId = normalizePositiveSegmentId(segmentId);
  if (normalizedSegmentId === undefined) {
    return;
  }
  removeSegmentFromVisibleSets(
    layer.displayState.segmentationGroupState.value,
    BigInt(normalizedSegmentId),
    options,
  );
}

function findRootNode(segmentNodes: readonly SpatiallyIndexedSkeletonNode[]) {
  return segmentNodes.find((candidate) => candidate.parentNodeId === undefined);
}

interface ResolvedSpatialSkeletonEditNode {
  skeletonLayer: SpatiallyIndexedSkeletonLayer;
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[];
  node: SpatiallyIndexedSkeletonNode;
}

interface ResolvedSpatialSkeletonEditNodeContext {
  currentNodeId: number;
  segmentId: number;
  cachedNode: SpatiallyIndexedSkeletonNode | undefined;
  skeletonLayer: SpatiallyIndexedSkeletonLayer;
}

type CatmaidSkeletonRootNodeSource = Pick<CatmaidClient, "getSkeletonRootNode">;
type CatmaidSkeletonSourceStateRefresh = Pick<CatmaidClient, "getSkeleton">;

function collectUniqueNodePositions(
  ...nodeSets: readonly (readonly (
    | SpatiallyIndexedSkeletonNode
    | undefined
  )[])[]
) {
  const positions: ArrayLike<number>[] = [];
  const seenNodeIds = new Set<number>();
  for (const nodeSet of nodeSets) {
    for (const node of nodeSet) {
      if (node === undefined || seenNodeIds.has(node.nodeId)) {
        continue;
      }
      seenNodeIds.add(node.nodeId);
      positions.push(node.position);
    }
  }
  return positions;
}

function getSplitAffectedNodes(resolvedNode: ResolvedSpatialSkeletonEditNode) {
  const subtreeNodes = getSpatiallyIndexedSkeletonSubtreeNodes(
    resolvedNode.segmentNodes,
    resolvedNode.node.nodeId,
  );
  if (subtreeNodes.length === 0) {
    return resolvedNode.segmentNodes;
  }
  return [
    ...subtreeNodes,
    getSpatiallyIndexedSkeletonNodeParent(
      resolvedNode.segmentNodes,
      resolvedNode.node,
    ),
  ];
}

function getSegmentNodesBySegmentId(
  segmentId: number | undefined,
  ...resolvedNodes: readonly ResolvedSpatialSkeletonEditNode[]
) {
  if (segmentId === undefined) {
    return undefined;
  }
  for (const resolvedNode of resolvedNodes) {
    if (resolvedNode.node.segmentId === segmentId) {
      return resolvedNode.segmentNodes;
    }
  }
  return undefined;
}

function getMergeAffectedPositions(
  deletedSegmentId: number | undefined,
  firstNode: ResolvedSpatialSkeletonEditNode,
  secondNode: ResolvedSpatialSkeletonEditNode,
) {
  const deletedSegmentNodes = getSegmentNodesBySegmentId(
    deletedSegmentId,
    firstNode,
    secondNode,
  );
  if (deletedSegmentNodes === undefined) {
    return collectUniqueNodePositions(
      firstNode.segmentNodes,
      secondNode.segmentNodes,
    );
  }
  return collectUniqueNodePositions(deletedSegmentNodes, [
    firstNode.node,
    secondNode.node,
  ]);
}

function getCatmaidSkeletonRootNodeSource(
  skeletonLayer: SpatiallyIndexedSkeletonLayer,
): CatmaidSkeletonRootNodeSource | undefined {
  const skeletonSource = getEditableSpatiallyIndexedSkeletonSource(
    skeletonLayer,
  ) as Partial<CatmaidSkeletonRootNodeSource> | undefined;
  return typeof skeletonSource?.getSkeletonRootNode === "function"
    ? (skeletonSource as CatmaidSkeletonRootNodeSource)
    : undefined;
}

async function getFreshRerootSourceStateUpdates(
  skeletonSource: CatmaidSkeletonSourceStateRefresh,
  segmentId: number,
  nodeIds: readonly number[],
): Promise<readonly CatmaidSpatialSkeletonNodeSourceStateUpdate[]> {
  const refreshedNodes = await skeletonSource.getSkeleton(segmentId);
  const refreshedNodeById = new Map(
    refreshedNodes.map((node) => [node.nodeId, node]),
  );
  const seen = new Set<number>();
  const updates: CatmaidSpatialSkeletonNodeSourceStateUpdate[] = [];
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const sourceState = refreshedNodeById.get(nodeId)?.sourceState;
    if (sourceState === undefined) {
      throw new Error(
        `CATMAID reroot refresh did not return revision state for node ${nodeId}.`,
      );
    }
    updates.push({ nodeId, sourceState });
  }
  return updates;
}

class CatmaidRerootSourceStateRefreshError extends Error {
  constructor(readonly cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "CATMAID reroot source-state refresh failed.",
    );
    this.name = "CatmaidRerootSourceStateRefreshError";
  }
}

function getResolvedNodeContextForEdit(
  layer: SegmentationUserLayer,
  stableNodeId: number,
  stableSegmentId: number | undefined,
): ResolvedSpatialSkeletonEditNodeContext {
  const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
  const currentNodeId = commandMappings.resolveNodeId(stableNodeId);
  if (currentNodeId === undefined) {
    throw new Error(`Unable to resolve current node ${stableNodeId}.`);
  }
  const { skeletonLayer } = getEditableSkeletonSourceForLayer(layer);
  const cachedNode =
    layer.spatialSkeletonState.getCachedNode(currentNodeId) ??
    skeletonLayer.getNode(currentNodeId);
  const candidateSegmentId =
    cachedNode?.segmentId ?? commandMappings.resolveSegmentId(stableSegmentId);
  if (candidateSegmentId === undefined) {
    throw new Error(
      `Unable to resolve the current segment for node ${stableNodeId}.`,
    );
  }
  return {
    currentNodeId,
    segmentId: candidateSegmentId,
    cachedNode,
    skeletonLayer,
  };
}

async function getResolvedNodeForEdit(
  layer: SegmentationUserLayer,
  stableNodeId: number,
  stableSegmentId: number | undefined,
): Promise<ResolvedSpatialSkeletonEditNode> {
  const {
    currentNodeId,
    segmentId: candidateSegmentId,
    skeletonLayer,
  } = getResolvedNodeContextForEdit(layer, stableNodeId, stableSegmentId);
  let segmentNodes =
    layer.spatialSkeletonState.getCachedSegmentNodes(candidateSegmentId);
  if (segmentNodes === undefined) {
    segmentNodes = await layer.spatialSkeletonState.getFullSegmentNodes(
      skeletonLayer,
      candidateSegmentId,
      { retainWhileInactive: true },
    );
  }
  const node = findSpatiallyIndexedSkeletonNode(segmentNodes, currentNodeId);
  if (node === undefined) {
    throw new Error(
      `Node ${currentNodeId} is not available in the inspected skeleton cache.`,
    );
  }
  return {
    skeletonLayer,
    segmentNodes,
    node,
  };
}

async function refreshTopologySegments(
  layer: SegmentationUserLayer,
  segmentIds: readonly number[],
  affectedPositions: Iterable<ArrayLike<number>>,
  { invalidateSourceCells = true }: { invalidateSourceCells?: boolean } = {},
) {
  const normalizedSegmentIds = [
    ...new Set(
      segmentIds
        .map(normalizePositiveSegmentId)
        .filter((value): value is number => value !== undefined),
    ),
  ];
  if (normalizedSegmentIds.length === 0) {
    return;
  }
  const { skeletonLayer } = getEditableSkeletonSourceForLayer(layer);
  if (invalidateSourceCells) {
    skeletonLayer.invalidateSourceCellsForPositions(affectedPositions);
  }
  if (
    await layer.spatialSkeletonState.refreshCachedSegments(
      skeletonLayer,
      normalizedSegmentIds,
      { notify: false },
    )
  ) {
    layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
  }
}

function applyCreatedNodeToCache(
  layer: SegmentationUserLayer,
  skeletonLayer: SpatiallyIndexedSkeletonLayer,
  committedNode: CatmaidSpatialSkeletonAddNodeResult,
  parentNodeId: number | undefined,
  positionInModelSpace: SpatialSkeletonVector,
  options: {
    childNodes?: readonly SpatiallyIndexedSkeletonNode[];
    focusSelection?: boolean;
    markChanged?: boolean;
    moveView: boolean;
    pinSegment: boolean;
    retainOverlaySegment?: boolean;
    selectSegment?: boolean;
  },
) {
  const newNode: SpatiallyIndexedSkeletonNode = {
    nodeId: committedNode.nodeId,
    segmentId: committedNode.segmentId,
    position: new Float32Array(positionInModelSpace),
    parentNodeId,
    isTrueEnd: false,
    ...(committedNode.sourceState === undefined
      ? {}
      : { sourceState: committedNode.sourceState }),
  };
  layer.spatialSkeletonState.upsertCachedNode(newNode, {
    allowUncachedSegment: parentNodeId === undefined,
  });
  for (const childNode of options.childNodes ?? []) {
    layer.spatialSkeletonState.setCachedNodeParent(
      childNode.nodeId,
      newNode.nodeId,
    );
  }
  if (
    parentNodeId !== undefined &&
    committedNode.parentSourceState !== undefined
  ) {
    layer.spatialSkeletonState.setCachedNodeSourceState(
      parentNodeId,
      committedNode.parentSourceState,
    );
  }
  if (committedNode.nodeSourceStateUpdates?.length) {
    layer.spatialSkeletonState.setCachedNodeSourceStates(
      committedNode.nodeSourceStateUpdates,
    );
  }
  ensureVisibleSegment(layer, newNode.segmentId);
  if (options.selectSegment ?? true) {
    selectSegment(layer, newNode.segmentId, options.pinSegment);
  }
  if (options.focusSelection) {
    layer.selectSpatialSkeletonNode(
      newNode.nodeId,
      layer.manager.root.selectionState.pin.value,
      {
        segmentId: newNode.segmentId,
        position: newNode.position,
      },
    );
    if (options.moveView) {
      layer.moveViewToSpatialSkeletonNodePosition(newNode.position);
    }
  }
  if (options.retainOverlaySegment) {
    skeletonLayer.retainOverlaySegment(newNode.segmentId);
  }
  if (options.markChanged ?? true) {
    layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
  }
  return newNode;
}

function applyDeleteNodeToCache(
  layer: SegmentationUserLayer,
  deleteContext: {
    node: SpatiallyIndexedSkeletonNode;
    parentNode: SpatiallyIndexedSkeletonNode | undefined;
    childNodes: readonly SpatiallyIndexedSkeletonNode[];
  },
  options: {
    moveView: boolean;
  },
  nodeSourceStateUpdates: readonly CatmaidSpatialSkeletonNodeSourceStateUpdate[] = [],
) {
  const { node, parentNode, childNodes } = deleteContext;
  const directChildIds = childNodes.map((child) => child.nodeId);
  layer.spatialSkeletonState.removeCachedNode(node.nodeId, {
    parentNodeId: node.parentNodeId,
    childNodeIds: directChildIds,
  });
  if (nodeSourceStateUpdates.length > 0) {
    layer.spatialSkeletonState.setCachedNodeSourceStates(
      nodeSourceStateUpdates,
    );
  }
  if (parentNode !== undefined) {
    if (options.moveView) {
      layer.selectAndMoveToSpatialSkeletonNode(
        parentNode,
        layer.manager.root.selectionState.pin.value,
      );
    } else {
      layer.selectSpatialSkeletonNode(
        parentNode.nodeId,
        layer.manager.root.selectionState.pin.value,
        {
          segmentId: parentNode.segmentId,
          position: parentNode.position,
        },
      );
    }
  } else {
    layer.clearSpatialSkeletonNodeSelection(
      layer.manager.root.selectionState.pin.value,
    );
  }
  const remainingSegmentNodes =
    layer.spatialSkeletonState.getCachedSegmentNodes(node.segmentId) ?? [];
  if (remainingSegmentNodes.length === 0) {
    removeVisibleSegment(layer, node.segmentId, { deselect: true });
  }
  layer.markSpatialSkeletonNodeDataChanged({
    invalidateFullSkeletonCache: false,
  });
}

function invalidateDeletedNodeSourceCells(
  skeletonLayer: SpatiallyIndexedSkeletonLayer,
  deleteContext: {
    node: SpatiallyIndexedSkeletonNode;
    parentNode: SpatiallyIndexedSkeletonNode | undefined;
    childNodes: readonly SpatiallyIndexedSkeletonNode[];
  },
) {
  skeletonLayer.invalidateSourceCellsForPositions([
    deleteContext.node.position,
    deleteContext.parentNode?.position,
    ...deleteContext.childNodes.map((child) => child.position),
  ]);
}

async function commitAndApplyDeleteNode(
  layer: SegmentationUserLayer,
  editOperations: CatmaidSpatialSkeletonEditOperations,
  stableNodeId: number,
  stableSegmentId: number | undefined,
  options: {
    childMode: "none" | "context";
    invalidateSourceCells: boolean;
    moveView: boolean;
  },
) {
  const resolvedNode = await getResolvedNodeForEdit(
    layer,
    stableNodeId,
    stableSegmentId,
  );
  const deleteContext = await layer.getSpatialSkeletonDeleteOperationContext(
    resolvedNode.node,
  );
  const result = await editOperations.commitDeleteNode({
    node: deleteContext.node,
    childNodes: options.childMode === "none" ? [] : deleteContext.childNodes,
    segmentNodes: resolvedNode.segmentNodes,
  });
  applyDeleteNodeToCache(
    layer,
    deleteContext,
    { moveView: options.moveView },
    result.nodeSourceStateUpdates,
  );
  if (options.invalidateSourceCells) {
    invalidateDeletedNodeSourceCells(resolvedNode.skeletonLayer, deleteContext);
  }
  const remainingNodes =
    layer.spatialSkeletonState.getCachedSegmentNodes(
      resolvedNode.node.segmentId,
    ) ?? [];
  if (remainingNodes.length > 0) {
    resolvedNode.skeletonLayer.retainOverlaySegment(
      resolvedNode.node.segmentId,
    );
  } else {
    resolvedNode.skeletonLayer.markSegmentEdited(resolvedNode.node.segmentId);
  }
  return { resolvedNode };
}

async function applyNodeDescriptionAndTrueEnd(
  editOperations: CatmaidSpatialSkeletonEditOperations,
  node: SpatiallyIndexedSkeletonNode,
  next: {
    description?: string;
    isTrueEnd?: boolean;
  },
) {
  const nextDescription = next.description;
  const nextTrueEnd = next.isTrueEnd ?? false;
  let updatedNode: SpatiallyIndexedSkeletonNode = {
    ...node,
    description: nextDescription,
    isTrueEnd: nextTrueEnd,
  };
  const descriptionChanged = node.description !== nextDescription;
  if (descriptionChanged) {
    const descriptionResult = await editOperations.commitDescription({
      node,
      description: nextDescription ?? "",
      isTrueEnd: nextTrueEnd,
    });
    updatedNode = {
      ...updatedNode,
      description: descriptionResult.description,
      sourceState: descriptionResult.sourceState ?? updatedNode.sourceState,
    };
  }
  if (!descriptionChanged && node.isTrueEnd !== nextTrueEnd) {
    const trueEndResult = await editOperations.commitTrueEnd({
      node,
      isTrueEnd: nextTrueEnd,
    });
    updatedNode = {
      ...updatedNode,
      sourceState: trueEndResult.sourceState ?? updatedNode.sourceState,
    };
  }
  return updatedNode;
}

async function restoreNodeAttributes(
  layer: SegmentationUserLayer,
  editOperations: CatmaidSpatialSkeletonEditOperations,
  createdNode: SpatiallyIndexedSkeletonNode,
  snapshot: SpatiallyIndexedSkeletonNode,
  options: { applyLocalState?: boolean } = {},
) {
  let nextNode = cloneNodeSnapshot(createdNode);
  if (snapshot.radius !== undefined && snapshot.radius !== nextNode.radius) {
    const radiusResult = await editOperations.commitRadius({
      node: nextNode,
      radius: snapshot.radius,
    });
    nextNode = {
      ...nextNode,
      radius: snapshot.radius,
      sourceState: radiusResult.sourceState ?? nextNode.sourceState,
    };
  }
  if (
    snapshot.confidence !== undefined &&
    snapshot.confidence !== nextNode.confidence
  ) {
    const confidenceResult = await editOperations.commitConfidence({
      node: nextNode,
      confidence: snapshot.confidence,
    });
    nextNode = {
      ...nextNode,
      confidence: snapshot.confidence,
      sourceState: confidenceResult.sourceState ?? nextNode.sourceState,
    };
  }
  if (
    nextNode.description !== snapshot.description ||
    nextNode.isTrueEnd !== snapshot.isTrueEnd
  ) {
    nextNode = await applyNodeDescriptionAndTrueEnd(
      editOperations,
      nextNode,
      snapshot,
    );
  }
  if (options.applyLocalState ?? true) {
    layer.spatialSkeletonState.upsertCachedNode(nextNode);
  }
  return nextNode;
}

interface ResolvedCatmaidAddNodeContext {
  skeletonLayer: SpatiallyIndexedSkeletonLayer;
  parentNode: SpatiallyIndexedSkeletonNode | undefined;
  segmentId: number;
}

class AddNodeCommand implements SpatialSkeletonCommand {
  readonly label = "Add node";
  readonly executeOptimistically?: (
    context: SpatialSkeletonCommandContext,
  ) => Promise<void>;
  private stableNodeId: number | undefined;
  private stableSegmentId: number | undefined;

  constructor(
    private layer: SegmentationUserLayer,
    private stableParentNodeId: number | undefined,
    private targetSkeletonId: number,
    private positionInModelSpace: Float32Array,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
    optimistic = false,
  ) {
    if (optimistic && stableParentNodeId !== undefined) {
      this.executeOptimistically = async (context) => {
        await getOrCreateCatmaidOptimisticEditQueue(
          this.layer,
          this.editOperations,
        ).enqueueAddNode(this, context, {
          moveView: true,
          pinSegment: true,
          statusPrefix: "Added",
        });
      };
    }
  }

  getPositionInModelSpace() {
    return new Float32Array(this.positionInModelSpace);
  }

  markOptimisticCommit(stableNodeId: number, stableSegmentId: number) {
    this.stableNodeId = stableNodeId;
    this.stableSegmentId = stableSegmentId;
  }

  private recordCreatedNodeMapping(
    result: CatmaidSpatialSkeletonAddNodeResult,
  ) {
    if (this.stableNodeId === undefined) {
      this.stableNodeId = result.nodeId;
    } else {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapNodeId(
        this.stableNodeId,
        result.nodeId,
      );
    }
    if (this.stableSegmentId === undefined) {
      this.stableSegmentId = result.segmentId;
    } else {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
        this.stableSegmentId,
        result.segmentId,
      );
    }
  }

  async resolveAddNodeContext(options: {
    requireFullParent: boolean;
  }): Promise<ResolvedCatmaidAddNodeContext> {
    const { skeletonLayer } = getEditableSkeletonSourceForLayer(this.layer);
    const commandMappings =
      this.layer.spatialSkeletonState.commandHistory.mappings;
    const currentParentNodeId =
      this.stableParentNodeId === undefined
        ? undefined
        : commandMappings.resolveNodeId(this.stableParentNodeId);
    let parentNode: SpatiallyIndexedSkeletonNode | undefined;
    let resolvedSkeletonId =
      commandMappings.resolveSegmentId(this.targetSkeletonId) ??
      this.targetSkeletonId;
    if (currentParentNodeId !== undefined) {
      if (options.requireFullParent) {
        parentNode = (
          await getResolvedNodeForEdit(
            this.layer,
            this.stableParentNodeId!,
            commandMappings.getStableOrCurrentSegmentId(this.targetSkeletonId),
          )
        ).node;
      } else {
        const resolvedNodeContext = getResolvedNodeContextForEdit(
          this.layer,
          this.stableParentNodeId!,
          commandMappings.getStableOrCurrentSegmentId(this.targetSkeletonId),
        );
        parentNode =
          resolvedNodeContext.cachedNode ??
          resolvedNodeContext.skeletonLayer.getNode(
            resolvedNodeContext.currentNodeId,
          );
      }
      if (parentNode === undefined) {
        throw new Error(
          `Unable to resolve parent node ${currentParentNodeId}.`,
        );
      }
      resolvedSkeletonId = parentNode.segmentId;
    }
    return {
      skeletonLayer,
      parentNode,
      segmentId: resolvedSkeletonId,
    };
  }

  private async addNode(
    _context: SpatialSkeletonCommandContext,
    options: {
      moveView: boolean;
      pinSegment: boolean;
      statusPrefix: string;
    },
  ) {
    const { skeletonLayer, parentNode, segmentId } =
      await this.resolveAddNodeContext({ requireFullParent: true });
    const result = await this.editOperations.commitAddNode({
      segmentId,
      position: this.positionInModelSpace,
      parentNode,
    });
    this.recordCreatedNodeMapping(result);
    applyCreatedNodeToCache(
      this.layer,
      skeletonLayer,
      result,
      parentNode?.nodeId,
      this.positionInModelSpace,
      {
        focusSelection: true,
        moveView: options.moveView,
        pinSegment: options.pinSegment,
        retainOverlaySegment: parentNode !== undefined,
      },
    );
    StatusMessage.showTemporaryMessage(
      `${options.statusPrefix} node ${result.nodeId} on segment ${result.segmentId}.`,
    );
  }

  async execute(context: SpatialSkeletonCommandContext) {
    await this.addNode(context, {
      moveView: true,
      pinSegment: true,
      statusPrefix: "Added",
    });
  }

  async undo(_context: SpatialSkeletonCommandContext) {
    if (this.stableNodeId === undefined) {
      throw new Error("Add-node undo is missing the created node id.");
    }
    const { resolvedNode } = await commitAndApplyDeleteNode(
      this.layer,
      this.editOperations,
      this.stableNodeId,
      this.stableSegmentId,
      {
        childMode: "none",
        invalidateSourceCells: false,
        moveView: false,
      },
    );
    StatusMessage.showTemporaryMessage(
      `Undid add node ${resolvedNode.node.nodeId}.`,
    );
  }

  async redo(context: SpatialSkeletonCommandContext) {
    await this.addNode(context, {
      moveView: false,
      pinSegment: false,
      statusPrefix: "Redid add of",
    });
  }
}

enum CatmaidOptimisticEditStatus {
  Pending = "pending",
  InFlight = "inFlight",
  CancelRequested = "cancelRequested",
  Committed = "committed",
  Failed = "failed",
  RolledBack = "rolledBack",
}

type CatmaidOptimisticEditKind =
  | "addNode"
  | "moveNode"
  | "deleteNode"
  | "splitSkeleton"
  | "mergeSkeletons";

interface CatmaidOptimisticEditEntryBase {
  readonly operationId: number;
  readonly kind: CatmaidOptimisticEditKind;
  readonly dependencies: number[];
  inFlightWarningTimeout?: ReturnType<typeof setTimeout>;
  inFlightWarning?: StatusMessage;
  status: CatmaidOptimisticEditStatus;
}

interface CatmaidOptimisticAddNodeEntry extends CatmaidOptimisticEditEntryBase {
  readonly kind: "addNode";
  readonly command: AddNodeCommand;
  readonly tempNodeId: number;
  readonly positionInModelSpace: Float32Array;
  readonly parentTempNodeId?: number;
  parentNodeId: number;
  parentNodeForServer?: SpatiallyIndexedSkeletonNode;
  result?: CatmaidSpatialSkeletonAddNodeResult;
}

interface CatmaidOptimisticMoveNodeEntry
  extends CatmaidOptimisticEditEntryBase {
  readonly kind: "moveNode";
  readonly command: MoveNodeCommand;
  nodeId: number;
  segmentId: number;
  nodeForServer: SpatiallyIndexedSkeletonNode;
  result?: CatmaidSpatialSkeletonNodeSourceStateResult;
  beforePositionInModelSpace: Float32Array;
  readonly afterPositionInModelSpace: Float32Array;
}

interface CatmaidOptimisticDeleteNodeEntry
  extends CatmaidOptimisticEditEntryBase {
  readonly kind: "deleteNode";
  readonly command: DeleteNodeCommand;
  nodeId: number;
  segmentId: number;
  deleteContext: {
    node: SpatiallyIndexedSkeletonNode;
    parentNode: SpatiallyIndexedSkeletonNode | undefined;
    childNodes: readonly SpatiallyIndexedSkeletonNode[];
  };
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[];
  affectedPositions: readonly ArrayLike<number>[];
  result?: CatmaidSpatialSkeletonDeleteNodeResult;
}

interface CatmaidOptimisticSplitSkeletonEntry
  extends CatmaidOptimisticEditEntryBase {
  readonly kind: "splitSkeleton";
  readonly command: SplitCommand;
  nodeId: number;
  originalSegmentId: number;
  tempSegmentId: number;
  formerParentNodeId: number;
  originalSegmentNodes: SpatiallyIndexedSkeletonNode[];
  affectedPositions: readonly ArrayLike<number>[];
  result?: CatmaidSpatialSkeletonSplitResult;
}

interface CatmaidOptimisticMergeSkeletonsEntry
  extends CatmaidOptimisticEditEntryBase {
  readonly kind: "mergeSkeletons";
  readonly command: MergeCommand;
  firstNodeId: number;
  secondNodeId: number;
  firstSegmentId: number;
  secondSegmentId: number;
  previewResultSegmentId: number;
  firstSegmentNodes: SpatiallyIndexedSkeletonNode[];
  secondSegmentNodes: SpatiallyIndexedSkeletonNode[];
  affectedPositions: readonly ArrayLike<number>[];
  result?: CatmaidSpatialSkeletonMergeResult;
}

type CatmaidOptimisticEditEntry =
  | CatmaidOptimisticAddNodeEntry
  | CatmaidOptimisticMoveNodeEntry
  | CatmaidOptimisticDeleteNodeEntry
  | CatmaidOptimisticSplitSkeletonEntry
  | CatmaidOptimisticMergeSkeletonsEntry;

const CATMAID_OPTIMISTIC_TEMP_ID_START = Number.MAX_SAFE_INTEGER;
const CATMAID_OPTIMISTIC_TEMP_SEGMENT_ID_START = 0xffff_fffe;
const CATMAID_OPTIMISTIC_IN_FLIGHT_WARNING_DELAY_MS = 30_000;

const catmaidOptimisticEditQueues = new WeakMap<
  object,
  CatmaidOptimisticEditQueue
>();

function getOrCreateCatmaidOptimisticEditQueue(
  layer: SegmentationUserLayer,
  editOperations: CatmaidSpatialSkeletonEditOperations,
) {
  const state = layer.spatialSkeletonState;
  const existingQueue = catmaidOptimisticEditQueues.get(state);
  if (existingQueue?.usesEditOperations(editOperations)) {
    state.setOptimisticEditQueue(existingQueue);
    return existingQueue;
  }
  existingQueue?.dispose();
  const queue = new CatmaidOptimisticEditQueue(layer, editOperations);
  catmaidOptimisticEditQueues.set(state, queue);
  state.setOptimisticEditQueue(queue);
  return queue;
}

function deleteCatmaidOptimisticEditQueue(
  layer: SegmentationUserLayer,
  queue: CatmaidOptimisticEditQueue,
) {
  const state = layer.spatialSkeletonState;
  if (catmaidOptimisticEditQueues.get(state) === queue) {
    catmaidOptimisticEditQueues.delete(state);
  }
}

function positionsEqual(
  first: ArrayLike<number> | undefined,
  second: ArrayLike<number>,
) {
  if (first === undefined || first.length < 3 || second.length < 3) {
    return false;
  }
  return (
    first[0] === second[0] && first[1] === second[1] && first[2] === second[2]
  );
}

class CatmaidOptimisticEditQueue implements SpatialSkeletonOptimisticEditQueue {
  private entries: CatmaidOptimisticEditEntry[] = [];
  private nextOperationId = 1;
  private nextTempId = CATMAID_OPTIMISTIC_TEMP_ID_START;
  private nextTempSegmentId = CATMAID_OPTIMISTIC_TEMP_SEGMENT_ID_START;
  private draining = false;
  private disposed = false;
  private reconcilingTopology = false;
  private topologyRefreshSegmentIds = new Set<number>();
  private topologyRefreshPositions: ArrayLike<number>[] = [];

  constructor(
    private readonly layer: SegmentationUserLayer,
    private readonly editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  usesEditOperations(editOperations: CatmaidSpatialSkeletonEditOperations) {
    return this.editOperations === editOperations;
  }

  canQueueAction(action: SpatialSkeletonAction) {
    if (this.reconcilingTopology) return false;
    return (
      action === SpatialSkeletonActions.addNodes ||
      action === SpatialSkeletonActions.moveNodes ||
      action === SpatialSkeletonActions.deleteNodes ||
      action === SpatialSkeletonActions.mergeSkeletons ||
      action === SpatialSkeletonActions.splitSkeletons
    );
  }

  canUndo() {
    return this.entries.some(
      (entry) =>
        entry.status === CatmaidOptimisticEditStatus.Pending ||
        entry.status === CatmaidOptimisticEditStatus.InFlight,
    );
  }

  hasUnconfirmedActions() {
    return (
      this.reconcilingTopology ||
      this.entries.some(
        (entry) =>
          entry.status === CatmaidOptimisticEditStatus.Pending ||
          entry.status === CatmaidOptimisticEditStatus.InFlight ||
          entry.status === CatmaidOptimisticEditStatus.CancelRequested,
      )
    );
  }

  getDebugSnapshot() {
    return this.entries.map((entry) => {
      const base = {
        operationId: entry.operationId,
        kind: entry.kind,
        status: entry.status,
        dependencies: [...entry.dependencies],
      };
      switch (entry.kind) {
        case "addNode":
          return {
            ...base,
            tempNodeId: entry.tempNodeId,
            parentNodeId: entry.parentNodeId,
            parentTempNodeId: entry.parentTempNodeId,
            nodeId: entry.result?.nodeId,
            segmentId:
              entry.result?.segmentId ??
              this.layer.spatialSkeletonState.getCachedNode(entry.tempNodeId)
                ?.segmentId,
          };
        case "moveNode":
        case "deleteNode":
          return {
            ...base,
            nodeId: entry.nodeId,
            segmentId: entry.segmentId,
          };
        case "splitSkeleton":
          return {
            ...base,
            nodeId: entry.nodeId,
            segmentId: entry.originalSegmentId,
            tempSegmentId: entry.tempSegmentId,
            resultSegmentId: entry.result?.newSegmentId,
          };
        case "mergeSkeletons":
          return {
            ...base,
            nodeId: entry.firstNodeId,
            secondNodeId: entry.secondNodeId,
            segmentId: entry.firstSegmentId,
            secondSegmentId: entry.secondSegmentId,
            resultSegmentId: entry.result?.resultSegmentId,
            deletedSegmentId: entry.result?.deletedSegmentId,
          };
      }
    });
  }

  clearSettled() {
    const changed = this.pruneSettledEntries();
    if (changed) {
      this.notifyChanged();
    }
    return changed;
  }

  clear() {
    const changed = this.rollbackAndCancelForReset();
    if (changed) {
      this.notifyChanged();
    }
    return changed;
  }

  dispose() {
    const changed = this.rollbackAndCancelForReset();
    this.disposed = true;
    deleteCatmaidOptimisticEditQueue(this.layer, this);
    return changed;
  }

  private pruneSettledEntries() {
    const dependenciesOfUnsettledEntries = new Set<number>();
    for (const entry of this.entries) {
      if (this.isSettled(entry)) continue;
      for (const dependency of entry.dependencies) {
        dependenciesOfUnsettledEntries.add(dependency);
      }
    }
    const removedEntries: CatmaidOptimisticEditEntry[] = [];
    const nextEntries = this.entries.filter((entry) => {
      const keep =
        !this.isSettled(entry) ||
        dependenciesOfUnsettledEntries.has(entry.operationId);
      if (!keep) {
        removedEntries.push(entry);
      }
      return keep;
    });
    if (nextEntries.length === this.entries.length) {
      return false;
    }
    for (const entry of removedEntries) {
      this.clearInFlightWarning(entry);
    }
    this.entries = nextEntries;
    return true;
  }

  private rollbackAndCancelForReset() {
    const changed = this.entries.length !== 0;
    this.topologyRefreshSegmentIds.clear();
    this.topologyRefreshPositions = [];
    for (const entry of [...this.entries].reverse()) {
      this.clearInFlightWarning(entry);
      if (
        entry.status === CatmaidOptimisticEditStatus.InFlight ||
        entry.status === CatmaidOptimisticEditStatus.CancelRequested
      ) {
        this.rollbackPreview(entry);
        entry.status = CatmaidOptimisticEditStatus.CancelRequested;
      } else if (entry.status === CatmaidOptimisticEditStatus.Pending) {
        this.rollbackPreview(entry);
        entry.status = CatmaidOptimisticEditStatus.RolledBack;
      }
    }
    this.entries = this.entries.filter(
      (entry) => entry.status === CatmaidOptimisticEditStatus.CancelRequested,
    );
    return changed;
  }

  private notifyChanged() {
    if (this.disposed) {
      return;
    }
    this.layer.spatialSkeletonState.notifyOptimisticEditQueueChanged();
  }

  private allocateTempId() {
    while (this.nextTempId > 0) {
      const tempId = this.nextTempId--;
      if (
        this.layer.spatialSkeletonState.getCachedNode(tempId) === undefined &&
        this.layer.spatialSkeletonState.getCachedSegmentNodes(tempId) ===
          undefined &&
        !this.entries.some(
          (entry) =>
            (entry.kind === "addNode" && entry.tempNodeId === tempId) ||
            (entry.kind === "splitSkeleton" && entry.tempSegmentId === tempId),
        )
      ) {
        return tempId;
      }
    }
    throw new Error("Unable to allocate optimistic skeleton edit id.");
  }

  private allocateTempSegmentId() {
    while (this.nextTempSegmentId > 0) {
      const tempSegmentId = this.nextTempSegmentId--;
      if (
        this.layer.spatialSkeletonState.getCachedNode(tempSegmentId) ===
          undefined &&
        this.layer.spatialSkeletonState.getCachedSegmentNodes(tempSegmentId) ===
          undefined &&
        !this.entries.some(
          (entry) =>
            entry.kind === "splitSkeleton" &&
            entry.tempSegmentId === tempSegmentId,
        )
      ) {
        return tempSegmentId;
      }
    }
    throw new Error("Unable to allocate optimistic skeleton segment id.");
  }

  private findEntryForTempNode(
    nodeId: number | undefined,
  ): CatmaidOptimisticAddNodeEntry | undefined {
    if (nodeId === undefined) return undefined;
    return this.entries.find(
      (entry): entry is CatmaidOptimisticAddNodeEntry =>
        entry.kind === "addNode" &&
        entry.tempNodeId === nodeId &&
        entry.status !== CatmaidOptimisticEditStatus.Failed &&
        entry.status !== CatmaidOptimisticEditStatus.RolledBack,
    );
  }

  private isSettled(entry: CatmaidOptimisticEditEntry) {
    return (
      entry.status === CatmaidOptimisticEditStatus.Committed ||
      entry.status === CatmaidOptimisticEditStatus.Failed ||
      entry.status === CatmaidOptimisticEditStatus.RolledBack
    );
  }

  private isActive(entry: CatmaidOptimisticEditEntry) {
    return !this.isSettled(entry);
  }

  private startInFlightWarning(entry: CatmaidOptimisticEditEntry) {
    this.clearInFlightWarning(entry);
    entry.inFlightWarningTimeout = setTimeout(() => {
      entry.inFlightWarningTimeout = undefined;
      if (
        this.disposed ||
        entry.status !== CatmaidOptimisticEditStatus.InFlight
      ) {
        return;
      }
      entry.inFlightWarning = StatusMessage.showErrorMessage(
        "CATMAID has not confirmed the optimistic skeleton edit yet. Wait for it to finish before continuing.",
      );
    }, CATMAID_OPTIMISTIC_IN_FLIGHT_WARNING_DELAY_MS);
  }

  private clearInFlightWarning(entry: CatmaidOptimisticEditEntry) {
    if (entry.inFlightWarningTimeout !== undefined) {
      clearTimeout(entry.inFlightWarningTimeout);
      entry.inFlightWarningTimeout = undefined;
    }
    if (entry.inFlightWarning !== undefined) {
      entry.inFlightWarning.dispose();
      entry.inFlightWarning = undefined;
    }
  }

  private isDependencyCommitted(operationId: number) {
    const dependency = this.entries.find(
      (entry) => entry.operationId === operationId,
    );
    // Committed dependency entries must be retained while active dependents
    // reference them; if one is missing, the dependency is not satisfied.
    return dependency?.status === CatmaidOptimisticEditStatus.Committed;
  }

  private getActiveDependenciesForResources(
    nodeIds: Iterable<number>,
    segmentIds: Iterable<number> = [],
  ) {
    const nodeIdSet = new Set(nodeIds);
    const segmentIdSet = new Set(segmentIds);
    const dependencies: number[] = [];
    for (const entry of this.entries) {
      if (!this.isActive(entry)) continue;
      if (
        this.entryTouchesAnyNode(entry, nodeIdSet) ||
        this.entryTouchesAnySegment(entry, segmentIdSet)
      ) {
        dependencies.push(entry.operationId);
      }
    }
    return dependencies;
  }

  private entryTouchesAnyNode(
    entry: CatmaidOptimisticEditEntry,
    nodeIds: ReadonlySet<number>,
  ) {
    switch (entry.kind) {
      case "addNode":
        return (
          nodeIds.has(entry.tempNodeId) ||
          (entry.result !== undefined && nodeIds.has(entry.result.nodeId))
        );
      case "moveNode":
        return nodeIds.has(entry.nodeId);
      case "deleteNode":
        return (
          nodeIds.has(entry.nodeId) ||
          entry.deleteContext.childNodes.some((child) =>
            nodeIds.has(child.nodeId),
          )
        );
      case "splitSkeleton":
        return entry.originalSegmentNodes.some((node) =>
          nodeIds.has(node.nodeId),
        );
      case "mergeSkeletons":
        return (
          entry.firstSegmentNodes.some((node) => nodeIds.has(node.nodeId)) ||
          entry.secondSegmentNodes.some((node) => nodeIds.has(node.nodeId))
        );
    }
  }

  private entryTouchesAnySegment(
    entry: CatmaidOptimisticEditEntry,
    segmentIds: ReadonlySet<number>,
  ) {
    if (segmentIds.size === 0) return false;
    switch (entry.kind) {
      case "addNode": {
        const previewSegmentId =
          entry.result?.segmentId ??
          this.layer.spatialSkeletonState.getCachedNode(entry.tempNodeId)
            ?.segmentId;
        return (
          (previewSegmentId !== undefined &&
            segmentIds.has(previewSegmentId)) ||
          (entry.parentNodeForServer !== undefined &&
            segmentIds.has(entry.parentNodeForServer.segmentId))
        );
      }
      case "moveNode":
      case "deleteNode":
        return segmentIds.has(entry.segmentId);
      case "splitSkeleton":
        return (
          segmentIds.has(entry.originalSegmentId) ||
          segmentIds.has(entry.tempSegmentId) ||
          (entry.result?.existingSegmentId !== undefined &&
            segmentIds.has(entry.result.existingSegmentId)) ||
          (entry.result?.newSegmentId !== undefined &&
            segmentIds.has(entry.result.newSegmentId))
        );
      case "mergeSkeletons":
        return (
          segmentIds.has(entry.firstSegmentId) ||
          segmentIds.has(entry.secondSegmentId) ||
          segmentIds.has(entry.previewResultSegmentId) ||
          (entry.result?.resultSegmentId !== undefined &&
            segmentIds.has(entry.result.resultSegmentId)) ||
          (entry.result?.deletedSegmentId !== undefined &&
            segmentIds.has(entry.result.deletedSegmentId))
        );
    }
  }

  private getExpectedAddNodeSegmentId(
    entry: CatmaidOptimisticAddNodeEntry,
    fallbackSegmentId?: number,
  ) {
    return (
      this.layer.spatialSkeletonState.getCachedNode(entry.parentNodeId)
        ?.segmentId ?? fallbackSegmentId
    );
  }

  private hasActiveMoveDependent(entry: CatmaidOptimisticAddNodeEntry) {
    return this.entries.some(
      (candidate) =>
        candidate.kind === "moveNode" &&
        this.isActive(candidate) &&
        candidate.dependencies.includes(entry.operationId),
    );
  }

  private hasActiveDeleteDependent(entry: CatmaidOptimisticAddNodeEntry) {
    return this.entries.some(
      (candidate) =>
        candidate.kind === "deleteNode" &&
        this.isActive(candidate) &&
        candidate.dependencies.includes(entry.operationId),
    );
  }

  private hasActiveTopologyDependent(entry: CatmaidOptimisticAddNodeEntry) {
    return this.entries.some(
      (candidate) =>
        (candidate.kind === "splitSkeleton" ||
          candidate.kind === "mergeSkeletons") &&
        this.isActive(candidate) &&
        candidate.dependencies.includes(entry.operationId),
    );
  }

  private previewAddNodeMatchesEntry(
    entry: CatmaidOptimisticAddNodeEntry,
    previewNode: SpatiallyIndexedSkeletonNode | undefined,
    expectedSegmentId?: number,
  ): previewNode is SpatiallyIndexedSkeletonNode {
    const hasTopologyDependent = this.hasActiveTopologyDependent(entry);
    return (
      previewNode !== undefined &&
      previewNode.nodeId === entry.tempNodeId &&
      (previewNode.parentNodeId === entry.parentNodeId ||
        hasTopologyDependent) &&
      (positionsEqual(previewNode.position, entry.positionInModelSpace) ||
        this.hasActiveMoveDependent(entry)) &&
      (expectedSegmentId === undefined ||
        previewNode.segmentId === expectedSegmentId ||
        hasTopologyDependent)
    );
  }

  private handlePreviewCollision(
    entry: CatmaidOptimisticAddNodeEntry,
    previewNode: SpatiallyIndexedSkeletonNode | undefined,
    expectedSegmentId?: number,
    result?: CatmaidSpatialSkeletonAddNodeResult,
  ) {
    const segmentIds = [
      expectedSegmentId,
      previewNode?.segmentId,
      result?.segmentId,
    ].filter(
      (segmentId): segmentId is number =>
        segmentId !== undefined &&
        Number.isSafeInteger(segmentId) &&
        segmentId > 0,
    );
    if (segmentIds.length !== 0) {
      this.layer.spatialSkeletonState.invalidateCachedSegments(segmentIds);
    }
    skeletonLayerFromLayer(this.layer)?.invalidateSourceCellsForPositions([
      entry.positionInModelSpace,
      previewNode?.position,
    ]);
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    StatusMessage.showErrorMessage(
      `Optimistic skeleton edit temporary id ${entry.tempNodeId} conflicted with loaded skeleton data. The affected skeleton cache was invalidated; refresh the skeleton to sync before continuing.`,
    );
  }

  private rollbackPreview(entry: CatmaidOptimisticEditEntry) {
    switch (entry.kind) {
      case "addNode":
        return this.rollbackAddNodePreview(entry);
      case "moveNode":
        return this.rollbackMoveNodePreview(entry);
      case "deleteNode":
        return this.rollbackDeleteNodePreview(entry);
      case "splitSkeleton":
        return this.rollbackSplitSkeletonPreview(entry);
      case "mergeSkeletons":
        return this.rollbackMergeSkeletonsPreview(entry);
    }
  }

  private rollbackAddNodePreview(entry: CatmaidOptimisticAddNodeEntry) {
    const previewNode = this.layer.spatialSkeletonState.getCachedNode(
      entry.tempNodeId,
    );
    if (previewNode === undefined) {
      return false;
    }
    const expectedSegmentId = this.getExpectedAddNodeSegmentId(
      entry,
      previewNode.segmentId,
    );
    if (
      !this.previewAddNodeMatchesEntry(entry, previewNode, expectedSegmentId)
    ) {
      this.handlePreviewCollision(entry, previewNode, expectedSegmentId);
      return false;
    }
    const parentNode =
      previewNode.parentNodeId === undefined
        ? undefined
        : this.layer.spatialSkeletonState.getCachedNode(
            previewNode.parentNodeId,
          );
    this.layer.spatialSkeletonState.removeCachedNode(entry.tempNodeId, {
      parentNodeId: previewNode.parentNodeId,
      childNodeIds: [],
    });
    const remainingNodes =
      this.layer.spatialSkeletonState.getCachedSegmentNodes(
        previewNode.segmentId,
      ) ?? [];
    if (remainingNodes.length === 0) {
      removeVisibleSegment(this.layer, previewNode.segmentId, {
        deselect: true,
      });
    }
    if (
      this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId ===
      entry.tempNodeId
    ) {
      if (parentNode !== undefined) {
        this.layer.selectSpatialSkeletonNode(
          parentNode.nodeId,
          this.layer.manager.root.selectionState.pin.value,
          {
            segmentId: parentNode.segmentId,
            position: parentNode.position,
          },
        );
      } else {
        this.layer.clearSpatialSkeletonNodeSelection(
          this.layer.manager.root.selectionState.pin.value,
        );
      }
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    return true;
  }

  private rollbackMoveNodePreview(entry: CatmaidOptimisticMoveNodeEntry) {
    const cachedNode = this.layer.spatialSkeletonState.getCachedNode(
      entry.nodeId,
    );
    if (cachedNode === undefined) {
      return false;
    }
    this.layer.spatialSkeletonState.moveCachedNode(
      entry.nodeId,
      entry.beforePositionInModelSpace,
    );
    if (
      this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId === entry.nodeId
    ) {
      this.layer.selectSpatialSkeletonNode(
        entry.nodeId,
        this.layer.manager.root.selectionState.pin.value,
        {
          segmentId: cachedNode.segmentId,
          position: entry.beforePositionInModelSpace,
        },
      );
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    return true;
  }

  private rollbackDeleteNodePreview(entry: CatmaidOptimisticDeleteNodeEntry) {
    const { node, childNodes } = entry.deleteContext;
    const restoredNode = {
      ...node,
      position: new Float32Array(node.position),
    };
    this.layer.spatialSkeletonState.upsertCachedNode(restoredNode, {
      allowUncachedSegment: true,
    });
    for (const childNode of childNodes) {
      this.layer.spatialSkeletonState.setCachedNodeParent(
        childNode.nodeId,
        restoredNode.nodeId,
      );
    }
    ensureVisibleSegment(this.layer, restoredNode.segmentId);
    this.layer.selectSpatialSkeletonNode(
      restoredNode.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      {
        segmentId: restoredNode.segmentId,
        position: restoredNode.position,
      },
    );
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    return true;
  }

  private applySplitSkeletonPreview(
    entry: CatmaidOptimisticSplitSkeletonEntry,
  ) {
    const subtreeNodeIds = new Set(
      getSpatiallyIndexedSkeletonSubtreeNodes(
        entry.originalSegmentNodes,
        entry.nodeId,
      ).map((node) => node.nodeId),
    );
    if (!subtreeNodeIds.has(entry.nodeId)) {
      subtreeNodeIds.add(entry.nodeId);
    }
    const upstreamNodes: SpatiallyIndexedSkeletonNode[] = [];
    const downstreamNodes: SpatiallyIndexedSkeletonNode[] = [];
    for (const originalNode of entry.originalSegmentNodes) {
      const node = cloneNodeSnapshot(originalNode);
      if (subtreeNodeIds.has(node.nodeId)) {
        node.segmentId = entry.tempSegmentId;
        if (node.nodeId === entry.nodeId) {
          node.parentNodeId = undefined;
        }
        downstreamNodes.push(node);
      } else {
        node.segmentId = entry.originalSegmentId;
        upstreamNodes.push(node);
      }
    }
    this.layer.spatialSkeletonState.replaceCachedSegmentSnapshots(
      [
        [entry.originalSegmentId, upstreamNodes],
        [entry.tempSegmentId, downstreamNodes],
      ],
      { notify: false },
    );
    ensureVisibleSegment(this.layer, entry.originalSegmentId);
    ensureVisibleSegment(this.layer, entry.tempSegmentId);
    selectSegment(this.layer, entry.tempSegmentId, true);
    this.layer.selectSpatialSkeletonNode(
      entry.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      { segmentId: entry.tempSegmentId },
    );
    const skeletonLayer = skeletonLayerFromLayer(this.layer);
    skeletonLayer?.retainOverlaySegment(entry.originalSegmentId);
    skeletonLayer?.retainOverlaySegment(entry.tempSegmentId);
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
  }

  private rollbackSplitSkeletonPreview(
    entry: CatmaidOptimisticSplitSkeletonEntry,
  ) {
    this.layer.spatialSkeletonState.replaceCachedSegmentSnapshots(
      [
        [entry.originalSegmentId, entry.originalSegmentNodes],
        [entry.tempSegmentId, undefined],
      ],
      { notify: false },
    );
    ensureVisibleSegment(this.layer, entry.originalSegmentId);
    removeVisibleSegment(this.layer, entry.tempSegmentId, { deselect: true });
    this.layer.selectSpatialSkeletonNode(
      entry.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      { segmentId: entry.originalSegmentId },
    );
    skeletonLayerFromLayer(this.layer)?.retainOverlaySegment(
      entry.originalSegmentId,
    );
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    return true;
  }

  private applyMergeSkeletonsPreview(
    entry: CatmaidOptimisticMergeSkeletonsEntry,
  ) {
    const rerootedSecondNodes = rerootSegmentNodeSnapshots(
      entry.secondSegmentNodes,
      entry.secondNodeId,
    ).map((node) => ({
      ...node,
      segmentId: entry.previewResultSegmentId,
      parentNodeId:
        node.nodeId === entry.secondNodeId
          ? entry.firstNodeId
          : node.parentNodeId,
    }));
    const mergedNodes = [
      ...entry.firstSegmentNodes.map((node) => ({
        ...cloneNodeSnapshot(node),
        segmentId: entry.previewResultSegmentId,
      })),
      ...rerootedSecondNodes,
    ];
    this.layer.spatialSkeletonState.replaceCachedSegmentSnapshots(
      [
        [entry.previewResultSegmentId, mergedNodes],
        [entry.secondSegmentId, undefined],
      ],
      { notify: false },
    );
    ensureVisibleSegment(this.layer, entry.previewResultSegmentId);
    removeVisibleSegment(this.layer, entry.secondSegmentId, { deselect: true });
    selectSegment(this.layer, entry.previewResultSegmentId, false);
    this.layer.selectSpatialSkeletonNode(
      entry.secondNodeId,
      this.layer.manager.root.selectionState.pin.value,
      { segmentId: entry.previewResultSegmentId },
    );
    const skeletonLayer = skeletonLayerFromLayer(this.layer);
    skeletonLayer?.retainOverlaySegment(entry.previewResultSegmentId);
    skeletonLayer?.markSegmentEdited(entry.secondSegmentId);
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
  }

  private rollbackMergeSkeletonsPreview(
    entry: CatmaidOptimisticMergeSkeletonsEntry,
  ) {
    this.layer.spatialSkeletonState.replaceCachedSegmentSnapshots(
      [
        [entry.firstSegmentId, entry.firstSegmentNodes],
        [entry.secondSegmentId, entry.secondSegmentNodes],
      ],
      { notify: false },
    );
    ensureVisibleSegment(this.layer, entry.firstSegmentId);
    ensureVisibleSegment(this.layer, entry.secondSegmentId);
    this.layer.selectSpatialSkeletonNode(
      entry.secondNodeId,
      this.layer.manager.root.selectionState.pin.value,
      { segmentId: entry.secondSegmentId },
    );
    const skeletonLayer = skeletonLayerFromLayer(this.layer);
    skeletonLayer?.retainOverlaySegment(entry.firstSegmentId);
    skeletonLayer?.retainOverlaySegment(entry.secondSegmentId);
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    return true;
  }

  private removeRestoredDeletePreview(entry: CatmaidOptimisticDeleteNodeEntry) {
    applyDeleteNodeToCache(
      this.layer,
      entry.deleteContext,
      { moveView: false },
      entry.result?.nodeSourceStateUpdates,
    );
  }

  private rollbackEntryAndDependents(
    entry: CatmaidOptimisticEditEntry,
    status:
      | CatmaidOptimisticEditStatus.Failed
      | CatmaidOptimisticEditStatus.RolledBack,
  ) {
    const affectedEntries = new Set<CatmaidOptimisticEditEntry>();
    const visit = (currentEntry: CatmaidOptimisticEditEntry) => {
      if (affectedEntries.has(currentEntry)) return;
      affectedEntries.add(currentEntry);
      for (const candidate of this.entries) {
        if (this.isSettled(candidate)) {
          continue;
        }
        if (candidate.dependencies.includes(currentEntry.operationId)) {
          visit(candidate);
        }
      }
    };
    visit(entry);
    for (const affectedEntry of [...affectedEntries].reverse()) {
      this.clearInFlightWarning(affectedEntry);
      if (
        affectedEntry.status === CatmaidOptimisticEditStatus.InFlight ||
        affectedEntry.status === CatmaidOptimisticEditStatus.CancelRequested
      ) {
        this.rollbackPreview(affectedEntry);
        affectedEntry.status = CatmaidOptimisticEditStatus.CancelRequested;
        continue;
      }
      this.rollbackPreview(affectedEntry);
      affectedEntry.status = status;
    }
    this.notifyChanged();
  }

  private rollbackUnconfirmedDependents(
    entry: CatmaidOptimisticEditEntry,
    status:
      | CatmaidOptimisticEditStatus.Failed
      | CatmaidOptimisticEditStatus.RolledBack,
  ) {
    const affectedEntries = new Set<CatmaidOptimisticEditEntry>();
    const visit = (currentEntry: CatmaidOptimisticEditEntry) => {
      for (const candidate of this.entries) {
        if (
          this.isSettled(candidate) ||
          !candidate.dependencies.includes(currentEntry.operationId) ||
          affectedEntries.has(candidate)
        ) {
          continue;
        }
        affectedEntries.add(candidate);
        visit(candidate);
      }
    };
    visit(entry);
    for (const affectedEntry of [...affectedEntries].reverse()) {
      this.clearInFlightWarning(affectedEntry);
      if (
        affectedEntry.status === CatmaidOptimisticEditStatus.InFlight ||
        affectedEntry.status === CatmaidOptimisticEditStatus.CancelRequested
      ) {
        this.rollbackPreview(affectedEntry);
        affectedEntry.status = CatmaidOptimisticEditStatus.CancelRequested;
        continue;
      }
      this.rollbackPreview(affectedEntry);
      affectedEntry.status = status;
    }
    if (affectedEntries.size !== 0) {
      this.notifyChanged();
    }
  }

  private getActiveDependentEntries(entry: CatmaidOptimisticEditEntry) {
    const dependentIds = new Set<number>();
    const visit = (operationId: number) => {
      for (const candidate of this.entries) {
        if (
          this.isSettled(candidate) ||
          dependentIds.has(candidate.operationId) ||
          !candidate.dependencies.includes(operationId)
        ) {
          continue;
        }
        dependentIds.add(candidate.operationId);
        visit(candidate.operationId);
      }
    };
    visit(entry.operationId);
    return this.entries.filter((candidate) =>
      dependentIds.has(candidate.operationId),
    );
  }

  private suspendDependentPreviews(entry: CatmaidOptimisticEditEntry) {
    const dependents = this.getActiveDependentEntries(entry);
    for (const dependent of [...dependents].reverse()) {
      if (dependent.status === CatmaidOptimisticEditStatus.Pending) {
        this.rollbackPreview(dependent);
      }
    }
    return dependents;
  }

  private async reapplyDependentPreview(entry: CatmaidOptimisticEditEntry) {
    switch (entry.kind) {
      case "addNode": {
        const parentNode = this.layer.spatialSkeletonState.getCachedNode(
          entry.parentNodeId,
        );
        if (parentNode === undefined) {
          throw new Error(
            `Unable to reapply optimistic add below node ${entry.parentNodeId}.`,
          );
        }
        this.layer.spatialSkeletonState.upsertCachedNode({
          nodeId: entry.tempNodeId,
          segmentId: parentNode.segmentId,
          position: new Float32Array(entry.positionInModelSpace),
          parentNodeId: parentNode.nodeId,
          isTrueEnd: false,
        });
        this.layer.markSpatialSkeletonNodeDataChanged({
          invalidateFullSkeletonCache: false,
        });
        return;
      }
      case "moveNode": {
        const node = this.layer.spatialSkeletonState.getCachedNode(
          entry.nodeId,
        );
        if (node === undefined) {
          throw new Error(
            `Unable to reapply optimistic move for node ${entry.nodeId}.`,
          );
        }
        entry.segmentId = node.segmentId;
        entry.nodeForServer = cloneNodeSnapshot(node);
        entry.beforePositionInModelSpace = new Float32Array(node.position);
        this.layer.spatialSkeletonState.moveCachedNode(
          entry.nodeId,
          entry.afterPositionInModelSpace,
        );
        this.layer.markSpatialSkeletonNodeDataChanged({
          invalidateFullSkeletonCache: false,
        });
        return;
      }
      case "deleteNode": {
        const node = this.layer.spatialSkeletonState.getCachedNode(
          entry.nodeId,
        );
        if (node === undefined) {
          throw new Error(
            `Unable to reapply optimistic deletion for node ${entry.nodeId}.`,
          );
        }
        const segmentNodes =
          this.layer.spatialSkeletonState.getCachedSegmentNodes(node.segmentId);
        if (segmentNodes === undefined) {
          throw new Error(
            `Unable to reapply optimistic deletion in segment ${node.segmentId}.`,
          );
        }
        const parentNode = getSpatiallyIndexedSkeletonNodeParent(
          segmentNodes,
          node,
        );
        const childNodes = getSpatiallyIndexedSkeletonDirectChildren(
          segmentNodes,
          node.nodeId,
        );
        entry.segmentId = node.segmentId;
        entry.deleteContext = {
          node: cloneNodeSnapshot(node),
          parentNode:
            parentNode === undefined
              ? undefined
              : cloneNodeSnapshot(parentNode),
          childNodes: childNodes.map(cloneNodeSnapshot),
        };
        entry.segmentNodes = segmentNodes.map(cloneNodeSnapshot);
        entry.affectedPositions = collectUniqueNodePositions(
          [node],
          [parentNode],
          childNodes,
        );
        applyDeleteNodeToCache(
          this.layer,
          { node, parentNode, childNodes },
          { moveView: false },
          [],
        );
        return;
      }
      case "splitSkeleton": {
        const resolvedNode = await entry.command.resolveSplitContext();
        if (resolvedNode.node.parentNodeId === undefined) {
          throw new Error("Cannot reapply an optimistic split at a root node.");
        }
        entry.nodeId = resolvedNode.node.nodeId;
        entry.originalSegmentId = resolvedNode.node.segmentId;
        entry.formerParentNodeId = resolvedNode.node.parentNodeId;
        entry.originalSegmentNodes =
          resolvedNode.segmentNodes.map(cloneNodeSnapshot);
        entry.affectedPositions = collectUniqueNodePositions(
          getSplitAffectedNodes(resolvedNode),
        );
        this.applySplitSkeletonPreview(entry);
        return;
      }
      case "mergeSkeletons": {
        const { firstNode, secondNode } =
          await entry.command.resolveMergeContext(true);
        entry.firstNodeId = firstNode.node.nodeId;
        entry.secondNodeId = secondNode.node.nodeId;
        entry.firstSegmentId = firstNode.node.segmentId;
        entry.secondSegmentId = secondNode.node.segmentId;
        entry.previewResultSegmentId = firstNode.node.segmentId;
        entry.firstSegmentNodes = firstNode.segmentNodes.map(cloneNodeSnapshot);
        entry.secondSegmentNodes =
          secondNode.segmentNodes.map(cloneNodeSnapshot);
        entry.affectedPositions = collectUniqueNodePositions(
          entry.firstSegmentNodes,
          entry.secondSegmentNodes,
        );
        this.applyMergeSkeletonsPreview(entry);
        return;
      }
    }
  }

  private async restoreDependentPreviews(
    dependents: readonly CatmaidOptimisticEditEntry[],
  ) {
    for (let index = 0; index < dependents.length; ++index) {
      const dependent = dependents[index];
      if (dependent.status !== CatmaidOptimisticEditStatus.Pending) continue;
      try {
        await this.reapplyDependentPreview(dependent);
      } catch (error) {
        for (const affected of dependents.slice(index)) {
          if (affected.status === CatmaidOptimisticEditStatus.Pending) {
            affected.status = CatmaidOptimisticEditStatus.RolledBack;
          }
        }
        StatusMessage.showErrorMessage(
          `A queued skeleton edit could not be reapplied after CATMAID reconciled an earlier topology edit. Refresh the affected skeleton before continuing. ${formatErrorMessage(error)}`,
        );
        break;
      }
    }
  }

  async undoLatest() {
    const entry = [...this.entries]
      .reverse()
      .find(
        (candidate) =>
          candidate.status === CatmaidOptimisticEditStatus.Pending ||
          candidate.status === CatmaidOptimisticEditStatus.InFlight,
      );
    if (entry === undefined) {
      return false;
    }
    if (entry.status === CatmaidOptimisticEditStatus.InFlight) {
      entry.status = CatmaidOptimisticEditStatus.CancelRequested;
      this.rollbackEntryAndDependents(
        entry,
        CatmaidOptimisticEditStatus.RolledBack,
      );
      return true;
    }
    this.rollbackEntryAndDependents(
      entry,
      CatmaidOptimisticEditStatus.RolledBack,
    );
    if (this.pruneSettledEntries()) {
      this.notifyChanged();
    }
    return true;
  }

  async enqueueAddNode(
    command: AddNodeCommand,
    _context: SpatialSkeletonCommandContext,
    options: {
      moveView: boolean;
      pinSegment: boolean;
      statusPrefix: string;
    },
  ) {
    const { skeletonLayer, parentNode, segmentId } =
      await command.resolveAddNodeContext({ requireFullParent: false });
    if (parentNode === undefined) {
      throw new Error("Optimistic add-node requires a parent node.");
    }
    const tempNodeId = this.allocateTempId();
    const parentEntry = this.findEntryForTempNode(parentNode.nodeId);
    const dependencies = this.getActiveDependenciesForResources(
      [parentNode.nodeId],
      [segmentId],
    );
    if (
      parentEntry !== undefined &&
      !dependencies.includes(parentEntry.operationId)
    ) {
      dependencies.push(parentEntry.operationId);
    }
    const positionInModelSpace = command.getPositionInModelSpace();
    const entry: CatmaidOptimisticAddNodeEntry = {
      operationId: this.nextOperationId++,
      kind: "addNode",
      command,
      dependencies,
      tempNodeId,
      positionInModelSpace,
      parentNodeId: parentNode.nodeId,
      parentTempNodeId: parentEntry?.tempNodeId,
      status: CatmaidOptimisticEditStatus.Pending,
    };
    this.entries.push(entry);
    applyCreatedNodeToCache(
      this.layer,
      skeletonLayer,
      {
        nodeId: tempNodeId,
        segmentId,
      },
      parentNode.nodeId,
      positionInModelSpace,
      {
        focusSelection: true,
        moveView: options.moveView,
        pinSegment: options.pinSegment,
        retainOverlaySegment: true,
      },
    );
    this.notifyChanged();
    void this.drain();
  }

  async enqueueMoveNode(command: MoveNodeCommand) {
    const { node, skeletonLayer } = await command.resolveMoveContext();
    const dependencies = this.getActiveDependenciesForResources(
      [node.nodeId],
      [node.segmentId],
    );
    const beforePositionInModelSpace = command.getBeforePositionInModelSpace();
    const afterPositionInModelSpace = command.getAfterPositionInModelSpace();
    const entry: CatmaidOptimisticMoveNodeEntry = {
      operationId: this.nextOperationId++,
      kind: "moveNode",
      command,
      dependencies,
      nodeId: node.nodeId,
      segmentId: node.segmentId,
      nodeForServer: cloneNodeSnapshot(node),
      beforePositionInModelSpace,
      afterPositionInModelSpace,
      status: CatmaidOptimisticEditStatus.Pending,
    };
    this.entries.push(entry);
    skeletonLayer.retainOverlaySegment(node.segmentId);
    this.layer.spatialSkeletonState.moveCachedNode(
      node.nodeId,
      afterPositionInModelSpace,
    );
    if (
      this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId === node.nodeId
    ) {
      this.layer.selectSpatialSkeletonNode(
        node.nodeId,
        this.layer.manager.root.selectionState.pin.value,
        {
          segmentId: node.segmentId,
          position: afterPositionInModelSpace,
        },
      );
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    this.notifyChanged();
    void this.drain();
  }

  async enqueueDeleteNode(command: DeleteNodeCommand) {
    const { resolvedNode, deleteContext } =
      await command.resolveDeleteContext();
    const dependencies = this.getActiveDependenciesForResources(
      [
        deleteContext.node.nodeId,
        ...deleteContext.childNodes.map((child) => child.nodeId),
      ],
      [deleteContext.node.segmentId],
    );
    const entry: CatmaidOptimisticDeleteNodeEntry = {
      operationId: this.nextOperationId++,
      kind: "deleteNode",
      command,
      dependencies,
      nodeId: deleteContext.node.nodeId,
      segmentId: deleteContext.node.segmentId,
      deleteContext: {
        node: cloneNodeSnapshot(deleteContext.node),
        parentNode:
          deleteContext.parentNode === undefined
            ? undefined
            : cloneNodeSnapshot(deleteContext.parentNode),
        childNodes: deleteContext.childNodes.map(cloneNodeSnapshot),
      },
      segmentNodes: resolvedNode.segmentNodes.map(cloneNodeSnapshot),
      affectedPositions: collectUniqueNodePositions(
        [deleteContext.node],
        [deleteContext.parentNode],
        deleteContext.childNodes,
      ),
      status: CatmaidOptimisticEditStatus.Pending,
    };
    this.entries.push(entry);
    applyDeleteNodeToCache(this.layer, deleteContext, { moveView: true }, []);
    const remainingNodes =
      this.layer.spatialSkeletonState.getCachedSegmentNodes(
        deleteContext.node.segmentId,
      ) ?? [];
    if (remainingNodes.length > 0) {
      resolvedNode.skeletonLayer.retainOverlaySegment(
        deleteContext.node.segmentId,
      );
    } else {
      resolvedNode.skeletonLayer.markSegmentEdited(
        deleteContext.node.segmentId,
      );
    }
    this.notifyChanged();
    void this.drain();
  }

  async enqueueSplitSkeleton(command: SplitCommand) {
    const resolvedNode = await command.resolveSplitContext();
    const formerParentNodeId = resolvedNode.node.parentNodeId;
    if (formerParentNodeId === undefined) {
      throw new Error("Cannot split at the root node.");
    }
    const tempSegmentId = this.allocateTempSegmentId();
    const originalSegmentNodes =
      resolvedNode.segmentNodes.map(cloneNodeSnapshot);
    const entry: CatmaidOptimisticSplitSkeletonEntry = {
      operationId: this.nextOperationId++,
      kind: "splitSkeleton",
      command,
      dependencies: this.getActiveDependenciesForResources(
        originalSegmentNodes.map((node) => node.nodeId),
        [resolvedNode.node.segmentId],
      ),
      nodeId: resolvedNode.node.nodeId,
      originalSegmentId: resolvedNode.node.segmentId,
      tempSegmentId,
      formerParentNodeId,
      originalSegmentNodes,
      affectedPositions: collectUniqueNodePositions(
        getSplitAffectedNodes(resolvedNode),
      ),
      status: CatmaidOptimisticEditStatus.Pending,
    };
    this.entries.push(entry);
    this.applySplitSkeletonPreview(entry);
    this.notifyChanged();
    void this.drain();
  }

  async enqueueMergeSkeletons(command: MergeCommand) {
    const { firstNode, secondNode } = await command.resolveMergeContext(true);
    if (firstNode.node.segmentId === secondNode.node.segmentId) {
      throw new Error("Cannot merge nodes from the same skeleton.");
    }
    const firstSegmentNodes = firstNode.segmentNodes.map(cloneNodeSnapshot);
    const secondSegmentNodes = secondNode.segmentNodes.map(cloneNodeSnapshot);
    const entry: CatmaidOptimisticMergeSkeletonsEntry = {
      operationId: this.nextOperationId++,
      kind: "mergeSkeletons",
      command,
      dependencies: this.getActiveDependenciesForResources(
        [
          ...firstSegmentNodes.map((node) => node.nodeId),
          ...secondSegmentNodes.map((node) => node.nodeId),
        ],
        [firstNode.node.segmentId, secondNode.node.segmentId],
      ),
      firstNodeId: firstNode.node.nodeId,
      secondNodeId: secondNode.node.nodeId,
      firstSegmentId: firstNode.node.segmentId,
      secondSegmentId: secondNode.node.segmentId,
      previewResultSegmentId: firstNode.node.segmentId,
      firstSegmentNodes,
      secondSegmentNodes,
      affectedPositions: collectUniqueNodePositions(
        firstSegmentNodes,
        secondSegmentNodes,
      ),
      status: CatmaidOptimisticEditStatus.Pending,
    };
    this.entries.push(entry);
    this.applyMergeSkeletonsPreview(entry);
    this.notifyChanged();
    void this.drain();
  }

  private scheduleTopologyRefresh(
    segmentIds: Iterable<number | undefined>,
    positions: Iterable<ArrayLike<number>>,
  ) {
    for (const segmentId of segmentIds) {
      const normalized = normalizePositiveSegmentId(segmentId);
      if (normalized !== undefined) {
        this.topologyRefreshSegmentIds.add(normalized);
      }
    }
    this.topologyRefreshPositions.push(...positions);
  }

  private async refreshReconciledTopology() {
    if (
      this.disposed ||
      this.topologyRefreshSegmentIds.size === 0 ||
      this.entries.some(
        (entry) =>
          entry.status === CatmaidOptimisticEditStatus.Pending ||
          entry.status === CatmaidOptimisticEditStatus.InFlight ||
          entry.status === CatmaidOptimisticEditStatus.CancelRequested,
      )
    ) {
      return;
    }
    const segmentIds = [...this.topologyRefreshSegmentIds];
    const positions = this.topologyRefreshPositions;
    this.topologyRefreshSegmentIds.clear();
    this.topologyRefreshPositions = [];
    this.reconcilingTopology = true;
    this.notifyChanged();
    try {
      await refreshTopologySegments(this.layer, segmentIds, positions, {
        // Optimistic topology previews keep authoritative full-skeleton overlays
        // for the edited segments. Their stale browse-pass copies are excluded,
        // so deleting shared spatial cells here would only hide unrelated
        // skeletons while CATMAID reloads those cells.
        invalidateSourceCells: false,
      });
    } finally {
      this.reconcilingTopology = false;
      this.notifyChanged();
    }
  }

  private async drain() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (!this.disposed) {
        const entry = this.entries.find(
          (candidate) =>
            candidate.status === CatmaidOptimisticEditStatus.Pending &&
            candidate.dependencies.every((operationId) =>
              this.isDependencyCommitted(operationId),
            ),
        );
        if (entry === undefined) {
          break;
        }
        await this.confirmEntry(entry);
        this.pruneSettledEntries();
      }
      await this.refreshReconciledTopology();
    } finally {
      this.draining = false;
      this.notifyChanged();
    }
  }

  private async confirmEntry(entry: CatmaidOptimisticEditEntry) {
    entry.status = CatmaidOptimisticEditStatus.InFlight;
    this.startInFlightWarning(entry);
    this.notifyChanged();
    try {
      switch (entry.kind) {
        case "addNode":
          await this.confirmAddNodeEntry(entry);
          return;
        case "moveNode":
          await this.confirmMoveNodeEntry(entry);
          return;
        case "deleteNode":
          await this.confirmDeleteNodeEntry(entry);
          return;
        case "splitSkeleton":
          await this.confirmSplitSkeletonEntry(entry);
          return;
        case "mergeSkeletons":
          await this.confirmMergeSkeletonsEntry(entry);
          return;
      }
    } finally {
      this.clearInFlightWarning(entry);
      this.pruneSettledEntries();
      this.notifyChanged();
    }
  }

  private async confirmAddNodeEntry(entry: CatmaidOptimisticAddNodeEntry) {
    try {
      const resolvedContext = await entry.command.resolveAddNodeContext({
        requireFullParent: false,
      });
      if (resolvedContext.parentNode === undefined) {
        throw new Error("Optimistic add-node requires a parent node.");
      }
      entry.parentNodeForServer = resolvedContext.parentNode;
      const result = await this.editOperations.commitAddNode({
        segmentId: resolvedContext.segmentId,
        position: entry.positionInModelSpace,
        parentNode: resolvedContext.parentNode,
        nocheck: true,
      });
      entry.result = result;
      if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
        await this.compensateCanceledAddCommit(entry, result);
        entry.status = CatmaidOptimisticEditStatus.RolledBack;
        return;
      }
      await this.reconcileCommittedAddEntry(
        entry,
        resolvedContext.skeletonLayer,
        resolvedContext.parentNode,
        result,
      );
    } catch (error) {
      if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
        entry.status = CatmaidOptimisticEditStatus.RolledBack;
        return;
      }
      entry.status = CatmaidOptimisticEditStatus.Failed;
      this.rollbackEntryAndDependents(
        entry,
        CatmaidOptimisticEditStatus.Failed,
      );
      StatusMessage.showErrorMessage(
        `CATMAID rejected node creation. The optimistic preview was removed. ${formatErrorMessage(error)}`,
      );
    } finally {
      this.notifyChanged();
    }
  }

  private async confirmMoveNodeEntry(entry: CatmaidOptimisticMoveNodeEntry) {
    try {
      const result = await this.editOperations.commitMoveNode({
        node: entry.nodeForServer,
        position: entry.afterPositionInModelSpace,
        nocheck: true,
      });
      entry.result = result;
      if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
        await this.compensateCanceledMoveCommit(entry, result);
        entry.status = CatmaidOptimisticEditStatus.RolledBack;
        return;
      }
      this.reconcileCommittedMoveEntry(entry, result);
      entry.status = CatmaidOptimisticEditStatus.Committed;
      await this.layer.spatialSkeletonState.commandHistory.recordExecuted(
        entry.command,
      );
    } catch (error) {
      if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
        entry.status = CatmaidOptimisticEditStatus.RolledBack;
        return;
      }
      entry.status = CatmaidOptimisticEditStatus.Failed;
      this.rollbackEntryAndDependents(
        entry,
        CatmaidOptimisticEditStatus.Failed,
      );
      StatusMessage.showErrorMessage(
        `CATMAID rejected node movement. The optimistic preview was removed. ${formatErrorMessage(error)}`,
      );
    } finally {
      this.notifyChanged();
    }
  }

  private async confirmDeleteNodeEntry(
    entry: CatmaidOptimisticDeleteNodeEntry,
  ) {
    try {
      const result = await this.editOperations.commitDeleteNode({
        node: entry.deleteContext.node,
        childNodes: entry.deleteContext.childNodes,
        segmentNodes: entry.segmentNodes,
        nocheck: true,
      });
      entry.result = result;
      if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
        await this.compensateCanceledDeleteCommit(entry, result);
        entry.status = CatmaidOptimisticEditStatus.RolledBack;
        return;
      }
      this.reconcileCommittedDeleteEntry(entry, result);
      entry.status = CatmaidOptimisticEditStatus.Committed;
      await this.layer.spatialSkeletonState.commandHistory.recordExecuted(
        entry.command,
      );
    } catch (error) {
      if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
        entry.status = CatmaidOptimisticEditStatus.RolledBack;
        return;
      }
      entry.status = CatmaidOptimisticEditStatus.Failed;
      this.rollbackEntryAndDependents(
        entry,
        CatmaidOptimisticEditStatus.Failed,
      );
      StatusMessage.showErrorMessage(
        `CATMAID rejected node deletion. The optimistic preview was removed. ${formatErrorMessage(error)}`,
      );
    } finally {
      this.notifyChanged();
    }
  }

  private async confirmSplitSkeletonEntry(
    entry: CatmaidOptimisticSplitSkeletonEntry,
  ) {
    let result: CatmaidSpatialSkeletonSplitResult;
    try {
      const resolvedNode = await entry.command.resolveSplitContext();
      result = await this.editOperations.commitSplit({
        node: resolvedNode.node,
        segmentNodes: resolvedNode.segmentNodes,
        nocheck: true,
      });
      entry.result = result;
    } catch (error) {
      if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
        entry.status = CatmaidOptimisticEditStatus.RolledBack;
        return;
      }
      entry.status = CatmaidOptimisticEditStatus.Failed;
      this.rollbackEntryAndDependents(
        entry,
        CatmaidOptimisticEditStatus.Failed,
      );
      StatusMessage.showErrorMessage(
        `CATMAID rejected skeleton splitting. The optimistic preview was removed. ${formatErrorMessage(error)}`,
      );
      return;
    }

    if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
      await this.compensateCanceledSplitCommit(entry, result);
      entry.status = CatmaidOptimisticEditStatus.RolledBack;
      return;
    }

    entry.command.markOptimisticCommit(
      entry.tempSegmentId,
      result,
      entry.originalSegmentId,
    );
    try {
      await this.reconcileCommittedSplitEntry(entry, result);
    } catch (error) {
      this.rollbackUnconfirmedDependents(
        entry,
        CatmaidOptimisticEditStatus.RolledBack,
      );
      await refreshTopologySegments(
        this.layer,
        [
          result.existingSegmentId ?? entry.originalSegmentId,
          result.newSegmentId ?? entry.tempSegmentId,
        ],
        entry.affectedPositions,
      );
      StatusMessage.showErrorMessage(
        `CATMAID split the skeleton, but optimistic reconciliation failed. The affected skeletons were refreshed. ${formatErrorMessage(error)}`,
      );
    }
    entry.status = CatmaidOptimisticEditStatus.Committed;
    await this.layer.spatialSkeletonState.commandHistory.recordExecuted(
      entry.command,
    );
  }

  private async confirmMergeSkeletonsEntry(
    entry: CatmaidOptimisticMergeSkeletonsEntry,
  ) {
    let result: CatmaidSpatialSkeletonMergeResult;
    try {
      const { firstNode, secondNode } =
        await entry.command.resolveMergeContext(true);
      result = await this.editOperations.commitMerge({
        fromNode: firstNode.node,
        toNode: secondNode.node,
        nocheck: true,
      });
      entry.result = result;
    } catch (error) {
      if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
        entry.status = CatmaidOptimisticEditStatus.RolledBack;
        return;
      }
      entry.status = CatmaidOptimisticEditStatus.Failed;
      this.rollbackEntryAndDependents(
        entry,
        CatmaidOptimisticEditStatus.Failed,
      );
      StatusMessage.showErrorMessage(
        `CATMAID rejected skeleton merging. The optimistic preview was removed. ${formatErrorMessage(error)}`,
      );
      return;
    }

    if (entry.status === CatmaidOptimisticEditStatus.CancelRequested) {
      await this.compensateCanceledMergeCommit(entry, result);
      entry.status = CatmaidOptimisticEditStatus.RolledBack;
      return;
    }

    const firstContext: ResolvedSpatialSkeletonEditNode = {
      skeletonLayer: getEditableSkeletonSourceForLayer(this.layer)
        .skeletonLayer,
      segmentNodes: entry.firstSegmentNodes,
      node:
        findSpatiallyIndexedSkeletonNode(
          entry.firstSegmentNodes,
          entry.firstNodeId,
        ) ?? entry.firstSegmentNodes[0],
    };
    const secondContext: ResolvedSpatialSkeletonEditNode = {
      skeletonLayer: firstContext.skeletonLayer,
      segmentNodes: entry.secondSegmentNodes,
      node:
        findSpatiallyIndexedSkeletonNode(
          entry.secondSegmentNodes,
          entry.secondNodeId,
        ) ?? entry.secondSegmentNodes[0],
    };
    entry.command.markOptimisticCommit(firstContext, secondContext, result);
    try {
      await this.reconcileCommittedMergeEntry(entry, result);
    } catch (error) {
      this.rollbackUnconfirmedDependents(
        entry,
        CatmaidOptimisticEditStatus.RolledBack,
      );
      await refreshTopologySegments(
        this.layer,
        [
          result.resultSegmentId ?? entry.firstSegmentId,
          result.deletedSegmentId ?? entry.secondSegmentId,
        ],
        entry.affectedPositions,
      );
      StatusMessage.showErrorMessage(
        `CATMAID merged the skeletons, but optimistic reconciliation failed. The affected skeletons were refreshed. ${formatErrorMessage(error)}`,
      );
    }
    entry.status = CatmaidOptimisticEditStatus.Committed;
    await this.layer.spatialSkeletonState.commandHistory.recordExecuted(
      entry.command,
    );
  }

  private async reconcileCommittedAddEntry(
    entry: CatmaidOptimisticAddNodeEntry,
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    parentNode: SpatiallyIndexedSkeletonNode,
    result: CatmaidSpatialSkeletonAddNodeResult,
  ) {
    const wasSelected =
      this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId ===
      entry.tempNodeId;
    const expectedSegmentId = parentNode.segmentId;
    const previewNode = this.layer.spatialSkeletonState.getCachedNode(
      entry.tempNodeId,
    );
    const previewRemovedByDelete =
      previewNode === undefined && this.hasActiveDeleteDependent(entry);
    if (
      previewNode !== undefined &&
      !this.previewAddNodeMatchesEntry(entry, previewNode, expectedSegmentId)
    ) {
      this.handlePreviewCollision(
        entry,
        previewNode,
        expectedSegmentId,
        result,
      );
      entry.status = CatmaidOptimisticEditStatus.Failed;
      this.rollbackUnconfirmedDependents(
        entry,
        CatmaidOptimisticEditStatus.RolledBack,
      );
      return;
    }
    if (previewNode === undefined && !previewRemovedByDelete) {
      this.handlePreviewCollision(
        entry,
        previewNode,
        expectedSegmentId,
        result,
      );
      entry.status = CatmaidOptimisticEditStatus.Failed;
      this.rollbackUnconfirmedDependents(
        entry,
        CatmaidOptimisticEditStatus.RolledBack,
      );
      return;
    }
    this.layer.spatialSkeletonState.commandHistory.mappings.remapNodeId(
      entry.tempNodeId,
      result.nodeId,
    );
    entry.command.markOptimisticCommit(entry.tempNodeId, result.segmentId);
    if (result.parentSourceState !== undefined) {
      this.layer.spatialSkeletonState.setCachedNodeSourceState(
        parentNode.nodeId,
        result.parentSourceState,
      );
    }
    const committedNodeSnapshot: SpatiallyIndexedSkeletonNode = {
      nodeId: result.nodeId,
      segmentId: previewNode?.segmentId ?? result.segmentId,
      position: new Float32Array(
        previewNode?.position ?? entry.positionInModelSpace,
      ),
      parentNodeId: previewNode?.parentNodeId ?? parentNode.nodeId,
      isTrueEnd: false,
      ...(result.sourceState === undefined
        ? {}
        : { sourceState: result.sourceState }),
    };
    this.remapPendingEntriesForCommittedAdd(
      entry,
      parentNode,
      committedNodeSnapshot,
    );
    if (previewNode !== undefined) {
      const previewSegmentNodes =
        this.layer.spatialSkeletonState.getCachedSegmentNodes(
          previewNode.segmentId,
        ) ?? [];
      const remappedSegmentNodes = previewSegmentNodes.map((node) => ({
        ...(node.nodeId === entry.tempNodeId
          ? committedNodeSnapshot
          : cloneNodeSnapshot(node)),
        parentNodeId:
          node.parentNodeId === entry.tempNodeId
            ? result.nodeId
            : node.parentNodeId,
      }));
      this.layer.spatialSkeletonState.replaceCachedSegmentSnapshots(
        [[previewNode.segmentId, remappedSegmentNodes]],
        { notify: false },
      );
      if (wasSelected) {
        this.layer.selectSpatialSkeletonNode(
          result.nodeId,
          this.layer.manager.root.selectionState.pin.value,
          {
            segmentId: previewNode.segmentId,
            position: committedNodeSnapshot.position,
          },
        );
      }
      skeletonLayer.retainOverlaySegment(previewNode.segmentId);
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    entry.status = CatmaidOptimisticEditStatus.Committed;
    await this.layer.spatialSkeletonState.commandHistory.recordExecuted(
      entry.command,
    );
  }

  private remapPendingEntriesForCommittedAdd(
    entry: CatmaidOptimisticAddNodeEntry,
    parentNode: SpatiallyIndexedSkeletonNode,
    committedNode: SpatiallyIndexedSkeletonNode,
  ) {
    const remapNode = (node: SpatiallyIndexedSkeletonNode) => {
      if (node.nodeId === entry.tempNodeId) {
        return {
          ...node,
          nodeId: committedNode.nodeId,
          segmentId: committedNode.segmentId,
          parentNodeId: committedNode.parentNodeId,
          sourceState: committedNode.sourceState,
        };
      }
      if (node.parentNodeId === entry.tempNodeId) {
        return { ...node, parentNodeId: committedNode.nodeId };
      }
      return node;
    };
    for (const dependentEntry of this.entries) {
      if (
        this.isSettled(dependentEntry) ||
        dependentEntry.operationId === entry.operationId
      ) {
        continue;
      }
      switch (dependentEntry.kind) {
        case "addNode":
          if (dependentEntry.parentTempNodeId === entry.tempNodeId) {
            dependentEntry.parentNodeId = committedNode.nodeId;
            this.layer.spatialSkeletonState.setCachedNodeParent(
              dependentEntry.tempNodeId,
              committedNode.nodeId,
            );
          }
          break;
        case "moveNode":
          if (dependentEntry.nodeId === entry.tempNodeId) {
            dependentEntry.nodeId = committedNode.nodeId;
            dependentEntry.segmentId = committedNode.segmentId;
            dependentEntry.nodeForServer = {
              ...dependentEntry.nodeForServer,
              nodeId: committedNode.nodeId,
              segmentId: committedNode.segmentId,
              parentNodeId: parentNode.nodeId,
              sourceState: committedNode.sourceState,
            };
          }
          break;
        case "deleteNode":
          this.remapDeleteEntryNode(
            dependentEntry,
            entry.tempNodeId,
            committedNode,
          );
          break;
        case "splitSkeleton":
          if (dependentEntry.nodeId === entry.tempNodeId) {
            dependentEntry.nodeId = committedNode.nodeId;
          }
          if (dependentEntry.formerParentNodeId === entry.tempNodeId) {
            dependentEntry.formerParentNodeId = committedNode.nodeId;
          }
          dependentEntry.originalSegmentNodes =
            dependentEntry.originalSegmentNodes.map(remapNode);
          break;
        case "mergeSkeletons":
          if (dependentEntry.firstNodeId === entry.tempNodeId) {
            dependentEntry.firstNodeId = committedNode.nodeId;
          }
          if (dependentEntry.secondNodeId === entry.tempNodeId) {
            dependentEntry.secondNodeId = committedNode.nodeId;
          }
          dependentEntry.firstSegmentNodes =
            dependentEntry.firstSegmentNodes.map(remapNode);
          dependentEntry.secondSegmentNodes =
            dependentEntry.secondSegmentNodes.map(remapNode);
          break;
      }
    }
  }

  private remapDeleteEntryNode(
    entry: CatmaidOptimisticDeleteNodeEntry,
    tempNodeId: number,
    committedNode: SpatiallyIndexedSkeletonNode,
  ) {
    const remapNode = (node: SpatiallyIndexedSkeletonNode) => {
      if (node.nodeId === tempNodeId) {
        return {
          ...node,
          nodeId: committedNode.nodeId,
          segmentId: committedNode.segmentId,
          parentNodeId: committedNode.parentNodeId,
          sourceState: committedNode.sourceState,
        };
      }
      if (node.parentNodeId === tempNodeId) {
        return {
          ...node,
          parentNodeId: committedNode.nodeId,
        };
      }
      return node;
    };
    entry.deleteContext = {
      node: remapNode(entry.deleteContext.node),
      parentNode:
        entry.deleteContext.parentNode === undefined
          ? undefined
          : remapNode(entry.deleteContext.parentNode),
      childNodes: entry.deleteContext.childNodes.map(remapNode),
    };
    entry.segmentNodes = entry.segmentNodes.map(remapNode);
    if (entry.nodeId === tempNodeId) {
      entry.nodeId = committedNode.nodeId;
      entry.segmentId = committedNode.segmentId;
    }
  }

  private reconcileCommittedMoveEntry(
    entry: CatmaidOptimisticMoveNodeEntry,
    result: CatmaidSpatialSkeletonNodeSourceStateResult,
  ) {
    if (this.layer.spatialSkeletonState.getCachedNode(entry.nodeId)) {
      const hasNewerMovePreview = this.entries.some(
        (candidate) =>
          candidate.kind === "moveNode" &&
          candidate.nodeId === entry.nodeId &&
          candidate.operationId > entry.operationId &&
          this.isActive(candidate),
      );
      if (!hasNewerMovePreview) {
        this.layer.spatialSkeletonState.moveCachedNode(
          entry.nodeId,
          entry.afterPositionInModelSpace,
        );
      }
      if (result.sourceState !== undefined) {
        this.layer.spatialSkeletonState.setCachedNodeSourceState(
          entry.nodeId,
          result.sourceState,
        );
      }
      this.layer.markSpatialSkeletonNodeDataChanged({
        invalidateFullSkeletonCache: false,
      });
    }
  }

  private reconcileCommittedDeleteEntry(
    entry: CatmaidOptimisticDeleteNodeEntry,
    result: CatmaidSpatialSkeletonDeleteNodeResult,
  ) {
    if (result.nodeSourceStateUpdates?.length) {
      this.layer.spatialSkeletonState.setCachedNodeSourceStates(
        result.nodeSourceStateUpdates,
      );
      this.layer.markSpatialSkeletonNodeDataChanged({
        invalidateFullSkeletonCache: false,
      });
    }
    skeletonLayerFromLayer(this.layer)?.invalidateSourceCellsForPositions(
      entry.affectedPositions,
    );
  }

  private remapPendingSegmentReferences(
    remappings: ReadonlyMap<number, number>,
    excludedOperationId?: number,
  ) {
    const remapSegmentId = (segmentId: number) =>
      remappings.get(segmentId) ?? segmentId;
    const remapNode = (node: SpatiallyIndexedSkeletonNode) => ({
      ...node,
      segmentId: remapSegmentId(node.segmentId),
    });
    for (const candidate of this.entries) {
      if (
        this.isSettled(candidate) ||
        candidate.operationId === excludedOperationId
      ) {
        continue;
      }
      switch (candidate.kind) {
        case "addNode":
          if (candidate.parentNodeForServer !== undefined) {
            candidate.parentNodeForServer = remapNode(
              candidate.parentNodeForServer,
            );
          }
          break;
        case "moveNode":
          candidate.segmentId = remapSegmentId(candidate.segmentId);
          candidate.nodeForServer = remapNode(candidate.nodeForServer);
          break;
        case "deleteNode":
          candidate.segmentId = remapSegmentId(candidate.segmentId);
          candidate.deleteContext = {
            node: remapNode(candidate.deleteContext.node),
            parentNode:
              candidate.deleteContext.parentNode === undefined
                ? undefined
                : remapNode(candidate.deleteContext.parentNode),
            childNodes: candidate.deleteContext.childNodes.map(remapNode),
          };
          candidate.segmentNodes = candidate.segmentNodes.map(remapNode);
          break;
        case "splitSkeleton":
          candidate.originalSegmentId = remapSegmentId(
            candidate.originalSegmentId,
          );
          candidate.tempSegmentId = remapSegmentId(candidate.tempSegmentId);
          candidate.originalSegmentNodes =
            candidate.originalSegmentNodes.map(remapNode);
          break;
        case "mergeSkeletons":
          candidate.firstSegmentId = remapSegmentId(candidate.firstSegmentId);
          candidate.secondSegmentId = remapSegmentId(candidate.secondSegmentId);
          candidate.previewResultSegmentId = remapSegmentId(
            candidate.previewResultSegmentId,
          );
          candidate.firstSegmentNodes =
            candidate.firstSegmentNodes.map(remapNode);
          candidate.secondSegmentNodes =
            candidate.secondSegmentNodes.map(remapNode);
          break;
      }
    }
  }

  private async reconcileCommittedSplitEntry(
    entry: CatmaidOptimisticSplitSkeletonEntry,
    result: CatmaidSpatialSkeletonSplitResult,
  ) {
    const newSegmentId = result.newSegmentId;
    if (newSegmentId === undefined) {
      throw new Error("CATMAID split response omitted the new skeleton id.");
    }
    const existingSegmentId =
      result.existingSegmentId ?? entry.originalSegmentId;
    const dependents = this.suspendDependentPreviews(entry);
    const upstreamNodes =
      this.layer.spatialSkeletonState.getCachedSegmentNodes(
        entry.originalSegmentId,
      ) ?? [];
    const downstreamNodes =
      this.layer.spatialSkeletonState.getCachedSegmentNodes(
        entry.tempSegmentId,
      ) ?? [];
    const replacements = new Map<
      number,
      readonly SpatiallyIndexedSkeletonNode[] | undefined
    >();
    replacements.set(entry.originalSegmentId, undefined);
    replacements.set(entry.tempSegmentId, undefined);
    replacements.set(existingSegmentId, upstreamNodes);
    replacements.set(newSegmentId, downstreamNodes);
    this.layer.spatialSkeletonState.replaceCachedSegmentSnapshots(
      replacements,
      { notify: false },
    );
    this.remapPendingSegmentReferences(
      new Map([
        [entry.originalSegmentId, existingSegmentId],
        [entry.tempSegmentId, newSegmentId],
      ]),
      entry.operationId,
    );
    removeVisibleSegment(this.layer, entry.tempSegmentId, { deselect: true });
    ensureVisibleSegment(this.layer, existingSegmentId);
    ensureVisibleSegment(this.layer, newSegmentId);
    selectSegment(this.layer, newSegmentId, true);
    this.layer.selectSpatialSkeletonNode(
      entry.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      { segmentId: newSegmentId },
    );
    const skeletonLayer = skeletonLayerFromLayer(this.layer);
    skeletonLayer?.retainOverlaySegment(existingSegmentId);
    skeletonLayer?.retainOverlaySegment(newSegmentId);
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    this.scheduleTopologyRefresh(
      [existingSegmentId, newSegmentId],
      entry.affectedPositions,
    );
    await this.restoreDependentPreviews(dependents);
  }

  private async reconcileCommittedMergeEntry(
    entry: CatmaidOptimisticMergeSkeletonsEntry,
    result: CatmaidSpatialSkeletonMergeResult,
  ) {
    const secondWins = result.resultSegmentId === entry.secondSegmentId;
    const winnerNodes = secondWins
      ? entry.secondSegmentNodes
      : entry.firstSegmentNodes;
    const loserNodes = secondWins
      ? entry.firstSegmentNodes
      : entry.secondSegmentNodes;
    const winnerNodeId = secondWins ? entry.secondNodeId : entry.firstNodeId;
    const loserNodeId = secondWins ? entry.firstNodeId : entry.secondNodeId;
    const fallbackResultSegmentId = secondWins
      ? entry.secondSegmentId
      : entry.firstSegmentId;
    const fallbackDeletedSegmentId = secondWins
      ? entry.firstSegmentId
      : entry.secondSegmentId;
    const resultSegmentId = result.resultSegmentId ?? fallbackResultSegmentId;
    const deletedSegmentId =
      result.deletedSegmentId ?? fallbackDeletedSegmentId;
    const dependents = this.suspendDependentPreviews(entry);
    const rerootedLoserNodes = rerootSegmentNodeSnapshots(
      loserNodes,
      loserNodeId,
    ).map((node) => ({
      ...node,
      segmentId: resultSegmentId,
      parentNodeId:
        node.nodeId === loserNodeId ? winnerNodeId : node.parentNodeId,
    }));
    const mergedNodes = [
      ...winnerNodes.map((node) => ({
        ...cloneNodeSnapshot(node),
        segmentId: resultSegmentId,
      })),
      ...rerootedLoserNodes,
    ];
    const replacements = new Map<
      number,
      readonly SpatiallyIndexedSkeletonNode[] | undefined
    >();
    replacements.set(entry.firstSegmentId, undefined);
    replacements.set(entry.secondSegmentId, undefined);
    replacements.set(resultSegmentId, mergedNodes);
    this.layer.spatialSkeletonState.replaceCachedSegmentSnapshots(
      replacements,
      { notify: false },
    );
    const segmentRemappings = new Map([
      [entry.firstSegmentId, resultSegmentId],
      [entry.secondSegmentId, resultSegmentId],
    ]);
    this.remapPendingSegmentReferences(segmentRemappings, entry.operationId);
    const mappings = this.layer.spatialSkeletonState.commandHistory.mappings;
    mappings.remapSegmentId(entry.firstSegmentId, resultSegmentId);
    mappings.remapSegmentId(entry.secondSegmentId, resultSegmentId);
    ensureVisibleSegment(this.layer, resultSegmentId);
    removeVisibleSegment(this.layer, deletedSegmentId, { deselect: true });
    selectSegment(this.layer, resultSegmentId, false);
    this.layer.selectSpatialSkeletonNode(
      loserNodeId,
      this.layer.manager.root.selectionState.pin.value,
      { segmentId: resultSegmentId },
    );
    const skeletonLayer = skeletonLayerFromLayer(this.layer);
    skeletonLayer?.markSegmentEdited(deletedSegmentId);
    skeletonLayer?.retainOverlaySegment(resultSegmentId);
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    this.scheduleTopologyRefresh(
      [resultSegmentId, deletedSegmentId],
      entry.affectedPositions,
    );
    await this.restoreDependentPreviews(dependents);
  }

  private async compensateCanceledSplitCommit(
    entry: CatmaidOptimisticSplitSkeletonEntry,
    result: CatmaidSpatialSkeletonSplitResult,
  ) {
    const existingSegmentId =
      result.existingSegmentId ?? entry.originalSegmentId;
    const newSegmentId = result.newSegmentId;
    const formerParent = findSpatiallyIndexedSkeletonNode(
      entry.originalSegmentNodes,
      entry.formerParentNodeId,
    );
    const splitNode = findSpatiallyIndexedSkeletonNode(
      entry.originalSegmentNodes,
      entry.nodeId,
    );
    try {
      if (
        newSegmentId === undefined ||
        formerParent === undefined ||
        splitNode === undefined
      ) {
        throw new Error(
          "Canceled split compensation is missing topology data.",
        );
      }
      const mergeResult = await this.editOperations.commitMerge({
        fromNode: { ...formerParent, segmentId: existingSegmentId },
        toNode: {
          ...splitNode,
          segmentId: newSegmentId,
          parentNodeId: undefined,
        },
        nocheck: true,
      });
      if (!this.disposed) {
        this.scheduleTopologyRefresh(
          [
            mergeResult.resultSegmentId ?? existingSegmentId,
            mergeResult.deletedSegmentId ?? newSegmentId,
          ],
          entry.affectedPositions,
        );
      }
    } catch (error) {
      if (!this.disposed) {
        await refreshTopologySegments(
          this.layer,
          [existingSegmentId, newSegmentId ?? entry.tempSegmentId],
          entry.affectedPositions,
        );
      }
      StatusMessage.showErrorMessage(
        `CATMAID split a skeleton after its optimistic preview was canceled, and automatic merge-back failed. Refresh the skeleton to sync. ${formatErrorMessage(error)}`,
      );
    }
  }

  private async compensateCanceledMergeCommit(
    entry: CatmaidOptimisticMergeSkeletonsEntry,
    result: CatmaidSpatialSkeletonMergeResult,
  ) {
    const secondWins = result.resultSegmentId === entry.secondSegmentId;
    const winnerSegmentId =
      result.resultSegmentId ??
      (secondWins ? entry.secondSegmentId : entry.firstSegmentId);
    const loserSegmentId = secondWins
      ? entry.firstSegmentId
      : entry.secondSegmentId;
    const loserNodeId = secondWins ? entry.firstNodeId : entry.secondNodeId;
    const loserNodes = secondWins
      ? entry.firstSegmentNodes
      : entry.secondSegmentNodes;
    const loserNode = findSpatiallyIndexedSkeletonNode(loserNodes, loserNodeId);
    try {
      if (loserNode === undefined) {
        throw new Error(
          "Canceled merge compensation is missing its split node.",
        );
      }
      const mergedServerNodes = rerootSegmentNodeSnapshots(
        loserNodes,
        loserNodeId,
      ).map((node) => ({ ...node, segmentId: winnerSegmentId }));
      const splitResult = await this.editOperations.commitSplit({
        node: {
          ...loserNode,
          segmentId: winnerSegmentId,
        },
        segmentNodes: mergedServerNodes,
        nocheck: true,
      });
      const restoredSegmentId = splitResult.newSegmentId;
      if (restoredSegmentId === undefined) {
        throw new Error(
          "Canceled merge compensation did not return a restored skeleton id.",
        );
      }
      const originalRoot = findRootNode(loserNodes);
      if (originalRoot !== undefined && originalRoot.nodeId !== loserNodeId) {
        const splitSideNodes = rerootSegmentNodeSnapshots(
          loserNodes,
          loserNodeId,
        ).map((node) => ({ ...node, segmentId: restoredSegmentId }));
        const rootForReroot = findSpatiallyIndexedSkeletonNode(
          splitSideNodes,
          originalRoot.nodeId,
        );
        if (rootForReroot === undefined) {
          throw new Error(
            "Canceled merge compensation is missing its original root.",
          );
        }
        await this.editOperations.commitReroot({
          node: rootForReroot,
          segmentNodes: splitSideNodes,
          nocheck: true,
        });
      }
      if (!this.disposed) {
        const restoredNodes = loserNodes.map((node) => ({
          ...cloneNodeSnapshot(node),
          segmentId: restoredSegmentId,
        }));
        this.layer.spatialSkeletonState.replaceCachedSegmentSnapshots(
          [
            [loserSegmentId, undefined],
            [restoredSegmentId, restoredNodes],
          ],
          { notify: false },
        );
        this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
          loserSegmentId,
          restoredSegmentId,
        );
        removeVisibleSegment(this.layer, loserSegmentId, { deselect: true });
        ensureVisibleSegment(this.layer, restoredSegmentId);
        this.layer.markSpatialSkeletonNodeDataChanged({
          invalidateFullSkeletonCache: false,
        });
        this.scheduleTopologyRefresh(
          [splitResult.existingSegmentId ?? winnerSegmentId, restoredSegmentId],
          entry.affectedPositions,
        );
      }
    } catch (error) {
      if (!this.disposed) {
        await refreshTopologySegments(
          this.layer,
          [winnerSegmentId, loserSegmentId],
          entry.affectedPositions,
        );
      }
      StatusMessage.showErrorMessage(
        `CATMAID merged skeletons after their optimistic preview was canceled, and automatic split-back failed. Refresh the skeleton to sync. ${formatErrorMessage(error)}`,
      );
    }
  }

  private async compensateCanceledAddCommit(
    entry: CatmaidOptimisticAddNodeEntry,
    result: CatmaidSpatialSkeletonAddNodeResult,
  ) {
    const parentNode =
      entry.parentNodeForServer === undefined ||
      result.parentSourceState === undefined
        ? entry.parentNodeForServer
        : {
            ...entry.parentNodeForServer,
            sourceState: result.parentSourceState,
          };
    const createdNode: SpatiallyIndexedSkeletonNode = {
      nodeId: result.nodeId,
      segmentId: result.segmentId,
      position: new Float32Array(entry.positionInModelSpace),
      parentNodeId: parentNode?.nodeId,
      isTrueEnd: false,
      ...(result.sourceState === undefined
        ? {}
        : { sourceState: result.sourceState }),
    };
    try {
      const deleteResult = await this.editOperations.commitDeleteNode({
        node: createdNode,
        childNodes: [],
        segmentNodes:
          parentNode === undefined ? [createdNode] : [parentNode, createdNode],
        nocheck: true,
      });
      if (!this.disposed && deleteResult.nodeSourceStateUpdates?.length) {
        this.layer.spatialSkeletonState.setCachedNodeSourceStates(
          deleteResult.nodeSourceStateUpdates,
        );
      }
    } catch (error) {
      if (!this.disposed) {
        skeletonLayerFromLayer(this.layer)?.invalidateSourceCellsForPositions([
          entry.positionInModelSpace,
          parentNode?.position,
        ]);
        this.layer.spatialSkeletonState.invalidateCachedSegments([
          result.segmentId,
        ]);
        this.layer.markSpatialSkeletonNodeDataChanged({
          invalidateFullSkeletonCache: false,
        });
      }
      StatusMessage.showErrorMessage(
        `CATMAID created a node after its optimistic preview was canceled, and automatic cleanup failed. Refresh the skeleton to sync. ${formatErrorMessage(error)}`,
      );
    }
  }

  private async compensateCanceledMoveCommit(
    entry: CatmaidOptimisticMoveNodeEntry,
    result: CatmaidSpatialSkeletonNodeSourceStateResult,
  ) {
    const nodeForCompensation: SpatiallyIndexedSkeletonNode = {
      ...entry.nodeForServer,
      position: new Float32Array(entry.afterPositionInModelSpace),
      ...(result.sourceState === undefined
        ? {}
        : { sourceState: result.sourceState }),
    };
    try {
      const compensationResult = await this.editOperations.commitMoveNode({
        node: nodeForCompensation,
        position: entry.beforePositionInModelSpace,
        nocheck: true,
      });
      if (!this.disposed && compensationResult.sourceState !== undefined) {
        this.layer.spatialSkeletonState.setCachedNodeSourceState(
          entry.nodeId,
          compensationResult.sourceState,
        );
      }
    } catch (error) {
      if (!this.disposed) {
        await refreshTopologySegments(
          this.layer,
          [entry.segmentId],
          [entry.beforePositionInModelSpace, entry.afterPositionInModelSpace],
        );
      }
      StatusMessage.showErrorMessage(
        `CATMAID moved a node after its optimistic preview was canceled, and automatic cleanup failed. Refresh the skeleton to sync. ${formatErrorMessage(error)}`,
      );
    }
  }

  private getDeleteCompensationNodeSnapshot(
    node: SpatiallyIndexedSkeletonNode | undefined,
    result: CatmaidSpatialSkeletonDeleteNodeResult,
  ) {
    if (node === undefined) {
      return undefined;
    }
    const updatedSourceState = result.nodeSourceStateUpdates?.find(
      (update) => update.nodeId === node.nodeId,
    )?.sourceState;
    return updatedSourceState === undefined
      ? node
      : {
          ...node,
          sourceState: updatedSourceState,
        };
  }

  private async restoreCanceledDeleteOnServer(
    entry: CatmaidOptimisticDeleteNodeEntry,
    result: CatmaidSpatialSkeletonDeleteNodeResult,
  ) {
    const parentNode = this.getDeleteCompensationNodeSnapshot(
      entry.deleteContext.parentNode,
      result,
    );
    const childNodes = entry.deleteContext.childNodes.map(
      (childNode) => this.getDeleteCompensationNodeSnapshot(childNode, result)!,
    );
    let createResult:
      | CatmaidSpatialSkeletonAddNodeResult
      | CatmaidSpatialSkeletonInsertNodeResult;
    if (childNodes.length === 0) {
      createResult = await this.editOperations.commitAddNode({
        segmentId: parentNode?.segmentId ?? entry.segmentId,
        position: entry.deleteContext.node.position,
        parentNode,
      });
    } else {
      if (parentNode === undefined) {
        throw new Error(
          "Canceled delete compensation is missing the parent node needed for insertion.",
        );
      }
      createResult = await this.editOperations.commitInsertNode({
        segmentId: parentNode.segmentId,
        position: entry.deleteContext.node.position,
        parentNode,
        childNodes,
      });
    }
    const restoredNode: SpatiallyIndexedSkeletonNode = {
      nodeId: createResult.nodeId,
      segmentId: createResult.segmentId,
      position: new Float32Array(entry.deleteContext.node.position),
      parentNodeId: parentNode?.nodeId,
      isTrueEnd: false,
      ...(createResult.sourceState === undefined
        ? {}
        : { sourceState: createResult.sourceState }),
    };
    await restoreNodeAttributes(
      this.layer,
      this.editOperations,
      restoredNode,
      entry.deleteContext.node,
      { applyLocalState: false },
    );
  }

  private async compensateCanceledDeleteCommit(
    entry: CatmaidOptimisticDeleteNodeEntry,
    result: CatmaidSpatialSkeletonDeleteNodeResult,
  ) {
    entry.result = result;
    try {
      if (this.disposed) {
        await this.restoreCanceledDeleteOnServer(entry, result);
        return;
      }
      this.removeRestoredDeletePreview(entry);
      await entry.command.restoreDeletedNode("Restored canceled deletion of", {
        showStatus: false,
      });
    } catch (error) {
      if (!this.disposed) {
        await refreshTopologySegments(
          this.layer,
          [entry.segmentId],
          entry.affectedPositions,
        );
      }
      StatusMessage.showErrorMessage(
        `CATMAID deleted a node after its optimistic preview was canceled, and automatic restore failed. Refresh the skeleton to sync. ${formatErrorMessage(error)}`,
      );
    }
  }
}

function skeletonLayerFromLayer(layer: SegmentationUserLayer) {
  return layer.getSpatiallyIndexedSkeletonLayer();
}

class InsertNodeCommand implements SpatialSkeletonCommand {
  readonly label = "Insert node";
  private stableNodeId: number | undefined;
  private stableSegmentId: number | undefined;

  constructor(
    private layer: SegmentationUserLayer,
    private stableParentNodeId: number,
    private stableChildNodeIds: readonly number[],
    private targetSkeletonId: number,
    private positionInModelSpace: Float32Array,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  private async insertNode(options: {
    moveView: boolean;
    pinSegment: boolean;
    statusPrefix: string;
  }) {
    const { skeletonLayer } = getEditableSkeletonSourceForLayer(this.layer);
    const parentNode = (
      await getResolvedNodeForEdit(
        this.layer,
        this.stableParentNodeId,
        this.stableSegmentId ?? this.targetSkeletonId,
      )
    ).node;
    const childNodes = await Promise.all(
      this.stableChildNodeIds.map((stableChildNodeId) =>
        getResolvedNodeForEdit(
          this.layer,
          stableChildNodeId,
          parentNode.segmentId,
        ).then((result) => result.node),
      ),
    );
    const result = await this.editOperations.commitInsertNode({
      segmentId: parentNode.segmentId,
      position: this.positionInModelSpace,
      parentNode,
      childNodes,
    });
    if (this.stableNodeId === undefined) {
      this.stableNodeId = result.nodeId;
    } else {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapNodeId(
        this.stableNodeId,
        result.nodeId,
      );
    }
    if (this.stableSegmentId === undefined) {
      this.stableSegmentId = result.segmentId;
    } else {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
        this.stableSegmentId,
        result.segmentId,
      );
    }
    applyCreatedNodeToCache(
      this.layer,
      skeletonLayer,
      result,
      parentNode.nodeId,
      this.positionInModelSpace,
      {
        childNodes,
        focusSelection: true,
        moveView: options.moveView,
        pinSegment: options.pinSegment,
        retainOverlaySegment: true,
      },
    );
    StatusMessage.showTemporaryMessage(
      `${options.statusPrefix} node ${result.nodeId} on segment ${result.segmentId}.`,
    );
  }

  private async deleteInsertedNode(statusPrefix: string) {
    if (this.stableNodeId === undefined) {
      throw new Error("Insert-node undo is missing the created node id.");
    }
    const { resolvedNode } = await commitAndApplyDeleteNode(
      this.layer,
      this.editOperations,
      this.stableNodeId,
      this.stableSegmentId,
      {
        childMode: "context",
        invalidateSourceCells: true,
        moveView: false,
      },
    );
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} inserted node ${resolvedNode.node.nodeId}.`,
    );
  }

  execute() {
    return this.insertNode({
      moveView: true,
      pinSegment: true,
      statusPrefix: "Inserted",
    });
  }

  undo() {
    return this.deleteInsertedNode("Undid insertion of");
  }

  redo() {
    return this.insertNode({
      moveView: false,
      pinSegment: false,
      statusPrefix: "Redid insertion of",
    });
  }
}

class MoveNodeCommand implements SpatialSkeletonCommand {
  readonly label = "Move node";
  readonly executeOptimistically?: (
    context: SpatialSkeletonCommandContext,
  ) => Promise<void>;

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private beforePositionInModelSpace: Float32Array,
    private afterPositionInModelSpace: Float32Array,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
    optimistic = false,
  ) {
    if (optimistic) {
      this.executeOptimistically = async () => {
        await getOrCreateCatmaidOptimisticEditQueue(
          this.layer,
          this.editOperations,
        ).enqueueMoveNode(this);
      };
    }
  }

  getBeforePositionInModelSpace() {
    return new Float32Array(this.beforePositionInModelSpace);
  }

  getAfterPositionInModelSpace() {
    return new Float32Array(this.afterPositionInModelSpace);
  }

  resolveMoveContext() {
    return getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
  }

  private async moveTo(
    positionInModelSpace: Float32Array,
    statusPrefix: string,
  ) {
    const { node, skeletonLayer } = await this.resolveMoveContext();
    const result = await this.editOperations.commitMoveNode({
      node,
      position: positionInModelSpace,
    });
    skeletonLayer.retainOverlaySegment(node.segmentId);
    this.layer.spatialSkeletonState.moveCachedNode(
      node.nodeId,
      positionInModelSpace,
    );
    if (result.sourceState !== undefined) {
      this.layer.spatialSkeletonState.setCachedNodeSourceState(
        node.nodeId,
        result.sourceState,
      );
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} node ${node.nodeId} to (${Math.round(positionInModelSpace[0])}, ${Math.round(positionInModelSpace[1])}, ${Math.round(positionInModelSpace[2])}).`,
    );
  }

  execute() {
    return this.moveTo(this.afterPositionInModelSpace, "Moved");
  }

  undo() {
    return this.moveTo(this.beforePositionInModelSpace, "Undid move of");
  }

  redo() {
    return this.moveTo(this.afterPositionInModelSpace, "Redid move of");
  }
}

class DeleteNodeCommand implements SpatialSkeletonCommand {
  readonly label = "Delete node";
  readonly executeOptimistically?: (
    context: SpatialSkeletonCommandContext,
  ) => Promise<void>;
  private stableDeletedNodeId: number;
  private stableSegmentId: number | undefined;
  private stableParentNodeId: number | undefined;
  private stableChildNodeIds: number[];
  private deletedSnapshot: SpatiallyIndexedSkeletonNode;

  constructor(
    private layer: SegmentationUserLayer,
    node: SpatiallyIndexedSkeletonNode,
    childNodes: readonly SpatiallyIndexedSkeletonNode[],
    private editOperations: CatmaidSpatialSkeletonEditOperations,
    optimistic = false,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    this.stableDeletedNodeId = commandMappings.getStableOrCurrentNodeId(
      node.nodeId,
    )!;
    this.stableSegmentId = commandMappings.getStableOrCurrentSegmentId(
      node.segmentId,
    );
    this.stableParentNodeId = commandMappings.getStableOrCurrentNodeId(
      node.parentNodeId,
    );
    this.stableChildNodeIds = childNodes.map(
      (child) => commandMappings.getStableOrCurrentNodeId(child.nodeId)!,
    );
    this.deletedSnapshot = cloneNodeSnapshot(node);
    if (optimistic) {
      this.executeOptimistically = async () => {
        await getOrCreateCatmaidOptimisticEditQueue(
          this.layer,
          this.editOperations,
        ).enqueueDeleteNode(this);
      };
    }
  }

  async resolveDeleteContext() {
    const resolvedNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableDeletedNodeId,
      this.stableSegmentId,
    );
    const deleteContext =
      await this.layer.getSpatialSkeletonDeleteOperationContext(
        resolvedNode.node,
      );
    return { resolvedNode, deleteContext };
  }

  private async deleteNode(options: {
    moveView: boolean;
    statusPrefix: string;
  }) {
    const { resolvedNode } = await commitAndApplyDeleteNode(
      this.layer,
      this.editOperations,
      this.stableDeletedNodeId,
      this.stableSegmentId,
      {
        childMode: "context",
        invalidateSourceCells: true,
        moveView: options.moveView,
      },
    );
    StatusMessage.showTemporaryMessage(
      `${options.statusPrefix} node ${resolvedNode.node.nodeId}.`,
    );
  }

  async restoreDeletedNode(
    statusPrefix: string,
    options: { showStatus?: boolean } = {},
  ) {
    const { skeletonLayer } = getEditableSkeletonSourceForLayer(this.layer);
    const currentParentNode =
      this.stableParentNodeId === undefined
        ? undefined
        : (
            await getResolvedNodeForEdit(
              this.layer,
              this.stableParentNodeId,
              this.stableSegmentId,
            )
          ).node;
    const currentChildNodes = await Promise.all(
      this.stableChildNodeIds.map((stableChildNodeId) =>
        getResolvedNodeForEdit(
          this.layer,
          stableChildNodeId,
          this.stableSegmentId,
        ).then((result) => result.node),
      ),
    );
    let createResult:
      | CatmaidSpatialSkeletonAddNodeResult
      | CatmaidSpatialSkeletonInsertNodeResult;
    if (currentChildNodes.length === 0) {
      createResult = await this.editOperations.commitAddNode({
        segmentId: currentParentNode?.segmentId ?? 0,
        position: this.deletedSnapshot.position,
        parentNode: currentParentNode,
      });
    } else {
      if (currentParentNode === undefined) {
        throw new Error(
          "Delete-node undo is missing the parent node needed for insertion.",
        );
      }
      createResult = await this.editOperations.commitInsertNode({
        segmentId: currentParentNode.segmentId,
        position: this.deletedSnapshot.position,
        parentNode: currentParentNode,
        childNodes: currentChildNodes,
      });
    }
    this.layer.spatialSkeletonState.commandHistory.mappings.remapNodeId(
      this.stableDeletedNodeId,
      createResult.nodeId,
    );
    if (this.stableSegmentId === undefined) {
      this.stableSegmentId = createResult.segmentId;
    } else {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
        this.stableSegmentId,
        createResult.segmentId,
      );
    }
    const restoredNode = applyCreatedNodeToCache(
      this.layer,
      skeletonLayer,
      createResult,
      currentParentNode?.nodeId,
      this.deletedSnapshot.position,
      {
        childNodes: currentChildNodes,
        focusSelection: false,
        markChanged: false,
        moveView: false,
        pinSegment: false,
        retainOverlaySegment: false,
        selectSegment: false,
      },
    );
    const restoredNodeWithAttributes = await restoreNodeAttributes(
      this.layer,
      this.editOperations,
      restoredNode,
      this.deletedSnapshot,
    );
    ensureVisibleSegment(this.layer, restoredNodeWithAttributes.segmentId);
    this.layer.selectSpatialSkeletonNode(
      restoredNodeWithAttributes.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      {
        segmentId: restoredNodeWithAttributes.segmentId,
        position: restoredNodeWithAttributes.position,
      },
    );
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    if (options.showStatus ?? true) {
      StatusMessage.showTemporaryMessage(
        `${statusPrefix} node ${restoredNodeWithAttributes.nodeId}.`,
      );
    }
  }

  execute() {
    return this.deleteNode({
      moveView: true,
      statusPrefix: "Deleted",
    });
  }

  undo() {
    return this.restoreDeletedNode("Restored");
  }

  redo() {
    return this.deleteNode({
      moveView: false,
      statusPrefix: "Redid deletion of",
    });
  }
}

class NodeDescriptionCommand implements SpatialSkeletonCommand {
  readonly label = "Edit node description";

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private beforeDescription: string | undefined,
    private afterDescription: string | undefined,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  private async applyDescription(
    nextDescription: string | undefined,
    statusPrefix: string,
  ) {
    const { node } = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    if (node.description === nextDescription) {
      return;
    }
    const result = await this.editOperations.commitDescription({
      node,
      description: nextDescription ?? "",
      isTrueEnd: node.isTrueEnd === true,
    });
    this.layer.spatialSkeletonState.updateCachedNode(
      node.nodeId,
      (candidate) => {
        if (candidate.description === result.description) {
          return candidate;
        }
        return {
          ...candidate,
          description: result.description,
        };
      },
    );
    if (result.sourceState !== undefined) {
      this.layer.spatialSkeletonState.setCachedNodeSourceState(
        node.nodeId,
        result.sourceState,
      );
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} node ${node.nodeId} description.`,
    );
  }

  execute() {
    return this.applyDescription(this.afterDescription, "Updated");
  }

  undo() {
    return this.applyDescription(
      this.beforeDescription,
      "Undid description update for",
    );
  }

  redo() {
    return this.applyDescription(
      this.afterDescription,
      "Redid description update for",
    );
  }
}

class NodeTrueEndCommand implements SpatialSkeletonCommand {
  readonly label = "Edit node true end state";

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private beforeIsTrueEnd: boolean,
    private afterIsTrueEnd: boolean,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  private async applyTrueEnd(nextIsTrueEnd: boolean, statusPrefix: string) {
    const { node } = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    if (node.isTrueEnd === nextIsTrueEnd) {
      return;
    }
    const result = await this.editOperations.commitTrueEnd({
      node,
      isTrueEnd: nextIsTrueEnd,
    });
    this.layer.spatialSkeletonState.updateCachedNode(
      node.nodeId,
      (candidate) => {
        if (candidate.isTrueEnd === nextIsTrueEnd) {
          return candidate;
        }
        return {
          ...candidate,
          isTrueEnd: nextIsTrueEnd,
        };
      },
    );
    if (result.sourceState !== undefined) {
      this.layer.spatialSkeletonState.setCachedNodeSourceState(
        node.nodeId,
        result.sourceState,
      );
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} node ${node.nodeId} true end state.`,
    );
  }

  execute() {
    return this.applyTrueEnd(this.afterIsTrueEnd, "Updated");
  }

  undo() {
    return this.applyTrueEnd(this.beforeIsTrueEnd, "Undid true end update for");
  }

  redo() {
    return this.applyTrueEnd(this.afterIsTrueEnd, "Redid true end update for");
  }
}

class NodeRadiusCommand implements SpatialSkeletonCommand {
  readonly label = "Edit node radius";

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private beforeRadius: number,
    private afterRadius: number,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  private async applyRadius(nextRadius: number, statusPrefix: string) {
    const { node } = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    if (node.radius === nextRadius) {
      return;
    }
    const radiusResult = await this.editOperations.commitRadius({
      node,
      radius: nextRadius,
    });
    this.layer.spatialSkeletonState.setNodeRadius(node.nodeId, nextRadius);
    if (radiusResult.sourceState !== undefined) {
      this.layer.spatialSkeletonState.setCachedNodeSourceState(
        node.nodeId,
        radiusResult.sourceState,
      );
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} node ${node.nodeId} radius.`,
    );
  }

  execute() {
    return this.applyRadius(this.afterRadius, "Updated");
  }

  undo() {
    return this.applyRadius(this.beforeRadius, "Undid radius update for");
  }

  redo() {
    return this.applyRadius(this.afterRadius, "Redid radius update for");
  }
}

class NodeConfidenceCommand implements SpatialSkeletonCommand {
  readonly label = "Edit node confidence";

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private beforeConfidence: number,
    private afterConfidence: number,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  private async applyConfidence(nextConfidence: number, statusPrefix: string) {
    const { node } = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    if (node.confidence === nextConfidence) {
      return;
    }
    const confidenceResult = await this.editOperations.commitConfidence({
      node,
      confidence: nextConfidence,
    });
    this.layer.spatialSkeletonState.setNodeConfidence(
      node.nodeId,
      nextConfidence,
    );
    if (confidenceResult.sourceState !== undefined) {
      this.layer.spatialSkeletonState.setCachedNodeSourceState(
        node.nodeId,
        confidenceResult.sourceState,
      );
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} node ${node.nodeId} confidence.`,
    );
  }

  execute() {
    return this.applyConfidence(this.afterConfidence, "Updated");
  }

  undo() {
    return this.applyConfidence(
      this.beforeConfidence,
      "Undid confidence update for",
    );
  }

  redo() {
    return this.applyConfidence(
      this.afterConfidence,
      "Redid confidence update for",
    );
  }
}

class RerootCommand implements SpatialSkeletonCommand {
  readonly label = "Reroot skeleton";

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private stablePreviousRootNodeId: number,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  private async rerootAt(stableTargetNodeId: number, statusPrefix: string) {
    const resolvedNode = await getResolvedNodeForEdit(
      this.layer,
      stableTargetNodeId,
      this.stableSegmentId,
    );
    if (resolvedNode.node.parentNodeId === undefined) {
      return;
    }
    let result: CatmaidSpatialSkeletonRerootResult;
    try {
      result = await this.editOperations.commitReroot({
        node: resolvedNode.node,
        segmentNodes: resolvedNode.segmentNodes,
      });
    } catch (error) {
      if (!(error instanceof CatmaidRerootSourceStateRefreshError)) {
        throw error;
      }
      resolvedNode.skeletonLayer.invalidateSourceCellsForPositions(
        collectUniqueNodePositions(resolvedNode.segmentNodes),
      );
      this.layer.spatialSkeletonState.invalidateCachedSegments([
        resolvedNode.node.segmentId,
      ]);
      this.layer.markSpatialSkeletonNodeDataChanged({
        invalidateFullSkeletonCache: false,
      });
      throw error;
    }
    this.layer.spatialSkeletonState.rerootCachedSegment(
      resolvedNode.node.nodeId,
    );
    if (
      result.nodeSourceStateUpdates !== undefined &&
      result.nodeSourceStateUpdates.length > 0
    ) {
      this.layer.spatialSkeletonState.setCachedNodeSourceStates(
        result.nodeSourceStateUpdates,
      );
    }
    this.layer.selectSpatialSkeletonNode(
      resolvedNode.node.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      {
        segmentId: resolvedNode.node.segmentId,
        position: resolvedNode.node.position,
      },
    );
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} node ${resolvedNode.node.nodeId} as root.`,
    );
  }

  execute() {
    return this.rerootAt(this.stableNodeId, "Set");
  }

  undo() {
    return this.rerootAt(this.stablePreviousRootNodeId, "Undid reroot for");
  }

  redo() {
    return this.rerootAt(this.stableNodeId, "Redid reroot for");
  }
}

class SplitCommand implements SpatialSkeletonCommand {
  readonly label = "Split skeleton";
  readonly executeOptimistically?: (
    context: SpatialSkeletonCommandContext,
  ) => Promise<void>;
  private stableNewSegmentId: number | undefined;

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private stableFormerParentNodeId: number | undefined,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
    optimistic = false,
  ) {
    if (optimistic) {
      this.executeOptimistically = async () => {
        await getOrCreateCatmaidOptimisticEditQueue(
          this.layer,
          this.editOperations,
        ).enqueueSplitSkeleton(this);
      };
    }
  }

  resolveSplitContext() {
    return getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
  }

  markOptimisticCommit(
    tempSegmentId: number,
    result: CatmaidSpatialSkeletonSplitResult,
    fallbackExistingSegmentId: number,
  ) {
    const newSegmentId = result.newSegmentId;
    if (newSegmentId === undefined) {
      throw new Error(
        "The active skeleton source did not return a new skeleton id for the split.",
      );
    }
    this.stableNewSegmentId = tempSegmentId;
    this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
      tempSegmentId,
      newSegmentId,
    );
    if (this.stableSegmentId !== undefined) {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
        this.stableSegmentId,
        result.existingSegmentId ?? fallbackExistingSegmentId,
      );
    }
  }

  private async split(statusPrefix: string) {
    const resolvedNode = await this.resolveSplitContext();
    if (resolvedNode.node.parentNodeId === undefined) {
      StatusMessage.showTemporaryMessage("Cannot split at the root node.");
      return;
    }
    let result: CatmaidSpatialSkeletonSplitResult;
    try {
      result = await this.editOperations.commitSplit({
        node: resolvedNode.node,
        segmentNodes: resolvedNode.segmentNodes,
      });
    } catch (error) {
      await refreshTopologySegments(
        this.layer,
        [resolvedNode.node.segmentId],
        collectUniqueNodePositions(resolvedNode.segmentNodes),
      );
      throw error;
    }
    const newSkeletonId = result.newSegmentId;
    const existingSkeletonId =
      result.existingSegmentId ?? resolvedNode.node.segmentId;
    if (newSkeletonId === undefined) {
      throw new Error(
        "The active skeleton source did not return a new skeleton id for the split.",
      );
    }
    if (this.stableNewSegmentId === undefined) {
      this.stableNewSegmentId = newSkeletonId;
    } else {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
        this.stableNewSegmentId,
        newSkeletonId,
      );
    }
    if (this.stableSegmentId !== undefined) {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
        this.stableSegmentId,
        existingSkeletonId,
      );
    }
    ensureVisibleSegment(this.layer, existingSkeletonId);
    ensureVisibleSegment(this.layer, newSkeletonId);
    selectSegment(this.layer, newSkeletonId, true);
    this.layer.selectSpatialSkeletonNode(
      resolvedNode.node.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      {
        segmentId: newSkeletonId,
      },
    );
    await refreshTopologySegments(
      this.layer,
      [existingSkeletonId, newSkeletonId],
      collectUniqueNodePositions(getSplitAffectedNodes(resolvedNode)),
    );
    resolvedNode.skeletonLayer.retainOverlaySegment(existingSkeletonId);
    resolvedNode.skeletonLayer.retainOverlaySegment(newSkeletonId);
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} skeleton ${existingSkeletonId}. New skeleton: ${newSkeletonId}.`,
    );
  }

  private async mergeBack(statusPrefix: string) {
    if (this.stableFormerParentNodeId === undefined) {
      throw new Error("Split-node undo is missing the former parent node.");
    }
    const splitNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableNewSegmentId ?? this.stableSegmentId,
    );
    const formerParent = await getResolvedNodeForEdit(
      this.layer,
      this.stableFormerParentNodeId,
      this.stableSegmentId,
    );
    let result: CatmaidSpatialSkeletonMergeResult;
    try {
      result = await this.editOperations.commitMerge({
        fromNode: formerParent.node,
        toNode: splitNode.node,
      });
    } catch (error) {
      await refreshTopologySegments(
        this.layer,
        [splitNode.node.segmentId, formerParent.node.segmentId],
        collectUniqueNodePositions(
          splitNode.segmentNodes,
          formerParent.segmentNodes,
        ),
      );
      throw error;
    }
    const resultSkeletonId =
      result.resultSegmentId ?? formerParent.node.segmentId;
    const deletedSkeletonId =
      result.deletedSegmentId ??
      (resultSkeletonId === splitNode.node.segmentId
        ? formerParent.node.segmentId
        : splitNode.node.segmentId);
    if (this.stableSegmentId !== undefined) {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
        this.stableSegmentId,
        resultSkeletonId,
      );
    }
    if (this.stableNewSegmentId !== undefined) {
      this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
        this.stableNewSegmentId,
        resultSkeletonId,
      );
    }
    ensureVisibleSegment(this.layer, resultSkeletonId);
    if (deletedSkeletonId !== resultSkeletonId) {
      removeVisibleSegment(this.layer, deletedSkeletonId, { deselect: true });
      this.layer.displayState.segmentStatedColors.value.delete(
        BigInt(deletedSkeletonId),
      );
      splitNode.skeletonLayer.markSegmentEdited(deletedSkeletonId);
    }
    this.layer.selectSpatialSkeletonNode(
      splitNode.node.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      {
        segmentId: resultSkeletonId,
      },
    );
    await refreshTopologySegments(
      this.layer,
      [resultSkeletonId, deletedSkeletonId],
      getMergeAffectedPositions(
        result.deletedSegmentId,
        splitNode,
        formerParent,
      ),
    );
    splitNode.skeletonLayer.retainOverlaySegment(resultSkeletonId);
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} split at node ${splitNode.node.nodeId}.`,
    );
  }

  execute() {
    return this.split("Split");
  }

  undo() {
    return this.mergeBack("Undid");
  }

  redo() {
    return this.split("Redid split of");
  }
}

class MergeCommand implements SpatialSkeletonCommand {
  readonly label = "Merge skeletons";
  readonly executeOptimistically?: (
    context: SpatialSkeletonCommandContext,
  ) => Promise<void>;
  private stableResultSegmentId: number | undefined;
  private stableDeletedSegmentId: number | undefined;
  private stableAttachedNodeId: number | undefined;
  private stableAttachedRootNodeId: number | undefined;

  constructor(
    private layer: SegmentationUserLayer,
    private stableFirstNodeId: number,
    private stableFirstSegmentId: number | undefined,
    private stableSecondNodeId: number,
    private stableSecondSegmentId: number | undefined,
    private secondNodeSourceState: SpatialSkeletonSourceState | undefined,
    private secondNodePositionInModelSpace: Float32Array | undefined,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
    optimistic = false,
  ) {
    if (optimistic) {
      this.executeOptimistically = async () => {
        await getOrCreateCatmaidOptimisticEditQueue(
          this.layer,
          this.editOperations,
        ).enqueueMergeSkeletons(this);
      };
    }
  }

  private async resolveSecondNodeForMerge(requireFullSegment = false) {
    if (requireFullSegment) {
      return getResolvedNodeForEdit(
        this.layer,
        this.stableSecondNodeId,
        this.stableSecondSegmentId,
      );
    }
    const secondNodeContext = getResolvedNodeContextForEdit(
      this.layer,
      this.stableSecondNodeId,
      this.stableSecondSegmentId,
    );
    const secondSegmentNodes =
      this.layer.spatialSkeletonState.getCachedSegmentNodes(
        secondNodeContext.segmentId,
      );
    const secondSourceState =
      secondNodeContext.cachedNode?.sourceState ?? this.secondNodeSourceState;
    if (secondSegmentNodes !== undefined || secondSourceState === undefined) {
      return getResolvedNodeForEdit(
        this.layer,
        this.stableSecondNodeId,
        this.stableSecondSegmentId,
      );
    }

    const rootNodeSource = getCatmaidSkeletonRootNodeSource(
      secondNodeContext.skeletonLayer,
    );
    if (rootNodeSource === undefined) {
      return getResolvedNodeForEdit(
        this.layer,
        this.stableSecondNodeId,
        this.stableSecondSegmentId,
      );
    }

    const rootTarget = await rootNodeSource.getSkeletonRootNode(
      secondNodeContext.segmentId,
    );
    const cachedPosition = secondNodeContext.cachedNode?.position;
    const endpointPosition =
      cachedPosition === undefined
        ? (this.secondNodePositionInModelSpace ?? new Float32Array(3))
        : toCatmaidPositionInModelSpace(
            cachedPosition,
            "merge second-node position",
          );
    const node: SpatiallyIndexedSkeletonNode = {
      nodeId: secondNodeContext.currentNodeId,
      segmentId: secondNodeContext.segmentId,
      position: new Float32Array(endpointPosition),
      parentNodeId: secondNodeContext.cachedNode?.parentNodeId,
      isTrueEnd: secondNodeContext.cachedNode?.isTrueEnd ?? false,
      sourceState: secondSourceState,
    };
    const segmentNodes: SpatiallyIndexedSkeletonNode[] = [];
    if (rootTarget.nodeId === node.nodeId) {
      node.parentNodeId = undefined;
      segmentNodes.push(node);
    } else {
      segmentNodes.push({
        nodeId: rootTarget.nodeId,
        segmentId: secondNodeContext.segmentId,
        position: toCatmaidPositionInModelSpace(
          rootTarget.position,
          "merge second-segment root position",
        ),
        parentNodeId: undefined,
        isTrueEnd: false,
      });
      segmentNodes.push(node);
    }
    return {
      skeletonLayer: secondNodeContext.skeletonLayer,
      segmentNodes,
      node,
    };
  }

  async resolveMergeContext(requireFullSecondSegment = false) {
    const firstNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableFirstNodeId,
      this.stableFirstSegmentId,
    );
    const secondNode = await this.resolveSecondNodeForMerge(
      requireFullSecondSegment,
    );
    return { firstNode, secondNode };
  }

  markOptimisticCommit(
    firstNode: ResolvedSpatialSkeletonEditNode,
    secondNode: ResolvedSpatialSkeletonEditNode,
    result: CatmaidSpatialSkeletonMergeResult,
  ) {
    const winningNode =
      result.resultSegmentId === secondNode.node.segmentId
        ? secondNode.node
        : firstNode.node;
    const losingNode =
      winningNode.nodeId === firstNode.node.nodeId
        ? secondNode.node
        : firstNode.node;
    const resultSkeletonId = result.resultSegmentId ?? winningNode.segmentId;
    const deletedSkeletonId = result.deletedSegmentId ?? losingNode.segmentId;
    const attachedRootNodeId =
      losingNode.segmentId === firstNode.node.segmentId
        ? findRootNode(firstNode.segmentNodes)?.nodeId
        : findRootNode(secondNode.segmentNodes)?.nodeId;
    const mappings = this.layer.spatialSkeletonState.commandHistory.mappings;
    this.stableAttachedNodeId =
      this.stableAttachedNodeId ??
      mappings.getStableOrCurrentNodeId(losingNode.nodeId);
    this.stableAttachedRootNodeId =
      this.stableAttachedRootNodeId ??
      mappings.getStableOrCurrentNodeId(attachedRootNodeId);
    this.stableResultSegmentId =
      this.stableResultSegmentId ??
      mappings.getStableOrCurrentSegmentId(resultSkeletonId);
    this.stableDeletedSegmentId =
      this.stableDeletedSegmentId ??
      mappings.getStableOrCurrentSegmentId(deletedSkeletonId);
    mappings.remapSegmentId(this.stableDeletedSegmentId, resultSkeletonId);
  }

  private async merge(statusPrefix: string) {
    const { firstNode, secondNode } = await this.resolveMergeContext();
    let result: CatmaidSpatialSkeletonMergeResult;
    try {
      result = await this.editOperations.commitMerge({
        fromNode: firstNode.node,
        toNode: secondNode.node,
      });
    } catch (error) {
      await refreshTopologySegments(
        this.layer,
        [firstNode.node.segmentId, secondNode.node.segmentId],
        collectUniqueNodePositions(
          firstNode.segmentNodes,
          secondNode.segmentNodes,
        ),
      );
      throw error;
    }
    const winningNode =
      result.resultSegmentId === secondNode.node.segmentId
        ? secondNode.node
        : firstNode.node;
    const losingNode =
      winningNode.nodeId === firstNode.node.nodeId
        ? secondNode.node
        : firstNode.node;
    const resultSkeletonId = result.resultSegmentId ?? winningNode.segmentId;
    const deletedSkeletonId = result.deletedSegmentId ?? losingNode.segmentId;
    const attachedRootNodeId =
      losingNode.segmentId === firstNode.node.segmentId
        ? findRootNode(firstNode.segmentNodes)?.nodeId
        : findRootNode(secondNode.segmentNodes)?.nodeId;
    this.stableAttachedNodeId =
      this.stableAttachedNodeId ??
      this.layer.spatialSkeletonState.commandHistory.mappings.getStableOrCurrentNodeId(
        losingNode.nodeId,
      );
    this.stableAttachedRootNodeId =
      this.stableAttachedRootNodeId ??
      this.layer.spatialSkeletonState.commandHistory.mappings.getStableOrCurrentNodeId(
        attachedRootNodeId,
      );
    this.stableResultSegmentId =
      this.stableResultSegmentId ??
      this.layer.spatialSkeletonState.commandHistory.mappings.getStableOrCurrentSegmentId(
        resultSkeletonId,
      );
    this.stableDeletedSegmentId =
      this.stableDeletedSegmentId ??
      this.layer.spatialSkeletonState.commandHistory.mappings.getStableOrCurrentSegmentId(
        deletedSkeletonId,
      );
    this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
      this.stableDeletedSegmentId,
      resultSkeletonId,
    );
    ensureVisibleSegment(this.layer, resultSkeletonId);
    removeVisibleSegment(this.layer, deletedSkeletonId, { deselect: true });
    selectSegment(this.layer, resultSkeletonId, false);
    this.layer.selectSpatialSkeletonNode(
      losingNode.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      {
        segmentId: resultSkeletonId,
      },
    );
    this.layer.displayState.segmentStatedColors.value.delete(
      BigInt(deletedSkeletonId),
    );
    if (deletedSkeletonId !== resultSkeletonId) {
      firstNode.skeletonLayer.markSegmentEdited(deletedSkeletonId);
    }
    await refreshTopologySegments(
      this.layer,
      [resultSkeletonId, deletedSkeletonId],
      getMergeAffectedPositions(result.deletedSegmentId, firstNode, secondNode),
    );
    firstNode.skeletonLayer.retainOverlaySegment(resultSkeletonId);
    const swapSuffix = result.directionAdjusted
      ? " Merge direction was adjusted by the active source."
      : "";
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} skeleton ${deletedSkeletonId} into ${resultSkeletonId}.${swapSuffix}`,
    );
  }

  private async undoMerge(statusPrefix: string) {
    if (this.stableAttachedNodeId === undefined) {
      throw new Error("Merge undo is missing the attached node id.");
    }
    if (this.stableDeletedSegmentId === undefined) {
      throw new Error("Merge undo is missing the deleted skeleton id.");
    }
    const attachedNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableAttachedNodeId,
      this.stableResultSegmentId ?? this.stableFirstSegmentId,
    );
    let splitResult: CatmaidSpatialSkeletonSplitResult;
    try {
      splitResult = await this.editOperations.commitSplit({
        node: attachedNode.node,
        segmentNodes: attachedNode.segmentNodes,
      });
    } catch (error) {
      await refreshTopologySegments(
        this.layer,
        [attachedNode.node.segmentId],
        collectUniqueNodePositions(attachedNode.segmentNodes),
      );
      throw error;
    }
    const restoredSegmentId =
      splitResult.newSegmentId ??
      (() => {
        throw new Error(
          "The active skeleton source did not return a new skeleton id for merge undo.",
        );
      })();
    this.layer.spatialSkeletonState.commandHistory.mappings.remapSegmentId(
      this.stableDeletedSegmentId,
      restoredSegmentId,
    );
    const survivingSegmentId =
      splitResult.existingSegmentId ?? attachedNode.node.segmentId;
    ensureVisibleSegment(this.layer, survivingSegmentId);
    ensureVisibleSegment(this.layer, restoredSegmentId);
    const attachedSplitAffectedPositions = collectUniqueNodePositions(
      getSplitAffectedNodes(attachedNode),
    );
    await refreshTopologySegments(
      this.layer,
      [survivingSegmentId, restoredSegmentId],
      attachedSplitAffectedPositions,
    );
    let rerootWarning: string | undefined;
    if (
      this.stableAttachedRootNodeId !== undefined &&
      this.stableAttachedRootNodeId !== this.stableAttachedNodeId
    ) {
      let rerootAffectedPositions = attachedSplitAffectedPositions;
      try {
        const restoredRoot = await getResolvedNodeForEdit(
          this.layer,
          this.stableAttachedRootNodeId,
          this.stableDeletedSegmentId,
        );
        rerootAffectedPositions = collectUniqueNodePositions(
          getSpatiallyIndexedSkeletonPathToRoot(
            restoredRoot.segmentNodes,
            restoredRoot.node,
          ),
        );
        if (restoredRoot.node.parentNodeId !== undefined) {
          await this.editOperations.commitReroot({
            node: restoredRoot.node,
            segmentNodes: restoredRoot.segmentNodes,
          });
          await refreshTopologySegments(
            this.layer,
            [survivingSegmentId, restoredSegmentId],
            rerootAffectedPositions,
          );
        }
      } catch (error) {
        await refreshTopologySegments(
          this.layer,
          [survivingSegmentId, restoredSegmentId],
          rerootAffectedPositions,
        );
        rerootWarning =
          `Undo split the merged skeletons, but failed to reroot the restored skeleton. ` +
          `Only the split completed. ${formatErrorMessage(error)}`;
      }
    }
    attachedNode.skeletonLayer.retainOverlaySegment(survivingSegmentId);
    attachedNode.skeletonLayer.retainOverlaySegment(restoredSegmentId);
    this.layer.selectSpatialSkeletonNode(
      attachedNode.node.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      {
        segmentId: restoredSegmentId,
      },
    );
    StatusMessage.showTemporaryMessage(
      rerootWarning ??
        `${statusPrefix} merge involving node ${attachedNode.node.nodeId}.`,
    );
  }

  execute() {
    return this.merge("Merged");
  }

  undo() {
    return this.undoMerge("Undid");
  }

  redo() {
    return this.merge("Redid merge of");
  }
}

function makeCatmaidCommandFactory<TAction extends SpatialSkeletonAction>(
  action: TAction,
  createCommand: (
    layer: SegmentationUserLayer,
    payload: object,
  ) => SpatialSkeletonCommand,
): SpatialSkeletonEditCommandFactory<TAction> {
  return { action, createCommand };
}

function getCatmaidEditPosition(
  position: SpatialSkeletonVector,
  label: string,
): [number, number, number] {
  const values = toCatmaidPositionInModelSpace(position, label);
  return [values[0], values[1], values[2]];
}

export class CatmaidSpatialSkeletonEditCommands {
  constructor(
    private readonly editContext: CatmaidSpatialSkeletonEditCommandContext,
  ) {}

  private readonly editOperations: CatmaidSpatialSkeletonEditOperations = {
    commitAddNode: (request) => this.commitAddNode(request),
    commitInsertNode: (request) => this.commitInsertNode(request),
    commitMoveNode: (request) => this.commitMoveNode(request),
    commitDeleteNode: (request) => this.commitDeleteNode(request),
    commitReroot: (request) => this.commitReroot(request),
    commitDescription: (request) => this.commitDescription(request),
    commitTrueEnd: (request) => this.commitTrueEnd(request),
    commitRadius: (request) => this.commitRadius(request),
    commitConfidence: (request) => this.commitConfidence(request),
    commitMerge: (request) => this.commitMerge(request),
    commitSplit: (request) => this.commitSplit(request),
  };

  readonly addNodesCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.addNodes,
    (layer, payload) =>
      this.createAddNodeCommand(
        layer,
        requireCatmaidAddNodeCommandOptions(payload),
      ),
  );

  readonly insertNodesCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.insertNodes,
    (layer, payload) =>
      this.createInsertNodeCommand(
        layer,
        requireCatmaidInsertNodeCommandOptions(payload),
      ),
  );

  readonly moveNodesCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.moveNodes,
    (layer, payload) =>
      this.createMoveNodeCommand(
        layer,
        requireCatmaidMoveNodeCommandOptions(payload),
      ),
  );

  readonly deleteNodesCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.deleteNodes,
    (layer, payload) =>
      this.createDeleteNodeCommand(
        layer,
        requireCatmaidDeleteNodeCommandPayload(payload),
      ),
  );

  readonly rerootCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.reroot,
    (layer, payload) =>
      this.createRerootCommand(
        layer,
        requireCatmaidRerootCommandPayload(payload),
      ),
  );

  readonly editNodeDescriptionCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.editNodeDescription,
    (layer, payload) =>
      this.createNodeDescriptionCommand(
        layer,
        requireCatmaidNodeDescriptionCommandOptions(payload),
      ),
  );

  readonly editNodeTrueEndCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.editNodeTrueEnd,
    (layer, payload) =>
      this.createNodeTrueEndCommand(
        layer,
        requireCatmaidNodeTrueEndCommandOptions(payload),
      ),
  );

  readonly editNodeRadiusCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.editNodeRadius,
    (layer, payload) =>
      this.createNodeRadiusCommand(
        layer,
        requireCatmaidNodeRadiusCommandOptions(payload),
      ),
  );

  readonly editNodeConfidenceCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.editNodeConfidence,
    (layer, payload) =>
      this.createNodeConfidenceCommand(
        layer,
        requireCatmaidNodeConfidenceCommandOptions(payload),
      ),
  );

  readonly mergeSkeletonsCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.mergeSkeletons,
    (layer, payload) => {
      const options = requireCatmaidMergeCommandPayload(payload);
      return this.createMergeCommand(
        layer,
        options.firstNode,
        options.secondNode,
      );
    },
  );

  readonly splitSkeletonsCommand = makeCatmaidCommandFactory(
    SpatialSkeletonActions.splitSkeletons,
    (layer, payload) =>
      this.createSplitCommand(
        layer,
        requireCatmaidSplitCommandPayload(payload),
      ),
  );

  private get client() {
    return this.editContext.getClient();
  }

  private commitAddNode(
    request: CatmaidSpatialSkeletonAddNodeRequest,
  ): Promise<CatmaidSpatialSkeletonAddNodeResult> {
    const [x, y, z] = getCatmaidEditPosition(
      request.position,
      "add-node position",
    );
    return this.client.addNode(
      request.segmentId,
      x,
      y,
      z,
      request.parentNode?.nodeId,
      request.nocheck === true || request.parentNode === undefined
        ? undefined
        : buildCatmaidNodeEditContext(request.parentNode),
      {
        nocheck: request.nocheck,
        signal: request.signal,
      },
    );
  }

  private commitInsertNode(
    request: CatmaidSpatialSkeletonInsertNodeRequest,
  ): Promise<CatmaidSpatialSkeletonInsertNodeResult> {
    const [x, y, z] = getCatmaidEditPosition(
      request.position,
      "insert-node position",
    );
    return this.client.insertNode(
      request.segmentId,
      x,
      y,
      z,
      request.parentNode.nodeId,
      request.childNodes.map((child) => child.nodeId),
      buildCatmaidInsertEditContext(request.parentNode, request.childNodes),
    );
  }

  private commitMoveNode(
    request: CatmaidSpatialSkeletonMoveNodeRequest,
  ): Promise<CatmaidSpatialSkeletonNodeSourceStateResult> {
    const [x, y, z] = getCatmaidEditPosition(
      request.position,
      "move-node position",
    );
    return this.client.moveNode(
      request.node.nodeId,
      x,
      y,
      z,
      buildCatmaidNodeEditContext(request.node),
      { nocheck: request.nocheck },
    );
  }

  private commitDeleteNode(
    request: CatmaidSpatialSkeletonDeleteNodeRequest,
  ): Promise<CatmaidSpatialSkeletonDeleteNodeResult> {
    return this.client.deleteNode(request.node.nodeId, {
      childNodeIds: request.childNodes.map((child) => child.nodeId),
      editContext: buildCatmaidNeighborhoodEditContext(
        request.node,
        request.segmentNodes,
      ),
      nocheck: request.nocheck,
    });
  }

  private commitReroot(
    request: CatmaidSpatialSkeletonRerootRequest,
  ): Promise<CatmaidSpatialSkeletonRerootResult> {
    return this.commitRerootAndRefreshSourceStates(request);
  }

  private async commitRerootAndRefreshSourceStates(
    request: CatmaidSpatialSkeletonRerootRequest,
  ): Promise<CatmaidSpatialSkeletonRerootResult> {
    const affectedNodeIds = getSpatiallyIndexedSkeletonPathToRoot(
      request.segmentNodes,
      request.node,
    ).map((node) => node.nodeId);
    const result =
      request.nocheck === true
        ? await this.client.rerootSkeleton(request.node.nodeId, undefined, {
            nocheck: true,
          })
        : await this.client.rerootSkeleton(
            request.node.nodeId,
            buildCatmaidRerootEditContext(request.node, request.segmentNodes),
          );
    let nodeSourceStateUpdates: readonly CatmaidSpatialSkeletonNodeSourceStateUpdate[];
    try {
      nodeSourceStateUpdates = await getFreshRerootSourceStateUpdates(
        this.client,
        request.node.segmentId,
        affectedNodeIds,
      );
    } catch (error) {
      throw new CatmaidRerootSourceStateRefreshError(error);
    }
    return {
      ...result,
      nodeSourceStateUpdates,
    };
  }

  private commitDescription(
    request: CatmaidSpatialSkeletonDescriptionUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonDescriptionUpdateResult> {
    return this.client.updateDescription(
      request.node.nodeId,
      request.description,
      {
        isTrueEnd: request.isTrueEnd ?? request.node.isTrueEnd === true,
      },
    );
  }

  private commitTrueEnd(
    request: CatmaidSpatialSkeletonTrueEndUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonNodeSourceStateResult> {
    return this.client.toggleTrueEnd(request.node.nodeId, request.isTrueEnd);
  }

  private commitRadius(
    request: CatmaidSpatialSkeletonRadiusUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonNodeSourceStateResult> {
    return this.client.updateRadius(
      request.node.nodeId,
      request.radius,
      buildCatmaidNodeEditContext(request.node),
    );
  }

  private commitConfidence(
    request: CatmaidSpatialSkeletonConfidenceUpdateRequest,
  ): Promise<CatmaidSpatialSkeletonNodeSourceStateResult> {
    return this.client.updateConfidence(
      request.node.nodeId,
      request.confidence,
      buildCatmaidNodeEditContext(request.node),
    );
  }

  private commitMerge(
    request: CatmaidSpatialSkeletonMergeRequest,
  ): Promise<CatmaidSpatialSkeletonMergeResult> {
    return request.nocheck === true
      ? this.client.mergeSkeletons(
          request.fromNode.nodeId,
          request.toNode.nodeId,
          undefined,
          { nocheck: true },
        )
      : this.client.mergeSkeletons(
          request.fromNode.nodeId,
          request.toNode.nodeId,
          buildCatmaidMultiNodeEditContext(request.fromNode, request.toNode),
        );
  }

  private commitSplit(
    request: CatmaidSpatialSkeletonSplitRequest,
  ): Promise<CatmaidSpatialSkeletonSplitResult> {
    return request.nocheck === true
      ? this.client.splitSkeleton(request.node.nodeId, undefined, {
          nocheck: true,
        })
      : this.client.splitSkeleton(
          request.node.nodeId,
          buildCatmaidNeighborhoodEditContext(
            request.node,
            request.segmentNodes,
          ),
        );
  }

  private createAddNodeCommand(
    layer: SegmentationUserLayer,
    options: CatmaidSpatialSkeletonAddNodeCommandOptions,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new AddNodeCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(options.parentNodeId),
      commandMappings.getStableOrCurrentSegmentId(options.skeletonId) ??
        options.skeletonId,
      toCatmaidPositionInModelSpace(
        options.positionInModelSpace,
        "add-node position",
      ),
      this.editOperations,
      this.editContext.getOptimisticSkeletonEdits?.(layer) === true,
    );
  }

  private createInsertNodeCommand(
    layer: SegmentationUserLayer,
    options: CatmaidSpatialSkeletonInsertNodeCommandOptions,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new InsertNodeCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(options.parentNodeId)!,
      options.childNodeIds.map(
        (childNodeId) => commandMappings.getStableOrCurrentNodeId(childNodeId)!,
      ),
      commandMappings.getStableOrCurrentSegmentId(options.skeletonId) ??
        options.skeletonId,
      toCatmaidPositionInModelSpace(
        options.positionInModelSpace,
        "insert-node position",
      ),
      this.editOperations,
    );
  }

  private createMoveNodeCommand(
    layer: SegmentationUserLayer,
    options: CatmaidSpatialSkeletonMoveNodeCommandOptions,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new MoveNodeCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(options.node.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(options.node.segmentId),
      toCatmaidPositionInModelSpace(
        options.node.position,
        "move-node current position",
      ),
      toCatmaidPositionInModelSpace(
        options.nextPositionInModelSpace,
        "move-node target position",
      ),
      this.editOperations,
      this.editContext.getOptimisticSkeletonEdits?.(layer) === true,
    );
  }

  private createDeleteNodeCommand(
    layer: SegmentationUserLayer,
    node: SpatiallyIndexedSkeletonNode,
  ) {
    const segmentNodes = layer.getCachedSpatialSkeletonSegmentNodesForEdit(
      node.segmentId,
    );
    const refreshedNode = findSpatiallyIndexedSkeletonNode(
      segmentNodes,
      node.nodeId,
    );
    if (refreshedNode === undefined) {
      throw new Error(
        `Node ${node.nodeId} is not available in the inspected skeleton cache.`,
      );
    }
    const childNodes = getSpatiallyIndexedSkeletonDirectChildren(
      segmentNodes,
      refreshedNode.nodeId,
    );
    return new DeleteNodeCommand(
      layer,
      refreshedNode,
      childNodes,
      this.editOperations,
      this.editContext.getOptimisticSkeletonEdits?.(layer) === true,
    );
  }

  private createNodeDescriptionCommand(
    layer: SegmentationUserLayer,
    options: CatmaidSpatialSkeletonNodeDescriptionCommandOptions,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new NodeDescriptionCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(options.node.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(options.node.segmentId),
      options.node.description,
      options.nextDescription ?? options.node.description,
      this.editOperations,
    );
  }

  private createNodeTrueEndCommand(
    layer: SegmentationUserLayer,
    options: CatmaidSpatialSkeletonNodeTrueEndCommandOptions,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new NodeTrueEndCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(options.node.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(options.node.segmentId),
      options.node.isTrueEnd ?? false,
      options.nextIsTrueEnd,
      this.editOperations,
    );
  }

  private createNodeRadiusCommand(
    layer: SegmentationUserLayer,
    options: CatmaidSpatialSkeletonNodeRadiusCommandOptions,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new NodeRadiusCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(options.node.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(options.node.segmentId),
      options.node.radius ?? 0,
      options.nextRadius,
      this.editOperations,
    );
  }

  private createNodeConfidenceCommand(
    layer: SegmentationUserLayer,
    options: CatmaidSpatialSkeletonNodeConfidenceCommandOptions,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new NodeConfidenceCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(options.node.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(options.node.segmentId),
      options.node.confidence ?? 0,
      options.nextConfidence,
      this.editOperations,
    );
  }

  private createRerootCommand(
    layer: SegmentationUserLayer,
    node: Pick<
      SpatiallyIndexedSkeletonNode,
      "nodeId" | "segmentId" | "parentNodeId"
    >,
  ) {
    const segmentNodes = layer.getCachedSpatialSkeletonSegmentNodesForEdit(
      node.segmentId,
    );
    const rootNode =
      findRootNode(segmentNodes) ??
      (() => {
        throw new Error(
          `Unable to resolve the current root for segment ${node.segmentId}.`,
        );
      })();
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new RerootCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(node.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(node.segmentId),
      commandMappings.getStableOrCurrentNodeId(rootNode.nodeId)!,
      this.editOperations,
    );
  }

  private createSplitCommand(
    layer: SegmentationUserLayer,
    node: Pick<SpatiallyIndexedSkeletonNode, "nodeId" | "segmentId">,
  ) {
    const segmentNodes = layer.getCachedSpatialSkeletonSegmentNodesForEdit(
      node.segmentId,
    );
    const splitNode = findSpatiallyIndexedSkeletonNode(
      segmentNodes,
      node.nodeId,
    );
    if (splitNode === undefined) {
      throw new Error(
        `Node ${node.nodeId} is not available in the inspected skeleton cache.`,
      );
    }
    if (splitNode.parentNodeId === undefined) {
      throw new Error("Cannot split at the root node.");
    }
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new SplitCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(splitNode.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(splitNode.segmentId),
      commandMappings.getStableOrCurrentNodeId(splitNode.parentNodeId),
      this.editOperations,
      this.editContext.getOptimisticSkeletonEdits?.(layer) === true,
    );
  }

  private createMergeCommand(
    layer: SegmentationUserLayer,
    firstNode: CatmaidSpatialSkeletonMergeEndpoint,
    secondNode: CatmaidSpatialSkeletonMergeEndpoint,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new MergeCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(firstNode.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(firstNode.segmentId),
      commandMappings.getStableOrCurrentNodeId(secondNode.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(secondNode.segmentId),
      secondNode.sourceState,
      secondNode.position === undefined
        ? undefined
        : toCatmaidPositionInModelSpace(
            secondNode.position,
            "merge second-node position",
          ),
      this.editOperations,
      this.editContext.getOptimisticSkeletonEdits?.(layer) === true,
    );
  }
}
