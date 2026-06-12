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

import "#src/ui/skeleton_edit_tools.css";

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import {
  getSegmentIdFromLayerSelectionValue,
  hasSpatialSkeletonNodeSelection,
} from "#src/layer/segmentation/selection.js";
import { getChunkPositionFromCombinedGlobalLocalPositions } from "#src/render_coordinate_transform.js";
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import {
  addSegmentToVisibleSets,
  getVisibleSegments,
  removeSegmentFromVisibleSets,
} from "#src/segmentation_display_state/base.js";
import { SpatialSkeletonActions } from "#src/skeleton/actions.js";
import type {
  SpatialSkeletonSourceState,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";
import {
  type SpatiallyIndexedSkeletonLayer,
  setSpatialSkeletonModesToLinesAndPoints,
} from "#src/skeleton/frontend.js";
import {
  PerspectiveViewSpatiallyIndexedSkeletonLayer,
  SliceViewPanelSpatiallyIndexedSkeletonLayer,
} from "#src/skeleton/frontend.js";
import {
  executeSpatialSkeletonAddNode,
  executeSpatialSkeletonDeleteNode,
  executeSpatialSkeletonMerge,
  executeSpatialSkeletonMoveNode,
  executeSpatialSkeletonSplit,
  showSpatialSkeletonActionError,
} from "#src/skeleton/spatial_skeleton_commands.js";
import { StatusMessage } from "#src/status.js";
import type { SpatialSkeletonToolPointInfo } from "#src/ui/skeleton_edit_tool_messages.js";
import {
  SPATIAL_SKELETON_SPLIT_BANNER_MESSAGE,
  getSpatialSkeletonEditBannerMessage,
  getSpatialSkeletonMergeBannerMessage,
  getSpatialSkeletonToolPointStatusFields,
  SPATIAL_SKELETON_MOVING_NODE_MESSAGE,
} from "#src/ui/skeleton_edit_tool_messages.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolActivationStatusMessageWithHeader,
  registerTool,
} from "#src/ui/tool.js";
import { removeChildren } from "#src/util/dom.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { vec3 } from "#src/util/geom.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";

export const SPATIAL_SKELETON_EDIT_MODE_TOOL_ID = "spatialSkeletonEditMode";
export const SPATIAL_SKELETON_MERGE_MODE_TOOL_ID = "spatialSkeletonMergeMode";
export const SPATIAL_SKELETON_SPLIT_MODE_TOOL_ID = "spatialSkeletonSplitMode";

const SKELETON_EDIT_STATUS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  // Only expose the primary edit actions in the auto-generated subtitle.
  "at:control+mousedown0": "spatial-skeleton-add-node",
  "at:alt+mousedown0": "spatial-skeleton-move-node",
  "at:control+mousedown2": {
    action: "spatial-skeleton-pin-node",
    stopPropagation: true,
    preventDefault: true,
  },
  "at:control+alt+mousedown2": {
    action: "spatial-skeleton-delete-node",
    stopPropagation: true,
    preventDefault: true,
  },
});

const SPATIAL_SKELETON_EDIT_AUX_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:dblclick0": {
    action: "spatial-skeleton-toggle-visible",
    stopPropagation: true,
    preventDefault: true,
  },
  "at:shift+control+mousedown2": {
    action: "spatial-skeleton-clear-node-selection",
    stopPropagation: true,
    preventDefault: true,
  },
});

const SPATIAL_SKELETON_PICK_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:control+mousedown2": {
    action: "spatial-skeleton-pick-node",
    stopPropagation: true,
    preventDefault: true,
  },
});

const SPATIAL_SKELETON_PICK_AUX_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:dblclick0": {
    action: "spatial-skeleton-toggle-visible",
    stopPropagation: true,
    preventDefault: true,
  },
  "at:shift+control+mousedown2": {
    action: "spatial-skeleton-clear-node-selection",
    stopPropagation: true,
    preventDefault: true,
  },
});

const DRAG_START_DISTANCE_PX = 4;

function waitForNextAnimationFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      window.setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

function renderSpatialSkeletonToolStatus(
  body: HTMLElement,
  options: {
    message: string;
    point?: SpatialSkeletonToolPointInfo;
  },
) {
  removeChildren(body);
  body.classList.add("neuroglancer-skeleton-tool-status");
  const message = document.createElement("span");
  message.className = "neuroglancer-skeleton-tool-status-message";
  message.textContent = options.message;
  body.appendChild(message);
  if (options.point === undefined) {
    return;
  }
  const point = document.createElement("span");
  point.className = "neuroglancer-skeleton-tool-status-point";
  for (const field of getSpatialSkeletonToolPointStatusFields(options.point)) {
    const fieldElement = document.createElement("span");
    fieldElement.className = "neuroglancer-skeleton-tool-status-point-field";
    const label = document.createElement("span");
    label.className = "neuroglancer-skeleton-tool-status-point-field-label";
    label.textContent = field.label;
    fieldElement.appendChild(label);
    const value = document.createElement("span");
    value.className = "neuroglancer-skeleton-tool-status-point-field-value";
    value.textContent = field.value;
    fieldElement.appendChild(value);
    point.appendChild(fieldElement);
  }
  body.appendChild(point);
}

abstract class SpatialSkeletonToolBase extends LayerTool<SegmentationUserLayer> {
  constructor(layer: SegmentationUserLayer) {
    super(layer, true);
  }

  protected getActiveSpatiallyIndexedSkeletonLayer() {
    const pickedLayer = this.mouseState.pickedRenderLayer;
    if (pickedLayer instanceof PerspectiveViewSpatiallyIndexedSkeletonLayer) {
      return pickedLayer.base;
    }
    if (pickedLayer instanceof SliceViewPanelSpatiallyIndexedSkeletonLayer) {
      return pickedLayer.base;
    }
    return this.layer.getSpatiallyIndexedSkeletonLayer();
  }

  protected getPickedSpatialSkeletonNode():
    | {
        nodeId: number;
        segmentId?: number;
        position?: Float32Array;
        sourceState?: SpatialSkeletonSourceState;
      }
    | undefined {
    if (!this.mouseState.updateUnconditionally() || !this.mouseState.active) {
      return undefined;
    }
    const pickedSpatialSkeleton = this.mouseState.pickedSpatialSkeleton;
    const nodeIdRaw = pickedSpatialSkeleton?.nodeId;
    if (
      typeof nodeIdRaw !== "number" ||
      !Number.isSafeInteger(nodeIdRaw) ||
      nodeIdRaw <= 0
    ) {
      return undefined;
    }
    const segmentIdRaw = pickedSpatialSkeleton?.segmentId;
    const position = pickedSpatialSkeleton?.position;
    const sourceState = pickedSpatialSkeleton?.sourceState;
    return {
      nodeId: nodeIdRaw,
      segmentId:
        typeof segmentIdRaw === "number" && Number.isSafeInteger(segmentIdRaw)
          ? segmentIdRaw
          : undefined,
      position:
        position instanceof Float32Array
          ? new Float32Array(position)
          : undefined,
      sourceState,
    };
  }

  protected getPickedSpatialSkeletonSegment() {
    if (!this.mouseState.updateUnconditionally() || !this.mouseState.active) {
      return undefined;
    }
    const segmentIdRaw = this.mouseState.pickedSpatialSkeleton?.segmentId;
    if (
      typeof segmentIdRaw !== "number" ||
      !Number.isSafeInteger(segmentIdRaw) ||
      segmentIdRaw <= 0
    ) {
      return undefined;
    }
    return segmentIdRaw;
  }

  protected selectSegmentByNumber(value: number) {
    if (!Number.isFinite(value)) return;
    this.layer.selectSegment(BigInt(Math.round(value)), false);
  }

  protected pinSegmentByNumber(value: number) {
    if (!Number.isFinite(value)) return;
    this.layer.selectSegment(BigInt(Math.round(value)), true);
  }

  protected ensureSegmentVisibleByNumber(value: number) {
    if (!Number.isFinite(value)) return;
    addSegmentToVisibleSets(
      this.layer.displayState.segmentationGroupState.value,
      BigInt(Math.round(value)),
    );
  }

  protected removeVisibleSegmentByNumber(
    value: number,
    options: {
      deselect?: boolean;
    } = {},
  ) {
    if (!Number.isFinite(value)) return;
    removeSegmentFromVisibleSets(
      this.layer.displayState.segmentationGroupState.value,
      BigInt(Math.round(value)),
      options,
    );
  }

  protected isSpatialSkeletonSegmentVisible(segmentId: number) {
    return getVisibleSegments(
      this.layer.displayState.segmentationGroupState.value,
    ).has(BigInt(Math.round(segmentId)));
  }

  protected togglePickedSpatialSkeletonVisibility() {
    const pickedSegmentId = this.getPickedSpatialSkeletonSegment();
    if (pickedSegmentId === undefined) {
      return false;
    }
    const skeletonLayer = this.layer.getSpatiallyIndexedSkeletonLayer();
    const isVisible = this.isSpatialSkeletonSegmentVisible(pickedSegmentId);
    if (isVisible) {
      this.removeVisibleSegmentByNumber(pickedSegmentId, { deselect: true });
      const selectedNodeId =
        this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
      const selectedNode =
        selectedNodeId === undefined
          ? undefined
          : skeletonLayer?.getNode(selectedNodeId);
      if (selectedNode?.segmentId === pickedSegmentId) {
        this.layer.clearSpatialSkeletonNodeSelection(false);
      }
      const mergeAnchorNodeId =
        this.layer.spatialSkeletonState.mergeAnchorNodeId.value;
      const anchorSegmentId =
        mergeAnchorNodeId === undefined
          ? undefined
          : (skeletonLayer?.getNode(mergeAnchorNodeId)?.segmentId ??
            this.layer.spatialSkeletonState.getCachedNode(mergeAnchorNodeId)
              ?.segmentId);
      if (anchorSegmentId === pickedSegmentId) {
        this.layer.clearSpatialSkeletonMergeAnchor();
      }
      const cachedSegmentIds = new Set<number>(
        [
          ...getVisibleSegments(
            this.layer.displayState.segmentationGroupState.value,
          ).keys(),
        ]
          .map((segmentId) => Number(segmentId))
          .filter(
            (segmentId) => Number.isSafeInteger(segmentId) && segmentId > 0,
          ),
      );
      for (const retainedSegmentId of skeletonLayer?.getRetainedOverlaySegmentIds() ??
        []) {
        cachedSegmentIds.add(retainedSegmentId);
      }
      this.layer.spatialSkeletonState.evictInactiveSegmentNodes(
        cachedSegmentIds,
      );
      StatusMessage.showTemporaryMessage(
        `Removed skeleton ${pickedSegmentId} from visible/editable skeletons.`,
      );
      return true;
    }
    this.ensureSegmentVisibleByNumber(pickedSegmentId);
    this.selectSegmentByNumber(pickedSegmentId);
    StatusMessage.showTemporaryMessage(
      `Made skeleton ${pickedSegmentId} visible/editable.`,
    );
    return true;
  }

  protected bindVisibilityToggleAction(activation: ToolActivation<this>) {
    activation.bindAction(
      "spatial-skeleton-toggle-visible",
      (event: ActionEvent<MouseEvent>) => {
        if (event.detail.button !== 0) return;
        event.stopPropagation();
        event.detail.preventDefault();
        this.togglePickedSpatialSkeletonVisibility();
      },
    );
  }

  protected resolvePickedNodeForAction(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
  ) {
    const pickedNode = this.resolvePickedNodeSelection(skeletonLayer);
    if (pickedNode === undefined) {
      return undefined;
    }
    if (pickedNode.segmentId !== undefined) {
      this.selectSegmentByNumber(pickedNode.segmentId);
    }
    this.layer.selectSpatialSkeletonNode(pickedNode.nodeId, false, pickedNode);
    return {
      nodeId: pickedNode.nodeId,
      segmentId: pickedNode.segmentId,
    };
  }

  protected resolvePickedNodeSelection(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
  ) {
    const nodeHit = this.getPickedSpatialSkeletonNode();
    if (nodeHit === undefined) {
      return undefined;
    }
    const resolvedNodeInfo = skeletonLayer.getNode(nodeHit.nodeId);
    return {
      nodeId: nodeHit.nodeId,
      segmentId: nodeHit.segmentId ?? resolvedNodeInfo?.segmentId,
      position: nodeHit.position ?? resolvedNodeInfo?.position,
      sourceState: nodeHit.sourceState ?? resolvedNodeInfo?.sourceState,
    };
  }

  protected resolvePickedNodeSelectionForMerge(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
  ):
    | {
        nodeId: number;
        segmentId?: number;
        position?: SpatialSkeletonVector;
        sourceState?: SpatialSkeletonSourceState;
        visible: boolean;
      }
    | undefined {
    const nodeHit = this.getPickedSpatialSkeletonNode();
    if (nodeHit === undefined) {
      return undefined;
    }
    const resolvedNodeInfo =
      skeletonLayer.getNode(nodeHit.nodeId) ??
      this.layer.spatialSkeletonState.getCachedNode(nodeHit.nodeId);
    const segmentId = nodeHit.segmentId ?? resolvedNodeInfo?.segmentId;
    return {
      nodeId: nodeHit.nodeId,
      segmentId,
      position: nodeHit.position ?? resolvedNodeInfo?.position,
      sourceState: nodeHit.sourceState ?? resolvedNodeInfo?.sourceState,
      visible:
        segmentId !== undefined &&
        this.isSpatialSkeletonSegmentVisible(segmentId),
    };
  }

  protected getSelectedSpatialSkeletonNodeForTool(
    skeletonLayer: SpatiallyIndexedSkeletonLayer | undefined,
  ):
    | {
        nodeId: number;
        segmentId?: number;
        position?: SpatialSkeletonVector;
        sourceState?: SpatialSkeletonSourceState;
      }
    | undefined {
    const nodeId = this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
    if (
      typeof nodeId !== "number" ||
      !Number.isSafeInteger(nodeId) ||
      nodeId <= 0
    ) {
      return undefined;
    }
    const resolvedNodeInfo =
      skeletonLayer?.getNode(nodeId) ??
      this.layer.spatialSkeletonState.getCachedNode(nodeId);
    const selectedNodeInfo = this.layer.selectedSpatialSkeletonNodeInfo.value;
    const layerSelectionState =
      this.layer.manager.root.selectionState.value?.layers.find(
        (entry) => entry.layer === this.layer,
      )?.state;
    return {
      nodeId,
      segmentId:
        resolvedNodeInfo?.segmentId ??
        selectedNodeInfo?.segmentId ??
        getSegmentIdFromLayerSelectionValue(layerSelectionState),
      position: resolvedNodeInfo?.position ?? selectedNodeInfo?.position,
      sourceState:
        resolvedNodeInfo?.sourceState ?? selectedNodeInfo?.sourceState,
    };
  }

  protected getSelectedSpatialSkeletonNodeSummary() {
    const nodeId = this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
    if (nodeId === undefined) {
      return undefined;
    }
    const selectedNode =
      this.getActiveSpatiallyIndexedSkeletonLayer()?.getNode(nodeId);
    const layerSelectionState =
      this.layer.manager.root.selectionState.value?.layers.find(
        (entry) => entry.layer === this.layer,
      )?.state;
    return {
      nodeId,
      segmentId:
        selectedNode?.segmentId ??
        getSegmentIdFromLayerSelectionValue(layerSelectionState),
    };
  }

  protected bindPinnedSelectionAction(
    activation: ToolActivation<this>,
    options: {
      showNodeSelectionMessage?: boolean;
    } = {},
  ) {
    const { showNodeSelectionMessage = true } = options;
    activation.bindAction(
      "spatial-skeleton-pin-node",
      (event: ActionEvent<MouseEvent>) => {
        if (
          event.detail.button !== 2 ||
          !event.detail.ctrlKey ||
          event.detail.shiftKey
        ) {
          return;
        }
        event.stopPropagation();
        event.detail.preventDefault();
        const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) {
          return;
        }
        const pickedNode = this.resolvePickedNodeSelection(skeletonLayer);
        if (pickedNode === undefined) {
          const pickedSegmentId = this.getPickedSpatialSkeletonSegment();
          if (pickedSegmentId === undefined) {
            return;
          }
          this.layer.clearSpatialSkeletonNodeSelection(false);
          this.pinSegmentByNumber(pickedSegmentId);
          return;
        }
        if (pickedNode.segmentId !== undefined) {
          this.pinSegmentByNumber(pickedNode.segmentId);
        }
        this.layer.selectSpatialSkeletonNode(
          pickedNode.nodeId,
          true,
          pickedNode,
        );
        if (showNodeSelectionMessage) {
          StatusMessage.showTemporaryMessage(
            `Selected and pinned node ${pickedNode.nodeId}.`,
          );
        }
      },
    );
  }

  protected bindClearSelectionAction(activation: ToolActivation<this>) {
    activation.bindAction(
      "spatial-skeleton-clear-node-selection",
      (event: ActionEvent<MouseEvent>) => {
        event.stopPropagation();
        event.detail.preventDefault();
        const pinnedSelection = this.layer.manager.root.selectionState.value;
        const hasSpatialSkeletonSelection =
          this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId !==
            undefined ||
          (pinnedSelection?.layers.some(
            ({ layer, state }) =>
              layer === this.layer && hasSpatialSkeletonNodeSelection(state),
          ) ??
            false);
        const hasMergeAnchor =
          this.layer.spatialSkeletonState.mergeAnchorNodeId.value !== undefined;
        if (hasSpatialSkeletonSelection || hasMergeAnchor) {
          this.layer.clearSpatialSkeletonNodeSelection("force-unpin");
          if (hasMergeAnchor) {
            this.layer.clearSpatialSkeletonMergeAnchor();
          }
          return;
        }
        this.layer.manager.root.selectionState.unpin();
      },
    );
  }

  protected activateModeWatchable(
    activation: ToolActivation<this>,
    modeWatchable: { value: boolean },
  ) {
    setSpatialSkeletonModesToLinesAndPoints(this.layer);
    modeWatchable.value = true;
    activation.registerDisposer(() => {
      modeWatchable.value = false;
    });
  }

  protected registerAutoCancelOnDisabled(
    activation: ToolActivation<this>,
    requiredActions: Parameters<
      SegmentationUserLayer["getSpatialSkeletonActionsDisabledReason"]
    >[0],
    onReady?: () => void,
  ) {
    const handleStateChanged = () => {
      const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
        requiredActions,
        {
          ignoreCommandBusy: true,
        },
      );
      if (disabledReason === undefined) {
        onReady?.();
        return;
      }
      StatusMessage.showTemporaryMessage(disabledReason);
      activation.cancel();
    };
    activation.registerDisposer(
      this.layer.layersChanged.add(handleStateChanged),
    );
  }
}

export class SpatialSkeletonEditModeTool extends SpatialSkeletonToolBase {
  toJSON() {
    return SPATIAL_SKELETON_EDIT_MODE_TOOL_ID;
  }

  get description() {
    return "Skeleton edit";
  }

  private curChunkRank = -1;
  private tempChunkPosition = new Float32Array(0);
  private readonly dragModelSpacePosition = vec3.create();
  private readonly dragGlobalAnchorPosition = vec3.create();
  private readonly dragGlobalPosition = vec3.create();

  // TODO (skm): really we can't handle a rank change right now
  // and heavily assume rank 3. This is likely mostly fine
  // but need to test a little more how it works if embedded in
  // higher dim spaces or alongside images with a t dim / channel dim
  // can also possibly remove this and just set tempChunkPosition
  // to be vec3 instead of Float32Array
  // will verify and clean up
  private handleRankChanged(rank: number) {
    if (rank === this.curChunkRank) return;
    this.curChunkRank = rank;
    this.tempChunkPosition = new Float32Array(rank);
  }

  private globalToSkeletonCoordinates(
    globalPosition: Float32Array,
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
  ): Float32Array | undefined {
    const chunkTransform = skeletonLayer.chunkTransform.value;
    if (chunkTransform.error !== undefined) return undefined;
    this.handleRankChanged(chunkTransform.modelTransform.unpaddedRank);
    if (
      !getChunkPositionFromCombinedGlobalLocalPositions(
        this.tempChunkPosition,
        globalPosition,
        skeletonLayer.localPosition.value,
        chunkTransform.layerRank,
        chunkTransform.combinedGlobalLocalToChunkTransform,
      )
    ) {
      return undefined;
    }
    return this.tempChunkPosition;
  }

  private getMousePositionInSkeletonCoordinates(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
  ): Float32Array | undefined {
    if (!this.mouseState.updateUnconditionally() || !this.mouseState.active) {
      return undefined;
    }
    return this.globalToSkeletonCoordinates(
      this.mouseState.unsnappedPosition,
      skeletonLayer,
    );
  }

  private getSelectedParentNodeForAdd(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    parentNodeId: number | undefined,
  ) {
    if (parentNodeId === undefined) {
      return undefined;
    }
    return (
      this.layer.spatialSkeletonState.getCachedNode(parentNodeId) ??
      skeletonLayer.getNode(parentNodeId)
    );
  }

  private getAddNodeBlockedReason(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    parentNodeId: number | undefined,
  ) {
    if (parentNodeId === undefined) {
      return undefined;
    }
    const selectedParentNode = this.getSelectedParentNodeForAdd(
      skeletonLayer,
      parentNodeId,
    );
    if (selectedParentNode !== undefined && selectedParentNode.isTrueEnd) {
      return `Node ${parentNodeId} is marked as a true end. Clear the true end state before appending a child node.`;
    }
    return undefined;
  }

  private getRenderedDataPanelForEvent(
    event: MouseEvent,
  ): RenderedDataPanel | undefined {
    const display = this.layer.manager.root.display;
    const target = event.target;
    if (target instanceof Node) {
      for (const panel of display.panels) {
        if (!(panel instanceof RenderedDataPanel)) continue;
        if (panel.element.contains(target)) {
          return panel;
        }
      }
    }
    const clientX = event.clientX;
    const clientY = event.clientY;
    for (const panel of display.panels) {
      if (!(panel instanceof RenderedDataPanel)) continue;
      const rect = panel.element.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return panel;
      }
    }
    return undefined;
  }

  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const rawInputEventMapBinder = activation.inputEventMapBinder;
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Skeleton edit";
    let statusOverride: string | undefined;
    let cachedNodeSummary:
      | ReturnType<typeof this.getSelectedSpatialSkeletonNodeSummary>
      | undefined;
    const clearCachedNodeSummary = () => {
      cachedNodeSummary = undefined;
    };
    const renderStatus = () => {
      const selectedPoint =
        cachedNodeSummary ?? this.getSelectedSpatialSkeletonNodeSummary();
      renderSpatialSkeletonToolStatus(body, {
        message:
          statusOverride ?? getSpatialSkeletonEditBannerMessage(selectedPoint),
        point: selectedPoint,
      });
    };
    const setStatus = (nextStatus: string | undefined) => {
      statusOverride = nextStatus;
      renderStatus();
    };
    const setReadyStatus = () => {
      setStatus(undefined);
    };

    const disableWithMessage = (message: string) => {
      setStatus(message);
      StatusMessage.showTemporaryMessage(message);
      queueMicrotask(() => activation.cancel());
    };

    const getEditSupportDisabledReason = () =>
      layer.getSpatialSkeletonActionsDisabledReason(
        [SpatialSkeletonActions.addNodes, SpatialSkeletonActions.moveNodes],
        {
          ignoreCommandBusy: true,
          requireVisibleChunks: false,
        },
      );
    const getEditMutationDisabledReason = () =>
      layer.getSpatialSkeletonActionsDisabledReason([
        SpatialSkeletonActions.addNodes,
        SpatialSkeletonActions.moveNodes,
      ]);
    const updateInteractionStatus = () => {
      const reason = getEditMutationDisabledReason();
      if (reason === undefined) {
        setReadyStatus();
        return undefined;
      }
      const message = `${reason} Node selection is still available.`;
      setStatus(message);
      return reason;
    };

    const disabledReason = getEditSupportDisabledReason();
    if (disabledReason !== undefined) {
      disableWithMessage(disabledReason);
      return;
    }
    if (this.getActiveSpatiallyIndexedSkeletonLayer() === undefined) {
      disableWithMessage(
        "No spatially indexed skeleton source is currently loaded.",
      );
      return;
    }

    this.activateModeWatchable(activation, layer.spatialSkeletonEditMode);
    activation.bindInputEventMap(SKELETON_EDIT_STATUS_INPUT_EVENT_MAP);
    rawInputEventMapBinder(
      SPATIAL_SKELETON_EDIT_AUX_INPUT_EVENT_MAP,
      activation,
    );
    this.bindPinnedSelectionAction(activation, {
      showNodeSelectionMessage: false,
    });
    this.bindClearSelectionAction(activation);
    this.bindVisibilityToggleAction(activation);
    updateInteractionStatus();
    activation.registerDisposer(() => {
      layer.spatialSkeletonState.clearPendingNodePositions();
    });
    activation.registerDisposer(
      layer.selectedSpatialSkeletonNodeInfo.changed.add(renderStatus),
    );
    activation.registerDisposer(
      layer.manager.root.selectionState.changed.add(renderStatus),
    );
    activation.registerDisposer(
      layer.spatialSkeletonState.commandHistory.isBusy.changed.add(
        updateInteractionStatus,
      ),
    );
    activation.registerDisposer(
      layer.layersChanged.add(() => {
        const supportReason = getEditSupportDisabledReason();
        if (supportReason !== undefined) {
          StatusMessage.showTemporaryMessage(supportReason);
          activation.cancel();
          return;
        }
        const reason = updateInteractionStatus();
        if (reason !== undefined) {
          StatusMessage.showTemporaryMessage(reason);
          return;
        }
        setReadyStatus();
      }),
    );

    activation.bindAction(
      "spatial-skeleton-add-node",
      (event: ActionEvent<MouseEvent>) => {
        if (
          event.detail.button !== 0 ||
          !event.detail.ctrlKey ||
          event.detail.shiftKey ||
          event.detail.altKey ||
          event.detail.metaKey
        ) {
          return;
        }
        event.stopPropagation();
        event.detail.preventDefault();
        const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.addNodes,
        );
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          return;
        }
        const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }
        const selectedParentNodeId =
          layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
        const addNodeBlockedReason = this.getAddNodeBlockedReason(
          skeletonLayer,
          selectedParentNodeId,
        );
        if (addNodeBlockedReason !== undefined) {
          StatusMessage.showTemporaryMessage(addNodeBlockedReason);
          return;
        }
        if (selectedParentNodeId === undefined) {
          const pickedSegmentId = this.getPickedSpatialSkeletonSegment();
          if (pickedSegmentId !== undefined) {
            this.selectSegmentByNumber(pickedSegmentId);
            return;
          }
        }
        const clickStartPosition =
          this.getMousePositionInSkeletonCoordinates(skeletonLayer);
        if (clickStartPosition === undefined) {
          StatusMessage.showTemporaryMessage(
            "Unable to resolve add-node position for this click.",
          );
          return;
        }
        let dragDistanceSquared = 0;
        startRelativeMouseDrag(
          event.detail,
          (_event, deltaX, deltaY) => {
            dragDistanceSquared += deltaX * deltaX + deltaY * deltaY;
          },
          (_finishEvent) => {
            const thresholdSquared =
              DRAG_START_DISTANCE_PX * DRAG_START_DISTANCE_PX;
            // Block adding nodes if the mouse release position
            // is too far from the click position
            if (dragDistanceSquared > thresholdSquared) {
              setReadyStatus();
              return;
            }
            const selectedParentNodeId =
              layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
            const addNodeBlockedReason = this.getAddNodeBlockedReason(
              skeletonLayer,
              selectedParentNodeId,
            );
            if (addNodeBlockedReason !== undefined) {
              setReadyStatus();
              StatusMessage.showTemporaryMessage(addNodeBlockedReason);
              return;
            }
            const selectedParentNode = this.getSelectedParentNodeForAdd(
              skeletonLayer,
              selectedParentNodeId,
            );
            const targetSkeletonId =
              selectedParentNode === undefined
                ? 0
                : selectedParentNode.segmentId;
            const clickPositionInModelSpace =
              this.getMousePositionInSkeletonCoordinates(skeletonLayer);
            if (clickPositionInModelSpace === undefined) return;
            void (async () => {
              try {
                await executeSpatialSkeletonAddNode(layer, {
                  skeletonId: targetSkeletonId,
                  parentNodeId: selectedParentNodeId,
                  positionInModelSpace: new Float32Array(
                    clickPositionInModelSpace,
                  ),
                });
              } catch (error) {
                showSpatialSkeletonActionError("create node", error);
                return;
              }
              setReadyStatus();
            })();
          },
        );
      },
    );

    activation.bindAction(
      "spatial-skeleton-move-node",
      (event: ActionEvent<MouseEvent>) => {
        event.stopPropagation();
        event.detail.preventDefault();
        const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.moveNodes,
        );
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          return;
        }
        const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }
        const actionPanel = this.getRenderedDataPanelForEvent(event.detail);
        const pickedNode = this.getPickedSpatialSkeletonNode();
        if (pickedNode === undefined) {
          const pickedSegmentId = this.getPickedSpatialSkeletonSegment();
          if (pickedSegmentId !== undefined) {
            this.selectSegmentByNumber(pickedSegmentId);
            layer.clearSpatialSkeletonNodeSelection(false);
          }
          return;
        }
        const pickedPosition = this.mouseState.position;
        const hasPickedPosition =
          pickedPosition.length >= 3 &&
          Number.isFinite(pickedPosition[0]) &&
          Number.isFinite(pickedPosition[1]) &&
          Number.isFinite(pickedPosition[2]);
        if (!hasPickedPosition) return;
        const nodeInfo = skeletonLayer.getNode(pickedNode.nodeId);
        if (nodeInfo === undefined) {
          return;
        }
        const dragPanel = actionPanel;
        if (dragPanel === undefined) {
          StatusMessage.showTemporaryMessage(
            "Unable to resolve active panel for node drag.",
          );
          return;
        }
        let moved = false;
        let finished = false;
        this.dragModelSpacePosition.set(nodeInfo.position);
        vec3.set(
          this.dragGlobalAnchorPosition,
          Number(pickedPosition[0]),
          Number(pickedPosition[1]),
          Number(pickedPosition[2]),
        );
        let totalDeltaX = 0;
        let totalDeltaY = 0;
        let dragStarted = false;
        cachedNodeSummary = this.getSelectedSpatialSkeletonNodeSummary();
        setStatus(SPATIAL_SKELETON_MOVING_NODE_MESSAGE);
        startRelativeMouseDrag(
          event.detail,
          (_event, deltaX, deltaY) => {
            totalDeltaX += deltaX;
            totalDeltaY += deltaY;
            if (!dragStarted) {
              const thresholdSquared =
                DRAG_START_DISTANCE_PX * DRAG_START_DISTANCE_PX;
              if (
                totalDeltaX * totalDeltaX + totalDeltaY * totalDeltaY <
                thresholdSquared
              )
                return;
              dragStarted = true;
              skeletonLayer.markSegmentEdited(nodeInfo.segmentId);
            }
            dragPanel.translateDataPointByViewportPixels(
              this.dragGlobalPosition,
              this.dragGlobalAnchorPosition,
              totalDeltaX,
              totalDeltaY,
            );
            if (
              !Number.isFinite(this.dragGlobalPosition[0]) ||
              !Number.isFinite(this.dragGlobalPosition[1]) ||
              !Number.isFinite(this.dragGlobalPosition[2])
            ) {
              return;
            }
            const modelPosition = this.globalToSkeletonCoordinates(
              this.dragGlobalPosition,
              skeletonLayer,
            );
            if (modelPosition === undefined) return;
            const previewChanged =
              layer.spatialSkeletonState.setPendingNodePosition(
                pickedNode.nodeId,
                modelPosition,
              );
            if (!previewChanged) return;
            moved = true;
            this.dragModelSpacePosition.set(modelPosition);
          },
          (_finishEvent) => {
            if (finished) return;
            finished = true;
            clearCachedNodeSummary();
            setReadyStatus();
            if (!dragStarted) {
              return;
            }
            if (moved) {
              void executeSpatialSkeletonMoveNode(layer, {
                node: nodeInfo,
                nextPositionInModelSpace: new Float32Array(
                  this.dragModelSpacePosition,
                ),
              })
                .then(() => {
                  layer.spatialSkeletonState.clearPendingNodePosition(
                    pickedNode.nodeId,
                  );
                })
                .catch((error) => {
                  layer.spatialSkeletonState.clearPendingNodePosition(
                    pickedNode.nodeId,
                  );
                  showSpatialSkeletonActionError("move node", error);
                });
              return;
            }
            layer.spatialSkeletonState.clearPendingNodePosition(
              pickedNode.nodeId,
            );
          },
        );
      },
    );

    activation.bindAction(
      "spatial-skeleton-delete-node",
      (event: ActionEvent<MouseEvent>) => {
        event.stopPropagation();
        event.detail.preventDefault();
        const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.deleteNodes,
        );
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          return;
        }
        const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }
        const pickedNode = this.getPickedSpatialSkeletonNode();
        if (pickedNode === undefined) {
          return;
        }
        const nodeInfo = skeletonLayer.getNode(pickedNode.nodeId);
        if (nodeInfo === undefined) {
          StatusMessage.showTemporaryMessage(
            `Unable to resolve node ${pickedNode.nodeId} for deletion.`,
          );
          return;
        }
        void layer
          .getSpatialSkeletonDeleteOperationContext(nodeInfo)
          .then(() => executeSpatialSkeletonDeleteNode(layer, nodeInfo))
          .catch((error) => {
            showSpatialSkeletonActionError("delete node", error);
          });
      },
    );
  }
}

export class SpatialSkeletonMergeModeTool extends SpatialSkeletonToolBase {
  toJSON() {
    return SPATIAL_SKELETON_MERGE_MODE_TOOL_ID;
  }

  get description() {
    return "Skeleton merge";
  }

  activate(activation: ToolActivation<this>) {
    const rawInputEventMapBinder = activation.inputEventMapBinder;
    const reason = this.layer.getSpatialSkeletonActionsDisabledReason(
      SpatialSkeletonActions.mergeSkeletons,
    );
    if (reason !== undefined) {
      StatusMessage.showTemporaryMessage(reason);
      queueMicrotask(() => activation.cancel());
      return;
    }
    if (this.getActiveSpatiallyIndexedSkeletonLayer() === undefined) {
      StatusMessage.showTemporaryMessage(
        "No spatially indexed skeleton source is currently loaded.",
      );
      queueMicrotask(() => activation.cancel());
      return;
    }

    this.activateModeWatchable(activation, this.layer.spatialSkeletonMergeMode);
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Spatial skeleton merge";
    let pending = false;
    type MergeAnchorSelection = {
      nodeId: number;
      segmentId?: number;
      position?: ArrayLike<number>;
      sourceState?: SpatialSkeletonSourceState;
    };
    let anchorSelection: MergeAnchorSelection | undefined;
    let statusOverride: string | undefined;
    const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
    const selectedNode =
      this.getSelectedSpatialSkeletonNodeForTool(skeletonLayer);
    if (selectedNode !== undefined) {
      anchorSelection = selectedNode;
      this.layer.selectSpatialSkeletonNode(
        selectedNode.nodeId,
        true,
        selectedNode,
      );
      this.layer.setSpatialSkeletonMergeAnchor(selectedNode.nodeId);
    } else {
      this.layer.clearSpatialSkeletonMergeAnchor();
    }
    activation.registerDisposer(() => {
      this.layer.clearSpatialSkeletonMergeAnchor();
    });
    const getAnchorNode = (): MergeAnchorSelection | undefined => {
      const nodeId = this.layer.spatialSkeletonState.mergeAnchorNodeId.value;
      if (nodeId === undefined || !Number.isSafeInteger(nodeId)) {
        anchorSelection = undefined;
        return undefined;
      }
      if (anchorSelection?.nodeId === nodeId) {
        return anchorSelection;
      }
      const cachedNode =
        this.getActiveSpatiallyIndexedSkeletonLayer()?.getNode(nodeId) ??
        this.layer.spatialSkeletonState.getCachedNode(nodeId);
      const anchorNode = {
        nodeId,
        segmentId: cachedNode?.segmentId,
        position: cachedNode?.position,
        sourceState: cachedNode?.sourceState,
      };
      anchorSelection = anchorNode;
      return anchorNode;
    };
    const renderStatus = () => {
      const anchorNode = getAnchorNode();
      renderSpatialSkeletonToolStatus(body, {
        message:
          statusOverride ?? getSpatialSkeletonMergeBannerMessage(anchorNode),
        point: anchorNode,
      });
    };
    const setStatus = (nextStatus: string | undefined) => {
      statusOverride = nextStatus;
      renderStatus();
    };
    const setReadyStatus = () => {
      setStatus(undefined);
    };
    setReadyStatus();
    activation.bindInputEventMap(SPATIAL_SKELETON_PICK_INPUT_EVENT_MAP);
    rawInputEventMapBinder(
      SPATIAL_SKELETON_PICK_AUX_INPUT_EVENT_MAP,
      activation,
    );
    this.bindClearSelectionAction(activation);
    this.bindVisibilityToggleAction(activation);
    this.registerAutoCancelOnDisabled(
      activation,
      SpatialSkeletonActions.mergeSkeletons,
      setReadyStatus,
    );
    activation.registerDisposer(
      this.layer.spatialSkeletonState.mergeAnchorNodeId.changed.add(
        renderStatus,
      ),
    );
    activation.registerDisposer(
      this.layer.selectedSpatialSkeletonNodeInfo.changed.add(() => {
        if (
          this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId ===
            undefined &&
          this.layer.spatialSkeletonState.mergeAnchorNodeId.value !== undefined
        ) {
          anchorSelection = undefined;
          this.layer.clearSpatialSkeletonMergeAnchor();
          return;
        }
        renderStatus();
      }),
    );
    activation.bindAction(
      "spatial-skeleton-pick-node",
      (_event: ActionEvent<MouseEvent>) => {
        if (pending) return;
        const disabledReason =
          this.layer.getSpatialSkeletonActionsDisabledReason(
            SpatialSkeletonActions.mergeSkeletons,
          );
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          return;
        }
        const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }
        const pickedNode =
          this.resolvePickedNodeSelectionForMerge(skeletonLayer);
        const anchorNode = getAnchorNode();
        if (pickedNode === undefined) {
          const pickedSegmentId = this.getPickedSpatialSkeletonSegment();
          if (pickedSegmentId !== undefined) {
            this.pinSegmentByNumber(pickedSegmentId);
            if (anchorNode === undefined) {
              this.layer.clearSpatialSkeletonNodeSelection(false);
            }
            renderStatus();
          }
          return;
        }
        if (pickedNode === undefined || pickedNode.segmentId === undefined) {
          return;
        }
        if (
          anchorNode === undefined ||
          anchorNode.nodeId === pickedNode.nodeId
        ) {
          this.pinSegmentByNumber(pickedNode.segmentId);
          anchorSelection = {
            nodeId: pickedNode.nodeId,
            segmentId: pickedNode.segmentId,
            position: pickedNode.position,
            sourceState: pickedNode.sourceState,
          };
          this.layer.setSpatialSkeletonMergeAnchor(pickedNode.nodeId);
          this.layer.selectSpatialSkeletonNode(
            pickedNode.nodeId,
            true,
            pickedNode,
          );
          renderStatus();
          return;
        }
        if (anchorNode.segmentId === pickedNode.segmentId) {
          this.pinSegmentByNumber(pickedNode.segmentId);
          anchorSelection = {
            nodeId: pickedNode.nodeId,
            segmentId: pickedNode.segmentId,
            position: pickedNode.position,
            sourceState: pickedNode.sourceState,
          };
          this.layer.setSpatialSkeletonMergeAnchor(pickedNode.nodeId);
          this.layer.selectSpatialSkeletonNode(
            pickedNode.nodeId,
            true,
            pickedNode,
          );
          renderStatus();
          return;
        }
        const firstNode = anchorNode;
        const secondNode = {
          nodeId: pickedNode.nodeId,
          segmentId: pickedNode.segmentId,
          position: pickedNode.position,
          sourceState: pickedNode.sourceState,
        };
        if (
          firstNode.segmentId === undefined ||
          secondNode.segmentId === undefined
        ) {
          StatusMessage.showTemporaryMessage(
            "Unable to resolve both merge segments.",
          );
          return;
        }
        if (!this.isSpatialSkeletonSegmentVisible(firstNode.segmentId)) {
          StatusMessage.showTemporaryMessage(
            `The first node selected for a merge operation must be from a visible skeleton. Make skeleton ${firstNode.segmentId} visible in the Seg tab or by double-clicking it in the viewer.`,
            3000,
          );
          return;
        }
        this.pinSegmentByNumber(pickedNode.segmentId);
        this.layer.selectSpatialSkeletonNode(
          pickedNode.nodeId,
          true,
          pickedNode,
        );
        pending = true;
        setStatus("Merging selected nodes.");
        void (async () => {
          try {
            await waitForNextAnimationFrame();
            await executeSpatialSkeletonMerge(
              this.layer,
              {
                nodeId: firstNode.nodeId,
                segmentId: firstNode.segmentId!,
                position: firstNode.position,
                sourceState: firstNode.sourceState,
              },
              {
                nodeId: secondNode.nodeId,
                segmentId: secondNode.segmentId!,
                position: secondNode.position,
                sourceState: secondNode.sourceState,
              },
            );
          } catch (error) {
            showSpatialSkeletonActionError("merge skeletons", error);
          } finally {
            pending = false;
            setReadyStatus();
          }
        })();
      },
    );
  }
}

export class SpatialSkeletonSplitModeTool extends SpatialSkeletonToolBase {
  toJSON() {
    return SPATIAL_SKELETON_SPLIT_MODE_TOOL_ID;
  }

  get description() {
    return "Skeleton split";
  }

  activate(activation: ToolActivation<this>) {
    const rawInputEventMapBinder = activation.inputEventMapBinder;
    const reason = this.layer.getSpatialSkeletonActionsDisabledReason(
      SpatialSkeletonActions.splitSkeletons,
    );
    if (reason !== undefined) {
      StatusMessage.showTemporaryMessage(reason);
      queueMicrotask(() => activation.cancel());
      return;
    }
    if (this.getActiveSpatiallyIndexedSkeletonLayer() === undefined) {
      StatusMessage.showTemporaryMessage(
        "No spatially indexed skeleton source is currently loaded.",
      );
      queueMicrotask(() => activation.cancel());
      return;
    }

    this.activateModeWatchable(activation, this.layer.spatialSkeletonSplitMode);
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Skeleton split";
    let pending = false;
    let statusOverride: string | undefined;
    let pendingPoint: SpatialSkeletonToolPointInfo | undefined;
    const renderStatus = () => {
      renderSpatialSkeletonToolStatus(body, {
        message: statusOverride ?? SPATIAL_SKELETON_SPLIT_BANNER_MESSAGE,
        point: pendingPoint,
      });
    };
    const setStatus = (
      nextStatus: string | undefined,
      nextPoint: SpatialSkeletonToolPointInfo | undefined = pendingPoint,
    ) => {
      statusOverride = nextStatus;
      pendingPoint = nextPoint;
      renderStatus();
    };
    const setReadyStatus = () => {
      setStatus(undefined, undefined);
    };
    const splitNode = (
      pickedNode: {
        nodeId: number;
        segmentId?: number;
        position?: SpatialSkeletonVector;
        sourceState?: SpatialSkeletonSourceState;
      },
      options: {
        selectNode?: boolean;
      } = {},
    ) => {
      if (pickedNode.segmentId === undefined) {
        return false;
      }
      this.pinSegmentByNumber(pickedNode.segmentId);
      if (options.selectNode ?? true) {
        this.layer.selectSpatialSkeletonNode(
          pickedNode.nodeId,
          true,
          pickedNode,
        );
      }
      const point = {
        nodeId: pickedNode.nodeId,
        segmentId: pickedNode.segmentId,
        position: pickedNode.position,
      };
      pending = true;
      setStatus("Splitting selected node.", point);
      void (async () => {
        try {
          await executeSpatialSkeletonSplit(this.layer, {
            nodeId: pickedNode.nodeId,
            segmentId: pickedNode.segmentId!,
          });
        } catch (error) {
          showSpatialSkeletonActionError("split skeleton", error);
        } finally {
          pending = false;
          setReadyStatus();
        }
      })();
      return true;
    };
    setReadyStatus();
    activation.bindInputEventMap(SPATIAL_SKELETON_PICK_INPUT_EVENT_MAP);
    rawInputEventMapBinder(
      SPATIAL_SKELETON_PICK_AUX_INPUT_EVENT_MAP,
      activation,
    );
    this.bindClearSelectionAction(activation);
    this.bindVisibilityToggleAction(activation);
    this.registerAutoCancelOnDisabled(
      activation,
      SpatialSkeletonActions.splitSkeletons,
      setReadyStatus,
    );
    const selectedNode = this.getSelectedSpatialSkeletonNodeForTool(
      this.getActiveSpatiallyIndexedSkeletonLayer(),
    );
    if (
      selectedNode?.segmentId !== undefined &&
      this.isSpatialSkeletonSegmentVisible(selectedNode.segmentId)
    ) {
      splitNode(selectedNode);
    }
    activation.bindAction(
      "spatial-skeleton-pick-node",
      (_event: ActionEvent<MouseEvent>) => {
        if (pending) return;
        const disabledReason =
          this.layer.getSpatialSkeletonActionsDisabledReason(
            SpatialSkeletonActions.splitSkeletons,
          );
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          return;
        }
        const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }
        const pickedNode = this.resolvePickedNodeSelection(skeletonLayer);
        if (pickedNode === undefined) {
          const pickedSegmentId = this.getPickedSpatialSkeletonSegment();
          if (pickedSegmentId !== undefined) {
            this.pinSegmentByNumber(pickedSegmentId);
            this.layer.clearSpatialSkeletonNodeSelection(false);
            renderStatus();
          }
          return;
        }
        if (pickedNode === undefined || pickedNode.segmentId === undefined) {
          return;
        }
        splitNode(pickedNode);
      },
    );
  }
}

function makeSpatialSkeletonToolLister(toolId: string) {
  return (layer: SegmentationUserLayer, onChange?: () => void) => {
    if (onChange !== undefined) {
      layer.layersChanged.addOnce(onChange);
    }
    if (layer.getSpatiallyIndexedSkeletonLayer() === undefined) {
      return [];
    }
    return [{ type: toolId }];
  };
}

export function registerSpatialSkeletonEditModeTool(
  contextType: typeof SegmentationUserLayer,
) {
  registerTool(
    contextType,
    SPATIAL_SKELETON_EDIT_MODE_TOOL_ID,
    (layer) => new SpatialSkeletonEditModeTool(layer),
    makeSpatialSkeletonToolLister(SPATIAL_SKELETON_EDIT_MODE_TOOL_ID),
  );
  registerTool(
    contextType,
    SPATIAL_SKELETON_MERGE_MODE_TOOL_ID,
    (layer) => new SpatialSkeletonMergeModeTool(layer),
    makeSpatialSkeletonToolLister(SPATIAL_SKELETON_MERGE_MODE_TOOL_ID),
  );
  registerTool(
    contextType,
    SPATIAL_SKELETON_SPLIT_MODE_TOOL_ID,
    (layer) => new SpatialSkeletonSplitModeTool(layer),
    makeSpatialSkeletonToolLister(SPATIAL_SKELETON_SPLIT_MODE_TOOL_ID),
  );
}
