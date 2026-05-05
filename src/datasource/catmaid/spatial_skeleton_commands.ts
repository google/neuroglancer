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

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type {
  CatmaidAddNodeResult,
  CatmaidEditContext,
  CatmaidInsertNodeResult,
  CatmaidMergeResult,
  CatmaidSkeletonNodeSourceStateUpdate,
  CatmaidSplitResult,
  CatmaidSpatialSkeletonEditApi,
} from "#src/datasource/catmaid/api.js";
import { getCatmaidRevisionToken } from "#src/datasource/catmaid/api.js";
import {
  buildCatmaidMultiNodeEditContext,
  buildCatmaidNeighborhoodEditContext,
  buildCatmaidNodeEditContext,
  buildCatmaidRerootEditContext,
} from "#src/datasource/catmaid/edit_state.js";
import {
  addSegmentToVisibleSets,
  removeSegmentFromVisibleSets,
} from "#src/segmentation_display_state/base.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonSourceState,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/actions.js";
import type {
  SpatialSkeletonCommand,
  SpatialSkeletonCommandContext,
} from "#src/skeleton/command_history.js";
import type { SpatialSkeletonEditCommandSource } from "#src/skeleton/edit_command_source.js";
import {
  findSpatiallyIndexedSkeletonNode,
  getSpatiallyIndexedSkeletonDirectChildren,
} from "#src/skeleton/edit_state.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/frontend.js";
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

interface CatmaidSpatialSkeletonNodePropertiesCommandOptions {
  node: SpatiallyIndexedSkeletonNode;
  next: { radius: number; confidence: number };
}

interface CatmaidSpatialSkeletonMergeEndpoint {
  nodeId: number;
  segmentId: number;
  sourceState?: SpatialSkeletonSourceState;
}

interface CatmaidSpatialSkeletonMergeCommandPayload {
  firstNode: CatmaidSpatialSkeletonMergeEndpoint;
  secondNode: CatmaidSpatialSkeletonMergeEndpoint;
}

type CatmaidSpatialSkeletonCommandHandler = (
  layer: SegmentationUserLayer,
  payload: object,
) => SpatialSkeletonCommand;

function hasFunction<T extends string>(
  value: object | undefined,
  property: T,
): value is Record<T, (...args: never[]) => object> {
  return (
    value !== undefined &&
    typeof (value as Partial<Record<T, (...args: never[]) => object>>)[
      property
    ] === "function"
  );
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
    value !== undefined &&
    isFiniteNumber((value as { length?: number }).length)
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
  };
  return isFiniteNumber(candidate.nodeId) && isFiniteNumber(candidate.segmentId);
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
    (candidate): candidate is CatmaidSpatialSkeletonInsertNodeCommandOptions => {
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

function requireCatmaidNodePropertiesCommandOptions(payload: object) {
  return requireCatmaidCommandPayload(
    payload,
    "node-properties",
    (
      candidate,
    ): candidate is CatmaidSpatialSkeletonNodePropertiesCommandOptions => {
      const options = candidate as {
        node?: object;
        next?: object;
      };
      const next = options.next as
        | { radius?: number; confidence?: number }
        | undefined;
      return (
        isSpatiallyIndexedSkeletonNodePayload(options.node) &&
        next !== undefined &&
        isFiniteNumber(next.radius) &&
        isFiniteNumber(next.confidence)
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

function isCatmaidSpatialSkeletonEditApi(
  value: object | undefined,
): value is CatmaidSpatialSkeletonEditApi {
  return (
    hasFunction(value, "getSkeletonRootNode") &&
    hasFunction(value, "addNode") &&
    hasFunction(value, "insertNode") &&
    hasFunction(value, "moveNode") &&
    hasFunction(value, "deleteNode") &&
    hasFunction(value, "updateDescription") &&
    hasFunction(value, "toggleTrueEnd") &&
    hasFunction(value, "updateRadius") &&
    hasFunction(value, "updateConfidence") &&
    hasFunction(value, "mergeSkeletons") &&
    hasFunction(value, "splitSkeleton")
  );
}

function toCatmaidPositionInModelSpace(
  position: SpatialSkeletonVector,
  label: string,
) {
  if (position.length < 3) {
    throw new Error(`CATMAID ${label} requires at least 3 coordinates.`);
  }
  const values = [
    Number(position[0]),
    Number(position[1]),
    Number(position[2]),
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`CATMAID ${label} coordinates must be finite.`);
  }
  return new Float32Array(values);
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
  skeletonSource: CatmaidSpatialSkeletonEditApi;
} {
  const skeletonLayer = layer.getSpatiallyIndexedSkeletonLayer();
  if (skeletonLayer === undefined) {
    throw new Error(
      "No spatially indexed skeleton source is currently loaded.",
    );
  }
  const skeletonSource = isCatmaidSpatialSkeletonEditApi(skeletonLayer.source)
    ? skeletonLayer.source
    : undefined;
  if (skeletonSource === undefined) {
    throw new Error(
      "Unable to resolve CATMAID editable skeleton source for the active layer.",
    );
  }
  return { skeletonLayer, skeletonSource };
}

function ensureVisibleSegment(
  layer: SegmentationUserLayer,
  segmentId: number | undefined,
) {
  if (
    segmentId === undefined ||
    !Number.isSafeInteger(Math.round(Number(segmentId))) ||
    Math.round(Number(segmentId)) <= 0
  ) {
    return;
  }
  addSegmentToVisibleSets(
    layer.displayState.segmentationGroupState.value,
    BigInt(Math.round(Number(segmentId))),
  );
}

function selectSegment(
  layer: SegmentationUserLayer,
  segmentId: number | undefined,
  pin: boolean,
) {
  if (
    segmentId === undefined ||
    !Number.isSafeInteger(Math.round(Number(segmentId))) ||
    Math.round(Number(segmentId)) <= 0
  ) {
    return;
  }
  layer.selectSegment(BigInt(Math.round(Number(segmentId))), pin);
}

function removeVisibleSegment(
  layer: SegmentationUserLayer,
  segmentId: number | undefined,
  options: {
    deselect?: boolean;
  } = {},
) {
  if (
    segmentId === undefined ||
    !Number.isSafeInteger(Math.round(Number(segmentId))) ||
    Math.round(Number(segmentId)) <= 0
  ) {
    return;
  }
  removeSegmentFromVisibleSets(
    layer.displayState.segmentationGroupState.value,
    BigInt(Math.round(Number(segmentId))),
    options,
  );
}

function findRootNode(segmentNodes: readonly SpatiallyIndexedSkeletonNode[]) {
  return segmentNodes.find((candidate) => candidate.parentNodeId === undefined);
}

interface ResolvedSpatialSkeletonEditNode {
  skeletonLayer: SpatiallyIndexedSkeletonLayer;
  skeletonSource: CatmaidSpatialSkeletonEditApi;
  segmentNodes: readonly SpatiallyIndexedSkeletonNode[];
  node: SpatiallyIndexedSkeletonNode;
}

interface ResolvedSpatialSkeletonEditNodeContext {
  currentNodeId: number;
  segmentId: number;
  cachedNode: SpatiallyIndexedSkeletonNode | undefined;
  skeletonLayer: SpatiallyIndexedSkeletonLayer;
  skeletonSource: CatmaidSpatialSkeletonEditApi;
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
  const { skeletonLayer, skeletonSource } =
    getEditableSkeletonSourceForLayer(layer);
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
    skeletonSource,
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
    skeletonSource,
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
    skeletonSource,
    segmentNodes,
    node,
  };
}

function buildInsertEditContext(
  parentNode: SpatiallyIndexedSkeletonNode,
  childNodes: readonly SpatiallyIndexedSkeletonNode[],
): CatmaidEditContext {
  return {
    node: buildCatmaidNodeEditContext(parentNode).node,
    children: childNodes.map((child) => {
      const revisionToken = getCatmaidRevisionToken(child.sourceState);
      if (revisionToken === undefined) {
        throw new Error(
          `Inspected CATMAID child node ${child.nodeId} is missing revision metadata.`,
        );
      }
      return { nodeId: child.nodeId, revisionToken };
    }),
  };
}

async function refreshTopologySegments(
  layer: SegmentationUserLayer,
  segmentIds: readonly number[],
) {
  const normalizedSegmentIds = [
    ...new Set(
      segmentIds.filter((value) => Number.isSafeInteger(Math.round(value))),
    ),
  ].map((value) => Math.round(value));
  if (normalizedSegmentIds.length === 0) {
    return;
  }
  const { skeletonLayer } = getEditableSkeletonSourceForLayer(layer);
  layer.spatialSkeletonState.invalidateCachedSegments(normalizedSegmentIds);
  layer.markSpatialSkeletonNodeDataChanged({
    invalidateFullSkeletonCache: false,
  });
  skeletonLayer.invalidateSourceCaches();
  await Promise.allSettled(
    normalizedSegmentIds.map((segmentId) =>
      layer.spatialSkeletonState.getFullSegmentNodes(skeletonLayer, segmentId),
    ),
  );
}

function applyAddNodeToCache(
  layer: SegmentationUserLayer,
  skeletonLayer: SpatiallyIndexedSkeletonLayer,
  committedNode: CatmaidAddNodeResult,
  parentNodeId: number | undefined,
  positionInModelSpace: Float32Array,
  options: {
    focusSelection: boolean;
    moveView: boolean;
    pinSegment: boolean;
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
  if (
    parentNodeId !== undefined &&
    committedNode.parentSourceState !== undefined
  ) {
    layer.spatialSkeletonState.setCachedNodeSourceState(
      parentNodeId,
      committedNode.parentSourceState,
    );
  }
  ensureVisibleSegment(layer, newNode.segmentId);
  selectSegment(layer, newNode.segmentId, options.pinSegment);
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
  if (parentNodeId !== undefined) {
    skeletonLayer.retainOverlaySegment(newNode.segmentId);
  }
  layer.markSpatialSkeletonNodeDataChanged({
    invalidateFullSkeletonCache: false,
  });
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
  nodeSourceStateUpdates: readonly CatmaidSkeletonNodeSourceStateUpdate[] = [],
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

async function applyNodeDescriptionAndTrueEnd(
  skeletonSource: CatmaidSpatialSkeletonEditApi,
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
    const descriptionResult = await skeletonSource.updateDescription(
      node.nodeId,
      nextDescription ?? "",
    );
    updatedNode = {
      ...updatedNode,
      description: descriptionResult.description,
      sourceState: descriptionResult.sourceState ?? updatedNode.sourceState,
    };
  }
  if (node.isTrueEnd !== nextTrueEnd || (descriptionChanged && nextTrueEnd)) {
    const trueEndResult = await skeletonSource.toggleTrueEnd(
      node.nodeId,
      nextTrueEnd,
    );
    updatedNode = {
      ...updatedNode,
      sourceState: trueEndResult.sourceState ?? updatedNode.sourceState,
    };
  }
  return updatedNode;
}

async function restoreNodeAttributes(
  layer: SegmentationUserLayer,
  skeletonSource: CatmaidSpatialSkeletonEditApi,
  createdNode: SpatiallyIndexedSkeletonNode,
  snapshot: SpatiallyIndexedSkeletonNode,
) {
  let nextNode = cloneNodeSnapshot(createdNode);
  if (snapshot.radius !== undefined && snapshot.radius !== nextNode.radius) {
    const radiusResult = await skeletonSource.updateRadius(
      createdNode.nodeId,
      snapshot.radius,
      buildCatmaidNodeEditContext(nextNode),
    );
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
    if (getCatmaidRevisionToken(nextNode.sourceState) === undefined) {
      throw new Error(
        `Node ${createdNode.nodeId} is missing revision metadata required to restore confidence.`,
      );
    }
    const confidenceResult = await skeletonSource.updateConfidence(
      createdNode.nodeId,
      snapshot.confidence,
      buildCatmaidNodeEditContext(nextNode),
    );
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
      skeletonSource,
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
  ) {}

  private async addNode(
    _context: SpatialSkeletonCommandContext,
    options: {
      moveView: boolean;
      pinSegment: boolean;
      statusPrefix: string;
    },
  ) {
    const { skeletonLayer, skeletonSource } = getEditableSkeletonSourceForLayer(
      this.layer,
    );
    const currentParentNodeId =
      this.stableParentNodeId === undefined
        ? undefined
        : this.layer.spatialSkeletonState.commandHistory.mappings.resolveNodeId(
            this.stableParentNodeId,
          );
    let resolvedEditContext: CatmaidEditContext | undefined;
    let resolvedSkeletonId = this.targetSkeletonId;
    if (currentParentNodeId !== undefined) {
      const parentNode = (
        await getResolvedNodeForEdit(
          this.layer,
          this.stableParentNodeId!,
          this.layer.spatialSkeletonState.commandHistory.mappings.getStableOrCurrentSegmentId(
            this.targetSkeletonId,
          ),
        )
      ).node;
      resolvedSkeletonId = parentNode.segmentId;
      resolvedEditContext = buildCatmaidNodeEditContext(parentNode);
    }
    const result = await skeletonSource.addNode(
      resolvedSkeletonId,
      Number(this.positionInModelSpace[0]),
      Number(this.positionInModelSpace[1]),
      Number(this.positionInModelSpace[2]),
      currentParentNodeId,
      resolvedEditContext,
    );
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
    applyAddNodeToCache(
      this.layer,
      skeletonLayer,
      result,
      currentParentNodeId,
      this.positionInModelSpace,
      {
        focusSelection: true,
        moveView: options.moveView,
        pinSegment: options.pinSegment,
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
    const resolvedNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    const deleteContext =
      await this.layer.getSpatialSkeletonDeleteOperationContext(
        resolvedNode.node,
      );
    const result = await resolvedNode.skeletonSource.deleteNode(
      resolvedNode.node.nodeId,
      {
        childNodeIds: [],
        editContext: buildCatmaidNeighborhoodEditContext(
          deleteContext.node,
          resolvedNode.segmentNodes,
        ),
      },
    );
    applyDeleteNodeToCache(
      this.layer,
      deleteContext,
      { moveView: true },
      result.nodeSourceStateUpdates,
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
  ) {}

  private async insertNode(options: {
    moveView: boolean;
    pinSegment: boolean;
    statusPrefix: string;
  }) {
    const { skeletonLayer, skeletonSource } = getEditableSkeletonSourceForLayer(
      this.layer,
    );
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
    const result = await skeletonSource.insertNode(
      parentNode.segmentId,
      Number(this.positionInModelSpace[0]),
      Number(this.positionInModelSpace[1]),
      Number(this.positionInModelSpace[2]),
      parentNode.nodeId,
      childNodes.map((child) => child.nodeId),
      buildInsertEditContext(parentNode, childNodes),
    );
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
    const newNode: SpatiallyIndexedSkeletonNode = {
      nodeId: result.nodeId,
      segmentId: result.segmentId,
      position: new Float32Array(this.positionInModelSpace),
      parentNodeId: parentNode.nodeId,
      isTrueEnd: false,
      ...(result.sourceState === undefined
        ? {}
        : { sourceState: result.sourceState }),
    };
    this.layer.spatialSkeletonState.upsertCachedNode(newNode);
    for (const childNode of childNodes) {
      this.layer.spatialSkeletonState.setCachedNodeParent(
        childNode.nodeId,
        newNode.nodeId,
      );
    }
    if (result.parentSourceState !== undefined) {
      this.layer.spatialSkeletonState.setCachedNodeSourceState(
        parentNode.nodeId,
        result.parentSourceState,
      );
    }
    if (result.nodeSourceStateUpdates?.length) {
      this.layer.spatialSkeletonState.setCachedNodeSourceStates(
        result.nodeSourceStateUpdates,
      );
    }
    ensureVisibleSegment(this.layer, newNode.segmentId);
    selectSegment(this.layer, newNode.segmentId, options.pinSegment);
    this.layer.selectSpatialSkeletonNode(
      newNode.nodeId,
      this.layer.manager.root.selectionState.pin.value,
      {
        segmentId: newNode.segmentId,
        position: newNode.position,
      },
    );
    if (options.moveView) {
      this.layer.moveViewToSpatialSkeletonNodePosition(newNode.position);
    }
    skeletonLayer.retainOverlaySegment(newNode.segmentId);
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    StatusMessage.showTemporaryMessage(
      `${options.statusPrefix} node ${result.nodeId} on segment ${result.segmentId}.`,
    );
  }

  private async deleteInsertedNode(statusPrefix: string) {
    if (this.stableNodeId === undefined) {
      throw new Error("Insert-node undo is missing the created node id.");
    }
    const resolvedNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    const deleteContext =
      await this.layer.getSpatialSkeletonDeleteOperationContext(
        resolvedNode.node,
      );
    const result = await resolvedNode.skeletonSource.deleteNode(
      resolvedNode.node.nodeId,
      {
        childNodeIds: deleteContext.childNodes.map((child) => child.nodeId),
        editContext: buildCatmaidNeighborhoodEditContext(
          deleteContext.node,
          resolvedNode.segmentNodes,
        ),
      },
    );
    applyDeleteNodeToCache(
      this.layer,
      deleteContext,
      { moveView: false },
      result.nodeSourceStateUpdates,
    );
    resolvedNode.skeletonLayer.invalidateSourceCaches();
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
  ) {}

  private async moveTo(
    positionInModelSpace: Float32Array,
    statusPrefix: string,
  ) {
    const { node, skeletonLayer, skeletonSource } =
      await getResolvedNodeForEdit(
        this.layer,
        this.stableNodeId,
        this.stableSegmentId,
      );
    const result = await skeletonSource.moveNode(
      node.nodeId,
      Number(positionInModelSpace[0]),
      Number(positionInModelSpace[1]),
      Number(positionInModelSpace[2]),
      buildCatmaidNodeEditContext(node),
    );
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
    const resolvedNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableDeletedNodeId,
      this.stableSegmentId,
    );
    const deleteContext =
      await this.layer.getSpatialSkeletonDeleteOperationContext(
        resolvedNode.node,
      );
    const result = await resolvedNode.skeletonSource.deleteNode(
      resolvedNode.node.nodeId,
      {
        childNodeIds: deleteContext.childNodes.map((child) => child.nodeId),
        editContext: buildCatmaidNeighborhoodEditContext(
          deleteContext.node,
          resolvedNode.segmentNodes,
        ),
      },
    );
    applyDeleteNodeToCache(
      this.layer,
      deleteContext,
      { moveView: options.moveView },
      result.nodeSourceStateUpdates,
    );
    resolvedNode.skeletonLayer.invalidateSourceCaches();
    StatusMessage.showTemporaryMessage(
      `${options.statusPrefix} node ${resolvedNode.node.nodeId}.`,
    );
  }

  private async restoreDeletedNode(statusPrefix: string) {
    const { skeletonSource } = getEditableSkeletonSourceForLayer(this.layer);
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
    const createResult: CatmaidAddNodeResult | CatmaidInsertNodeResult =
      currentChildNodes.length === 0
        ? await skeletonSource.addNode(
            currentParentNode?.segmentId ?? 0,
            Number(this.deletedSnapshot.position[0]),
            Number(this.deletedSnapshot.position[1]),
            Number(this.deletedSnapshot.position[2]),
            currentParentNode?.nodeId,
            currentParentNode === undefined
              ? undefined
              : buildCatmaidNodeEditContext(currentParentNode),
          )
        : await skeletonSource.insertNode(
            currentParentNode?.segmentId ?? this.deletedSnapshot.segmentId,
            Number(this.deletedSnapshot.position[0]),
            Number(this.deletedSnapshot.position[1]),
            Number(this.deletedSnapshot.position[2]),
            currentParentNode?.nodeId ??
              (() => {
                throw new Error(
                  "Delete-node undo is missing the parent node needed for insertion.",
                );
              })(),
            currentChildNodes.map((child) => child.nodeId),
            buildInsertEditContext(currentParentNode!, currentChildNodes),
          );
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
    const restoredNode: SpatiallyIndexedSkeletonNode = {
      nodeId: createResult.nodeId,
      segmentId: createResult.segmentId,
      position: new Float32Array(this.deletedSnapshot.position),
      parentNodeId: currentParentNode?.nodeId,
      sourceState: createResult.sourceState,
      radius: undefined,
      confidence: undefined,
      description: undefined,
      isTrueEnd: false,
    };
    this.layer.spatialSkeletonState.upsertCachedNode(restoredNode, {
      allowUncachedSegment: currentParentNode === undefined,
    });
    for (const childNode of currentChildNodes) {
      this.layer.spatialSkeletonState.setCachedNodeParent(
        childNode.nodeId,
        restoredNode.nodeId,
      );
    }
    if (createResult.parentSourceState !== undefined && currentParentNode) {
      this.layer.spatialSkeletonState.setCachedNodeSourceState(
        currentParentNode.nodeId,
        createResult.parentSourceState,
      );
    }
    if (createResult.nodeSourceStateUpdates?.length) {
      this.layer.spatialSkeletonState.setCachedNodeSourceStates(
        createResult.nodeSourceStateUpdates,
      );
    }
    const restoredNodeWithAttributes = await restoreNodeAttributes(
      this.layer,
      skeletonSource,
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
  ) {}

  private async applyDescription(
    nextDescription: string | undefined,
    statusPrefix: string,
  ) {
    const { node, skeletonSource } = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    if (node.description === nextDescription) {
      return;
    }
    const result = await skeletonSource.updateDescription(
      node.nodeId,
      nextDescription ?? "",
    );
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
  ) {}

  private async applyTrueEnd(nextIsTrueEnd: boolean, statusPrefix: string) {
    const { node, skeletonSource } = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    if (node.isTrueEnd === nextIsTrueEnd) {
      return;
    }
    const result = await skeletonSource.toggleTrueEnd(
      node.nodeId,
      nextIsTrueEnd,
    );
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

class NodePropertiesCommand implements SpatialSkeletonCommand {
  readonly label = "Edit node properties";

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private before: { radius: number; confidence: number },
    private after: { radius: number; confidence: number },
  ) {}

  private async applyProperties(
    next: { radius: number; confidence: number },
    statusPrefix: string,
  ) {
    const { node, skeletonSource } = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    let currentNode = cloneNodeSnapshot(node);
    if (currentNode.radius !== next.radius) {
      const radiusResult = await skeletonSource.updateRadius(
        node.nodeId,
        next.radius,
        buildCatmaidNodeEditContext(currentNode),
      );
      currentNode = {
        ...currentNode,
        radius: next.radius,
        sourceState: radiusResult.sourceState ?? currentNode.sourceState,
      };
    }
    if (currentNode.confidence !== next.confidence) {
      if (getCatmaidRevisionToken(currentNode.sourceState) === undefined) {
        throw new Error(
          `Node ${node.nodeId} is missing revision metadata required to update confidence.`,
        );
      }
      const confidenceResult = await skeletonSource.updateConfidence(
        node.nodeId,
        next.confidence,
        buildCatmaidNodeEditContext(currentNode),
      );
      currentNode = {
        ...currentNode,
        confidence: next.confidence,
        sourceState: confidenceResult.sourceState ?? currentNode.sourceState,
      };
    }
    this.layer.spatialSkeletonState.setNodeProperties(node.nodeId, next);
    if (currentNode.sourceState !== undefined) {
      this.layer.spatialSkeletonState.setCachedNodeSourceState(
        node.nodeId,
        currentNode.sourceState,
      );
    }
    this.layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });
    StatusMessage.showTemporaryMessage(
      `${statusPrefix} node ${node.nodeId} properties.`,
    );
  }

  execute() {
    return this.applyProperties(this.after, "Updated");
  }

  undo() {
    return this.applyProperties(this.before, "Undid property update for");
  }

  redo() {
    return this.applyProperties(this.after, "Redid property update for");
  }
}

class RerootCommand implements SpatialSkeletonCommand {
  readonly label = "Reroot skeleton";

  constructor(
    private layer: SegmentationUserLayer,
    private stableNodeId: number,
    private stableSegmentId: number | undefined,
    private stablePreviousRootNodeId: number,
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
    if (resolvedNode.skeletonSource.rerootSkeleton === undefined) {
      throw new Error(
        "Unable to resolve a reroot-capable skeleton source for the active layer.",
      );
    }
    const result = await resolvedNode.skeletonSource.rerootSkeleton(
      resolvedNode.node.nodeId,
      buildCatmaidRerootEditContext(
        resolvedNode.node,
        resolvedNode.segmentNodes,
      ),
    );
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
  ) {}

  private async split(statusPrefix: string) {
    const resolvedNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableNodeId,
      this.stableSegmentId,
    );
    let result: CatmaidSplitResult;
    try {
      result = await resolvedNode.skeletonSource.splitSkeleton(
        resolvedNode.node.nodeId,
        buildCatmaidNeighborhoodEditContext(
          resolvedNode.node,
          resolvedNode.segmentNodes,
        ),
      );
    } catch (error) {
      await refreshTopologySegments(this.layer, [resolvedNode.node.segmentId]);
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
    await refreshTopologySegments(this.layer, [
      existingSkeletonId,
      newSkeletonId,
    ]);
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
    let result: CatmaidMergeResult;
    try {
      result = await formerParent.skeletonSource.mergeSkeletons(
        formerParent.node.nodeId,
        splitNode.node.nodeId,
        buildCatmaidMultiNodeEditContext(formerParent.node, splitNode.node),
      );
    } catch (error) {
      await refreshTopologySegments(this.layer, [
        splitNode.node.segmentId,
        formerParent.node.segmentId,
      ]);
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
    await refreshTopologySegments(this.layer, [
      resultSkeletonId,
      deletedSkeletonId,
    ]);
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
  ) {}

  private async merge(statusPrefix: string) {
    const firstNode = await getResolvedNodeForEdit(
      this.layer,
      this.stableFirstNodeId,
      this.stableFirstSegmentId,
    );
    const secondNodeContext = getResolvedNodeContextForEdit(
      this.layer,
      this.stableSecondNodeId,
      this.stableSecondSegmentId,
    );
    let secondNode: ResolvedSpatialSkeletonEditNode;
    let preservedSecondRootNodeId: number | undefined;
    const secondSegmentCached =
      this.layer.spatialSkeletonState.getCachedSegmentNodes(
        secondNodeContext.segmentId,
      ) !== undefined;
    const secondSourceState =
      this.secondNodeSourceState ?? secondNodeContext.cachedNode?.sourceState;
    if (
      secondSegmentCached ||
      getCatmaidRevisionToken(secondSourceState) === undefined
    ) {
      secondNode = await getResolvedNodeForEdit(
        this.layer,
        this.stableSecondNodeId,
        this.stableSecondSegmentId,
      );
    } else {
      preservedSecondRootNodeId = (
        await secondNodeContext.skeletonSource.getSkeletonRootNode(
          secondNodeContext.segmentId,
        )
      ).nodeId;
      secondNode = {
        skeletonLayer: secondNodeContext.skeletonLayer,
        skeletonSource: secondNodeContext.skeletonSource,
        segmentNodes: [],
        node: {
          nodeId: secondNodeContext.currentNodeId,
          segmentId: secondNodeContext.segmentId,
          position: new Float32Array(3),
          parentNodeId: secondNodeContext.cachedNode?.parentNodeId,
          isTrueEnd: secondNodeContext.cachedNode?.isTrueEnd ?? false,
          sourceState: secondSourceState,
        },
      };
    }
    let result: CatmaidMergeResult;
    try {
      result = await firstNode.skeletonSource.mergeSkeletons(
        firstNode.node.nodeId,
        secondNode.node.nodeId,
        buildCatmaidMultiNodeEditContext(firstNode.node, secondNode.node),
      );
    } catch (error) {
      await refreshTopologySegments(this.layer, [
        firstNode.node.segmentId,
        secondNode.node.segmentId,
      ]);
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
        : (preservedSecondRootNodeId ??
          findRootNode(secondNode.segmentNodes)?.nodeId);
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
    await refreshTopologySegments(this.layer, [
      resultSkeletonId,
      deletedSkeletonId,
    ]);
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
    let splitResult: CatmaidSplitResult;
    try {
      splitResult = await attachedNode.skeletonSource.splitSkeleton(
        attachedNode.node.nodeId,
        buildCatmaidNeighborhoodEditContext(
          attachedNode.node,
          attachedNode.segmentNodes,
        ),
      );
    } catch (error) {
      await refreshTopologySegments(this.layer, [attachedNode.node.segmentId]);
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
    await refreshTopologySegments(this.layer, [
      survivingSegmentId,
      restoredSegmentId,
    ]);
    let rerootWarning: string | undefined;
    if (
      this.stableAttachedRootNodeId !== undefined &&
      this.stableAttachedRootNodeId !== this.stableAttachedNodeId
    ) {
      try {
        const restoredRoot = await getResolvedNodeForEdit(
          this.layer,
          this.stableAttachedRootNodeId,
          this.stableDeletedSegmentId,
        );
        if (restoredRoot.node.parentNodeId !== undefined) {
          if (restoredRoot.skeletonSource.rerootSkeleton === undefined) {
            throw new Error(
              "The active skeleton source does not support reroot.",
            );
          }
          await restoredRoot.skeletonSource.rerootSkeleton(
            restoredRoot.node.nodeId,
            buildCatmaidRerootEditContext(
              restoredRoot.node,
              restoredRoot.segmentNodes,
            ),
          );
          await refreshTopologySegments(this.layer, [
            survivingSegmentId,
            restoredSegmentId,
          ]);
        }
      } catch (error) {
        await refreshTopologySegments(this.layer, [
          survivingSegmentId,
          restoredSegmentId,
        ]);
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

export class CatmaidSpatialSkeletonEditCommandSource
  implements SpatialSkeletonEditCommandSource
{
  private readonly commandHandlers: Partial<
    Record<SpatialSkeletonAction, CatmaidSpatialSkeletonCommandHandler>
  > = {
    [SpatialSkeletonActions.addNodes]: (layer, payload) =>
      this.createAddNodeCommand(
        layer,
        requireCatmaidAddNodeCommandOptions(payload),
      ),
    [SpatialSkeletonActions.insertNodes]: (layer, payload) =>
      this.createInsertNodeCommand(
        layer,
        requireCatmaidInsertNodeCommandOptions(payload),
      ),
    [SpatialSkeletonActions.moveNodes]: (layer, payload) =>
      this.createMoveNodeCommand(
        layer,
        requireCatmaidMoveNodeCommandOptions(payload),
      ),
    [SpatialSkeletonActions.deleteNodes]: (layer, payload) =>
      this.createDeleteNodeCommand(
        layer,
        requireCatmaidDeleteNodeCommandPayload(payload),
      ),
    [SpatialSkeletonActions.reroot]: (layer, payload) =>
      this.createRerootCommand(
        layer,
        requireCatmaidRerootCommandPayload(payload),
      ),
    [SpatialSkeletonActions.editNodeDescription]: (layer, payload) =>
      this.createNodeDescriptionCommand(
        layer,
        requireCatmaidNodeDescriptionCommandOptions(payload),
      ),
    [SpatialSkeletonActions.editNodeTrueEnd]: (layer, payload) =>
      this.createNodeTrueEndCommand(
        layer,
        requireCatmaidNodeTrueEndCommandOptions(payload),
      ),
    [SpatialSkeletonActions.editNodeProperties]: (layer, payload) =>
      this.createNodePropertiesCommand(
        layer,
        requireCatmaidNodePropertiesCommandOptions(payload),
      ),
    [SpatialSkeletonActions.mergeSkeletons]: (layer, payload) => {
      const options = requireCatmaidMergeCommandPayload(payload);
      return this.createMergeCommand(
        layer,
        options.firstNode,
        options.secondNode,
      );
    },
    [SpatialSkeletonActions.splitSkeletons]: (layer, payload) =>
      this.createSplitCommand(
        layer,
        requireCatmaidSplitCommandPayload(payload),
      ),
  };

  supports(action: SpatialSkeletonAction) {
    return this.commandHandlers[action] !== undefined;
  }

  createCommand(
    action: SpatialSkeletonAction,
    layer: SegmentationUserLayer,
    payload: object,
  ) {
    return this.commandHandlers[action]?.(layer, payload);
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
    return new DeleteNodeCommand(layer, refreshedNode, childNodes);
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
    );
  }

  private createNodePropertiesCommand(
    layer: SegmentationUserLayer,
    options: CatmaidSpatialSkeletonNodePropertiesCommandOptions,
  ) {
    const commandMappings = layer.spatialSkeletonState.commandHistory.mappings;
    return new NodePropertiesCommand(
      layer,
      commandMappings.getStableOrCurrentNodeId(options.node.nodeId)!,
      commandMappings.getStableOrCurrentSegmentId(options.node.segmentId),
      {
        radius: options.node.radius ?? 0,
        confidence: options.node.confidence ?? 0,
      },
      options.next,
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
    );
  }
}
