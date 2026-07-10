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
import {
  SKELETON_ADD_NODE,
  SKELETON_CLEAR_SELECTION,
  SKELETON_ENTER_CREATE,
  SKELETON_ENTER_DELETE_MODE,
  SKELETON_ENTER_MERGE_MODE,
  SKELETON_ENTER_SPLIT_MODE,
  SKELETON_PIN_NODE,
  SKELETON_REROOT,
  SKELETON_TOGGLE_TRUE_END,
} from "#src/skeleton/actions.js";
import type {
  SpatialSkeletonSourceState,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";
import { SpatialSkeletonActions } from "#src/skeleton/command_protocol.js";
import {
  executeSpatialSkeletonAddNode,
  executeSpatialSkeletonDeleteNode,
  executeSpatialSkeletonMerge,
  executeSpatialSkeletonMoveNode,
  executeSpatialSkeletonNodeTrueEndUpdate,
  executeSpatialSkeletonSplit,
  showSpatialSkeletonActionError,
} from "#src/skeleton/commands.js";
import {
  type SpatiallyIndexedSkeletonLayer,
  setSpatialSkeletonModesToLinesAndPoints,
} from "#src/skeleton/frontend.js";
import {
  PerspectiveViewSpatiallyIndexedSkeletonLayer,
  SliceViewPanelSpatiallyIndexedSkeletonLayer,
} from "#src/skeleton/frontend.js";
import { StatusMessage } from "#src/status.js";
import {
  getDefaultSkeletonEditAuxBindings,
  getDefaultSkeletonEditNodeBindings,
  getDefaultSkeletonEditToolBindings,
} from "#src/ui/default_input_event_bindings.js";
import type { SpatialSkeletonToolStatusText } from "#src/ui/skeleton_edit_tool_messages.js";
import {
  SPATIAL_SKELETON_EDIT_TOOL_NAME,
  getSpatialSkeletonCreateIdleStatusText,
  getSpatialSkeletonCreatingStatusText,
  getSpatialSkeletonDefaultStatusText,
  getSpatialSkeletonDeleteIdleStatusText,
  getSpatialSkeletonDeletingStatusText,
  getSpatialSkeletonMergeStatusText,
  getSpatialSkeletonMovingStatusText,
  getSpatialSkeletonSplitIdleStatusText,
} from "#src/ui/skeleton_edit_tool_messages.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolActivationStatusMessageWithHeader,
  registerTool,
} from "#src/ui/tool.js";
import { removeChildren } from "#src/util/dom.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import { vec3 } from "#src/util/geom.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";

export const SPATIAL_SKELETON_EDIT_MODE_TOOL_ID = "spatialSkeletonEditMode";

// Internal mode enum for sustained editing states.
// Move and Select are both handled in Default.
const enum SkeletonEditMode {
  Default = 0,
  Merge = 1,
  Create = 2,
  Split = 3,
  Delete = 4,
}

// In edit mode, plain left click is selection-only — it never rotates or
// pans. Navigation (rotate in perspective, pan in slice) is handled by
// middle mouse (mousedown1), plus trackpad-friendly aliases on the
// navigation modifier + left mouse (control+mousedown0 on most platforms,
// cmd+mousedown0 on Mac — see hasNavigationModifier below): the modifier
// alone mirrors plain middle-click, and modifier+shift mirrors
// control+middle-click. mousedown0 is therefore handled only via the
// capture-phase DOM listeners in activate(); it is not in the EventActionMap.
//
// mousedown1 / control?+mousedown0 → rotate-via-mouse-drag covers perspective
// panels via the EventActionMap. Slice panels intercept middle mouse and the
// navigation-modifier chords in the capture listener and call
// translateByViewportPixels directly, consuming the event before
// MouseEventBinder can dispatch this action.
//
// Default bindings are defined in getDefaultSkeletonEditToolBindings() /
// getDefaultSkeletonEditAuxBindings() in default_input_event_bindings.ts.

const DRAG_START_DISTANCE_PX = 2;

// Physical key codes that exit the corresponding momentary mode on keyup
// (see the onKeyUp handler in activate()). Centralized here so the "which
// key exits which mode" association — inherently duplicated between the
// exit trigger and the status-bar hint that describes it — lives in exactly
// one place. Tool-scoped bindings like these aren't wired into the app's
// input-event-map rebinding system, so this can't be derived generically.
const MERGE_EXIT_KEY_CODE = "KeyM";
const SPLIT_EXIT_KEY_CODE = "KeyS";
const CREATE_EXIT_KEY_CODE = "KeyN";
const DELETE_EXIT_KEY_CODE = "KeyD";

function hasNavigationModifier(event: { ctrlKey: boolean; metaKey: boolean }) {
  // TODO replace by mac check
  return event.metaKey || event.ctrlKey;
}

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
  text: SpatialSkeletonToolStatusText,
) {
  removeChildren(body);
  body.classList.add("neuroglancer-skeleton-tool-status");
  const dividerElement = document.createElement("span");
  dividerElement.className = "neuroglancer-skeleton-tool-status-divider";
  dividerElement.textContent = "—";
  body.appendChild(dividerElement);
  const statusElement = document.createElement("span");
  statusElement.className = "neuroglancer-skeleton-tool-status-text";
  statusElement.textContent = text.status;
  body.appendChild(statusElement);
  if (text.actions.length === 0) {
    return;
  }
  const actionsElement = document.createElement("span");
  actionsElement.className = "neuroglancer-skeleton-tool-status-actions";
  actionsElement.textContent = text.actions;
  body.appendChild(actionsElement);
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
      SKELETON_PIN_NODE,
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
      SKELETON_CLEAR_SELECTION,
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

  // Persistent coordinate-transform fields — created once, never reassigned.
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

  // Activation-scoped state — reset at the start of each activate() call.
  private currentMode: SkeletonEditMode = SkeletonEditMode.Default;
  private dragInProgress = false;
  private pending = false;
  private createPlacedThisHold = false;
  // One-shot guards: prevent repeated fires while a key is held down.
  private mergeKeyHeld = false;
  private splitKeyHeld = false;
  private deleteKeyHeld = false;
  // Modifier-held state drives cursor indicators and blocks node actions.
  private shiftHeld = false;
  // Navigation modifier (ctrl, or cmd on Mac — see hasNavigationModifier).
  // While held, the shift-driven "add node" cursor/status must be
  // suppressed, since modifier+shift now means pan, not add-node.
  private ctrlHeld = false;
  // Physical key codes currently held down — used only to decide whether the
  // status actions text should show a "release <key> to exit" hint. Merge/
  // split/create can also be entered via a synthetic dispatched action (no
  // physical keydown), in which case that hint would be misleading.
  private heldPhysicalKeyCodes = new Set<string>();
  private statusOverride: SpatialSkeletonToolStatusText | undefined = undefined;
  // Set at activation start; cleared by the activation disposer to prevent
  // post-deactivation UI writes.
  private statusBody: HTMLElement | undefined = undefined;

  // --- Cursor helpers ---

  private setModeAttribute(mode: string | undefined) {
    const { display } = this.layer.manager.root;
    for (const panel of display.panels) {
      if (!(panel instanceof RenderedDataPanel)) continue;
      if (mode === undefined) {
        delete panel.element.dataset.skeletonEditMode;
      } else {
        panel.element.dataset.skeletonEditMode = mode;
      }
    }
  }

  // Recomputes the correct data-skeleton-edit-mode attribute from current
  // mode + held modifiers so callers don't have to care about that interaction.
  // Priority: sustained tool modes > shift (add cursor hint).
  private updateModeAttribute() {
    if (this.currentMode === SkeletonEditMode.Merge) {
      this.setModeAttribute("merge");
    } else if (this.currentMode === SkeletonEditMode.Create) {
      this.setModeAttribute("create");
    } else if (this.currentMode === SkeletonEditMode.Split) {
      this.setModeAttribute("split");
    } else if (this.currentMode === SkeletonEditMode.Delete) {
      this.setModeAttribute("delete");
    } else if (this.shiftHeld && !this.ctrlHeld) {
      this.setModeAttribute("add");
    } else {
      this.setModeAttribute("default");
    }
  }

  // --- Status rendering ---

  private renderStatus() {
    if (this.statusBody === undefined) return;
    const body = this.statusBody;
    if (this.statusOverride !== undefined) {
      renderSpatialSkeletonToolStatus(body, this.statusOverride);
      return;
    }
    if (this.currentMode === SkeletonEditMode.Merge) {
      const anchorNodeId =
        this.layer.spatialSkeletonState.mergeAnchorNodeId.value;
      const canExitWithKey = this.heldPhysicalKeyCodes.has(MERGE_EXIT_KEY_CODE);
      if (anchorNodeId !== undefined) {
        const cachedNode =
          this.getActiveSpatiallyIndexedSkeletonLayer()?.getNode(
            anchorNodeId,
          ) ?? this.layer.spatialSkeletonState.getCachedNode(anchorNodeId);
        const isHidden =
          cachedNode?.segmentId !== undefined &&
          !this.isSpatialSkeletonSegmentVisible(cachedNode.segmentId);
        renderSpatialSkeletonToolStatus(
          body,
          getSpatialSkeletonMergeStatusText(
            isHidden ? "from-node-hidden" : "from-node-visible",
            canExitWithKey,
          ),
        );
      } else {
        renderSpatialSkeletonToolStatus(
          body,
          getSpatialSkeletonMergeStatusText("no-from-node", canExitWithKey),
        );
      }
      return;
    }
    if (this.currentMode === SkeletonEditMode.Split) {
      renderSpatialSkeletonToolStatus(
        body,
        getSpatialSkeletonSplitIdleStatusText(
          this.heldPhysicalKeyCodes.has(SPLIT_EXIT_KEY_CODE),
        ),
      );
      return;
    }
    if (this.currentMode === SkeletonEditMode.Create) {
      renderSpatialSkeletonToolStatus(
        body,
        getSpatialSkeletonCreateIdleStatusText(
          this.heldPhysicalKeyCodes.has(CREATE_EXIT_KEY_CODE),
        ),
      );
      return;
    }
    if (this.currentMode === SkeletonEditMode.Delete) {
      renderSpatialSkeletonToolStatus(
        body,
        getSpatialSkeletonDeleteIdleStatusText(
          this.heldPhysicalKeyCodes.has(DELETE_EXIT_KEY_CODE),
        ),
      );
      return;
    }
    // Default mode
    const selectedPoint = this.getSelectedSpatialSkeletonNodeSummary();
    const isHidden =
      selectedPoint?.segmentId !== undefined &&
      !this.isSpatialSkeletonSegmentVisible(selectedPoint.segmentId);
    renderSpatialSkeletonToolStatus(
      body,
      getSpatialSkeletonDefaultStatusText(
        selectedPoint === undefined
          ? "none"
          : isHidden
            ? "selected-hidden"
            : "selected-visible",
        this.shiftHeld && !this.ctrlHeld,
      ),
    );
  }

  private setStatus(text: SpatialSkeletonToolStatusText | undefined) {
    this.statusOverride = text;
    this.renderStatus();
  }

  private clearStatus() {
    this.setStatus(undefined);
  }

  // --- Modifier tracking ---

  // Sync shiftHeld/ctrlHeld from the logical modifier flags on any event
  // that carries them. This mirrors what NG's EventActionMap does via
  // getEventModifierMask, so OS-level modifier rebindings are transparent —
  // we never inspect key codes.
  private syncModifiers(event: {
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }) {
    const isShift = event.shiftKey;
    const isCtrl = hasNavigationModifier(event);
    if (this.shiftHeld === isShift && this.ctrlHeld === isCtrl) return;
    this.shiftHeld = isShift;
    this.ctrlHeld = isCtrl;
    this.updateModeAttribute();
    this.renderStatus();
  }

  // --- Mode transitions ---

  // Return merge to its "waiting for the first pick" state: no active anchor
  // and the selected-node highlight hidden. Used both when entering merge and
  // after a merge completes. The node selection itself is preserved (only its
  // highlight is suppressed) — merge never clears the selection, it only hides
  // it. Merge mode itself is left untouched.
  private resetMergeToFreshState() {
    this.layer.clearSpatialSkeletonMergeAnchor();
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = true;
    // Drop any transient override so the idle "click a node to merge from"
    // prompt shows again — the tool stays held, so it just waits for the next
    // pick rather than lingering on a stale status.
    this.statusOverride = undefined;
    this.renderStatus();
  }

  // Split has no anchor, but like merge it stays active while held; reset the
  // selection/highlight and status after a split so it prompts for the next
  // node instead of lingering.
  private resetSplitToFreshState() {
    this.layer.clearSpatialSkeletonNodeSelection("force-unpin");
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = true;
    this.statusOverride = undefined;
    this.renderStatus();
  }

  private enterMerge() {
    // Merge always starts without an active anchor — it can never begin with a
    // pre-set anchor. The anchor is set solely by the first in-mode pick
    // (handleMergeFirstPick), which also sets the selected node. Entering merge
    // preserves the current node selection and only hides its highlight, so the
    // selection reappears if the user exits merge without picking.
    this.resetMergeToFreshState();
    this.layer.spatialSkeletonMergeMode.value = true;
    this.currentMode = SkeletonEditMode.Merge;
    this.updateModeAttribute();
    this.renderStatus();
  }

  private exitMerge() {
    if (this.currentMode !== SkeletonEditMode.Merge) return;
    this.layer.clearSpatialSkeletonMergeAnchor();
    this.layer.spatialSkeletonMergeMode.value = false;
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
    this.currentMode = SkeletonEditMode.Default;
    this.updateModeAttribute();
    this.clearStatus();
  }

  private enterCreate() {
    this.currentMode = SkeletonEditMode.Create;
    this.createPlacedThisHold = false;
    this.updateModeAttribute();
    this.renderStatus();
  }

  private exitCreate() {
    if (this.currentMode !== SkeletonEditMode.Create) return;
    this.currentMode = SkeletonEditMode.Default;
    this.createPlacedThisHold = false;
    this.updateModeAttribute();
    this.clearStatus();
  }

  private enterSplit() {
    this.currentMode = SkeletonEditMode.Split;
    this.layer.spatialSkeletonSplitMode.value = true;
    // In split mode the selected-node highlight stays hidden until the user
    // clicks a node to split (or exits back to default mode).
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = true;
    this.updateModeAttribute();
    this.renderStatus();
  }

  private exitSplit() {
    if (this.currentMode !== SkeletonEditMode.Split) return;
    this.currentMode = SkeletonEditMode.Default;
    this.layer.spatialSkeletonSplitMode.value = false;
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
    this.updateModeAttribute();
    this.clearStatus();
  }

  private enterDelete() {
    this.currentMode = SkeletonEditMode.Delete;
    this.updateModeAttribute();
    this.renderStatus();
  }

  private exitDelete() {
    if (this.currentMode !== SkeletonEditMode.Delete) return;
    this.currentMode = SkeletonEditMode.Default;
    this.updateModeAttribute();
    this.clearStatus();
  }

  // --- Mouse handlers ---

  private handleDefaultMousedown(event: MouseEvent, panel: RenderedDataPanel) {
    const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
    const pickedNode = skeletonLayer
      ? this.getPickedSpatialSkeletonNode()
      : undefined;

    if (pickedNode === undefined) {
      // Off-node left click: consume so NG's rotate/pan actions don't fire.
      // Navigation is handled exclusively by middle mouse in edit mode.
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    // On a node: consume the event so NG doesn't also start a rotate/pan.
    event.stopPropagation();
    event.preventDefault();
    if (skeletonLayer === undefined) return;

    const canMove =
      this.layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.moveNodes,
      ) === undefined;
    const nodeInfo = canMove
      ? skeletonLayer.getNode(pickedNode.nodeId)
      : undefined;

    const pickedPosition = this.mouseState.position;
    const hasPickedPosition =
      pickedPosition.length >= 3 &&
      Number.isFinite(pickedPosition[0]) &&
      Number.isFinite(pickedPosition[1]) &&
      Number.isFinite(pickedPosition[2]);

    // Select immediately on mousedown so it always happens even if the drag
    // finish callback never fires (e.g. pointer capture lost).
    if (pickedNode.segmentId !== undefined) {
      this.pinSegmentByNumber(pickedNode.segmentId);
    }
    this.layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);

    if (nodeInfo === undefined || !hasPickedPosition) {
      return; // Can't drag: done after the select above.
    }

    // Arm drag: if threshold exceeded, move the node.
    let totalDeltaX = 0;
    let totalDeltaY = 0;
    let dragStarted = false;
    let finished = false;
    let moved = false;

    this.dragModelSpacePosition.set(nodeInfo.position);
    vec3.set(
      this.dragGlobalAnchorPosition,
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
          const thresholdSq = DRAG_START_DISTANCE_PX * DRAG_START_DISTANCE_PX;
          if (
            totalDeltaX * totalDeltaX + totalDeltaY * totalDeltaY <
            thresholdSq
          ) {
            return;
          }
          dragStarted = true;
          this.dragInProgress = true;
          skeletonLayer!.markSegmentEdited(nodeInfo!.segmentId);
          panel.element.dataset.skeletonPressMode = "move";
          this.setStatus(getSpatialSkeletonMovingStatusText());
        }
        panel.translateDataPointByViewportPixels(
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
          skeletonLayer!,
        );
        if (modelPosition === undefined) return;
        const previewChanged =
          this.layer.spatialSkeletonState.setPendingNodePosition(
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
        if (this.dragInProgress) {
          this.dragInProgress = false;
          delete panel.element.dataset.skeletonPressMode;
          this.clearStatus();
        }
        if (!dragStarted) return; // Pure click: selection already happened on mousedown.
        if (moved) {
          void executeSpatialSkeletonMoveNode(this.layer, {
            node: nodeInfo!,
            nextPositionInModelSpace: new Float32Array(
              this.dragModelSpacePosition,
            ),
          })
            .then(() => {
              this.layer.spatialSkeletonState.clearPendingNodePosition(
                pickedNode.nodeId,
              );
            })
            .catch((error) => {
              this.layer.spatialSkeletonState.clearPendingNodePosition(
                pickedNode.nodeId,
              );
              showSpatialSkeletonActionError("move node", error);
            });
          return;
        }
        this.layer.spatialSkeletonState.clearPendingNodePosition(
          pickedNode.nodeId,
        );
      },
    );
  }

  private executeSplitOnNode(pickedNode: {
    nodeId: number;
    segmentId: number;
    position?: SpatialSkeletonVector;
  }) {
    this.pinSegmentByNumber(pickedNode.segmentId);
    this.layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);
    // A node was clicked: reveal the selected-node highlight for it.
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
    this.pending = true;
    void (async () => {
      try {
        await executeSpatialSkeletonSplit(this.layer, {
          nodeId: pickedNode.nodeId,
          segmentId: pickedNode.segmentId,
        });
      } catch (error) {
        showSpatialSkeletonActionError("split skeleton", error);
      } finally {
        this.pending = false;
        // Reset to a fresh split so it prompts for the next node (the user may
        // still be holding s) rather than lingering on a "splitting…" status.
        this.resetSplitToFreshState();
      }
    })();
  }

  private handleSplitPick() {
    // Caller (capture listener) already called stopPropagation/preventDefault.
    if (this.pending) return;

    const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
    if (skeletonLayer === undefined) {
      StatusMessage.showTemporaryMessage(
        "No spatially indexed skeleton source is currently loaded.",
      );
      return;
    }
    const pickedNode = this.resolvePickedNodeSelection(skeletonLayer);
    if (pickedNode === undefined || pickedNode.segmentId === undefined) {
      StatusMessage.showTemporaryMessage("Click a skeleton node to split.");
      return;
    }
    this.executeSplitOnNode({
      nodeId: pickedNode.nodeId,
      segmentId: pickedNode.segmentId,
      position: pickedNode.position,
    });
  }

  private handleMergeFirstPick() {
    const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
    if (skeletonLayer === undefined) {
      StatusMessage.showTemporaryMessage(
        "No spatially indexed skeleton source is currently loaded.",
      );
      return;
    }
    const pickedNode = this.resolvePickedNodeSelectionForMerge(skeletonLayer);
    if (pickedNode === undefined || pickedNode.segmentId === undefined) {
      StatusMessage.showTemporaryMessage(
        "Click a skeleton node to set as merge anchor.",
      );
      return;
    }
    if (!this.isSpatialSkeletonSegmentVisible(pickedNode.segmentId)) {
      StatusMessage.showTemporaryMessage(
        `Make skeleton ${pickedNode.segmentId} visible before merging.`,
      );
      return;
    }
    if (pickedNode.segmentId !== undefined) {
      this.pinSegmentByNumber(pickedNode.segmentId);
    }
    this.layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);
    this.layer.setSpatialSkeletonMergeAnchor(pickedNode.nodeId);
    // First click made: reveal the selected-node highlight for the from node.
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
    this.renderStatus();
  }

  private handleMergeSecondPick() {
    // Caller (capture listener) already called stopPropagation/preventDefault.
    if (this.pending) return;

    const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
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

    const anchorNodeId =
      this.layer.spatialSkeletonState.mergeAnchorNodeId.value;
    if (anchorNodeId === undefined) {
      // No anchor yet — this click sets the merge anchor.
      this.handleMergeFirstPick();
      return;
    }
    const anchorNodeInfo =
      skeletonLayer.getNode(anchorNodeId) ??
      this.layer.spatialSkeletonState.getCachedNode(anchorNodeId);
    const firstNode = {
      nodeId: anchorNodeId,
      segmentId: anchorNodeInfo?.segmentId,
      position: anchorNodeInfo?.position,
      sourceState: anchorNodeInfo?.sourceState,
    };

    const pickedNode = this.resolvePickedNodeSelectionForMerge(skeletonLayer);
    if (pickedNode === undefined || pickedNode.segmentId === undefined) return;

    if (pickedNode.nodeId === anchorNodeId) {
      // Clicked the anchor node again — nothing to do.
      return;
    }
    if (pickedNode.segmentId === firstNode.segmentId) {
      // The second pick is on the SAME skeleton as the anchor. Rather than
      // blocking the edit and leaving the old anchor armed, treat this as the
      // user re-choosing the "from" node: move the merge anchor here and stay
      // in merge mode so they can now pick a node on a different skeleton.
      if (!this.isSpatialSkeletonSegmentVisible(pickedNode.segmentId)) {
        StatusMessage.showTemporaryMessage(
          `Make skeleton ${pickedNode.segmentId} visible before merging.`,
        );
        return;
      }
      this.pinSegmentByNumber(pickedNode.segmentId);
      this.layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);
      this.layer.setSpatialSkeletonMergeAnchor(pickedNode.nodeId);
      this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
      this.renderStatus();
      StatusMessage.showTemporaryMessage(
        "Moved the merge start here — now select a node on a different skeleton.",
      );
      return;
    }

    if (firstNode.segmentId === undefined) {
      StatusMessage.showTemporaryMessage(
        "Unable to resolve merge anchor segment.",
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
    this.layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);
    this.pending = true;

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
            nodeId: pickedNode.nodeId,
            segmentId: pickedNode.segmentId!,
            position: pickedNode.position,
            sourceState: pickedNode.sourceState,
          },
        );
      } catch (error) {
        showSpatialSkeletonActionError("merge skeletons", error);
      } finally {
        this.pending = false;
        // If the user released M while the merge was in flight, exitMerge has
        // already left merge mode and restored the highlight — do not re-hide
        // it here (that would leave the selection permanently hidden). Only
        // reset when still in merge mode: clear the anchor and re-hide the
        // highlight (the selection is kept) so the next click starts a fresh
        // merge. Applies on both success and error.
        if (this.currentMode === SkeletonEditMode.Merge) {
          this.resetMergeToFreshState();
        }
      }
    })();
  }

  private handleCreatePlace() {
    // Caller (capture listener) already called stopPropagation/preventDefault.
    if (this.pending || this.createPlacedThisHold) return;

    const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
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

    const clickPosition =
      this.getMousePositionInSkeletonCoordinates(skeletonLayer);
    if (clickPosition === undefined) {
      StatusMessage.showTemporaryMessage(
        "Unable to resolve click position for new skeleton.",
      );
      return;
    }

    this.createPlacedThisHold = true;
    this.pending = true;
    this.setStatus(getSpatialSkeletonCreatingStatusText());

    void (async () => {
      try {
        await executeSpatialSkeletonAddNode(this.layer, {
          skeletonId: 0,
          parentNodeId: undefined,
          positionInModelSpace: new Float32Array(clickPosition),
        });
      } catch (error) {
        showSpatialSkeletonActionError("create skeleton", error);
      } finally {
        this.pending = false;
        this.renderStatus();
      }
    })();
  }

  // --- Action implementations ---

  // Merge (m): enters merge mode — click to pick the anchor node, then the target.
  private onEnterMergeModeAction() {
    if (
      this.mergeKeyHeld ||
      this.dragInProgress ||
      this.pending ||
      this.currentMode !== SkeletonEditMode.Default
    )
      return;
    this.mergeKeyHeld = true;
    const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
      SpatialSkeletonActions.mergeSkeletons,
    );
    if (disabledReason !== undefined) {
      StatusMessage.showTemporaryMessage(disabledReason);
      return;
    }
    this.enterMerge();
  }

  private onEnterCreateAction() {
    if (
      this.dragInProgress ||
      this.pending ||
      this.currentMode !== SkeletonEditMode.Default
    )
      return;
    this.enterCreate();
  }

  // Split (s): enters split mode — click the node to split.
  private onEnterSplitModeAction() {
    if (
      this.splitKeyHeld ||
      this.dragInProgress ||
      this.pending ||
      this.currentMode !== SkeletonEditMode.Default
    )
      return;
    this.splitKeyHeld = true;
    const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
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
    this.enterSplit();
  }

  // Delete (d): enters delete mode — click a node to delete it.
  private onEnterDeleteModeAction() {
    if (
      this.deleteKeyHeld ||
      this.dragInProgress ||
      this.pending ||
      this.currentMode !== SkeletonEditMode.Default
    )
      return;
    this.deleteKeyHeld = true;
    const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
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
    this.enterDelete();
  }

  private onAddNodeAction(event: ActionEvent<MouseEvent>) {
    event.stopPropagation();
    event.detail.preventDefault();

    if (this.currentMode !== SkeletonEditMode.Default) return;

    const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
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
      this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
    if (selectedParentNodeId === undefined) {
      StatusMessage.showTemporaryMessage(
        "Select a node first, then shift+click to append a child.",
      );
      return;
    }
    const addNodeBlockedReason = this.getAddNodeBlockedReason(
      skeletonLayer,
      selectedParentNodeId,
    );
    if (addNodeBlockedReason !== undefined) {
      StatusMessage.showTemporaryMessage(addNodeBlockedReason);
      return;
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
          this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
        if (currentParentNodeId === undefined) {
          StatusMessage.showTemporaryMessage(
            "Select a node first, then shift+click to append a child.",
          );
          return;
        }
        const blockedReason = this.getAddNodeBlockedReason(
          skeletonLayer,
          currentParentNodeId,
        );
        if (blockedReason !== undefined) {
          StatusMessage.showTemporaryMessage(blockedReason);
          return;
        }
        const selectedParentNode = this.getSelectedParentNodeForAdd(
          skeletonLayer,
          currentParentNodeId,
        );
        const clickPositionInModelSpace =
          this.getMousePositionInSkeletonCoordinates(skeletonLayer);
        if (clickPositionInModelSpace === undefined) return;
        void (async () => {
          try {
            await executeSpatialSkeletonAddNode(this.layer, {
              skeletonId: selectedParentNode?.segmentId ?? 0,
              parentNodeId: currentParentNodeId,
              positionInModelSpace: new Float32Array(clickPositionInModelSpace),
            });
          } catch (error) {
            showSpatialSkeletonActionError("create node", error);
          }
        })();
      },
    );
  }

  private handleDeletePick() {
    // Caller (capture listener) already called stopPropagation/preventDefault.
    if (this.pending) return;

    const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
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
      StatusMessage.showTemporaryMessage("Click a skeleton node to delete.");
      return;
    }
    const nodeInfo = skeletonLayer.getNode(pickedNode.nodeId);
    if (nodeInfo === undefined) {
      StatusMessage.showTemporaryMessage(
        `Unable to resolve node ${pickedNode.nodeId} for deletion.`,
      );
      return;
    }
    this.pending = true;
    this.setStatus(getSpatialSkeletonDeletingStatusText());
    void this.layer
      .getSpatialSkeletonDeleteOperationContext(nodeInfo)
      .then(() => executeSpatialSkeletonDeleteNode(this.layer, nodeInfo))
      .catch((error) => {
        showSpatialSkeletonActionError("delete node", error);
      })
      .finally(() => {
        this.pending = false;
        this.renderStatus();
      });
  }

  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const rawInputEventMapBinder = activation.inputEventMapBinder;

    // 1. Reset all activation-scoped state.
    this.currentMode = SkeletonEditMode.Default;
    this.dragInProgress = false;
    this.pending = false;
    this.createPlacedThisHold = false;
    this.mergeKeyHeld = false;
    this.splitKeyHeld = false;
    this.deleteKeyHeld = false;
    this.shiftHeld = false;
    this.ctrlHeld = false;
    this.heldPhysicalKeyCodes = new Set();
    this.statusOverride = undefined;
    layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;

    // 2. Create status UI.
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = SPATIAL_SKELETON_EDIT_TOOL_NAME;
    this.statusBody = body;

    // 3. Precondition checks.
    const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
      [SpatialSkeletonActions.addNodes, SpatialSkeletonActions.moveNodes],
      { ignoreCommandBusy: true, requireVisibleChunks: false },
    );
    if (disabledReason !== undefined) {
      StatusMessage.showTemporaryMessage(disabledReason);
      renderSpatialSkeletonToolStatus(body, {
        status: disabledReason,
        actions: "",
      });
      queueMicrotask(() => activation.cancel());
      return;
    }
    if (this.getActiveSpatiallyIndexedSkeletonLayer() === undefined) {
      const msg = "No spatially indexed skeleton source is currently loaded.";
      StatusMessage.showTemporaryMessage(msg);
      renderSpatialSkeletonToolStatus(body, { status: msg, actions: "" });
      queueMicrotask(() => activation.cancel());
      return;
    }

    // 4. Register disposer: clear statusBody, reset mode attribute, and
    //    deactivate layer-level mode flags.
    activation.registerDisposer(() => {
      this.statusBody = undefined;
      this.setModeAttribute(undefined);
      layer.spatialSkeletonMergeMode.value = false;
      layer.spatialSkeletonSplitMode.value = false;
      layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
      layer.spatialSkeletonState.clearPendingNodePositions();
    });

    // 5. Activate edit mode watchable.
    this.activateModeWatchable(activation, layer.spatialSkeletonEditMode);

    // 6. Bind event maps.
    activation.bindInputEventMap(getDefaultSkeletonEditToolBindings());
    rawInputEventMapBinder(getDefaultSkeletonEditAuxBindings(), activation);
    rawInputEventMapBinder(getDefaultSkeletonEditNodeBindings(), activation);
    this.bindPinnedSelectionAction(activation, {
      showNodeSelectionMessage: false,
    });
    this.bindClearSelectionAction(activation);

    // 7. Register state-change watcher disposers.
    activation.registerDisposer(
      layer.selectedSpatialSkeletonNodeInfo.changed.add(() =>
        this.renderStatus(),
      ),
    );
    activation.registerDisposer(
      layer.manager.root.selectionState.changed.add(() => this.renderStatus()),
    );
    activation.registerDisposer(
      layer.spatialSkeletonState.mergeAnchorNodeId.changed.add(() =>
        this.renderStatus(),
      ),
    );
    activation.registerDisposer(
      layer.displayState.segmentationGroupState.value.visibleSegments.changed.add(
        () => this.renderStatus(),
      ),
    );

    // 8. Layer validity watcher.
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

    // 9. Global key/mouse listeners — thin lambda wrappers delegating to class methods.
    const onKeyDown = (event: KeyboardEvent) => {
      this.syncModifiers(event);
      if (!this.heldPhysicalKeyCodes.has(event.code)) {
        this.heldPhysicalKeyCodes.add(event.code);
        this.renderStatus();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      this.heldPhysicalKeyCodes.delete(event.code);
      if (event.code === MERGE_EXIT_KEY_CODE) {
        this.mergeKeyHeld = false;
        this.exitMerge();
      }
      if (event.code === CREATE_EXIT_KEY_CODE) this.exitCreate();
      if (event.code === SPLIT_EXIT_KEY_CODE) {
        this.splitKeyHeld = false;
        this.exitSplit();
      }
      if (event.code === DELETE_EXIT_KEY_CODE) {
        this.deleteKeyHeld = false;
        this.exitDelete();
      }
      this.syncModifiers(event);
    };
    // mousemove catches modifiers pressed/released while keyboard focus is
    // outside the panel (e.g. a text input elsewhere in the UI).
    const onMouseMove = (event: MouseEvent) => this.syncModifiers(event);
    const onBlur = () => {
      this.mergeKeyHeld = false;
      this.splitKeyHeld = false;
      this.deleteKeyHeld = false;
      this.shiftHeld = false;
      this.ctrlHeld = false;
      this.heldPhysicalKeyCodes = new Set();
      this.exitMerge();
      this.exitCreate();
      this.exitSplit();
      this.exitDelete();
      this.updateModeAttribute();
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

    // 10. Per-panel capture listeners — closures per panel; body delegates to class methods.
    // Left click (mousedown0) is handled here rather than in the EventActionMap so that
    // we can consume off-node clicks without accidentally shadowing EventActionMap actions
    // at lower priority.  All plain/shift left clicks are owned by the edit tool — they
    // either select a node, add a node, or do nothing.  Navigation (rotate/pan) belongs to
    // middle mouse and to the navigation-modifier + left-click aliases below (for trackpad
    // users without a reliable middle-click), handled via the EventActionMap + the
    // slice-panel path below.
    for (const panel of layer.manager.root.display.panels) {
      if (!(panel instanceof RenderedDataPanel)) continue;
      const captureMousedown = (event: MouseEvent) => {
        // Middle mouse (plain): rotate in 3D (EventActionMap mousedown1 → rotate-via-mouse-drag),
        // translate in 2D (intercepted here via startRelativeMouseDrag).
        // Ctrl+middle: translate in 3D (EventActionMap control+mousedown1 → translate-via-mouse-drag),
        // translate in 2D (intercepted here, same as plain middle).
        if (event.button === 1) {
          if (panel instanceof PerspectivePanel) {
            panel.element.dataset.skeletonPressMode = "rotate";
            const onMouseUp = () => {
              delete panel.element.dataset.skeletonPressMode;
              window.removeEventListener("mouseup", onMouseUp);
            };
            window.addEventListener("mouseup", onMouseUp);
          } else {
            event.stopPropagation();
            event.preventDefault();
            panel.element.dataset.skeletonPressMode = "pan";
            startRelativeMouseDrag(
              event,
              (_dragEvent, deltaX, deltaY) => {
                panel.context.flagContinuousCameraMotion();
                panel.translateByViewportPixels(deltaX, deltaY);
              },
              () => {
                delete panel.element.dataset.skeletonPressMode;
              },
            );
          }
          return;
        }

        // Trackpad-friendly aliases for the middle-mouse scheme above.
        // Navigation modifier + left (plain): rotate in 3D (EventActionMap
        // control+mousedown0 → rotate-via-mouse-drag), pan in 2D
        // (intercepted here) — mirrors plain middle mouse.
        // Navigation modifier + shift + left: translate in 3D
        // (EventActionMap control+shift+mousedown0 → translate-via-mouse-drag),
        // pan in 2D (intercepted here, same as above) — mirrors ctrl+middle
        // mouse. Checked before the shift guard below so it takes priority
        // over the shift+mousedown0 add-node chord; hasNavigationModifier is
        // the discriminator (add-node never has the modifier held).
        if (event.button === 0 && hasNavigationModifier(event)) {
          if (panel instanceof PerspectivePanel) {
            panel.element.dataset.skeletonPressMode = "rotate";
            const onMouseUp = () => {
              delete panel.element.dataset.skeletonPressMode;
              window.removeEventListener("mouseup", onMouseUp);
            };
            window.addEventListener("mouseup", onMouseUp);
          } else {
            event.stopPropagation();
            event.preventDefault();
            panel.element.dataset.skeletonPressMode = "pan";
            startRelativeMouseDrag(
              event,
              (_dragEvent, deltaX, deltaY) => {
                panel.context.flagContinuousCameraMotion();
                panel.translateByViewportPixels(deltaX, deltaY);
              },
              () => {
                delete panel.element.dataset.skeletonPressMode;
              },
            );
          }
          return;
        }

        // shift+mousedown0 → EventActionMap (add-node); other buttons → normal dispatch.
        // Both must pass through the capture listener unmodified.
        if (event.button !== 0 || event.shiftKey) return;
        if (this.currentMode === SkeletonEditMode.Merge) {
          event.stopPropagation();
          event.preventDefault();
          this.handleMergeSecondPick();
          return;
        }
        if (this.currentMode === SkeletonEditMode.Split) {
          event.stopPropagation();
          event.preventDefault();
          this.handleSplitPick();
          return;
        }
        if (this.currentMode === SkeletonEditMode.Create) {
          event.stopPropagation();
          event.preventDefault();
          this.handleCreatePlace();
          return;
        }
        if (this.currentMode === SkeletonEditMode.Delete) {
          event.stopPropagation();
          event.preventDefault();
          this.handleDeletePick();
          return;
        }
        // Default mode: only consume if hovering a node.
        this.handleDefaultMousedown(event, panel);
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

    // 11. Bind actions — thin one-liners delegating to class methods.
    activation.bindAction(SKELETON_ENTER_MERGE_MODE, () =>
      this.onEnterMergeModeAction(),
    );
    activation.bindAction(SKELETON_ENTER_CREATE, () =>
      this.onEnterCreateAction(),
    );
    activation.bindAction(SKELETON_ENTER_SPLIT_MODE, () =>
      this.onEnterSplitModeAction(),
    );
    activation.bindAction(SKELETON_ADD_NODE, (event) =>
      this.onAddNodeAction(event as ActionEvent<MouseEvent>),
    );
    activation.bindAction(SKELETON_ENTER_DELETE_MODE, () =>
      this.onEnterDeleteModeAction(),
    );
    activation.bindAction(SKELETON_TOGGLE_TRUE_END, () => {
      const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
      const nodeId = this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
      if (nodeId === undefined) return;
      const node =
        skeletonLayer?.getNode(nodeId) ??
        this.layer.spatialSkeletonState.getCachedNode(nodeId);
      if (node === undefined) {
        StatusMessage.showTemporaryMessage(
          `Node ${nodeId} is not available in the skeleton cache.`,
        );
        return;
      }
      const nextIsTrueEnd = !(node.isTrueEnd ?? false);
      if (nextIsTrueEnd) {
        if (node.parentNodeId === undefined) {
          StatusMessage.showTemporaryMessage(
            "Cannot set the root node as a true end.",
          );
          return;
        }
        const cachedSegmentNodes =
          this.layer.spatialSkeletonState.getCachedSegmentNodes(node.segmentId);
        if (cachedSegmentNodes !== undefined) {
          const hasChildren = cachedSegmentNodes.some(
            (candidate) => candidate.parentNodeId === node.nodeId,
          );
          if (hasChildren) {
            StatusMessage.showTemporaryMessage(
              "Only leaf nodes can be marked as true ends.",
            );
            return;
          }
        }
      }
      void executeSpatialSkeletonNodeTrueEndUpdate(this.layer, {
        node,
        nextIsTrueEnd,
      }).catch((error) =>
        showSpatialSkeletonActionError("toggle true end", error),
      );
    });
    activation.bindAction(SKELETON_REROOT, () => {
      const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
      const nodeId = this.layer.selectedSpatialSkeletonNodeInfo.value?.nodeId;
      if (nodeId === undefined) return;
      const node =
        skeletonLayer?.getNode(nodeId) ??
        this.layer.spatialSkeletonState.getCachedNode(nodeId);
      if (node === undefined) {
        StatusMessage.showTemporaryMessage(
          `Node ${nodeId} is not available in the skeleton cache.`,
        );
        return;
      }
      if (node.isTrueEnd) {
        StatusMessage.showTemporaryMessage(
          "Cannot set a true end node as root. Clear the true end state first.",
        );
        return;
      }
      void this.layer
        .rerootSpatialSkeletonNode(node)
        .catch((error) => showSpatialSkeletonActionError("reroot", error));
    });

    // 12. Initial render.
    this.renderStatus();
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
