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
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/actions.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonSourceState,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";
import type { SpatialSkeletonEditCommandFactory } from "#src/skeleton/command_factories.js";
import type {
  SpatialSkeletonCommand,
  SpatialSkeletonCommandContext,
} from "#src/skeleton/command_history.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/frontend.js";
import {
  findSpatiallyIndexedSkeletonNode,
  getSpatiallyIndexedSkeletonDirectChildren,
  getSpatiallyIndexedSkeletonNodeParent,
  getSpatiallyIndexedSkeletonPathToRoot,
  getSpatiallyIndexedSkeletonSubtreeNodes,
} from "#src/skeleton/node_traversal.js";
import { getEditableSpatiallyIndexedSkeletonSource } from "#src/skeleton/spatial_skeleton_manager.js";
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

function validateCatmaidNodeDescription(description: string | undefined) {
  if (description === undefined) return;
  for (const line of description.split(/\r?\n/)) {
    if (line.trim().includes(",")) {
      throw new Error("Node descriptions containing commas are not supported.");
    }
  }
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
) {
  const preRefreshPositions = [...affectedPositions];
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
  skeletonLayer.invalidateSourceCellsForPositions(preRefreshPositions);
  layer.spatialSkeletonState.invalidateCachedSegments(normalizedSegmentIds);
  layer.markSpatialSkeletonNodeDataChanged({
    invalidateFullSkeletonCache: false,
  });
  await Promise.allSettled(
    normalizedSegmentIds.map((segmentId) =>
      layer.spatialSkeletonState.getFullSegmentNodes(skeletonLayer, segmentId),
    ),
  );
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
  layer.spatialSkeletonState.upsertCachedNode(nextNode);
  return nextNode;
}

class AddNodeCommand implements SpatialSkeletonCommand {
  readonly label = "Add node";
  private stableNodeId: number | undefined;
  private stableSegmentId: number | undefined;

  constructor(
    private layer: SegmentationUserLayer,
    private stableParentNodeId: number | undefined,
    private targetSkeletonId: number,
    private positionInModelSpace: Float32Array,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  private async addNode(
    _context: SpatialSkeletonCommandContext,
    options: {
      moveView: boolean;
      pinSegment: boolean;
      statusPrefix: string;
    },
  ) {
    const { skeletonLayer } = getEditableSkeletonSourceForLayer(this.layer);
    const currentParentNodeId =
      this.stableParentNodeId === undefined
        ? undefined
        : this.layer.spatialSkeletonState.commandHistory.mappings.resolveNodeId(
            this.stableParentNodeId,
          );
    let parentNode: SpatiallyIndexedSkeletonNode | undefined;
    let resolvedSkeletonId = this.targetSkeletonId;
    if (currentParentNodeId !== undefined) {
      parentNode = (
        await getResolvedNodeForEdit(
          this.layer,
          this.stableParentNodeId!,
          this.layer.spatialSkeletonState.commandHistory.mappings.getStableOrCurrentSegmentId(
            this.targetSkeletonId,
          ),
        )
      ).node;
      resolvedSkeletonId = parentNode.segmentId;
    }
    const result = await this.editOperations.commitAddNode({
      segmentId: resolvedSkeletonId,
      position: this.positionInModelSpace,
      parentNode,
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

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private beforePositionInModelSpace: Float32Array,
    private afterPositionInModelSpace: Float32Array,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  private async moveTo(
    positionInModelSpace: Float32Array,
    statusPrefix: string,
  ) {
    const { node, skeletonLayer } = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
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

  private async restoreDeletedNode(statusPrefix: string) {
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
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} node ${restoredNodeWithAttributes.nodeId}.`,
    );
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
    validateCatmaidNodeDescription(nextDescription);
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
    const result = await this.editOperations.commitReroot({
      node: resolvedNode.node,
      segmentNodes: resolvedNode.segmentNodes,
    });
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
  private stableNewSegmentId: number | undefined;

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private stableFormerParentNodeId: number | undefined,
    private editOperations: CatmaidSpatialSkeletonEditOperations,
  ) {}

  private async split(statusPrefix: string) {
    const resolvedNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
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
      splitNode.skeletonLayer.suppressBrowseSegment(deletedSkeletonId);
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
  ) {}

  private async resolveSecondNodeForMerge() {
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

  private async merge(statusPrefix: string) {
    const firstNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableFirstNodeId,
      this.stableFirstSegmentId,
    );
    const secondNode = await this.resolveSecondNodeForMerge();
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
      firstNode.skeletonLayer.suppressBrowseSegment(deletedSkeletonId);
    }
    this.layer.clearSpatialSkeletonMergeAnchor();
    await refreshTopologySegments(
      this.layer,
      [resultSkeletonId, deletedSkeletonId],
      getMergeAffectedPositions(result.deletedSegmentId, firstNode, secondNode),
    );
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
      request.parentNode === undefined
        ? undefined
        : buildCatmaidNodeEditContext(request.parentNode),
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
    });
  }

  private commitReroot(
    request: CatmaidSpatialSkeletonRerootRequest,
  ): Promise<CatmaidSpatialSkeletonRerootResult> {
    return this.client.rerootSkeleton(
      request.node.nodeId,
      buildCatmaidRerootEditContext(request.node, request.segmentNodes),
    );
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
    return this.client.mergeSkeletons(
      request.fromNode.nodeId,
      request.toNode.nodeId,
      buildCatmaidMultiNodeEditContext(request.fromNode, request.toNode),
    );
  }

  private commitSplit(
    request: CatmaidSpatialSkeletonSplitRequest,
  ): Promise<CatmaidSpatialSkeletonSplitResult> {
    return this.client.splitSkeleton(
      request.node.nodeId,
      buildCatmaidNeighborhoodEditContext(request.node, request.segmentNodes),
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
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new SplitCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(splitNode.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(splitNode.segmentId),
      commandMappings.getStableOrCurrentNodeId(splitNode.parentNodeId),
      this.editOperations,
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
    );
  }
}
