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

import type { Annotation } from "#src/annotation/index.js";
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
  SKELETON_ENTER_INSERT_MODE,
  SKELETON_ENTER_MERGE_MODE,
  SKELETON_ENTER_SPLIT_MODE,
  SKELETON_FIND_PATH_SELECT_ENDPOINT,
  SKELETON_PIN_NODE,
  SKELETON_REROOT,
  SKELETON_TOGGLE_TRUE_END,
} from "#src/skeleton/actions.js";
import type {
  SpatiallyIndexedSkeletonNode,
  SpatialSkeletonVector,
} from "#src/skeleton/api.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/command_protocol.js";
import {
  executeSpatialSkeletonAddNode,
  executeSpatialSkeletonDeleteNode,
  executeSpatialSkeletonInsertNode,
  executeSpatialSkeletonMerge,
  executeSpatialSkeletonMoveNode,
  executeSpatialSkeletonNodeTrueEndUpdate,
  executeSpatialSkeletonSplit,
  showSpatialSkeletonActionError,
} from "#src/skeleton/commands.js";
import type { SkeletonFindPathEndpoint } from "#src/skeleton/find_path.js";
import {
  SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
  SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION,
} from "#src/skeleton/find_path_annotations.js";
import {
  PerspectiveViewSpatiallyIndexedSkeletonLayer,
  type SpatiallyIndexedSkeletonLayer,
  setSpatialSkeletonModesToLinesAndPoints,
  SliceViewPanelSpatiallyIndexedSkeletonLayer,
} from "#src/skeleton/frontend.js";
import {
  buildSpatiallyIndexedSkeletonNavigationGraph,
  getPathBetweenNodes,
  type SpatiallyIndexedSkeletonNavigationGraph,
} from "#src/skeleton/navigation_graph.js";
import {
  classifySpatialSkeletonDisplayNodeType,
  SpatialSkeletonDisplayNodeType,
} from "#src/skeleton/node_types.js";
import type { SpatialSkeletonOptimisticEditExecution } from "#src/skeleton/optimistic_edit/types.js";
import { StatusMessage } from "#src/status.js";
import { makeAnnotationListElement } from "#src/ui/annotations.js";
import {
  getDefaultAnnotationListBindings,
  getDefaultSkeletonEditAuxBindings,
  getDefaultSkeletonEditNodeBindings,
  getDefaultSkeletonEditToolBindings,
  getDefaultSkeletonFindPathToolBindings,
} from "#src/ui/default_input_event_bindings.js";
import {
  getSpatialSkeletonCreateIdleStatusText,
  getSpatialSkeletonCreatingStatusText,
  getSpatialSkeletonDefaultStatusText,
  getSpatialSkeletonDeleteIdleStatusText,
  getSpatialSkeletonDeletingStatusText,
  getSpatialSkeletonInsertingStatusText,
  getSpatialSkeletonInsertStatusText,
  getSpatialSkeletonMergeStatusText,
  getSpatialSkeletonMovingStatusText,
  getSpatialSkeletonSplitIdleStatusText,
} from "#src/ui/skeleton_edit_tool_messages.js";
import type { SpatialSkeletonToolStatusText } from "#src/ui/skeleton_edit_tool_shortcuts.js";
import {
  getSpatialSkeletonModeKeyCode,
  renderSpatialSkeletonShortcut,
  SPATIAL_SKELETON_EDIT_TOOL_NAME,
} from "#src/ui/skeleton_edit_tool_shortcuts.js";
import { SpatialSkeletonMergeTargetPrefetch } from "#src/ui/skeleton_merge_target_prefetch.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolActivationStatusMessageWithHeader,
  registerTool,
} from "#src/ui/tool.js";
import { removeChildren } from "#src/util/dom.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import { vec3 } from "#src/util/geom.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import { makeIcon } from "#src/widget/icon.js";

export const SPATIAL_SKELETON_EDIT_MODE_TOOL_ID = "spatialSkeletonEditMode";
export const SPATIAL_SKELETON_FIND_PATH_TOOL_ID = "spatialSkeletonFindPath";

// Internal mode enum for sustained editing states.
// Move and Select are both handled in Default.
const enum SkeletonEditMode {
  Default = 0,
  Merge = 1,
  Create = 2,
  Split = 3,
  Delete = 4,
  Insert = 5,
}

// In edit mode, plain left click is selection-only — it never rotates or
// pans. Navigation (rotate in perspective, pan in slice) is handled by
// middle mouse (mousedown1), plus trackpad-friendly aliases on
// control+left mouse. Control alone mirrors plain middle-click.
// Control+shift mirrors control+middle-click. mousedown0 is therefore
// handled only via the capture-phase DOM listeners in activate(). It is not
// in the EventActionMap.
//
// mousedown1 / control?+mousedown0 → rotate-via-mouse-drag covers perspective
// panels via the EventActionMap. Slice panels intercept middle mouse and the
// control chords in the capture listener and call
// translateByViewportPixels directly, consuming the event before
// MouseEventBinder can dispatch this action.
//
// Default bindings are defined in getDefaultSkeletonEditToolBindings() /
// getDefaultSkeletonEditAuxBindings() in default_input_event_bindings.ts.

const DRAG_START_DISTANCE_PX = 2;

const MERGE_EXIT_KEY_CODE = getSpatialSkeletonModeKeyCode(
  SKELETON_ENTER_MERGE_MODE,
);
const SPLIT_EXIT_KEY_CODE = getSpatialSkeletonModeKeyCode(
  SKELETON_ENTER_SPLIT_MODE,
);
const CREATE_EXIT_KEY_CODE = getSpatialSkeletonModeKeyCode(
  SKELETON_ENTER_CREATE,
);
const DELETE_EXIT_KEY_CODE = getSpatialSkeletonModeKeyCode(
  SKELETON_ENTER_DELETE_MODE,
);
const INSERT_EXIT_KEY_CODE = getSpatialSkeletonModeKeyCode(
  SKELETON_ENTER_INSERT_MODE,
);

/**
 * Preserves the skeleton tools' middle-mouse and control+left-click controls
 * when a tool claims regular left click as its primary interaction.
 */
function bindSpatialSkeletonToolMouseControls<
  T extends LayerTool<SegmentationUserLayer>,
>(
  activation: ToolActivation<T>,
  layer: SegmentationUserLayer,
  onPrimaryMousedown?: (event: MouseEvent, panel: RenderedDataPanel) => void,
) {
  for (const panel of layer.manager.root.display.panels) {
    if (!(panel instanceof RenderedDataPanel)) continue;
    const captureMousedown = (event: MouseEvent) => {
      // Perspective navigation is dispatched through the active tool's input
      // map. Slice navigation is performed directly here.
      const isNavigationGesture =
        event.button === 1 || (event.button === 0 && event.ctrlKey);
      if (isNavigationGesture) {
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

      if (event.button === 0) {
        onPrimaryMousedown?.(event, panel);
      }
    };
    panel.element.addEventListener("mousedown", captureMousedown, {
      capture: true,
    });
    activation.registerDisposer(() => {
      delete panel.element.dataset.skeletonPressMode;
      panel.element.removeEventListener("mousedown", captureMousedown, {
        capture: true,
      });
    });
  }
}

function makeSpatialSkeletonToolStatus(
  body: HTMLElement,
): (text: SpatialSkeletonToolStatusText) => void {
  body.classList.add("neuroglancer-skeleton-tool-status");
  const statusElement = document.createElement("span");
  statusElement.classList.add("neuroglancer-skeleton-tool-status-text");
  const actionsElement = document.createElement("span");
  actionsElement.classList.add("neuroglancer-skeleton-tool-status-actions");
  body.append(statusElement, actionsElement);
  return (text) => {
    statusElement.textContent = text.status;
    actionsElement.replaceChildren(
      ...text.actions.map(renderSpatialSkeletonShortcut),
    );
  };
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

  protected pinSegmentByNumber(value: number) {
    if (!Number.isFinite(value)) return;
    this.layer.selectSegment(BigInt(Math.round(value)), true);
  }

  protected isSpatialSkeletonSegmentVisible(segmentId: number | bigint) {
    return getVisibleSegments(
      this.layer.displayState.segmentationGroupState.value,
    ).has(
      typeof segmentId === "bigint" ? segmentId : BigInt(Math.round(segmentId)),
    );
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
      segmentId: resolvedNodeInfo?.segmentId ?? nodeHit.segmentId,
      position: resolvedNodeInfo?.position ?? nodeHit.position,
      parentNodeId: resolvedNodeInfo?.parentNodeId,
    };
  }

  protected resolvePickedNodeSelectionForMerge(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
  ):
    | {
        nodeId: number;
        segmentId?: number;
        position?: SpatialSkeletonVector;
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
      segmentId: resolvedNodeInfo?.segmentId ?? nodeHit.segmentId,
      position: resolvedNodeInfo?.position ?? nodeHit.position,
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
      const disabledReason =
        this.layer.getSpatialSkeletonActionsDisabledReason(requiredActions);
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

  protected cancelActivationIfPreconditionsFail(
    activation: ToolActivation<this>,
    requiredAction: Parameters<
      SegmentationUserLayer["getSpatialSkeletonActionsDisabledReason"]
    >[0],
  ): boolean {
    const reason =
      this.layer.getSpatialSkeletonActionsDisabledReason(requiredAction);
    if (reason !== undefined) {
      StatusMessage.showTemporaryMessage(reason);
      queueMicrotask(() => activation.cancel());
      return false;
    }
    if (this.getActiveSpatiallyIndexedSkeletonLayer() === undefined) {
      StatusMessage.showTemporaryMessage(
        "No spatially indexed skeleton source is currently loaded.",
      );
      queueMicrotask(() => activation.cancel());
      return false;
    }
    return true;
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
  private readonly mergeTargetPrefetch = new SpatialSkeletonMergeTargetPrefetch(
    this.layer.spatialSkeletonState,
  );
  private mergeTargetHoverRelease: (() => boolean) | undefined = undefined;

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

  private resolveInspectedNode(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    nodeId: number,
    segmentId: number | undefined,
  ) {
    const resolvedSegmentId =
      // Spatial browse cells may still describe a node's pre-edit owner.
      // Complete inspected data owns topology; the pick is only a fallback
      // for nodes whose skeleton has not been inspected yet.
      skeletonLayer.getNode(nodeId)?.segmentId ??
      this.layer.spatialSkeletonState.getCachedNode(nodeId)?.segmentId ??
      segmentId;
    if (resolvedSegmentId === undefined) {
      return {
        segmentId: undefined,
        inspected: false,
        node: undefined,
      };
    }
    const snapshot =
      this.layer.spatialSkeletonState.getCachedSegmentSnapshotHandle(
        resolvedSegmentId,
      );
    return {
      segmentId: resolvedSegmentId,
      inspected: snapshot !== undefined,
      node: snapshot?.handle.getNode(nodeId),
    };
  }

  private requireInspectedNode(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    nodeId: number,
    segmentId: number | undefined,
  ): SpatiallyIndexedSkeletonNode | undefined {
    const resolved = this.resolveInspectedNode(
      skeletonLayer,
      nodeId,
      segmentId,
    );
    if (!resolved.inspected) {
      if (resolved.segmentId === undefined) {
        StatusMessage.showTemporaryMessage(
          `Unable to resolve the skeleton for node ${nodeId}.`,
        );
      } else {
        StatusMessage.showTemporaryMessage(
          `Inspect skeleton ${resolved.segmentId} before editing it.`,
        );
      }
      return undefined;
    }
    if (resolved.node === undefined) {
      StatusMessage.showTemporaryMessage(
        `Node ${nodeId} is not available in inspected skeleton ${resolved.segmentId}.`,
      );
      return undefined;
    }
    return resolved.node;
  }

  private getSelectedParentNodeForAdd(
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    parentNodeId: number | undefined,
  ) {
    if (parentNodeId === undefined) return undefined;
    const selectedNode = this.layer.selectedSpatialSkeletonNodeInfo.value;
    return this.requireInspectedNode(
      skeletonLayer,
      parentNodeId,
      selectedNode?.nodeId === parentNodeId
        ? selectedNode.segmentId
        : undefined,
    );
  }

  private bindClearSelectionAction(activation: ToolActivation<this>) {
    activation.bindAction(
      SKELETON_CLEAR_SELECTION,
      (event: ActionEvent<MouseEvent>) => {
        event.stopPropagation();
        event.detail.preventDefault();
        if (this.insertAnchorNodeId !== undefined) {
          this.resetInsertToFreshState();
        }
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

  // Activation-scoped state — reset at the start of each activate() call.
  private currentMode: SkeletonEditMode = SkeletonEditMode.Default;
  private dragInProgress = false;
  private activeDragBrowseExclusionRelease: (() => boolean) | undefined;
  private pending = false;
  /** Invalidates delayed callbacks from prior modes or tool activations. */
  private interactionGeneration = 0;
  private createPlacedThisHold = false;
  // One-shot guards: prevent repeated fires while a key is held down.
  private mergeKeyHeld = false;
  private splitKeyHeld = false;
  private deleteKeyHeld = false;
  private insertKeyHeld = false;
  // First node picked in insert mode; the next pick must be its parent or one
  // of its children.
  private insertAnchorNodeId: number | undefined = undefined;
  // Modifier-held state drives cursor indicators and blocks node actions.
  private shiftHeld = false;
  // While held, the shift-driven "add node" cursor/status must be
  // suppressed, since control+shift means pan, not add-node.
  private ctrlHeld = false;
  // Physical key codes currently held down — used only to decide whether the
  // status actions text should show a "release <key> to exit" hint. Merge/
  // split/create can also be entered via a synthetic dispatched action (no
  // physical keydown), in which case that hint would be misleading.
  private heldPhysicalKeyCodes = new Set<string>();
  private statusOverride: SpatialSkeletonToolStatusText | undefined = undefined;
  private setStatusText:
    | ((text: SpatialSkeletonToolStatusText) => void)
    | undefined = undefined;

  private advanceInteractionGeneration() {
    this.interactionGeneration = (this.interactionGeneration ?? 0) + 1;
  }

  /** Starts one mode-owned action and releases its interaction on admission. */
  private startPendingAction(
    actionLabel: SpatialSkeletonAction,
    start: () => SpatialSkeletonOptimisticEditExecution<void>,
    release: () => void,
  ) {
    const generation = this.interactionGeneration ?? 0;
    this.interactionGeneration = generation;
    this.pending = true;
    let execution: SpatialSkeletonOptimisticEditExecution<void>;
    try {
      execution = start();
    } catch (error) {
      if (this.interactionGeneration === generation) {
        this.pending = false;
        release();
      }
      showSpatialSkeletonActionError(actionLabel, error);
      return undefined;
    }
    void execution.catch((error) => {
      showSpatialSkeletonActionError(actionLabel, error);
    });
    const releaseIfCurrent = () => {
      if (this.interactionGeneration !== generation) return;
      this.pending = false;
      release();
    };
    // Admission rejection also releases the interaction. The action promise
    // above reports the actual failure to the user.
    void execution.acceptedByQueue.then(releaseIfCurrent, releaseIfCurrent);
    return execution;
  }

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
    } else if (this.currentMode === SkeletonEditMode.Insert) {
      this.setModeAttribute("insert");
    } else if (this.shiftHeld && !this.ctrlHeld) {
      this.setModeAttribute("add");
    } else {
      this.setModeAttribute(undefined);
    }
  }

  // --- Status rendering ---

  private renderStatus() {
    const { setStatusText } = this;
    if (setStatusText === undefined) return;
    if (this.statusOverride !== undefined) {
      setStatusText(this.statusOverride);
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
        setStatusText(
          getSpatialSkeletonMergeStatusText(
            isHidden ? "from-node-hidden" : "from-node-visible",
            canExitWithKey,
          ),
        );
      } else {
        setStatusText(
          getSpatialSkeletonMergeStatusText("no-from-node", canExitWithKey),
        );
      }
      return;
    }
    if (this.currentMode === SkeletonEditMode.Split) {
      setStatusText(
        getSpatialSkeletonSplitIdleStatusText(
          this.heldPhysicalKeyCodes.has(SPLIT_EXIT_KEY_CODE),
        ),
      );
      return;
    }
    if (this.currentMode === SkeletonEditMode.Create) {
      setStatusText(
        getSpatialSkeletonCreateIdleStatusText(
          this.heldPhysicalKeyCodes.has(CREATE_EXIT_KEY_CODE),
        ),
      );
      return;
    }
    if (this.currentMode === SkeletonEditMode.Delete) {
      setStatusText(
        getSpatialSkeletonDeleteIdleStatusText(
          this.heldPhysicalKeyCodes.has(DELETE_EXIT_KEY_CODE),
        ),
      );
      return;
    }
    if (this.currentMode === SkeletonEditMode.Insert) {
      setStatusText(
        getSpatialSkeletonInsertStatusText(
          this.insertAnchorNodeId === undefined
            ? "no-first-node"
            : "first-node-picked",
          this.heldPhysicalKeyCodes.has(INSERT_EXIT_KEY_CODE),
        ),
      );
      return;
    }
    // Default mode
    const selectedPoint = this.getSelectedSpatialSkeletonNodeSummary();
    const isHidden =
      selectedPoint?.segmentId !== undefined &&
      !this.isSpatialSkeletonSegmentVisible(selectedPoint.segmentId);
    setStatusText(
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
  private syncModifiers(event: { shiftKey: boolean; ctrlKey: boolean }) {
    const isShift = event.shiftKey;
    const isCtrl = event.ctrlKey;
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

  private handleMergeAnchorChanged() {
    if (
      this.currentMode !== SkeletonEditMode.Merge ||
      this.layer.spatialSkeletonState.mergeAnchorNodeId.value === undefined
    ) {
      this.stopMergeTargetPrefetch();
      return;
    }
    this.mergeTargetHoverRelease ??= this.mouseState.changed.add(() =>
      this.prefetchHoveredMergeTarget(),
    );
    this.prefetchHoveredMergeTarget();
  }

  private stopMergeTargetPrefetch() {
    this.mergeTargetHoverRelease?.();
    this.mergeTargetHoverRelease = undefined;
    this.mergeTargetPrefetch.clear();
  }

  /** Hovering empty space or the anchor's own skeleton keeps the last target. */
  private prefetchHoveredMergeTarget() {
    if (this.pending) return;
    // Forcing a pick update here would re-dispatch the mouse-state signal.
    const { mouseState } = this;
    if (!mouseState.active) return;
    const { spatialSkeletonState } = this.layer;
    const anchorNodeId = spatialSkeletonState.mergeAnchorNodeId.value;
    const hoveredSegmentId = mouseState.pickedSpatialSkeleton?.segmentId;
    if (
      anchorNodeId === undefined ||
      typeof hoveredSegmentId !== "number" ||
      !Number.isSafeInteger(hoveredSegmentId) ||
      hoveredSegmentId <= 0 ||
      hoveredSegmentId ===
        spatialSkeletonState.getCachedNode(anchorNodeId)?.segmentId
    ) {
      return;
    }
    const skeletonLayer = this.layer.getSpatiallyIndexedSkeletonLayer();
    if (skeletonLayer === undefined) return;
    this.mergeTargetPrefetch.setTarget(skeletonLayer, hoveredSegmentId);
  }

  private enterMerge() {
    this.advanceInteractionGeneration();
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
    this.advanceInteractionGeneration();
    this.pending = false;
    this.stopMergeTargetPrefetch();
    this.layer.clearSpatialSkeletonMergeAnchor();
    this.layer.spatialSkeletonMergeMode.value = false;
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
    this.currentMode = SkeletonEditMode.Default;
    this.updateModeAttribute();
    this.clearStatus();
  }

  // Insert mirrors merge but keeps its first pick tool-local: nothing outside
  // the tool needs to observe it.
  private resetInsertToFreshState() {
    this.insertAnchorNodeId = undefined;
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = true;
    this.statusOverride = undefined;
    this.renderStatus();
  }

  private enterInsert() {
    this.advanceInteractionGeneration();
    this.resetInsertToFreshState();
    this.currentMode = SkeletonEditMode.Insert;
    this.updateModeAttribute();
    this.renderStatus();
  }

  private exitInsert() {
    if (this.currentMode !== SkeletonEditMode.Insert) return;
    this.advanceInteractionGeneration();
    this.pending = false;
    this.insertAnchorNodeId = undefined;
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
    this.currentMode = SkeletonEditMode.Default;
    this.updateModeAttribute();
    this.clearStatus();
  }

  private enterCreate() {
    this.advanceInteractionGeneration();
    this.currentMode = SkeletonEditMode.Create;
    this.createPlacedThisHold = false;
    this.updateModeAttribute();
    this.renderStatus();
  }

  private exitCreate() {
    if (this.currentMode !== SkeletonEditMode.Create) return;
    this.advanceInteractionGeneration();
    this.pending = false;
    this.currentMode = SkeletonEditMode.Default;
    this.createPlacedThisHold = false;
    this.updateModeAttribute();
    this.clearStatus();
  }

  private enterSplit() {
    this.advanceInteractionGeneration();
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
    this.advanceInteractionGeneration();
    this.pending = false;
    this.currentMode = SkeletonEditMode.Default;
    this.layer.spatialSkeletonSplitMode.value = false;
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
    this.updateModeAttribute();
    this.clearStatus();
  }

  private enterDelete() {
    this.advanceInteractionGeneration();
    this.currentMode = SkeletonEditMode.Delete;
    this.updateModeAttribute();
    this.renderStatus();
  }

  private exitDelete() {
    if (this.currentMode !== SkeletonEditMode.Delete) return;
    this.advanceInteractionGeneration();
    this.pending = false;
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
      ? this.resolveInspectedNode(
          skeletonLayer,
          pickedNode.nodeId,
          pickedNode.segmentId,
        ).node
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

    if (!canMove || !hasPickedPosition) {
      return; // Can't drag: done after the select above.
    }
    if (nodeInfo === undefined) {
      this.reportUninspectedNodeOnDrag(
        event,
        skeletonLayer,
        pickedNode.nodeId,
        pickedNode.segmentId,
      );
      return;
    }

    // Arm drag: if threshold exceeded, move the node.
    // Document-level drag callbacks may outlive this tool activation.
    const generation = this.interactionGeneration;
    let totalDeltaX = 0;
    let totalDeltaY = 0;
    let dragStarted = false;
    let finished = false;
    let moved = false;
    // Acknowledging an earlier edit can replace the node or its skeleton ID
    // between mousedown and mouseup, including before the first drag event.
    const state = this.layer.spatialSkeletonState;
    const identities = state.getOptimisticEditingIdentityService();
    const nodeHandle = identities.getOrCreateNodeHandle(nodeInfo.nodeId);
    const resolveDragNode = () => {
      const nodeId = identities.resolveNode(nodeHandle);
      return nodeId === undefined ? undefined : state.getCachedNode(nodeId);
    };

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
        if (finished || this.interactionGeneration !== generation) return;
        totalDeltaX += deltaX;
        totalDeltaY += deltaY;
        const currentNode = resolveDragNode();
        if (currentNode === undefined) return;
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
          this.layer.spatialSkeletonState.clearPendingNodePositions();
          this.activeDragBrowseExclusionRelease?.();
          this.activeDragBrowseExclusionRelease =
            skeletonLayer.beginTemporaryBrowseExclusion(currentNode.segmentId);
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
            currentNode.nodeId,
            modelPosition,
          );
        if (!previewChanged) return;
        moved = true;
        this.dragModelSpacePosition.set(modelPosition);
      },
      (_finishEvent) => {
        if (finished || this.interactionGeneration !== generation) return;
        finished = true;
        if (this.dragInProgress) {
          this.dragInProgress = false;
          delete panel.element.dataset.skeletonPressMode;
          this.clearStatus();
        }
        if (!dragStarted) return; // Pure click: selection already happened on mousedown.
        const releaseBrowseExclusion = this.activeDragBrowseExclusionRelease;
        this.activeDragBrowseExclusionRelease = undefined;
        if (moved) {
          // The queue is mandatory for every editable source. Remove only the
          // gesture-owned drag overlay before admission; the engine publishes
          // the exact preview and owns it from that point onward.
          this.layer.spatialSkeletonState.clearPendingNodePositions();
          let execution: SpatialSkeletonOptimisticEditExecution<void>;
          try {
            const currentNode = resolveDragNode();
            if (currentNode === undefined) {
              throw new Error("The dragged node is no longer available.");
            }
            execution = executeSpatialSkeletonMoveNode(this.layer, {
              node: currentNode,
              nextPositionInModelSpace: new Float32Array(
                this.dragModelSpacePosition,
              ),
            });
          } catch (error) {
            releaseBrowseExclusion?.();
            showSpatialSkeletonActionError(
              SpatialSkeletonActions.moveNodes,
              error,
            );
            return;
          }
          // The exact-preview promise resolves only after the projection has
          // adopted the move and permanently retained/excluded the segment.
          // Rejection means no exact preview owns the display, so release the
          // temporary exclusion along the same path.
          void execution.then(
            () => releaseBrowseExclusion?.(),
            (error) => {
              releaseBrowseExclusion?.();
              this.layer.spatialSkeletonState.clearPendingNodePositions();
              showSpatialSkeletonActionError(
                SpatialSkeletonActions.moveNodes,
                error,
              );
            },
          );
          return;
        }
        this.layer.spatialSkeletonState.clearPendingNodePositions();
        releaseBrowseExclusion?.();
      },
    );
  }

  private reportUninspectedNodeOnDrag(
    event: MouseEvent,
    skeletonLayer: SpatiallyIndexedSkeletonLayer,
    nodeId: number,
    segmentId: number | undefined,
  ) {
    const generation = this.interactionGeneration;
    let dragDistanceSquared = 0;
    let reported = false;
    startRelativeMouseDrag(event, (_dragEvent, deltaX, deltaY) => {
      if (reported || this.interactionGeneration !== generation) return;
      dragDistanceSquared += deltaX * deltaX + deltaY * deltaY;
      if (
        dragDistanceSquared <
        DRAG_START_DISTANCE_PX * DRAG_START_DISTANCE_PX
      ) {
        return;
      }
      reported = true;
      this.requireInspectedNode(skeletonLayer, nodeId, segmentId);
    });
  }

  private executeSplitOnNode(pickedNode: {
    nodeId: number;
    segmentId: number;
    position?: SpatialSkeletonVector;
    parentNodeId?: number;
  }) {
    this.pinSegmentByNumber(pickedNode.segmentId);
    this.layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);
    // A node was clicked: reveal the selected-node highlight for it.
    this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
    this.startPendingAction(
      SpatialSkeletonActions.splitSkeletons,
      () =>
        executeSpatialSkeletonSplit(this.layer, {
          nodeId: pickedNode.nodeId,
          segmentId: pickedNode.segmentId,
          position: pickedNode.position,
          parentNodeId: pickedNode.parentNodeId,
        }),
      () => {
        // Reset to a fresh split so it prompts for the next node (the user may
        // still be holding s) rather than waiting for hydration/confirmation.
        this.resetSplitToFreshState();
      },
    );
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
    const pickedNode = this.getPickedSpatialSkeletonNode();
    if (pickedNode === undefined) {
      StatusMessage.showTemporaryMessage("Click a skeleton node to split.");
      return;
    }
    const nodeInfo = this.requireInspectedNode(
      skeletonLayer,
      pickedNode.nodeId,
      pickedNode.segmentId,
    );
    if (nodeInfo === undefined) return;
    this.executeSplitOnNode({
      nodeId: nodeInfo.nodeId,
      segmentId: nodeInfo.segmentId,
      position: nodeInfo.position,
      parentNodeId: nodeInfo.parentNodeId,
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
    const pickedNode = this.getPickedSpatialSkeletonNode();
    if (pickedNode === undefined) {
      StatusMessage.showTemporaryMessage(
        "Click a skeleton node to set as merge anchor.",
      );
      return;
    }
    const nodeInfo = this.requireInspectedNode(
      skeletonLayer,
      pickedNode.nodeId,
      pickedNode.segmentId,
    );
    if (nodeInfo === undefined) return;
    if (!this.isSpatialSkeletonSegmentVisible(nodeInfo.segmentId)) {
      StatusMessage.showTemporaryMessage(
        `Make skeleton ${nodeInfo.segmentId} visible before merging.`,
      );
      return;
    }
    this.pinSegmentByNumber(nodeInfo.segmentId);
    this.layer.selectSpatialSkeletonNode(nodeInfo.nodeId, true, nodeInfo);
    this.layer.setSpatialSkeletonMergeAnchor(nodeInfo.nodeId);
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
    const selectedNode = this.layer.selectedSpatialSkeletonNodeInfo.value;
    const anchorNodeInfo = this.requireInspectedNode(
      skeletonLayer,
      anchorNodeId,
      selectedNode?.nodeId === anchorNodeId
        ? selectedNode.segmentId
        : undefined,
    );
    if (anchorNodeInfo === undefined) return;
    const firstNode = {
      nodeId: anchorNodeId,
      segmentId: anchorNodeInfo.segmentId,
      position: anchorNodeInfo.position,
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
      const reanchoredNode = this.requireInspectedNode(
        skeletonLayer,
        pickedNode.nodeId,
        pickedNode.segmentId,
      );
      if (reanchoredNode === undefined) return;
      this.pinSegmentByNumber(reanchoredNode.segmentId);
      this.layer.selectSpatialSkeletonNode(
        reanchoredNode.nodeId,
        true,
        reanchoredNode,
      );
      this.layer.setSpatialSkeletonMergeAnchor(reanchoredNode.nodeId);
      this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
      this.renderStatus();
      StatusMessage.showTemporaryMessage(
        "Moved the merge start here — now select a node on a different skeleton.",
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
    this.startPendingAction(
      SpatialSkeletonActions.mergeSkeletons,
      () =>
        executeSpatialSkeletonMerge(
          this.layer,
          {
            nodeId: firstNode.nodeId,
            segmentId: firstNode.segmentId,
            position: firstNode.position,
          },
          {
            nodeId: pickedNode.nodeId,
            segmentId: pickedNode.segmentId,
            position: pickedNode.position,
          },
        ),
      () => {
        // If the user released M while the merge was in flight, exitMerge has
        // already left merge mode and restored the highlight — do not re-hide
        // it here (that would leave the selection permanently hidden). Only
        // reset when still in merge mode: clear the anchor and re-hide the
        // highlight (the selection is kept) so the next click starts a fresh
        // merge. Applies on both success and error.
        if (this.currentMode === SkeletonEditMode.Merge) {
          this.resetMergeToFreshState();
        }
      },
    );
  }

  private handleInsertPick() {
    // Caller (capture listener) already called stopPropagation/preventDefault.
    if (this.pending) return;

    const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
      SpatialSkeletonActions.insertNodes,
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
    const nodeHit = this.getPickedSpatialSkeletonNode();
    if (nodeHit === undefined) {
      StatusMessage.showTemporaryMessage(
        "Click a skeleton node to insert between.",
      );
      return;
    }
    // Nodes of non-visible skeletons are only known from the pick buffer, so
    // check visibility before requiring the fully loaded node.
    if (
      nodeHit.segmentId !== undefined &&
      !this.isSpatialSkeletonSegmentVisible(nodeHit.segmentId)
    ) {
      StatusMessage.showTemporaryMessage(
        `Nodes selected for an insert operation must be from a visible skeleton. Make skeleton ${nodeHit.segmentId} visible in the Seg tab or by double-clicking it in the viewer.`,
        3000,
      );
      return;
    }
    const pickedNode = skeletonLayer.getNode(nodeHit.nodeId);
    if (pickedNode === undefined) {
      StatusMessage.showTemporaryMessage(
        `Node ${nodeHit.nodeId} is not available in the skeleton cache.`,
      );
      return;
    }

    const firstNodeId = this.insertAnchorNodeId;
    if (firstNodeId === undefined) {
      this.insertAnchorNodeId = pickedNode.nodeId;
      this.layer.selectSpatialSkeletonNode(pickedNode.nodeId, true, pickedNode);
      this.layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
      this.renderStatus();
      return;
    }
    if (pickedNode.nodeId === firstNodeId) return;
    const firstNode =
      skeletonLayer.getNode(firstNodeId) ??
      this.layer.spatialSkeletonState.getCachedNode(firstNodeId);
    if (firstNode === undefined) {
      StatusMessage.showTemporaryMessage(
        `Node ${firstNodeId} is no longer available. Pick the first node again.`,
      );
      this.resetInsertToFreshState();
      return;
    }

    // A node has exactly one parent, so a node can only be inserted on an
    // existing edge: one of the two picks must be the parent of the other.
    const parentNode =
      pickedNode.parentNodeId === firstNode.nodeId
        ? firstNode
        : firstNode.parentNodeId === pickedNode.nodeId
          ? pickedNode
          : undefined;
    if (parentNode === undefined) {
      StatusMessage.showTemporaryMessage(
        `Node ${pickedNode.nodeId} is not connected to node ${firstNode.nodeId}. Click the parent or a child of node ${firstNode.nodeId}.`,
      );
      return;
    }
    const childNode = parentNode === firstNode ? pickedNode : firstNode;
    const midpoint = new Float32Array(3);
    for (let i = 0; i < 3; ++i) {
      midpoint[i] =
        (Number(parentNode.position[i]) + Number(childNode.position[i])) / 2;
    }

    this.setStatus(getSpatialSkeletonInsertingStatusText());
    this.startPendingAction(
      SpatialSkeletonActions.insertNodes,
      () =>
        executeSpatialSkeletonInsertNode(this.layer, {
          skeletonId: parentNode.segmentId,
          parentNodeId: parentNode.nodeId,
          childNodeIds: [childNode.nodeId],
          positionInModelSpace: midpoint,
        }),
      () => {
        if (this.currentMode === SkeletonEditMode.Insert)
          this.resetInsertToFreshState();
      },
    );
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
    this.setStatus(getSpatialSkeletonCreatingStatusText());
    this.startPendingAction(
      SpatialSkeletonActions.addNodes,
      () =>
        executeSpatialSkeletonAddNode(this.layer, {
          skeletonId: 0,
          parentNodeId: undefined,
          positionInModelSpace: new Float32Array(clickPosition),
        }),
      () => this.renderStatus(),
    );
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

  // Insert (i): enters insert mode — click two connected nodes to insert between them.
  private onEnterInsertModeAction() {
    if (
      this.insertKeyHeld ||
      this.dragInProgress ||
      this.pending ||
      this.currentMode !== SkeletonEditMode.Default
    )
      return;
    this.insertKeyHeld = true;
    const disabledReason = this.layer.getSpatialSkeletonActionsDisabledReason(
      SpatialSkeletonActions.insertNodes,
    );
    if (disabledReason !== undefined) {
      StatusMessage.showTemporaryMessage(disabledReason);
      return;
    }
    this.enterInsert();
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
        const selectedParentNode = this.getSelectedParentNodeForAdd(
          skeletonLayer,
          currentParentNodeId,
        );
        if (selectedParentNode === undefined) return;
        const clickPositionInModelSpace =
          this.getMousePositionInSkeletonCoordinates(skeletonLayer);
        if (clickPositionInModelSpace === undefined) return;
        void (async () => {
          try {
            await executeSpatialSkeletonAddNode(this.layer, {
              skeletonId: selectedParentNode.segmentId,
              parentNodeId: currentParentNodeId,
              positionInModelSpace: new Float32Array(clickPositionInModelSpace),
            });
          } catch (error) {
            showSpatialSkeletonActionError(
              SpatialSkeletonActions.addNodes,
              error,
            );
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
    const nodeInfo = this.requireInspectedNode(
      skeletonLayer,
      pickedNode.nodeId,
      pickedNode.segmentId,
    );
    if (nodeInfo === undefined) return;
    this.setStatus(getSpatialSkeletonDeletingStatusText());
    this.startPendingAction(
      SpatialSkeletonActions.deleteNodes,
      () => executeSpatialSkeletonDeleteNode(this.layer, nodeInfo),
      () => this.renderStatus(),
    );
  }

  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    // 1. Reset all activation-scoped state.
    this.advanceInteractionGeneration();
    this.currentMode = SkeletonEditMode.Default;
    this.dragInProgress = false;
    this.activeDragBrowseExclusionRelease?.();
    this.activeDragBrowseExclusionRelease = undefined;
    this.pending = false;
    this.createPlacedThisHold = false;
    this.mergeKeyHeld = false;
    this.splitKeyHeld = false;
    this.deleteKeyHeld = false;
    this.insertKeyHeld = false;
    this.insertAnchorNodeId = undefined;
    this.shiftHeld = false;
    this.ctrlHeld = false;
    this.heldPhysicalKeyCodes = new Set();
    this.statusOverride = undefined;
    layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;

    // 2. Create status UI.
    const { body, header } = makeToolActivationStatusMessageWithHeader(
      activation,
      { showBindings: false },
    );
    header.textContent = SPATIAL_SKELETON_EDIT_TOOL_NAME;
    const setStatusText = makeSpatialSkeletonToolStatus(body);
    this.setStatusText = setStatusText;

    // 3. Precondition checks.
    const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
      [SpatialSkeletonActions.addNodes, SpatialSkeletonActions.moveNodes],
      { requireVisibleChunks: false },
    );
    if (disabledReason !== undefined) {
      StatusMessage.showTemporaryMessage(disabledReason);
      setStatusText({
        status: disabledReason,
        actions: [],
      });
      queueMicrotask(() => activation.cancel());
      return;
    }
    if (this.getActiveSpatiallyIndexedSkeletonLayer() === undefined) {
      const msg = "No spatially indexed skeleton source is currently loaded.";
      StatusMessage.showTemporaryMessage(msg);
      setStatusText({
        status: msg,
        actions: [],
      });
      queueMicrotask(() => activation.cancel());
      return;
    }

    // 4. Register disposer: clear setStatusText, reset mode attribute, and
    //    deactivate layer-level mode flags.
    activation.registerDisposer(() => {
      this.advanceInteractionGeneration();
      this.setStatusText = undefined;
      this.currentMode = SkeletonEditMode.Default;
      this.pending = false;
      this.stopMergeTargetPrefetch();
      this.dragInProgress = false;
      this.activeDragBrowseExclusionRelease?.();
      this.activeDragBrowseExclusionRelease = undefined;
      this.setModeAttribute(undefined);
      layer.spatialSkeletonMergeMode.value = false;
      layer.spatialSkeletonSplitMode.value = false;
      layer.spatialSkeletonSuppressSelectedNodeHighlight.value = false;
      layer.spatialSkeletonState.clearPendingNodePositions();
      this.insertAnchorNodeId = undefined;
    });

    // 5. Activate edit mode watchable.
    this.activateModeWatchable(activation, layer.spatialSkeletonEditMode);

    // 6. Bind event maps.
    activation.bindInputEventMap(getDefaultSkeletonEditToolBindings());
    activation.bindInputEventMap(getDefaultSkeletonEditAuxBindings());
    activation.bindInputEventMap(getDefaultSkeletonEditNodeBindings());
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
      layer.spatialSkeletonState.mergeAnchorNodeId.changed.add(() => {
        this.handleMergeAnchorChanged();
        this.renderStatus();
      }),
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
          { requireVisibleChunks: false },
        );
        if (reason !== undefined) {
          StatusMessage.showTemporaryMessage(reason);
          activation.cancel();
        }
      }),
    );
    const optimisticQueueVersion =
      layer.spatialSkeletonState.optimisticEditQueueVersion;
    if (optimisticQueueVersion !== undefined) {
      activation.registerDisposer(
        optimisticQueueVersion.changed.add(() => {
          if (
            layer.spatialSkeletonState.getOptimisticEditFatalState() !==
            undefined
          ) {
            activation.cancel();
          }
        }),
      );
    }

    // 9. Global key/mouse listeners — thin lambda wrappers delegating to class methods.
    const onKeyDown = (event: KeyboardEvent) => {
      this.syncModifiers(event);
      const keyCode = event.code.toLowerCase();
      if (!this.heldPhysicalKeyCodes.has(keyCode)) {
        this.heldPhysicalKeyCodes.add(keyCode);
        this.renderStatus();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const keyCode = event.code.toLowerCase();
      this.heldPhysicalKeyCodes.delete(keyCode);
      if (keyCode === MERGE_EXIT_KEY_CODE) {
        this.mergeKeyHeld = false;
        this.exitMerge();
      }
      if (keyCode === CREATE_EXIT_KEY_CODE) this.exitCreate();
      if (keyCode === SPLIT_EXIT_KEY_CODE) {
        this.splitKeyHeld = false;
        this.exitSplit();
      }
      if (keyCode === DELETE_EXIT_KEY_CODE) {
        this.deleteKeyHeld = false;
        this.exitDelete();
      }
      if (keyCode === INSERT_EXIT_KEY_CODE) {
        this.insertKeyHeld = false;
        this.exitInsert();
      }
      this.syncModifiers(event);
    };
    // mousemove catches modifiers pressed/released while keyboard focus is
    // outside the panel (e.g. a text input elsewhere in the UI).
    const onMouseMove = (event: MouseEvent) => {
      this.syncModifiers(event);
    };
    const onBlur = () => {
      this.mergeKeyHeld = false;
      this.splitKeyHeld = false;
      this.deleteKeyHeld = false;
      this.insertKeyHeld = false;
      this.shiftHeld = false;
      this.ctrlHeld = false;
      this.heldPhysicalKeyCodes = new Set();
      this.exitMerge();
      this.exitCreate();
      this.exitSplit();
      this.exitDelete();
      this.exitInsert();
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

    // 10. Share the navigation controls used by skeleton tools, while keeping
    // the Edit tool's existing primary-click mode handling local.
    bindSpatialSkeletonToolMouseControls(activation, layer, (event, panel) => {
      // shift+mousedown0 is dispatched as the add-node action.
      if (event.shiftKey) return;
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
      if (this.currentMode === SkeletonEditMode.Insert) {
        event.stopPropagation();
        event.preventDefault();
        this.handleInsertPick();
        return;
      }
      // Default mode: only consume if hovering a node.
      this.handleDefaultMousedown(event, panel);
    });

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
    activation.bindAction(SKELETON_ENTER_INSERT_MODE, () =>
      this.onEnterInsertModeAction(),
    );
    activation.bindAction(SKELETON_TOGGLE_TRUE_END, () => {
      const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
      if (skeletonLayer === undefined) return;
      const selectedNode = this.layer.selectedSpatialSkeletonNodeInfo.value;
      if (selectedNode === undefined) return;
      const node = this.requireInspectedNode(
        skeletonLayer,
        selectedNode.nodeId,
        selectedNode.segmentId,
      );
      if (node === undefined) {
        return;
      }
      const nextIsTrueEnd = !(node.isTrueEnd ?? false);
      void executeSpatialSkeletonNodeTrueEndUpdate(this.layer, {
        node,
        nextIsTrueEnd,
      }).catch((error) =>
        showSpatialSkeletonActionError(
          SpatialSkeletonActions.editNodeTrueEnd,
          error,
        ),
      );
    });
    activation.bindAction(SKELETON_REROOT, () => {
      const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
      if (skeletonLayer === undefined) return;
      const selectedNode = this.layer.selectedSpatialSkeletonNodeInfo.value;
      if (selectedNode === undefined) return;
      const node = this.requireInspectedNode(
        skeletonLayer,
        selectedNode.nodeId,
        selectedNode.segmentId,
      );
      if (node === undefined) return;
      void this.layer
        .rerootSpatialSkeletonNode(node)
        .catch((error) =>
          showSpatialSkeletonActionError(SpatialSkeletonActions.reroot, error),
        );
    });

    // 12. Initial render.
    this.renderStatus();
  }
}

// Backward-compat alias — external code referencing SpatialSkeletonEditModeTool still works.
export { SpatialSkeletonEditTool as SpatialSkeletonEditModeTool };

function getSpatialSkeletonFindPathNodeTypeLabel(
  graph: SpatiallyIndexedSkeletonNavigationGraph,
  nodeId: number,
) {
  const node = graph.nodeById.get(nodeId);
  if (node === undefined) return undefined;
  if (node.isTrueEnd ?? false) return "True end";
  const parentInTree =
    node.parentNodeId !== undefined && graph.nodeById.has(node.parentNodeId);
  const type = classifySpatialSkeletonDisplayNodeType(
    node,
    graph.childrenByParent.get(nodeId)?.length ?? 0,
    parentInTree,
  );
  switch (type) {
    case SpatialSkeletonDisplayNodeType.ROOT:
      return "Root";
    case SpatialSkeletonDisplayNodeType.BRANCH_START:
      return "Branch point";
    case SpatialSkeletonDisplayNodeType.VIRTUAL_END:
      return "Leaf";
    default:
      return "Node";
  }
}

export function getSpatialSkeletonFindPathEndpointDescription(
  endpointName: "Source" | "Target",
  endpoint: SkeletonFindPathEndpoint,
  graph: SpatiallyIndexedSkeletonNavigationGraph | undefined,
) {
  const nodeId = Number(endpoint.nodeId);
  const nodeType = Number.isSafeInteger(nodeId)
    ? graph === undefined
      ? undefined
      : getSpatialSkeletonFindPathNodeTypeLabel(graph, nodeId)
    : undefined;
  return nodeType === undefined
    ? endpointName
    : `${endpointName} · ${nodeType}`;
}

export class SpatialSkeletonFindPathTool extends SpatialSkeletonToolBase {
  toJSON() {
    return SPATIAL_SKELETON_FIND_PATH_TOOL_ID;
  }

  get description() {
    return "Find path";
  }

  activate(activation: ToolActivation<this>) {
    if (
      !this.cancelActivationIfPreconditionsFail(
        activation,
        SpatialSkeletonActions.inspect,
      )
    ) {
      return;
    }

    const { layer } = this;
    const activeContext = layer.getSpatialSkeletonFindPathContext();
    setSpatialSkeletonModesToLinesAndPoints(layer);

    const { body, header } = makeToolActivationStatusMessageWithHeader(
      activation,
      { showBindings: false },
    );
    header.textContent = "Find Path";
    body.classList.add("neuroglancer-skeleton-find-path-status");

    const statusElement = document.createElement("span");
    statusElement.className = "neuroglancer-skeleton-find-path-message";
    let statusOverride: string | undefined;

    const getStateContext = () => {
      if (activeContext === undefined) return undefined;
      return layer.getSpatialSkeletonFindPathContext() === activeContext
        ? activeContext
        : undefined;
    };

    const getState = () => getStateContext()?.state;
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear Find Path",
        onClick: () => {
          statusOverride = undefined;
          getState()?.clear();
        },
      }),
    );
    body.appendChild(statusElement);

    const annotationElements = document.createElement("div");
    annotationElements.className =
      "neuroglancer-skeleton-find-path-annotations";
    body.appendChild(annotationElements);
    annotationElements.addEventListener("mouseleave", () => {
      layer.annotationDisplayState.hoverState.value = undefined;
    });
    activation.registerDisposer(
      new MouseEventBinder(
        annotationElements,
        getDefaultAnnotationListBindings(),
      ),
    );

    const updateAnnotationElements = () => {
      removeChildren(annotationElements);
      const state = getState();
      const annotationState =
        getStateContext()?.annotationController.annotationState;
      if (state === undefined || annotationState === undefined) return;
      const annotationsByDescription = new Map<string, Annotation>();
      for (const annotation of annotationState.source) {
        if (
          annotation.description ===
            SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION ||
          annotation.description ===
            SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION
        ) {
          annotationsByDescription.set(annotation.description, annotation);
        }
      }
      const maxColumnWidths = [0, 0, 0];
      const template =
        "[symbol] 2ch [dim] var(--neuroglancer-column-0-width) [dim] var(--neuroglancer-column-1-width) [dim] var(--neuroglancer-column-2-width) [delete] min-content";
      for (const description of [
        SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
        SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION,
      ]) {
        const annotation = annotationsByDescription.get(description);
        if (annotation === undefined) continue;
        const sourceEndpoint =
          description === SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION;
        const endpoint = sourceEndpoint ? state.source : state.target;
        const [element, elementColumnWidths] = makeAnnotationListElement(
          layer,
          annotation,
          annotationState,
          template,
          [0, 1, 2],
          [],
        );
        if (endpoint !== undefined) {
          const segmentId = Number(endpoint.segmentId);
          const cachedSegmentNodes = Number.isSafeInteger(segmentId)
            ? layer.spatialSkeletonState.getCachedSegmentNodes(segmentId)
            : undefined;
          const graph =
            cachedSegmentNodes === undefined
              ? undefined
              : buildSpatiallyIndexedSkeletonNavigationGraph(
                  cachedSegmentNodes,
                );
          const endpointDescription =
            getSpatialSkeletonFindPathEndpointDescription(
              sourceEndpoint ? "Source" : "Target",
              endpoint,
              graph,
            );
          const descriptionElement = element.querySelector(
            ".neuroglancer-annotation-description",
          );
          if (descriptionElement !== null) {
            descriptionElement.textContent = endpointDescription;
          }
          element.title = `${endpointDescription} · node ${endpoint.nodeId}`;
        }
        for (const [column, width] of elementColumnWidths.entries()) {
          maxColumnWidths[column] = Math.max(maxColumnWidths[column], width);
        }
        annotationElements.appendChild(element);
      }
      for (const [column, width] of maxColumnWidths.entries()) {
        annotationElements.style.setProperty(
          `--neuroglancer-column-${column}-width`,
          `${width + 2}ch`,
        );
      }
    };

    function updateStatus() {
      const state = getState();
      if (statusOverride !== undefined) {
        statusElement.textContent = statusOverride;
      } else if (state === undefined) {
        statusElement.textContent =
          "No spatial skeleton datasource supports Find Path.";
      } else if (state.result !== undefined) {
        statusElement.textContent = `Path found (${state.result.length} nodes).`;
      } else if (state.source === undefined) {
        statusElement.textContent = "Left-click the source node.";
      } else if (state.target === undefined) {
        statusElement.textContent = "Left-click the target node.";
      } else {
        statusElement.textContent = "Finding path…";
      }
      updateAnnotationElements();
    }

    const showPathStatus = (message: string, announce: boolean) => {
      statusOverride = message;
      updateStatus();
      if (announce) {
        StatusMessage.showTemporaryMessage(message);
      }
    };

    const computePath = (announce: boolean) => {
      const context = getStateContext();
      const state = context?.state;
      if (context === undefined || state === undefined) {
        showPathStatus(
          "The spatial skeleton source selected for Find Path is no longer loaded.",
          announce,
        );
        return false;
      }
      const { source, target } = state;
      if (source === undefined || target === undefined) {
        updateStatus();
        return false;
      }
      if (state.result !== undefined) {
        updateStatus();
        return true;
      }
      if (source.segmentId !== target.segmentId) {
        showPathStatus(
          "Find Path endpoints must belong to the same skeleton segment.",
          announce,
        );
        return false;
      }
      if (source.nodeId === target.nodeId) {
        showPathStatus(
          "Find Path endpoints must be distinct skeleton nodes.",
          announce,
        );
        return false;
      }

      const segmentId = Number(source.segmentId);
      const sourceNodeId = Number(source.nodeId);
      const targetNodeId = Number(target.nodeId);
      if (
        !Number.isSafeInteger(segmentId) ||
        !Number.isSafeInteger(sourceNodeId) ||
        !Number.isSafeInteger(targetNodeId)
      ) {
        showPathStatus(
          "The selected endpoint IDs are not supported by this spatial skeleton source.",
          announce,
        );
        return false;
      }
      const cachedSegmentNodes =
        layer.spatialSkeletonState.getCachedSegmentNodes(segmentId);
      if (cachedSegmentNodes === undefined) {
        showPathStatus(
          `Full data for skeleton ${source.segmentId} is not cached. Make it visible and wait for loading.`,
          announce,
        );
        return false;
      }

      statusOverride = undefined;
      try {
        const graph =
          buildSpatiallyIndexedSkeletonNavigationGraph(cachedSegmentNodes);
        if (!graph.nodeById.has(sourceNodeId)) {
          throw new Error(
            `Source node ${source.nodeId} is missing from the loaded skeleton.`,
          );
        }
        if (!graph.nodeById.has(targetNodeId)) {
          throw new Error(
            `Target node ${target.nodeId} is missing from the loaded skeleton.`,
          );
        }
        const path = getPathBetweenNodes(graph, sourceNodeId, targetNodeId);
        if (path === undefined) {
          throw new Error(
            `No route exists between nodes ${source.nodeId} and ${target.nodeId}.`,
          );
        }
        state.setResult(
          path.map(({ nodeId, position }) => ({
            nodeId: BigInt(nodeId),
            position: new Float32Array(position),
          })),
        );
        if (announce) {
          StatusMessage.showTemporaryMessage("Path found!", 5000);
        }
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        showPathStatus(`Failed to find path: ${detail}`, announce);
        return false;
      }
    };

    const state = getState();
    if (state !== undefined) {
      activation.registerDisposer(
        state.changed.add(() => {
          statusOverride = undefined;
          updateStatus();
        }),
      );
    }
    activation.registerDisposer(
      layer.spatialSkeletonState.nodeDataVersion.changed.add(() => {
        statusOverride = undefined;
        const state = getState();
        if (
          state?.source !== undefined &&
          state.target !== undefined &&
          state.result === undefined
        ) {
          computePath(false);
        } else {
          updateStatus();
        }
      }),
    );
    this.registerAutoCancelOnDisabled(
      activation,
      SpatialSkeletonActions.inspect,
      updateStatus,
    );

    bindSpatialSkeletonToolMouseControls(activation, layer);
    activation.bindInputEventMap(getDefaultSkeletonFindPathToolBindings());
    activation.bindAction(
      SKELETON_FIND_PATH_SELECT_ENDPOINT,
      (event: ActionEvent<MouseEvent>) => {
        event.stopPropagation();
        event.detail.preventDefault();
        const currentState = getState();
        if (
          currentState?.source !== undefined &&
          currentState.target !== undefined
        ) {
          StatusMessage.showTemporaryMessage(
            "Clear Find Path or delete an endpoint before selecting another node.",
          );
          return;
        }
        const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
        const context = getStateContext();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }
        if (context === undefined) {
          StatusMessage.showTemporaryMessage(
            "The spatial skeleton source selected for Find Path is no longer loaded.",
          );
          return;
        }
        if (context.skeletonLayer !== skeletonLayer) {
          StatusMessage.showTemporaryMessage(
            "Find Path is only available for the first active spatial skeleton datasource in this layer.",
          );
          return;
        }
        const pickedNode = this.resolvePickedNodeSelection(skeletonLayer);
        if (
          pickedNode?.segmentId === undefined ||
          pickedNode.position === undefined
        ) {
          StatusMessage.showTemporaryMessage(
            "Find Path endpoints must be exact skeleton nodes, not edges.",
          );
          return;
        }
        const endpoint: SkeletonFindPathEndpoint = {
          nodeId: BigInt(pickedNode.nodeId),
          segmentId: BigInt(pickedNode.segmentId),
          position: new Float32Array(pickedNode.position),
        };
        const state = context.state;
        const otherEndpoint =
          state.source === undefined ? state.target : state.source;
        if (otherEndpoint !== undefined) {
          if (otherEndpoint.segmentId !== endpoint.segmentId) {
            StatusMessage.showTemporaryMessage(
              "Find Path endpoints must belong to the same skeleton segment.",
            );
            return;
          }
          if (otherEndpoint.nodeId === endpoint.nodeId) {
            StatusMessage.showTemporaryMessage(
              "Find Path endpoints must be distinct skeleton nodes.",
            );
            return;
          }
        }
        statusOverride = undefined;
        if (state.source === undefined) {
          state.setSource(endpoint);
        } else {
          state.setTarget(endpoint);
        }
        if (state.source !== undefined && state.target !== undefined) {
          computePath(true);
        }
      },
    );

    if (
      state?.source !== undefined &&
      state.target !== undefined &&
      state.result === undefined
    ) {
      computePath(false);
    } else {
      updateStatus();
    }
  }
}

function makeSpatialSkeletonToolLister(toolId: string) {
  return (layer: SegmentationUserLayer, onChange?: () => void) => {
    if (onChange !== undefined) {
      layer.layersChanged.addOnce(onChange);
    }
    if (
      layer.getSpatiallyIndexedSkeletonLayer() === undefined ||
      (toolId === SPATIAL_SKELETON_FIND_PATH_TOOL_ID &&
        layer.getSpatialSkeletonFindPathContext() === undefined)
    ) {
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
  registerTool(
    contextType,
    SPATIAL_SKELETON_FIND_PATH_TOOL_ID,
    (layer) => new SpatialSkeletonFindPathTool(layer),
    makeSpatialSkeletonToolLister(SPATIAL_SKELETON_FIND_PATH_TOOL_ID),
  );
}
