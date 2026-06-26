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
import { PerspectivePanel } from "#src/perspective_view/panel.js";
import { getChunkPositionFromCombinedGlobalLocalPositions } from "#src/render_coordinate_transform.js";
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { getVisibleSegments } from "#src/segmentation_display_state/base.js";
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
  SPATIAL_SKELETON_CREATE_BANNER_MESSAGE,
  SPATIAL_SKELETON_MERGE_SELECTED_BANNER_MESSAGE,
  SPATIAL_SKELETON_MOVING_NODE_MESSAGE,
  getSpatialSkeletonEditBannerMessage,
  getSpatialSkeletonToolPointStatusFields,
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

// Internal mode enum — only Default, Merge, Create are sustained states.
// Move and Select are both handled in Default; Split is a one-shot keydown with no sustained mode.
const enum SkeletonEditMode {
  Default = 0,
  Merge = 1,
  Create = 2,
}

// mousedown0 is intentionally absent — it is handled via capture-phase DOM
// listeners registered in activate() so that off-node clicks pass through to
// NG's own rotate/pan EventActionMap actions (which would be shadowed if we
// bound mousedown0 here at POSITIVE_INFINITY priority).
//
// mousedown1 (middle) is bound here for perspective-panel rotation. Slice
// panels intercept middle mouse in the capture listener below and call
// translateByViewportPixels directly, consuming the event before
// MouseEventBinder can dispatch this action.
const SKELETON_UNIFIED_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:mousedown1": "rotate-via-mouse-drag",
  "at:control+mousedown0": "spatial-skeleton-add-node",
  "at:keym": "spatial-skeleton-enter-merge",
  "at:keys": "spatial-skeleton-split",
  "at:keyn": "spatial-skeleton-enter-create",
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

// Bound via the raw inputEventMapBinder so it stays out of the auto-generated subtitle.
const SPATIAL_SKELETON_AUX_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift+control+mousedown2": {
    action: "spatial-skeleton-clear-node-selection",
    stopPropagation: true,
    preventDefault: true,
  },
});

const DRAG_START_DISTANCE_PX = 2;

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

  protected isSpatialSkeletonSegmentVisible(segmentId: number) {
    return getVisibleSegments(
      this.layer.displayState.segmentationGroupState.value,
    ).has(BigInt(Math.round(segmentId)));
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
      }
    | undefined {
    const nodeHit = this.getPickedSpatialSkeletonNode();
    if (nodeHit === undefined) {
      return undefined;
    }
    const resolvedNodeInfo =
      skeletonLayer.getNode(nodeHit.nodeId) ??
      this.layer.spatialSkeletonState.getCachedNode(nodeHit.nodeId);
    return {
      nodeId: nodeHit.nodeId,
      segmentId: nodeHit.segmentId ?? resolvedNodeInfo?.segmentId,
      position: nodeHit.position ?? resolvedNodeInfo?.position,
      sourceState: nodeHit.sourceState ?? resolvedNodeInfo?.sourceState,
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
}

export class SpatialSkeletonEditTool extends SpatialSkeletonToolBase {
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

  activate(activation: ToolActivation<this>) {
    const tool = this;
    const { layer } = this;
    const rawInputEventMapBinder = activation.inputEventMapBinder;
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Skeleton edit";

    const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
      [SpatialSkeletonActions.addNodes, SpatialSkeletonActions.moveNodes],
      { ignoreCommandBusy: true, requireVisibleChunks: false },
    );
    if (disabledReason !== undefined) {
      StatusMessage.showTemporaryMessage(disabledReason);
      renderSpatialSkeletonToolStatus(body, { message: disabledReason });
      queueMicrotask(() => activation.cancel());
      return;
    }
    if (tool.getActiveSpatiallyIndexedSkeletonLayer() === undefined) {
      const msg = "No spatially indexed skeleton source is currently loaded.";
      StatusMessage.showTemporaryMessage(msg);
      renderSpatialSkeletonToolStatus(body, { message: msg });
      queueMicrotask(() => activation.cancel());
      return;
    }

    // Keep editMode on for the entire tool lifetime — drives the lines+points render mode.
    tool.activateModeWatchable(activation, layer.spatialSkeletonEditMode);
    activation.bindInputEventMap(SKELETON_UNIFIED_INPUT_EVENT_MAP);
    rawInputEventMapBinder(SPATIAL_SKELETON_AUX_INPUT_EVENT_MAP, activation);
    tool.bindPinnedSelectionAction(activation, { showNodeSelectionMessage: false });
    tool.bindClearSelectionAction(activation);

    let currentMode: SkeletonEditMode = SkeletonEditMode.Default;
    let dragInProgress = false;
    let pending = false;
    let createPlacedThisHold = false;
    // One-shot guards: prevent repeated fires while a key is held down.
    let mergeKeyHeld = false;
    let splitKeyHeld = false;
    // Modifier-held state drives cursor indicators and blocks node actions.
    let ctrlHeld = false;
    let shiftHeld = false;
    let statusOverride: string | undefined;
    let statusPoint: SpatialSkeletonToolPointInfo | undefined;

    // --- Cursor helpers ---

    const setModeAttribute = (mode: string | undefined) => {
      const { display } = layer.manager.root;
      for (const panel of display.panels) {
        if (!(panel instanceof RenderedDataPanel)) continue;
        if (mode === undefined) {
          delete panel.element.dataset.skeletonEditMode;
        } else {
          panel.element.dataset.skeletonEditMode = mode;
        }
      }
    };

    // Recomputes the correct data-skeleton-edit-mode attribute from current
    // mode + held modifiers so callers don't have to care about that interaction.
    // Priority: sustained tool modes > ctrl (add) > shift (translate hint).
    const updateModeAttribute = () => {
      if (currentMode === SkeletonEditMode.Merge) {
        setModeAttribute("merge");
      } else if (currentMode === SkeletonEditMode.Create) {
        setModeAttribute("create");
      } else if (ctrlHeld) {
        setModeAttribute("add");
      } else if (shiftHeld) {
        setModeAttribute("shift");
      } else {
        setModeAttribute(undefined);
      }
    };

    activation.registerDisposer(() => setModeAttribute(undefined));

    // --- Status rendering ---

    const renderStatus = () => {
      if (statusOverride !== undefined) {
        renderSpatialSkeletonToolStatus(body, {
          message: statusOverride,
          point: statusPoint,
        });
        return;
      }
      if (currentMode === SkeletonEditMode.Merge) {
        const anchorNodeId =
          layer.spatialSkeletonState.mergeAnchorNodeId.value;
        if (anchorNodeId !== undefined) {
          const cachedNode =
            tool.getActiveSpatiallyIndexedSkeletonLayer()?.getNode(
              anchorNodeId,
            ) ?? layer.spatialSkeletonState.getCachedNode(anchorNodeId);
          const point: SpatialSkeletonToolPointInfo = {
            nodeId: anchorNodeId,
            segmentId: cachedNode?.segmentId,
            position: cachedNode?.position,
          };
          if (
            cachedNode?.segmentId !== undefined &&
            !tool.isSpatialSkeletonSegmentVisible(cachedNode.segmentId)
          ) {
            renderSpatialSkeletonToolStatus(body, {
              message:
                "Make this segment visible, then select a 2nd node to merge with · release m to exit",
              point,
            });
          } else {
            renderSpatialSkeletonToolStatus(body, {
              message: SPATIAL_SKELETON_MERGE_SELECTED_BANNER_MESSAGE,
              point,
            });
          }
        } else {
          renderSpatialSkeletonToolStatus(body, {
            message: "Select a node to merge with · release m to exit",
          });
        }
        return;
      }
      if (currentMode === SkeletonEditMode.Create) {
        renderSpatialSkeletonToolStatus(body, {
          message: SPATIAL_SKELETON_CREATE_BANNER_MESSAGE,
        });
        return;
      }
      // Default mode
      const selectedPoint = tool.getSelectedSpatialSkeletonNodeSummary();
      renderSpatialSkeletonToolStatus(body, {
        message: getSpatialSkeletonEditBannerMessage(selectedPoint),
        point: selectedPoint,
      });
    };

    const setStatus = (
      message: string | undefined,
      point?: SpatialSkeletonToolPointInfo,
    ) => {
      statusOverride = message;
      statusPoint = point;
      renderStatus();
    };

    const clearStatus = () => setStatus(undefined, undefined);

    // --- Mode transitions ---

    const enterMerge = (anchorNode: {
      nodeId: number;
      segmentId?: number;
      position?: SpatialSkeletonVector;
      sourceState?: SpatialSkeletonSourceState;
    }) => {
      if (anchorNode.segmentId !== undefined) {
        tool.pinSegmentByNumber(anchorNode.segmentId);
      }
      layer.selectSpatialSkeletonNode(anchorNode.nodeId, true, anchorNode);
      layer.setSpatialSkeletonMergeAnchor(anchorNode.nodeId);
      layer.spatialSkeletonMergeMode.value = true;
      currentMode = SkeletonEditMode.Merge;
      updateModeAttribute();
      renderStatus();
    };

    const exitMerge = () => {
      if (currentMode !== SkeletonEditMode.Merge) return;
      layer.clearSpatialSkeletonMergeAnchor();
      layer.spatialSkeletonMergeMode.value = false;
      currentMode = SkeletonEditMode.Default;
      updateModeAttribute();
      clearStatus();
    };

    const enterCreate = () => {
      currentMode = SkeletonEditMode.Create;
      createPlacedThisHold = false;
      updateModeAttribute();
      renderStatus();
    };

    const exitCreate = () => {
      if (currentMode !== SkeletonEditMode.Create) return;
      currentMode = SkeletonEditMode.Default;
      createPlacedThisHold = false;
      updateModeAttribute();
      clearStatus();
    };

    activation.registerDisposer(() => {
      layer.spatialSkeletonMergeMode.value = false;
      layer.spatialSkeletonState.clearPendingNodePositions();
    });

    // Sync ctrlHeld/shiftHeld from the logical modifier flags on any event that
    // carries them. This mirrors what NG's EventActionMap does via
    // getEventModifierMask, so OS-level modifier rebindings are transparent —
    // we never inspect specific key codes for ctrl or shift.
    const syncModifiers = (event: { ctrlKey: boolean; shiftKey: boolean }) => {
      const isCtrl = event.ctrlKey;
      const isShift = event.shiftKey;
      if (ctrlHeld === isCtrl && shiftHeld === isShift) return;
      ctrlHeld = isCtrl;
      shiftHeld = isShift;
      updateModeAttribute();
    };

    // Release held-key modes on keyup or when the window loses focus.
    const onKeyDown = (event: KeyboardEvent) => {
      syncModifiers(event);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "KeyM") {
        mergeKeyHeld = false;
        exitMerge();
      }
      if (event.code === "KeyN") exitCreate();
      if (event.code === "KeyS") splitKeyHeld = false;
      syncModifiers(event);
    };
    // mousemove catches modifiers pressed/released while keyboard focus is
    // outside the panel (e.g. a text input elsewhere in the UI).
    const onMouseMove = (event: MouseEvent) => {
      syncModifiers(event);
    };
    const onBlur = () => {
      mergeKeyHeld = false;
      splitKeyHeld = false;
      ctrlHeld = false;
      shiftHeld = false;
      exitMerge();
      exitCreate();
      updateModeAttribute();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("blur", onBlur);
    activation.registerDisposer(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("blur", onBlur);
    });

    activation.registerDisposer(
      layer.selectedSpatialSkeletonNodeInfo.changed.add(renderStatus),
    );
    activation.registerDisposer(
      layer.manager.root.selectionState.changed.add(renderStatus),
    );
    activation.registerDisposer(
      layer.spatialSkeletonState.mergeAnchorNodeId.changed.add(renderStatus),
    );
    activation.registerDisposer(
      layer.displayState.segmentationGroupState.value.visibleSegments.changed.add(
        renderStatus,
      ),
    );
    activation.registerDisposer(
      layer.layersChanged.add(() => {
        const reason = layer.getSpatialSkeletonActionsDisabledReason(
          [SpatialSkeletonActions.addNodes, SpatialSkeletonActions.moveNodes],
          { ignoreCommandBusy: true, requireVisibleChunks: false },
        );
        if (reason !== undefined) {
          StatusMessage.showTemporaryMessage(reason);
          activation.cancel();
        }
      }),
    );

    renderStatus();

    // --- Mode key action handlers ---

    activation.bindAction(
      "spatial-skeleton-enter-merge",
      (_event: ActionEvent<MouseEvent>) => {
        // mergeKeyHeld prevents the error toast from repeating on key-repeat
        // events while m is held without a hovered node.
        if (mergeKeyHeld || dragInProgress || pending || currentMode !== SkeletonEditMode.Default) return;
        mergeKeyHeld = true;
        const skeletonLayer = tool.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) return;
        const pickedNode =
          tool.resolvePickedNodeSelectionForMerge(skeletonLayer);
        if (pickedNode === undefined || pickedNode.segmentId === undefined) {
          StatusMessage.showTemporaryMessage(
            "Hover over a skeleton node to enter merge mode.",
          );
          return;
        }
        if (!tool.isSpatialSkeletonSegmentVisible(pickedNode.segmentId)) {
          StatusMessage.showTemporaryMessage(
            `Make skeleton ${pickedNode.segmentId} visible before merging.`,
          );
          return;
        }
        const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.mergeSkeletons,
        );
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          return;
        }
        enterMerge(pickedNode);
      },
    );

    activation.bindAction(
      "spatial-skeleton-enter-create",
      (_event: ActionEvent<MouseEvent>) => {
        if (dragInProgress || pending || currentMode !== SkeletonEditMode.Default) return;
        enterCreate();
      },
    );

    activation.bindAction(
      "spatial-skeleton-split",
      (_event: ActionEvent<MouseEvent>) => {
        // splitKeyHeld makes split a one-shot per keydown — browser key-repeat
        // would otherwise fire it continuously while s is held.
        if (splitKeyHeld || dragInProgress || pending) return;
        splitKeyHeld = true;
        const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.splitSkeletons,
        );
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          return;
        }
        const skeletonLayer = tool.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }
        const pickedNode = tool.resolvePickedNodeSelection(skeletonLayer);
        if (pickedNode === undefined || pickedNode.segmentId === undefined) {
          StatusMessage.showTemporaryMessage(
            "Hover over a skeleton node to split at that point.",
          );
          return;
        }
        tool.pinSegmentByNumber(pickedNode.segmentId);
        layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);
        const splitPoint: SpatialSkeletonToolPointInfo = {
          nodeId: pickedNode.nodeId,
          segmentId: pickedNode.segmentId,
          position: pickedNode.position,
        };
        pending = true;
        setStatus("Splitting selected node.", splitPoint);
        void (async () => {
          try {
            await executeSpatialSkeletonSplit(layer, {
              nodeId: pickedNode.nodeId,
              segmentId: pickedNode.segmentId!,
            });
          } catch (error) {
            showSpatialSkeletonActionError("split skeleton", error);
          } finally {
            pending = false;
            clearStatus();
          }
        })();
      },
    );

    // --- Capture-phase mousedown listeners ---
    // We don't bind mousedown0 in the EventActionMap because doing so would
    // shadow NG's rotate-via-mouse-drag / translate-via-mouse-drag actions
    // (both are EventActionMap actions at lower priority — stopPropagation:false
    // on the binding only affects native DOM propagation, not the NG action
    // dispatch hierarchy). Instead we register capture-phase DOM listeners so
    // we fire before MouseEventBinder's bubbling-phase listener. Off-node in
    // Default mode we return without calling stopPropagation, which lets
    // MouseEventBinder dispatch the rotate/pan action normally.

    for (const panel of layer.manager.root.display.panels) {
      if (!(panel instanceof RenderedDataPanel)) continue;
      const captureMousedown = (event: MouseEvent) => {
        // Middle mouse: rotate in perspective panels (handled by EventActionMap
        // mousedown1 → rotate-via-mouse-drag), pan in slice panels.
        // For slice panels we intercept here and drive translateByViewportPixels
        // directly via startRelativeMouseDrag, consuming the event before
        // MouseEventBinder can dispatch rotate-via-mouse-drag from the EventActionMap.
        // For perspective panels we let it pass through unmodified.
        if (event.button === 1) {
          if (!(panel instanceof PerspectivePanel)) {
            event.stopPropagation();
            event.preventDefault();
            startRelativeMouseDrag(event, (_dragEvent, deltaX, deltaY) => {
              panel.context.flagContinuousCameraMotion();
              panel.translateByViewportPixels(deltaX, deltaY);
            });
          }
          return;
        }

        // ctrl+mousedown0 → EventActionMap (add-node); shift+mousedown0 →
        // NG's translate/rotate action; other buttons → normal dispatch.
        // All three must pass through the capture listener unmodified.
        if (event.button !== 0 || event.ctrlKey || event.shiftKey) return;
        if (currentMode === SkeletonEditMode.Merge) {
          event.stopPropagation();
          event.preventDefault();
          handleMergeSecondPick(event);
          return;
        }
        if (currentMode === SkeletonEditMode.Create) {
          event.stopPropagation();
          event.preventDefault();
          handleCreatePlace(event);
          return;
        }
        // Default mode: only consume if hovering a node.
        handleDefaultMousedown(event, panel);
      };
      panel.element.addEventListener("mousedown", captureMousedown, {
        capture: true,
      });
      activation.registerDisposer(() => {
        panel.element.removeEventListener("mousedown", captureMousedown, {
          capture: true,
        });
      });
    }

    function handleDefaultMousedown(
      event: MouseEvent,
      panel: RenderedDataPanel,
    ) {
      const skeletonLayer = tool.getActiveSpatiallyIndexedSkeletonLayer();
      const pickedNode = skeletonLayer
        ? tool.getPickedSpatialSkeletonNode()
        : undefined;

      if (pickedNode === undefined) {
        // Off-node: don't consume — NG's bubbling-phase listener handles
        // rotate/pan. Show a transient press cursor so the user knows what NG
        // is about to do.
        const pressMode =
          panel instanceof PerspectivePanel ? "rotate" : "pan";
        panel.element.dataset.skeletonPressMode = pressMode;
        window.addEventListener(
          "pointerup",
          () => {
            delete panel.element.dataset.skeletonPressMode;
          },
          { once: true },
        );
        return;
      }

      // On a node: consume the event so NG doesn't also start a rotate/pan.
      event.stopPropagation();
      event.preventDefault();
      if (skeletonLayer === undefined) return;

      const canMove =
        layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.moveNodes,
        ) === undefined;
      const nodeInfo = canMove
        ? skeletonLayer.getNode(pickedNode.nodeId)
        : undefined;

      const pickedPosition = tool.mouseState.position;
      const hasPickedPosition =
        pickedPosition.length >= 3 &&
        Number.isFinite(pickedPosition[0]) &&
        Number.isFinite(pickedPosition[1]) &&
        Number.isFinite(pickedPosition[2]);

      // Can't start a drag: immediately select.
      if (nodeInfo === undefined || !hasPickedPosition) {
        if (pickedNode.segmentId !== undefined) {
          tool.pinSegmentByNumber(pickedNode.segmentId);
        }
        layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);
        return;
      }

      // Arm drag: threshold → move, no threshold → select.
      let totalDeltaX = 0;
      let totalDeltaY = 0;
      let dragStarted = false;
      let finished = false;
      let moved = false;

      tool.dragModelSpacePosition.set(nodeInfo.position);
      vec3.set(
        tool.dragGlobalAnchorPosition,
        Number(pickedPosition[0]),
        Number(pickedPosition[1]),
        Number(pickedPosition[2]),
      );

      startRelativeMouseDrag(
        event,
        (_dragEvent, deltaX, deltaY) => {
          totalDeltaX += deltaX;
          totalDeltaY += deltaY;
          if (!dragStarted) {
            const thresholdSq =
              DRAG_START_DISTANCE_PX * DRAG_START_DISTANCE_PX;
            if (
              totalDeltaX * totalDeltaX + totalDeltaY * totalDeltaY <
              thresholdSq
            ) {
              return;
            }
            dragStarted = true;
            dragInProgress = true;
            skeletonLayer!.markSegmentEdited(nodeInfo!.segmentId);
            panel.element.dataset.skeletonPressMode = "move";
            setStatus(SPATIAL_SKELETON_MOVING_NODE_MESSAGE);
          }
          panel.translateDataPointByViewportPixels(
            tool.dragGlobalPosition,
            tool.dragGlobalAnchorPosition,
            totalDeltaX,
            totalDeltaY,
          );
          if (
            !Number.isFinite(tool.dragGlobalPosition[0]) ||
            !Number.isFinite(tool.dragGlobalPosition[1]) ||
            !Number.isFinite(tool.dragGlobalPosition[2])
          ) {
            return;
          }
          const modelPosition = tool.globalToSkeletonCoordinates(
            tool.dragGlobalPosition,
            skeletonLayer!,
          );
          if (modelPosition === undefined) return;
          const previewChanged =
            layer.spatialSkeletonState.setPendingNodePosition(
              pickedNode.nodeId,
              modelPosition,
            );
          if (!previewChanged) return;
          moved = true;
          tool.dragModelSpacePosition.set(modelPosition);
        },
        (_finishEvent) => {
          if (finished) return;
          finished = true;
          if (dragInProgress) {
            dragInProgress = false;
            delete panel.element.dataset.skeletonPressMode;
            clearStatus();
          }
          if (!dragStarted) {
            // Click → select.
            if (pickedNode.segmentId !== undefined) {
              tool.pinSegmentByNumber(pickedNode.segmentId);
            }
            layer.selectSpatialSkeletonNode(
              pickedNode.nodeId,
              true,
              pickedNode,
            );
            return;
          }
          if (moved) {
            void executeSpatialSkeletonMoveNode(layer, {
              node: nodeInfo!,
              nextPositionInModelSpace: new Float32Array(
                tool.dragModelSpacePosition,
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
          layer.spatialSkeletonState.clearPendingNodePosition(pickedNode.nodeId);
        },
      );
    }

    function handleMergeSecondPick(event: MouseEvent) {
      // Caller (capture listener) already called stopPropagation/preventDefault.
      void event;
      if (pending) return;

      const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.mergeSkeletons,
      );
      if (disabledReason !== undefined) {
        StatusMessage.showTemporaryMessage(disabledReason);
        return;
      }
      const skeletonLayer = tool.getActiveSpatiallyIndexedSkeletonLayer();
      if (skeletonLayer === undefined) {
        StatusMessage.showTemporaryMessage(
          "No spatially indexed skeleton source is currently loaded.",
        );
        return;
      }

      const anchorNodeId = layer.spatialSkeletonState.mergeAnchorNodeId.value;
      if (anchorNodeId === undefined) {
        exitMerge();
        return;
      }
      const anchorNodeInfo =
        skeletonLayer.getNode(anchorNodeId) ??
        layer.spatialSkeletonState.getCachedNode(anchorNodeId);
      const firstNode = {
        nodeId: anchorNodeId,
        segmentId: anchorNodeInfo?.segmentId,
        position: anchorNodeInfo?.position,
        sourceState: anchorNodeInfo?.sourceState,
      };

      const pickedNode =
        tool.resolvePickedNodeSelectionForMerge(skeletonLayer);
      if (pickedNode === undefined || pickedNode.segmentId === undefined)
        return;

      if (
        pickedNode.nodeId === anchorNodeId ||
        pickedNode.segmentId === firstNode.segmentId
      ) {
        StatusMessage.showTemporaryMessage(
          "Select a node from a different skeleton to merge with.",
        );
        return;
      }

      if (firstNode.segmentId === undefined) {
        StatusMessage.showTemporaryMessage(
          "Unable to resolve merge anchor segment.",
        );
        return;
      }
      if (!tool.isSpatialSkeletonSegmentVisible(firstNode.segmentId)) {
        StatusMessage.showTemporaryMessage(
          `The first node selected for a merge operation must be from a visible skeleton. Make skeleton ${firstNode.segmentId} visible in the Seg tab or by double-clicking it in the viewer.`,
          3000,
        );
        return;
      }

      tool.pinSegmentByNumber(pickedNode.segmentId);
      layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);
      pending = true;
      setStatus("Merging selected nodes.");

      void (async () => {
        try {
          await waitForNextAnimationFrame();
          await executeSpatialSkeletonMerge(
            layer,
            {
              nodeId: firstNode.nodeId,
              segmentId: firstNode.segmentId!,
              position: firstNode.position,
              sourceState: firstNode.sourceState,
            },
            {
              nodeId: pickedNode.nodeId,
              segmentId: pickedNode.segmentId!,
              position: pickedNode.position,
              sourceState: pickedNode.sourceState,
            },
          );
        } catch (error) {
          showSpatialSkeletonActionError("merge skeletons", error);
        } finally {
          pending = false;
          renderStatus(); // Keep merge mode — user may still be holding m.
        }
      })();
    }

    function handleCreatePlace(event: MouseEvent) {
      // Caller (capture listener) already called stopPropagation/preventDefault.
      void event;

      if (pending || createPlacedThisHold) return;

      const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.addNodes,
      );
      if (disabledReason !== undefined) {
        StatusMessage.showTemporaryMessage(disabledReason);
        return;
      }
      const skeletonLayer = tool.getActiveSpatiallyIndexedSkeletonLayer();
      if (skeletonLayer === undefined) {
        StatusMessage.showTemporaryMessage(
          "No spatially indexed skeleton source is currently loaded.",
        );
        return;
      }

      const clickPosition =
        tool.getMousePositionInSkeletonCoordinates(skeletonLayer);
      if (clickPosition === undefined) {
        StatusMessage.showTemporaryMessage(
          "Unable to resolve click position for new skeleton.",
        );
        return;
      }

      createPlacedThisHold = true;
      pending = true;
      setStatus("Creating new skeleton.");

      void (async () => {
        try {
          await executeSpatialSkeletonAddNode(layer, {
            skeletonId: 0,
            parentNodeId: undefined,
            positionInModelSpace: new Float32Array(clickPosition),
          });
        } catch (error) {
          showSpatialSkeletonActionError("create skeleton", error);
        } finally {
          pending = false;
          renderStatus();
        }
      })();
    }

    // --- Add node handler (ctrl+mousedown0) ---

    activation.bindAction(
      "spatial-skeleton-add-node",
      (event: ActionEvent<MouseEvent>) => {
        event.stopPropagation();
        event.detail.preventDefault();

        // Exit any sub-mode so state stays consistent.
        if (currentMode === SkeletonEditMode.Merge) exitMerge();
        if (currentMode === SkeletonEditMode.Create) exitCreate();

        const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.addNodes,
        );
        if (disabledReason !== undefined) {
          StatusMessage.showTemporaryMessage(disabledReason);
          return;
        }
        const skeletonLayer = tool.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }

        const selectedParentNodeId =
          layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
        if (selectedParentNodeId === undefined) {
          StatusMessage.showTemporaryMessage(
            "Select a node first, then ctrl+click to append a child.",
          );
          return;
        }
        const addNodeBlockedReason = tool.getAddNodeBlockedReason(
          skeletonLayer,
          selectedParentNodeId,
        );
        if (addNodeBlockedReason !== undefined) {
          StatusMessage.showTemporaryMessage(addNodeBlockedReason);
          return;
        }

        const clickStartPosition =
          tool.getMousePositionInSkeletonCoordinates(skeletonLayer);
        if (clickStartPosition === undefined) {
          StatusMessage.showTemporaryMessage(
            "Unable to resolve add-node position for this click.",
          );
          return;
        }

        let dragDistanceSquared = 0;
        startRelativeMouseDrag(
          event.detail,
          (_dragEvent, deltaX, deltaY) => {
            dragDistanceSquared += deltaX * deltaX + deltaY * deltaY;
          },
          (_finishEvent) => {
            const thresholdSquared =
              DRAG_START_DISTANCE_PX * DRAG_START_DISTANCE_PX;
            if (dragDistanceSquared > thresholdSquared) {
              return;
            }
            const currentParentNodeId =
              layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
            if (currentParentNodeId === undefined) {
              StatusMessage.showTemporaryMessage(
                "Select a node first, then ctrl+click to append a child.",
              );
              return;
            }
            const blockedReason = tool.getAddNodeBlockedReason(
              skeletonLayer,
              currentParentNodeId,
            );
            if (blockedReason !== undefined) {
              StatusMessage.showTemporaryMessage(blockedReason);
              return;
            }
            const selectedParentNode = tool.getSelectedParentNodeForAdd(
              skeletonLayer,
              currentParentNodeId,
            );
            const clickPositionInModelSpace =
              tool.getMousePositionInSkeletonCoordinates(skeletonLayer);
            if (clickPositionInModelSpace === undefined) return;
            void (async () => {
              try {
                await executeSpatialSkeletonAddNode(layer, {
                  skeletonId: selectedParentNode?.segmentId ?? 0,
                  parentNodeId: currentParentNodeId,
                  positionInModelSpace: new Float32Array(
                    clickPositionInModelSpace,
                  ),
                });
              } catch (error) {
                showSpatialSkeletonActionError("create node", error);
              }
            })();
          },
        );
      },
    );

    // --- Delete node handler (ctrl+alt+mousedown2) ---

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
        const skeletonLayer = tool.getActiveSpatiallyIndexedSkeletonLayer();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }
        const pickedNode = tool.getPickedSpatialSkeletonNode();
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

// Backward-compat alias — external code referencing SpatialSkeletonEditModeTool still works.
export { SpatialSkeletonEditTool as SpatialSkeletonEditModeTool };

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
    (layer) => new SpatialSkeletonEditTool(layer),
    makeSpatialSkeletonToolLister(SPATIAL_SKELETON_EDIT_MODE_TOOL_ID),
  );
}
