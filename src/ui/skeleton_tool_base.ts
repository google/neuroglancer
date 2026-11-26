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
 * @file Defines the tool IDs, the base class and the tool listing that the
 * skeleton tools share.
 */

import type { DisplayContext, RenderedPanel } from "#src/display_context.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { getSegmentIdFromLayerSelectionValue } from "#src/layer/segmentation/skeleton_node_selection.js";
import type { SkeletonSourceConnection } from "#src/layer/segmentation/skeleton_source_connection.js";
import type { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { getVisibleSegments } from "#src/segmentation_display_state/base.js";
import type { SkeletonVector } from "#src/skeleton/api.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import type { SliceViewPanel } from "#src/sliceview/panel.js";
import { StatusMessage } from "#src/status.js";
import {
  SKELETON_DRAG_VIEW,
  SKELETON_PIN_NODE,
} from "#src/ui/skeleton_edit_tool_shortcuts.js";
import type { ToolActivation } from "#src/ui/tool.js";
import { LayerTool } from "#src/ui/tool.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import { dispatchEventAction } from "#src/util/event_action_map.js";

export const SPATIAL_SKELETON_EDIT_MODE_TOOL_ID = "skeletonEditMode";
export const SPATIAL_SKELETON_FIND_PATH_TOOL_ID = "skeletonFindPath";

function isRenderedDataPanel(panel: RenderedPanel): panel is RenderedDataPanel {
  return (
    ("translateDataPointByViewportPixels" satisfies keyof RenderedDataPanel) in
    panel
  );
}

function isSliceViewPanel(panel: RenderedDataPanel): panel is SliceViewPanel {
  return ("sliceView" satisfies keyof SliceViewPanel) in panel;
}

export function getActionPanel(
  display: DisplayContext,
  event: ActionEvent<MouseEvent>,
): RenderedDataPanel | undefined {
  for (const panel of display.panels) {
    if (panel.element === event.target && isRenderedDataPanel(panel)) {
      return panel;
    }
  }
  return undefined;
}

export function bindSpatialSkeletonViewDrag<
  T extends LayerTool<SegmentationUserLayer>,
>(activation: ToolActivation<T>) {
  activation.bindAction(
    SKELETON_DRAG_VIEW,
    (event: ActionEvent<MouseEvent>) => {
      const panel = getActionPanel(
        activation.tool.layer.manager.root.display,
        event,
      );
      if (panel === undefined) return;
      dispatchEventAction(event.detail, event.detail, {
        action: isSliceViewPanel(panel)
          ? "translate-via-mouse-drag"
          : "rotate-via-mouse-drag",
      });
    },
  );
}
export abstract class SpatialSkeletonToolBase extends LayerTool<SegmentationUserLayer> {
  constructor(layer: SegmentationUserLayer) {
    super(layer, true);
  }

  protected getActiveSpatiallyIndexedSkeletonLayer() {
    return this.layer.spatiallyIndexedSkeletonLayer.value;
  }

  protected getPickedSpatialSkeletonNode():
    | {
        nodeId: bigint;
        segmentId?: bigint;
        position?: Float32Array;
      }
    | undefined {
    if (!this.mouseState.updateUnconditionally() || !this.mouseState.active) {
      return undefined;
    }
    const { pickedSpatialSkeleton } = this.mouseState;
    const nodeId = pickedSpatialSkeleton?.nodeId;
    if (nodeId === undefined || nodeId === 0n) {
      return undefined;
    }
    const position = pickedSpatialSkeleton?.position;
    return {
      nodeId,
      segmentId: pickedSpatialSkeleton?.segmentId,
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
    const segmentId = this.mouseState.pickedSpatialSkeleton?.segmentId;
    return segmentId === 0n ? undefined : segmentId;
  }

  protected isSpatialSkeletonSegmentVisible(segmentId: bigint) {
    return getVisibleSegments(
      this.layer.displayState.segmentationGroupState.value,
    ).has(segmentId);
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
        nodeId: bigint;
        segmentId?: bigint;
        position?: SkeletonVector;
      }
    | undefined {
    const nodeHit = this.getPickedSpatialSkeletonNode();
    if (nodeHit === undefined) {
      return undefined;
    }
    const resolvedNodeInfo =
      skeletonLayer.getNode(nodeHit.nodeId) ??
      this.layer.spatialSkeletonEditSession.getCachedNode(nodeHit.nodeId);
    return {
      nodeId: nodeHit.nodeId,
      segmentId: resolvedNodeInfo?.segmentId ?? nodeHit.segmentId,
      position: resolvedNodeInfo?.position ?? nodeHit.position,
    };
  }

  protected getSelectedSkeletonNodeSummary() {
    const nodeId = this.layer.skeletonNodeSelection.selected.value?.nodeId;
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
          this.layer.skeletonNodeSelection.clear(false);
          this.layer.selectSegment(pickedSegmentId, true);
          return;
        }
        if (pickedNode.segmentId !== undefined) {
          this.layer.selectSegment(pickedNode.segmentId, true);
        }
        this.layer.skeletonNodeSelection.select(
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
    modeWatchable.value = true;
    activation.registerDisposer(() => {
      modeWatchable.value = false;
    });
  }

  protected registerAutoCancelOnDisabled(
    activation: ToolActivation<this>,
    requiredActions: Parameters<
      SkeletonSourceConnection["getActionsDisabledReason"]
    >[0],
    onReady?: () => void,
  ) {
    const handleStateChanged = () => {
      const disabledReason =
        this.layer.skeletonSourceConnection.getActionsDisabledReason(
          requiredActions,
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

  protected cancelActivationIfPreconditionsFail(
    activation: ToolActivation<this>,
    requiredAction: Parameters<
      SkeletonSourceConnection["getActionsDisabledReason"]
    >[0],
  ): boolean {
    const reason =
      this.layer.skeletonSourceConnection.getActionsDisabledReason(
        requiredAction,
      );
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
export function makeSpatialSkeletonToolLister(toolId: string) {
  return (layer: SegmentationUserLayer, onChange?: () => void) => {
    if (onChange !== undefined) {
      layer.layersChanged.addOnce(onChange);
    }
    if (
      layer.spatiallyIndexedSkeletonLayer.value === undefined ||
      (toolId === SPATIAL_SKELETON_FIND_PATH_TOOL_ID &&
        layer.skeletonSourceConnection.getFindPathContext() === undefined) ||
      (toolId === SPATIAL_SKELETON_EDIT_MODE_TOOL_ID &&
        layer.editableSkeletonSource.value === undefined)
    ) {
      return [];
    }
    return [{ type: toolId }];
  };
}
