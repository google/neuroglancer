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

import "#src/ui/skeleton_tab.css";
import svg_arrow_left from "ikonate/icons/arrow-left.svg?raw";
import svg_arrow_right from "ikonate/icons/arrow-right.svg?raw";
import svg_bin from "ikonate/icons/bin.svg?raw";
import svg_chevron_right from "ikonate/icons/chevron-right.svg?raw";
import svg_chevrons_left from "ikonate/icons/chevrons-left.svg?raw";
import svg_chevrons_right from "ikonate/icons/chevrons-right.svg?raw";
import svg_origin from "ikonate/icons/origin.svg?raw";
import svg_redo from "ikonate/icons/redo.svg?raw";
import svg_retweet from "ikonate/icons/retweet.svg?raw";
import svg_undo from "ikonate/icons/undo.svg?raw";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { getSegmentIdFromLayerSelectionValue } from "#src/layer/segmentation/selection.js";
import {
  getSegmentEquivalences,
  getVisibleSegments,
} from "#src/segmentation_display_state/base.js";
import { getBaseObjectColor } from "#src/segmentation_display_state/frontend.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import {
  executeSpatialSkeletonDeleteNode,
  executeSpatialSkeletonNodeTrueEndUpdate,
  redoSpatialSkeletonCommand,
  showSpatialSkeletonActionError,
  undoSpatialSkeletonCommand,
} from "#src/skeleton/edit/submit_edits.js";
import type { SpatialSkeletonAction } from "#src/skeleton/edit_commands.js";
import {
  SpatialSkeletonActions,
  SpatialSkeletonHistoryActions,
} from "#src/skeleton/edit_commands.js";
import { SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON } from "#src/skeleton/edit_queue/types.js";
import { isSkeletonNodeTrueEnd } from "#src/skeleton/node_attributes.js";
import {
  getSkeletonNodeFilterLabel,
  getSkeletonNodeTypeLabel,
  type SkeletonNodeFilterType,
} from "#src/skeleton/node_types.js";
import { SkeletonNavigation } from "#src/skeleton/skeleton_navigator.js";
import { StatusMessage } from "#src/status.js";
import {
  observeWatchable,
  registerNested,
  registerNestedSync,
  makeCachedDerivedWatchableValue,
} from "#src/trackable_value.js";
import { registerSpatialSkeletonEditQueueTab } from "#src/ui/skeleton_edit_queue_tab.js";
import { getSkeletonNodeTypeIcon } from "#src/ui/skeleton_node_icons.js";
import {
  buildSkeletonSegmentRenderState,
  buildSkeletonVirtualListItems,
  getSkeletonEmptyListText,
  getSkeletonNodeIdPresentation,
  getSpatialSkeletonDetailsPreparationState,
  PREPARATION_PENDING_LIST_MESSAGE,
  type SegmentDisplayState,
  type SkeletonListItem,
  type SkeletonSegmentRenderRow,
  type SpatialSkeletonDetailsPreparationState,
} from "#src/ui/skeleton_tab_render.js";
import {
  SPATIAL_SKELETON_EDIT_MODE_TOOL_ID,
  SPATIAL_SKELETON_FIND_PATH_TOOL_ID,
} from "#src/ui/skeleton_tool_base.js";
import { makeToolButton } from "#src/ui/tool.js";
import type { ArraySpliceOp } from "#src/util/array.js";
import * as matrix from "#src/util/matrix.js";
import { formatScaleWithUnitAsString } from "#src/util/si_units.js";
import { Signal } from "#src/util/signal.js";
import { EnumSelectWidget } from "#src/widget/enum_widget.js";
import { makeIcon } from "#src/widget/icon.js";
import { Tab } from "#src/widget/tab_view.js";
import type { VirtualListSource } from "#src/widget/virtual_list.js";
import { VirtualList } from "#src/widget/virtual_list.js";

export class SkeletonTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-skeleton-tab");

    const toolbarActions = document.createElement("div");
    toolbarActions.className = "neuroglancer-skeleton-toolbar-actions";

    const makeIconButton = (
      parent: HTMLElement,
      svg: string,
      title: string,
      onClick: () => void,
    ) => {
      const button = document.createElement("button");
      button.className = "neuroglancer-skeleton-icon-button";
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.appendChild(makeIcon({ svg, title, clickable: false }));
      button.addEventListener("click", () => onClick());
      parent.appendChild(button);
      return button;
    };
    const undoButton = makeIconButton(toolbarActions, svg_undo, "Undo", () => {
      if (undoButton.disabled) return;
      void (async () => {
        try {
          await undoSpatialSkeletonCommand(layer.skeletonSourceConnection);
        } catch (error) {
          showSpatialSkeletonActionError(
            SpatialSkeletonHistoryActions.undo,
            error,
          );
        }
      })();
    });
    const redoButton = makeIconButton(toolbarActions, svg_redo, "Redo", () => {
      if (redoButton.disabled) return;
      void (async () => {
        try {
          await redoSpatialSkeletonCommand(layer.skeletonSourceConnection);
        } catch (error) {
          showSpatialSkeletonActionError(
            SpatialSkeletonHistoryActions.redo,
            error,
          );
        }
      })();
    });
    const navTools = document.createElement("div");
    navTools.className = "neuroglancer-skeleton-nav-tools";

    const nodesSection = document.createElement("div");
    nodesSection.className = "neuroglancer-skeleton-section";
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.placeholder = "Enter node ID or description";
    filterInput.className = "neuroglancer-skeleton-filter";
    const nodeQuery = layer.displayState.skeletonBrowse.nodeQuery;
    const nodeFilterTypeModel = layer.displayState.skeletonBrowse.nodeFilter;
    filterInput.value = nodeQuery.value;
    const nodeFilterTypeWidget = this.registerDisposer(
      new EnumSelectWidget(nodeFilterTypeModel),
    );
    nodeFilterTypeWidget.element.classList.add(
      "neuroglancer-layer-control-control",
      "neuroglancer-skeleton-filter-select",
    );
    nodeFilterTypeWidget.element.title = "Filter loaded nodes by node type";
    nodeFilterTypeWidget.element.setAttribute(
      "aria-label",
      nodeFilterTypeWidget.element.title,
    );
    for (const option of nodeFilterTypeWidget.element.options) {
      option.textContent = getSkeletonNodeFilterLabel(
        nodeFilterTypeModel.enumType[
          option.value.toUpperCase()
        ] as SkeletonNodeFilterType,
      );
    }
    const nodeFilterTypeRow = document.createElement("label");
    nodeFilterTypeRow.className = "neuroglancer-skeleton-filter-row";
    const nodeFilterTypeLabel = document.createElement("span");
    nodeFilterTypeLabel.className = "neuroglancer-skeleton-filter-label";
    nodeFilterTypeLabel.textContent = "Filter";
    nodeFilterTypeRow.appendChild(nodeFilterTypeLabel);
    nodeFilterTypeRow.appendChild(nodeFilterTypeWidget.element);
    const nodesNavigationBar = document.createElement("div");
    nodesNavigationBar.className = "neuroglancer-skeleton-navigation-bar";
    const preparationStatus = document.createElement("div");
    preparationStatus.className = "neuroglancer-skeleton-preparation-status";
    preparationStatus.hidden = true;
    preparationStatus.setAttribute("role", "status");
    preparationStatus.setAttribute("aria-live", "polite");
    const preparationStatusTitle = document.createElement("div");
    preparationStatusTitle.className =
      "neuroglancer-skeleton-preparation-status-title";
    const preparationStatusDetail = document.createElement("div");
    preparationStatusDetail.className =
      "neuroglancer-skeleton-preparation-status-detail";
    const preparationStatusQueue = document.createElement("div");
    preparationStatusQueue.className =
      "neuroglancer-skeleton-preparation-status-queue";
    preparationStatus.appendChild(preparationStatusTitle);
    preparationStatus.appendChild(preparationStatusDetail);
    preparationStatus.appendChild(preparationStatusQueue);
    const nodesSummaryBar = document.createElement("div");
    nodesSummaryBar.className = "neuroglancer-skeleton-summary-bar";
    const nodesSummary = document.createElement("div");
    nodesSummary.className = "neuroglancer-skeleton-summary";
    const inferredTopologyBadge = document.createElement("div");
    inferredTopologyBadge.className = "neuroglancer-skeleton-inferred-topology";
    inferredTopologyBadge.textContent = "Inferred topology";
    inferredTopologyBadge.title =
      "Parent and child are inferred, because this skeleton's edges have no direction.";
    inferredTopologyBadge.hidden = true;
    let virtualItems: SkeletonListItem[] = [];
    let renderVirtualListItem = (
      _item: SkeletonListItem | undefined,
    ): HTMLElement => document.createElement("div");
    const virtualListChanged = new Signal<(splices: ArraySpliceOp[]) => void>();
    const virtualListRenderChanged = new Signal();
    const virtualListSource: VirtualListSource = {
      length: 0,
      render: (index) => renderVirtualListItem(virtualItems[index]),
      changed: virtualListChanged,
      renderChanged: virtualListRenderChanged,
    };
    const nodesList = this.registerDisposer(
      new VirtualList({ source: virtualListSource }),
    );
    nodesList.element.className = "neuroglancer-skeleton-tree";
    const editModeButton = makeToolButton(this, layer.toolBinder, {
      toolJson: SPATIAL_SKELETON_EDIT_MODE_TOOL_ID,
      label: "Edit",
      title: "Toggle skeleton edit mode",
    });
    const findPathButton = makeToolButton(this, layer.toolBinder, {
      toolJson: SPATIAL_SKELETON_FIND_PATH_TOOL_ID,
      label: "Find Path",
      title: "Highlight the route between two skeleton nodes",
    });
    nodeFilterTypeRow.appendChild(editModeButton);
    nodeFilterTypeRow.appendChild(findPathButton);
    nodesSection.appendChild(filterInput);
    nodesSection.appendChild(nodeFilterTypeRow);
    nodesNavigationBar.appendChild(navTools);
    nodesNavigationBar.appendChild(toolbarActions);
    nodesSection.appendChild(nodesNavigationBar);
    nodesSection.appendChild(preparationStatus);
    nodesSummaryBar.appendChild(nodesSummary);
    nodesSummaryBar.appendChild(inferredTopologyBadge);
    nodesSection.appendChild(nodesSummaryBar);
    nodesSection.appendChild(nodesList.element);
    element.appendChild(nodesSection);

    let activeSegmentId: bigint | undefined;
    let selectedSegmentDetailsUnavailable = false;
    let nodesBySegment = new Map<bigint, readonly SkeletonNode[]>();
    let inspectionAllowed = false;
    let navigationAllowed = false;
    let trueEndEditingAllowed = false;
    let nodeDeletionAllowed = false;
    let nodeRerootAllowed = false;
    let detailsPreparationState:
      | SpatialSkeletonDetailsPreparationState
      | undefined;
    let pendingScrollToSelectedNode = false;
    const MAX_SCROLL_RETRY_FRAMES = 6;
    const SCROLL_CENTER_EPSILON = 2;
    let scrollRetryHandle: number | undefined;
    let scrollRetriesRemaining = 0;
    let scrollRetryNodeId: bigint | undefined;
    let loadedNodeSummarySuffix = "";
    let hoveredViewerNodeId: bigint | undefined;
    let hoveredListNodeId: bigint | undefined;
    const pendingDeleteNodes = new Set<bigint>();
    const pendingTrueEndNodes = new Set<bigint>();
    const listIndexByNodeId = new Map<bigint, number>();
    const skeletonState = layer.spatialSkeletonEditSession;
    const segmentColorScratch = new Float32Array(4);

    const getSkeletonTransform = () => {
      const transform =
        layer.skeletonNodeAccess.value?.displayState.transform.value;
      return transform !== undefined && transform.error === undefined
        ? transform
        : undefined;
    };

    const getCoordinateDimensionHeaders = (): string[] => {
      const transform = getSkeletonTransform();
      if (transform === undefined) return ["x", "y", "z"];
      const globalCoordSpace = layer.manager.root.coordinateSpace.value;
      const localCoordSpace = layer.localCoordinateSpace.value;
      return transform.layerDimensionNames.map((name, renderDim) => {
        for (
          let g = 0;
          g < transform.globalToRenderLayerDimensions.length;
          g++
        ) {
          if (transform.globalToRenderLayerDimensions[g] === renderDim) {
            return `${name} (${formatScaleWithUnitAsString(globalCoordSpace.scales[g], globalCoordSpace.units[g], { precision: 2 })})`;
          }
        }
        for (
          let l = 0;
          l < transform.localToRenderLayerDimensions.length;
          l++
        ) {
          if (transform.localToRenderLayerDimensions[l] === renderDim) {
            return `${name} (${formatScaleWithUnitAsString(localCoordSpace.scales[l], localCoordSpace.units[l], { precision: 2 })})`;
          }
        }
        return name;
      });
    };

    const formatNodeCoordinates = (position: ArrayLike<number>): string[] => {
      const transform = getSkeletonTransform();
      if (transform !== undefined) {
        const { rank } = transform;
        const modelPos = new Float32Array(rank);
        for (let i = 0; i < Math.min(position.length, rank); i++) {
          modelPos[i] = Number(position[i]);
        }
        const layerPos = new Float32Array(rank);
        matrix.transformPoint(
          layerPos,
          transform.modelToRenderLayerTransform,
          rank + 1,
          modelPos,
          rank,
        );
        return Array.from({ length: rank }, (_, i) =>
          String(Math.round(layerPos[i])),
        );
      }
      return [0, 1, 2].map((i) => String(Math.round(Number(position[i]))));
    };

    const getFilterText = () => nodeQuery.value.trim().toLowerCase();

    const ensureActionsAllowed = (
      requiredActions: SpatialSkeletonAction | readonly SpatialSkeletonAction[],
    ) => {
      const reason =
        layer.skeletonSourceConnection.getActionsDisabledReason(
          requiredActions,
        );
      if (reason !== undefined) {
        StatusMessage.showTemporaryMessage(reason);
        return false;
      }
      return true;
    };

    const selectNode = (
      node: SkeletonNode | undefined,
      options: {
        moveView?: boolean;
        pin?: boolean;
      } = {},
    ) => {
      if (node === undefined) return;
      const moveView = options.moveView ?? false;
      const pin = options.pin ?? false;
      pendingScrollToSelectedNode = true;
      layer.skeletonNodeSelection.select(node.nodeId, pin, {
        segmentId: node.segmentId,
        position: node.position,
      });
      if (moveView) {
        moveViewToNodePosition(node.position);
      }
      applyRowInteractionState({ scrollSelectedIntoView: true });
    };

    const moveViewToNodePosition = (position: ArrayLike<number>) => {
      layer.skeletonNodeSelection.moveViewTo(position);
    };

    const getSegmentChipColors = (segmentId: bigint) => {
      const color = getBaseObjectColor(
        layer.displayState,
        segmentId,
        segmentColorScratch,
      );
      const r = Math.round(color[0] * 255);
      const g = Math.round(color[1] * 255);
      const b = Math.round(color[2] * 255);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return {
        background: `rgb(${r}, ${g}, ${b})`,
        foreground: luminance > 0.6 ? "#101010" : "#f5f5f5",
      };
    };

    const bindSegmentSelectionControls = (
      element: HTMLElement,
      segmentId: bigint,
    ) => {
      const hasSegmentSelectionModifiers = (event: MouseEvent) =>
        event.ctrlKey && !event.altKey;
      element.addEventListener("mousedown", (event: MouseEvent) => {
        if (event.button !== 2 || !hasSegmentSelectionModifiers(event)) {
          return;
        }
        layer.selectSegment(segmentId, event.shiftKey ? "force-unpin" : true);
        event.preventDefault();
        event.stopPropagation();
      });
      element.addEventListener("contextmenu", (event: MouseEvent) => {
        if (!hasSegmentSelectionModifiers(event)) return;
        if (event.button !== 2) {
          layer.selectSegment(segmentId, event.shiftKey ? "force-unpin" : true);
        }
        event.preventDefault();
        event.stopPropagation();
      });
    };

    const getSegmentSelectionTitle = (segmentId: bigint) =>
      `segment ${segmentId}\n` +
      `Ctrl+right-click to pin selection\n` +
      `Ctrl+shift+right-click to unpin`;

    const getNodeDescriptionText = (node: SkeletonNode) =>
      node.description?.length ? node.description : undefined;

    const getHoveredNodeIdFromViewer = () => {
      return layer.skeletonNodeSelection.hovered.value?.nodeId;
    };

    const getSelectedSegmentId = () => {
      const layerSelectionState =
        layer.manager.root.selectionState.value?.layers.find(
          (entry) => entry.layer === layer,
        )?.state;
      return getSegmentIdFromLayerSelectionValue(layerSelectionState);
    };

    const getDetailsPreparationState = () => {
      const selectedSegmentId = getSelectedSegmentId();
      const presentation = skeletonState.spatialSkeletonDisplay.value;
      return getSpatialSkeletonDetailsPreparationState({
        preparations: presentation.pendingEdits,
        selectedSegmentId,
        selectedSegmentStableId:
          selectedSegmentId === undefined
            ? undefined
            : presentation.activeStableOwners.find(
                (owner) => owner.segmentId === selectedSegmentId,
              )?.stableHandle.stableId,
        hasExactTopology:
          selectedSegmentId !== undefined &&
          skeletonState.getCachedSegmentNodes(selectedSegmentId) !== undefined,
      });
    };

    const updatePreparationStatus = () => {
      detailsPreparationState = getDetailsPreparationState();
      const state = detailsPreparationState;
      preparationStatus.hidden = state === undefined;
      if (state === undefined) {
        preparationStatus.removeAttribute("data-lifecycle");
        preparationStatusTitle.textContent = "";
        preparationStatusDetail.textContent = "";
        preparationStatusQueue.textContent = "";
        return;
      }
      preparationStatus.dataset.lifecycle = state.preparation.lifecycle;
      preparationStatusTitle.textContent = state.statusText;
      preparationStatusDetail.textContent = state.detailText;
      preparationStatusQueue.textContent =
        state.laterEditCount === 0
          ? ""
          : `${state.laterEditCount} later edit${
              state.laterEditCount === 1 ? "" : "s"
            } queued`;
    };

    const ensureTopologyControlsAvailable = () => {
      const reason = detailsPreparationState?.controlsDisabledReason;
      if (reason === undefined) return true;
      StatusMessage.showTemporaryMessage(reason);
      return false;
    };

    const addVisibleSegmentIds = (segmentIds: Set<bigint>) => {
      const visibleSegments = getVisibleSegments(
        layer.displayState.segmentationGroupState.value,
      );
      for (const segmentId of visibleSegments.keys()) {
        if (segmentId !== 0n) {
          segmentIds.add(segmentId);
        }
      }
    };

    const cancelScrollRetry = () => {
      if (scrollRetryHandle !== undefined) {
        cancelAnimationFrame(scrollRetryHandle);
        scrollRetryHandle = undefined;
      }
    };

    // The area below the sticky header in which rows are actually visible.
    const getRowViewport = () => {
      const listRect = nodesList.element.getBoundingClientRect();
      const top = listRect.top + nodesList.header.offsetHeight;
      return { top, bottom: listRect.bottom, height: listRect.bottom - top };
    };

    // The `anchorClientOffset` (distance from the top of the list element to the
    // top of the anchored row) that vertically centers a row of the given height
    // in the viewport below the sticky header.  Rows taller than the viewport are
    // clamped to align their top with the header.
    const getCenteringAnchorClientOffset = (rowHeight: number) => {
      const headerHeight = nodesList.header.offsetHeight;
      const availableHeight = getRowViewport().height;
      return headerHeight + Math.max(0, (availableHeight - rowHeight) / 2);
    };

    // True when the row is vertically centered in the viewport, within epsilon.
    // Rows taller than the viewport count as centered once their top reaches the
    // header, since they cannot be centered any better.
    const isRowCentered = (element: HTMLElement) => {
      const viewport = getRowViewport();
      const rowRect = element.getBoundingClientRect();
      if (rowRect.height >= viewport.height) {
        return Math.abs(rowRect.top - viewport.top) <= SCROLL_CENTER_EPSILON;
      }
      const rowCenter = rowRect.top + rowRect.height / 2;
      const viewportCenter = viewport.top + viewport.height / 2;
      return Math.abs(rowCenter - viewportCenter) <= SCROLL_CENTER_EPSILON;
    };

    // Center the currently selected node's row in the virtual list.  Aligning it
    // to the middle (rather than merely scrolling it barely into view) keeps it
    // clear of UI overlays anchored to the bottom of the list, which could
    // otherwise obscure a row revealed at the very bottom.  The virtual list
    // renders asynchronously (animation-frame debounced) and positions unrendered
    // rows using size *estimates*, so a single synchronous attempt is unreliable.
    // We keep `pendingScrollToSelectedNode` set until the target row is genuinely
    // rendered and centered, correcting the scroll position against the real
    // measured geometry across a bounded number of frames.
    const attemptScrollToSelectedNode = () => {
      scrollRetryHandle = undefined;
      const selectedNodeId = layer.skeletonNodeSelection.selected.value?.nodeId;
      if (selectedNodeId === undefined) {
        pendingScrollToSelectedNode = false;
        return;
      }
      // A newer selection superseded this loop.
      if (selectedNodeId !== scrollRetryNodeId) return;

      const index = listIndexByNodeId.get(selectedNodeId);
      if (index === undefined) {
        // The node is not in the current list yet (async load, or a different
        // segment).  Leave the pending flag set without scheduling a frame or
        // consuming the retry budget; `updateList` re-triggers this once the
        // list is rebuilt with the node present.
        return;
      }

      const renderedElement = nodesList.getItemElement(index);
      if (renderedElement !== undefined && isRowCentered(renderedElement)) {
        pendingScrollToSelectedNode = false;
        return;
      }
      if (scrollRetriesRemaining <= 0) {
        // Found and rendered but still not centered after several corrections
        // (e.g. the row is near a list edge and cannot be centered further); stop
        // retrying so `updateList` doesn't loop forever.
        pendingScrollToSelectedNode = false;
        return;
      }
      scrollRetriesRemaining--;

      nodesList.state.anchorIndex = index;
      if (renderedElement === undefined) {
        // Not rendered: the row's real height is unknown, so anchor its top at the
        // viewport center and let the next frame render + measure it before
        // correcting to a true center.
        nodesList.state.anchorClientOffset = getCenteringAnchorClientOffset(0);
      } else {
        // Rendered but off-center: center it using the real measured height.
        const rowRect = renderedElement.getBoundingClientRect();
        nodesList.state.anchorClientOffset = getCenteringAnchorClientOffset(
          rowRect.height,
        );
      }
      // Drives VirtualList's own debouncedUpdateView; its rAF is registered
      // before ours below, so it runs first and our next attempt measures the
      // freshly rendered row.
      virtualListRenderChanged.dispatch();
      scrollRetryHandle = requestAnimationFrame(attemptScrollToSelectedNode);
    };

    const scrollSelectedNodeIntoView = () => {
      const selectedNodeId = layer.skeletonNodeSelection.selected.value?.nodeId;
      if (selectedNodeId === undefined) {
        pendingScrollToSelectedNode = false;
        cancelScrollRetry();
        return;
      }
      // A loop is already converging on this node; let it continue rather than
      // restarting (and resetting) it on every list rebuild / hover update.
      if (
        scrollRetryHandle !== undefined &&
        scrollRetryNodeId === selectedNodeId
      ) {
        return;
      }
      cancelScrollRetry();
      scrollRetryNodeId = selectedNodeId;
      scrollRetriesRemaining = MAX_SCROLL_RETRY_FRAMES;
      attemptScrollToSelectedNode();
    };

    // Node IDs repeat across the segments of some skeleton sources.
    const isSelectedNode = (node: SkeletonNode) => {
      const selected = layer.skeletonNodeSelection.selected.value;
      return (
        selected?.nodeId === node.nodeId &&
        (selected.segmentId === undefined ||
          selected.segmentId === node.segmentId)
      );
    };

    const applyRowInteractionState = (
      options: { scrollSelectedIntoView?: boolean } = {},
    ) => {
      nodesList.forEachRenderedItem((entry, index) => {
        const item = virtualItems[index];
        if (item?.kind !== "node") return;
        const { nodeId } = item.row.node;
        const isSelected = isSelectedNode(item.row.node);
        const isHovered = nodeId === hoveredViewerNodeId;
        const isListHovered = nodeId === hoveredListNodeId;
        entry.dataset.selected = String(isSelected);
        entry.dataset.viewerHovered = String(isHovered);
        entry.dataset.listHovered = String(isListHovered);
      });
      if (options.scrollSelectedIntoView) {
        scrollSelectedNodeIntoView();
      }
    };

    const updateHoveredViewerNode = () => {
      const nextHoveredNodeId = getHoveredNodeIdFromViewer();
      if (hoveredViewerNodeId === nextHoveredNodeId) return;
      hoveredViewerNodeId = nextHoveredNodeId;
      applyRowInteractionState();
    };

    const updateHoveredListNode = (nextHoveredNodeId: bigint | undefined) => {
      if (hoveredListNodeId === nextHoveredNodeId) return;
      hoveredListNodeId = nextHoveredNodeId;
      applyRowInteractionState();
    };

    const updateTrueEndLabel = (node: SkeletonNode, present: boolean) => {
      if (!ensureTopologyControlsAvailable()) return;
      if (!ensureActionsAllowed(SpatialSkeletonActions.editNodeTrueEnd)) return;
      if (pendingTrueEndNodes.has(node.nodeId)) return;
      if (present) {
        if (node.parentNodeId === undefined) {
          StatusMessage.showTemporaryMessage(
            "Cannot set the root node as a true end.",
          );
          return;
        }
        const segmentNodes = nodesBySegment.get(node.segmentId) ?? [];
        const hasChildren = segmentNodes.some(
          (candidate) => candidate.parentNodeId === node.nodeId,
        );
        if (hasChildren) {
          StatusMessage.showTemporaryMessage(
            "Only leaf nodes can be marked as true ends.",
          );
          return;
        }
      }
      pendingTrueEndNodes.add(node.nodeId);
      updateDisplay();
      void (async () => {
        try {
          const currentNode = skeletonState.getCachedNode(node.nodeId);
          if (currentNode === undefined) {
            throw new Error(
              `Node ${node.nodeId} is missing from the inspected skeleton cache.`,
            );
          }
          await executeSpatialSkeletonNodeTrueEndUpdate(
            layer.skeletonSourceConnection,
            {
              node: currentNode,
              nextIsTrueEnd: present,
            },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          StatusMessage.showTemporaryMessage(
            `Failed to update true end state: ${message}`,
          );
        } finally {
          pendingTrueEndNodes.delete(node.nodeId);
          updateDisplay();
        }
      })();
    };

    const deleteNode = (node: SkeletonNode) => {
      if (!ensureTopologyControlsAvailable()) return;
      if (!ensureActionsAllowed(SpatialSkeletonActions.deleteNodes)) return;
      if (pendingDeleteNodes.has(node.nodeId)) {
        return;
      }
      const segmentNodes = nodesBySegment.get(node.segmentId) ?? [];
      const hasChildren = segmentNodes.some(
        (candidate) => candidate.parentNodeId === node.nodeId,
      );
      if (node.parentNodeId === undefined && hasChildren) {
        StatusMessage.showTemporaryMessage(
          "Reroot the skeleton manually before deleting the current root node.",
        );
        return;
      }
      pendingDeleteNodes.add(node.nodeId);
      updateDisplay();
      void (async () => {
        try {
          await executeSpatialSkeletonDeleteNode(
            layer.skeletonSourceConnection,
            node,
          );
          refreshNodes();
        } catch (error) {
          showSpatialSkeletonActionError(
            SpatialSkeletonActions.deleteNodes,
            error,
          );
          updateDisplay();
        } finally {
          pendingDeleteNodes.delete(node.nodeId);
          updateDisplay();
        }
      })();
    };

    const goRootButton = makeIconButton(
      navTools,
      svg_origin,
      "Go to root",
      () => layer.skeletonNodeSelection.navigate(SkeletonNavigation.ROOT),
    );
    const goBranchStartButton = makeIconButton(
      navTools,
      svg_chevrons_left,
      "Go to start of branch",
      () =>
        layer.skeletonNodeSelection.navigate(SkeletonNavigation.BRANCH_START),
    );
    const goTreeEndButton = makeIconButton(
      navTools,
      svg_chevrons_right,
      "Go to end of branch",
      () => layer.skeletonNodeSelection.navigate(SkeletonNavigation.BRANCH_END),
    );
    const cycleBranchesButton = makeIconButton(
      navTools,
      svg_retweet,
      "Cycle through level nodes",
      () =>
        layer.skeletonNodeSelection.navigate(
          SkeletonNavigation.NEXT_LEVEL_NODE,
        ),
    );
    const goParentButton = makeIconButton(
      navTools,
      svg_arrow_left,
      "Go to parent",
      () => layer.skeletonNodeSelection.navigate(SkeletonNavigation.PARENT),
    );
    const goChildButton = makeIconButton(
      navTools,
      svg_arrow_right,
      "Go to child",
      () => layer.skeletonNodeSelection.navigate(SkeletonNavigation.CHILD),
    );
    const goUnfinishedBranchButton = makeIconButton(
      navTools,
      svg_chevron_right,
      "Go to nearest unfinished leaf node",
      () =>
        layer.skeletonNodeSelection.navigate(
          SkeletonNavigation.NEAREST_OPEN_LEAF,
        ),
    );
    const gatedControls = [
      goRootButton,
      goBranchStartButton,
      goTreeEndButton,
      cycleBranchesButton,
      goParentButton,
      goChildButton,
      goUnfinishedBranchButton,
    ];
    const gatedControlDefaultTitles = new Map(
      gatedControls.map((control) => [control, control.title] as const),
    );

    const makeRowActionButton = (
      svg: string,
      title: string,
      onClick: () => void,
      disabled: boolean,
    ) => {
      const button = document.createElement("button");
      button.className = "neuroglancer-skeleton-node-action";
      button.type = "button";
      button.title = title;
      button.disabled = disabled;
      button.appendChild(makeIcon({ svg, title, clickable: false }));
      button.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        onClick();
      });
      return button;
    };

    const getSegmentDisplayLabel = (segmentId: bigint) => {
      const segmentationGroupState =
        layer.displayState.segmentationGroupState.value;
      const segmentPropertyMap =
        segmentationGroupState.segmentPropertyMap.value;
      if (segmentPropertyMap === undefined) {
        return undefined;
      }
      const mappedSegmentId = getSegmentEquivalences(
        segmentationGroupState,
      ).get(segmentId);
      return segmentPropertyMap.getSegmentLabel(mappedSegmentId);
    };

    const buildSegmentDisplayState = (): SegmentDisplayState | undefined => {
      const segmentId = activeSegmentId;
      if (segmentId === undefined) return undefined;
      const graph = layer.skeletonNodeSelection.navigator.getGraph(segmentId);
      const renderState =
        graph === undefined
          ? {
              segmentId,
              totalNodeCount: 0,
              matchedNodeCount: 0,
              displayedNodeCount: 0,
              branchCount: 0,
              rows: [],
            }
          : buildSkeletonSegmentRenderState(segmentId, graph, {
              filterText: getFilterText(),
              nodeFilterType: nodeFilterTypeModel.value,
              getNodeDescription: getNodeDescriptionText,
            });
      return {
        ...renderState,
        segmentLabel: getSegmentDisplayLabel(segmentId),
      };
    };

    const makeListHeader = () => {
      const listHeader = document.createElement("div");
      listHeader.className = "neuroglancer-skeleton-list-header";
      const headerTypeSpacer = document.createElement("span");
      headerTypeSpacer.className =
        "neuroglancer-skeleton-list-header-spacer neuroglancer-skeleton-list-header-type";
      const headerId = document.createElement("span");
      headerId.className = "neuroglancer-skeleton-list-header-cell";
      headerId.textContent = "id";
      const headerCoordinates = document.createElement("span");
      headerCoordinates.className =
        "neuroglancer-skeleton-list-header-cell neuroglancer-skeleton-coordinates-flex";
      for (const dimLabel of getCoordinateDimensionHeaders()) {
        const dimSpan = document.createElement("span");
        dimSpan.className = "neuroglancer-skeleton-coord-dim";
        dimSpan.textContent = dimLabel;
        headerCoordinates.appendChild(dimSpan);
      }
      listHeader.appendChild(headerTypeSpacer);
      listHeader.appendChild(headerId);
      listHeader.appendChild(headerCoordinates);
      return listHeader;
    };

    const updateListHeader = (show: boolean) => {
      nodesList.header.textContent = "";
      if (show) {
        nodesList.header.appendChild(makeListHeader());
      }
    };

    const makeSegmentEntry = (segmentState: SegmentDisplayState) => {
      const segmentEntry = document.createElement("div");
      segmentEntry.className =
        "neuroglancer-skeleton-tree-entry neuroglancer-skeleton-segment-entry";
      const segmentRow = document.createElement("div");
      segmentRow.className =
        "neuroglancer-skeleton-tree-row neuroglancer-skeleton-segment-row";
      const segmentTypeSpacer = document.createElement("span");
      segmentTypeSpacer.className =
        "neuroglancer-skeleton-list-header-spacer neuroglancer-skeleton-list-header-type";
      const segmentIdCell = document.createElement("span");
      segmentIdCell.className = "neuroglancer-skeleton-node-id";
      const segmentChip = document.createElement("span");
      segmentChip.className = "neuroglancer-skeleton-node-segment-chip";
      const segmentAlias =
        skeletonState.spatialSkeletonDisplay.value.numericAliases.find(
          (alias) => alias.segmentId === segmentState.segmentId,
        );
      const segmentChipColors =
        segmentAlias?.authoritative === false
          ? { background: "rgb(255, 0, 0)", foreground: "#ffffff" }
          : getSegmentChipColors(segmentState.segmentId);
      const hideNumericSegmentId =
        detailsPreparationState !== undefined ||
        segmentAlias?.authoritative === false;
      segmentChip.textContent =
        segmentAlias?.authoritative === false
          ? "Preview"
          : hideNumericSegmentId
            ? "Updating"
            : String(segmentState.segmentId);
      segmentChip.style.backgroundColor = segmentChipColors.background;
      segmentChip.style.color = segmentChipColors.foreground;
      segmentChip.title =
        segmentAlias?.authoritative === false
          ? "Preview skeleton. Red means the skeleton source has not yet confirmed its permanent skeleton ID."
          : detailsPreparationState !== undefined
            ? "Showing the last complete skeleton while the requested preview is prepared. Selection and pinning remain available."
            : getSegmentSelectionTitle(segmentState.segmentId);
      bindSegmentSelectionControls(segmentChip, segmentState.segmentId);
      segmentIdCell.appendChild(segmentChip);
      const segmentMeta = document.createElement("div");
      segmentMeta.className =
        "neuroglancer-skeleton-node-coordinate-cell neuroglancer-skeleton-segment-meta";
      const segmentMetaLine = document.createElement("div");
      segmentMetaLine.className = "neuroglancer-skeleton-segment-meta-line";
      const segmentName = document.createElement("span");
      segmentName.className = "neuroglancer-skeleton-segment-name";
      segmentName.textContent = segmentState.segmentLabel ?? "";
      const segmentRatio = document.createElement("span");
      segmentRatio.className = "neuroglancer-skeleton-node-ratio";
      segmentRatio.textContent = `${segmentState.displayedNodeCount}/${segmentState.totalNodeCount}`;
      segmentMetaLine.appendChild(segmentName);
      segmentMetaLine.appendChild(segmentRatio);
      segmentMeta.appendChild(segmentMetaLine);
      segmentRow.appendChild(segmentTypeSpacer);
      segmentRow.appendChild(segmentIdCell);
      segmentRow.appendChild(segmentMeta);
      segmentEntry.appendChild(segmentRow);
      return segmentEntry;
    };

    const makeNodeEntry = (rowInfo: SkeletonSegmentRenderRow) => {
      const { node, type, isLeaf } = rowInfo;
      const entry = document.createElement("div");
      entry.className = "neuroglancer-skeleton-tree-entry";
      entry.dataset.selected = String(isSelectedNode(node));
      entry.dataset.viewerHovered = String(node.nodeId === hoveredViewerNodeId);
      entry.dataset.listHovered = String(node.nodeId === hoveredListNodeId);
      entry.addEventListener("mouseenter", () => {
        updateHoveredListNode(node.nodeId);
      });
      entry.addEventListener("mouseleave", () => {
        updateHoveredListNode(undefined);
      });

      const row = document.createElement("div");
      row.className = "neuroglancer-skeleton-tree-row";
      row.dataset.nodeType = type;
      if (inspectionAllowed) {
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.title =
          "Click to move to node and pin selection. Right-click to move to node. Ctrl+right-click to pin selection without moving.";
        row.addEventListener("click", (event: MouseEvent) => {
          const { target } = event;
          if (
            target instanceof HTMLElement &&
            target.closest(
              ".neuroglancer-skeleton-node-actions, .neuroglancer-skeleton-node-type-toggle",
            ) !== null
          ) {
            return;
          }
          if (!ensureActionsAllowed(SpatialSkeletonActions.inspect)) {
            return;
          }
          selectNode(node, { moveView: true, pin: true });
        });
        row.addEventListener("contextmenu", (event: MouseEvent) => {
          const { target } = event;
          if (
            target instanceof HTMLElement &&
            target.closest(
              ".neuroglancer-skeleton-node-actions, .neuroglancer-skeleton-node-type-toggle",
            ) !== null
          ) {
            return;
          }
          event.preventDefault();
          if (!ensureActionsAllowed(SpatialSkeletonActions.inspect)) {
            return;
          }
          if (event.ctrlKey) {
            selectNode(node, { moveView: false, pin: true });
            return;
          }
          moveViewToNodePosition(node.position);
        });
        row.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (!ensureActionsAllowed(SpatialSkeletonActions.inspect)) {
            return;
          }
          selectNode(node, { moveView: true, pin: true });
        });
      } else {
        row.setAttribute("aria-disabled", "true");
      }

      const nodeIsTrueEnd = isSkeletonNodeTrueEnd(node);
      const typeIconSvg = getSkeletonNodeTypeIcon(type, nodeIsTrueEnd);
      const typeIconTitle = getSkeletonNodeTypeLabel(type, nodeIsTrueEnd);
      const typeButtonPending = pendingTrueEndNodes.has(node.nodeId);
      const typeButtonTitle = typeButtonPending
        ? nodeIsTrueEnd
          ? "Removing true end"
          : "Setting true end"
        : typeIconTitle;
      const canChangeType =
        layer.editableSkeletonSource.value !== undefined &&
        (isLeaf || nodeIsTrueEnd);
      const typeIcon = canChangeType
        ? document.createElement("button")
        : document.createElement("span");
      typeIcon.className = `neuroglancer-skeleton-node-type${canChangeType ? "-toggle" : ""}`;
      const toggleToName = nodeIsTrueEnd ? "Virtual end" : "True end";
      const fullTitle =
        canChangeType && detailsPreparationState !== undefined
          ? detailsPreparationState.controlsDisabledReason
          : typeButtonTitle +
            (canChangeType ? ` (click to toggle to ${toggleToName})` : "");
      typeIcon.title = fullTitle;
      if (typeIcon instanceof HTMLButtonElement) {
        typeIcon.type = "button";
        typeIcon.disabled = !trueEndEditingAllowed || typeButtonPending;
        typeIcon.setAttribute("aria-pressed", String(nodeIsTrueEnd));
        typeIcon.addEventListener("click", (event: MouseEvent) => {
          event.stopPropagation();
          updateTrueEndLabel(node, !nodeIsTrueEnd);
        });
      }
      typeIcon.appendChild(
        makeIcon({
          svg: typeIconSvg,
          title: fullTitle,
          clickable: false,
        }),
      );

      const idCell = document.createElement("span");
      idCell.className = "neuroglancer-skeleton-node-id";
      const nodeIdPresentation = getSkeletonNodeIdPresentation(
        node.nodeId,
        skeletonState.spatialSkeletonDisplay.value.provisionalNodeIds,
      );
      idCell.textContent = nodeIdPresentation.label;
      idCell.dataset.provisional = String(nodeIdPresentation.provisional);
      if (nodeIdPresentation.tooltip !== undefined) {
        idCell.title = nodeIdPresentation.tooltip;
      }

      const coordinatesCell = document.createElement("div");
      coordinatesCell.className = "neuroglancer-skeleton-node-coordinate-cell";
      const coordinatesLine = document.createElement("div");
      coordinatesLine.className =
        "neuroglancer-skeleton-node-coordinates neuroglancer-skeleton-coordinates-flex";
      for (const val of formatNodeCoordinates(node.position)) {
        const valSpan = document.createElement("span");
        valSpan.className = "neuroglancer-skeleton-coord-dim";
        valSpan.textContent = val;
        coordinatesLine.appendChild(valSpan);
      }
      coordinatesCell.appendChild(coordinatesLine);
      const description = getNodeDescriptionText(node);
      if (description !== undefined) {
        const descriptionLine = document.createElement("div");
        descriptionLine.className = "neuroglancer-skeleton-node-description";
        descriptionLine.textContent = description;
        coordinatesCell.appendChild(descriptionLine);
      }

      const actions = document.createElement("div");
      actions.className = "neuroglancer-skeleton-node-actions";
      let deleteActionTitle = "Delete node";
      if (detailsPreparationState !== undefined) {
        deleteActionTitle = detailsPreparationState.controlsDisabledReason;
      } else if (pendingDeleteNodes.has(node.nodeId)) {
        deleteActionTitle = "Deleting node";
      }
      if (layer.editableSkeletonSource.value !== undefined) {
        actions.appendChild(
          makeRowActionButton(
            svg_bin,
            deleteActionTitle,
            () => deleteNode(node),
            !nodeDeletionAllowed || pendingDeleteNodes.has(node.nodeId),
          ),
        );
      }

      row.appendChild(typeIcon);
      row.appendChild(idCell);
      row.appendChild(coordinatesCell);
      row.appendChild(actions);
      entry.appendChild(row);
      return entry;
    };

    const makeEmptyEntry = (text: string) => {
      const empty = document.createElement("div");
      empty.className = "neuroglancer-skeleton-summary";
      empty.textContent = text;
      return empty;
    };

    renderVirtualListItem = (item: SkeletonListItem | undefined) => {
      switch (item?.kind) {
        case "segment":
          return makeSegmentEntry(item.segmentState);
        case "node":
          return makeNodeEntry(item.row);
        case "empty":
          return makeEmptyEntry(item.text);
        default:
          return document.createElement("div");
      }
    };

    const getListItemKey = (item: SkeletonListItem) => {
      switch (item.kind) {
        case "segment":
          return `segment:${item.segmentState.segmentId}`;
        case "node":
          return `node:${item.row.node.nodeId}`;
        case "empty":
          return `empty:${item.text}`;
      }
    };

    const setVirtualItems = (nextItems: SkeletonListItem[]) => {
      const oldItems = virtualItems;
      const sameItems =
        oldItems.length === nextItems.length &&
        oldItems.every(
          (item, index) =>
            getListItemKey(item) === getListItemKey(nextItems[index]),
        );
      virtualItems = nextItems;
      virtualListSource.length = virtualItems.length;
      if (sameItems) {
        virtualListRenderChanged.dispatch();
      } else {
        virtualListChanged.dispatch([
          {
            retainCount: 0,
            deleteCount: oldItems.length,
            insertCount: nextItems.length,
          },
        ]);
      }
    };

    const getEmptyListText = (segmentState: SegmentDisplayState | undefined) =>
      getSkeletonEmptyListText({
        activeSegmentId,
        selectedSegmentDetailsUnavailable,
        segmentState,
        filterText: getFilterText(),
        nodeFilterType: nodeFilterTypeModel.value,
        preparationActive: detailsPreparationState !== undefined,
        hasPickableNodes:
          layer.skeletonNodeAccess.value?.hasPickableNodes ?? false,
      });

    const updateList = (segmentState: SegmentDisplayState | undefined) => {
      const flattened = buildSkeletonVirtualListItems(
        segmentState,
        getEmptyListText(segmentState),
      );
      listIndexByNodeId.clear();
      for (const [nodeId, index] of flattened.listIndexByNodeId) {
        listIndexByNodeId.set(nodeId, index);
      }
      updateListHeader(
        segmentState !== undefined && segmentState.displayedNodeCount > 0,
      );
      setVirtualItems(flattened.items);
      if (pendingScrollToSelectedNode) {
        applyRowInteractionState({ scrollSelectedIntoView: true });
      } else {
        applyRowInteractionState();
      }
    };

    const summarizeNodeState = (
      segmentState: SegmentDisplayState | undefined,
      summarySuffix = "",
    ) => {
      if (detailsPreparationState !== undefined && segmentState === undefined) {
        nodesSummary.textContent = PREPARATION_PENDING_LIST_MESSAGE;
        nodesSummary.removeAttribute("title");
        return;
      }
      const branchCount = segmentState?.branchCount ?? 0;
      const nodeCount = segmentState?.displayedNodeCount ?? 0;
      nodesSummary.textContent = `${branchCount} branch${branchCount === 1 ? "" : "es"}, ${nodeCount} node${
        nodeCount === 1 ? "" : "s"
      }`;
      if (summarySuffix.trim().length > 0) {
        nodesSummary.title = summarySuffix.trim();
      } else {
        nodesSummary.removeAttribute("title");
      }
    };

    const updateDisplay = (summarySuffix = loadedNodeSummarySuffix) => {
      updatePreparationStatus();
      const segmentState = buildSegmentDisplayState();
      summarizeNodeState(segmentState, summarySuffix);
      updateList(segmentState);
    };

    const applyNodesBySegment = (
      nextNodesBySegment: Map<bigint, readonly SkeletonNode[]>,
      summarySuffix = "",
    ) => {
      loadedNodeSummarySuffix = summarySuffix;
      nodesBySegment = nextNodesBySegment;
      updateDisplay(summarySuffix);
    };

    const refreshNodes = () => {
      const skeletonLayer = layer.spatiallyIndexedSkeletonLayer.value;
      const selectedSegmentId = getSelectedSegmentId();
      const cachedSelectedSegmentNodes =
        selectedSegmentId === undefined
          ? undefined
          : layer.skeletonNodeAccess.value?.getSegmentNodes(selectedSegmentId);
      activeSegmentId =
        cachedSelectedSegmentNodes === undefined
          ? undefined
          : selectedSegmentId;
      selectedSegmentDetailsUnavailable =
        selectedSegmentId !== undefined &&
        cachedSelectedSegmentNodes === undefined;
      loadedNodeSummarySuffix = "";
      const parentsInferred =
        layer.skeletonNodeAccess.value?.parentsInferred ?? false;
      inferredTopologyBadge.hidden =
        !parentsInferred || cachedSelectedSegmentNodes === undefined;
      if (
        activeSegmentId === undefined ||
        cachedSelectedSegmentNodes === undefined
      ) {
        nodesBySegment = new Map();
        updateDisplay();
        return;
      }
      nodesBySegment = new Map();
      updateDisplay();

      const segmentId = activeSegmentId;
      if (skeletonLayer !== undefined) {
        const cachedSegmentIds = new Set<bigint>([segmentId]);
        addVisibleSegmentIds(cachedSegmentIds);
        for (const retainedSegmentId of layer.skeletonOverlaySegments.getRetainedSegmentIds()) {
          cachedSegmentIds.add(retainedSegmentId);
        }
        skeletonState.evictInactiveSegmentNodes(cachedSegmentIds);
      }
      applyNodesBySegment(
        new Map<bigint, readonly SkeletonNode[]>([
          [segmentId, cachedSelectedSegmentNodes],
        ]),
        parentsInferred ? "" : " Using inspected full skeleton data.",
      );
    };

    const updateGateStatus = () => {
      findPathButton.hidden =
        layer.skeletonSourceConnection.getFindPathContext() === undefined;
      updatePreparationStatus();
      const topologyControlsDisabledReason =
        detailsPreparationState?.controlsDisabledReason;
      const nextInspectionAllowed =
        layer.skeletonSourceConnection.getActionsDisabledReason(
          SpatialSkeletonActions.inspect,
        ) === undefined;
      const nextNavigationAllowed =
        nextInspectionAllowed && topologyControlsDisabledReason === undefined;
      const nextTrueEndEditingAllowed =
        topologyControlsDisabledReason === undefined &&
        layer.skeletonSourceConnection.getActionsDisabledReason(
          SpatialSkeletonActions.editNodeTrueEnd,
        ) === undefined;
      const nextNodeDeletionAllowed =
        topologyControlsDisabledReason === undefined &&
        layer.skeletonSourceConnection.getActionsDisabledReason(
          SpatialSkeletonActions.deleteNodes,
        ) === undefined;
      const nextNodeRerootAllowed =
        topologyControlsDisabledReason === undefined &&
        layer.skeletonSourceConnection.getActionsDisabledReason(
          SpatialSkeletonActions.reroot,
        ) === undefined;
      const gateStateChanged =
        inspectionAllowed !== nextInspectionAllowed ||
        navigationAllowed !== nextNavigationAllowed ||
        trueEndEditingAllowed !== nextTrueEndEditingAllowed ||
        nodeDeletionAllowed !== nextNodeDeletionAllowed ||
        nodeRerootAllowed !== nextNodeRerootAllowed;

      inspectionAllowed = nextInspectionAllowed;
      navigationAllowed = nextNavigationAllowed;
      trueEndEditingAllowed = nextTrueEndEditingAllowed;
      nodeDeletionAllowed = nextNodeDeletionAllowed;
      nodeRerootAllowed = nextNodeRerootAllowed;

      filterInput.disabled = !inspectionAllowed;
      nodeFilterTypeWidget.element.disabled =
        !inspectionAllowed || topologyControlsDisabledReason !== undefined;
      nodeFilterTypeWidget.element.title =
        topologyControlsDisabledReason ?? "Filter loaded nodes by node type";
      nodeFilterTypeWidget.element.setAttribute(
        "aria-label",
        nodeFilterTypeWidget.element.title,
      );
      for (const control of gatedControls) {
        control.disabled = !navigationAllowed;
        control.title =
          topologyControlsDisabledReason ??
          gatedControlDefaultTitles.get(control) ??
          "Skeleton navigation";
        control.setAttribute("aria-label", control.title);
      }
      if (gateStateChanged) {
        updateDisplay();
      }
    };

    const updateHistoryButtons = () => {
      const { commandHistory } = layer.spatialSkeletonEditSession;
      const undoLabel = commandHistory.undoLabel.value;
      const redoLabel = commandHistory.redoLabel.value;
      const canUndoOptimistic = layer.spatialSkeletonEditSession.canUndoEdit();
      const canRedoOptimistic = layer.spatialSkeletonEditSession.canRedoEdit();
      const reloadRequired =
        layer.spatialSkeletonEditSession.getReloadRequired() !== undefined;
      undoButton.disabled = !canUndoOptimistic;
      redoButton.disabled = !canRedoOptimistic;
      undoButton.title = reloadRequired
        ? SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON
        : !canUndoOptimistic
          ? "Nothing to undo."
          : undoLabel === undefined
            ? "Undo latest optimistic edit."
            : `Undo ${undoLabel}`;
      redoButton.title = reloadRequired
        ? SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON
        : !canRedoOptimistic
          ? "Nothing to redo."
          : redoLabel === undefined
            ? "Redo latest optimistic edit."
            : `Redo ${redoLabel}`;
      undoButton.setAttribute("aria-label", undoButton.title);
      redoButton.setAttribute("aria-label", redoButton.title);
    };

    filterInput.addEventListener("input", () => {
      nodeQuery.value = filterInput.value;
    });
    this.registerDisposer(
      nodeQuery.changed.add(() => {
        if (filterInput.value !== nodeQuery.value) {
          filterInput.value = nodeQuery.value;
        }
        updateDisplay();
      }),
    );
    this.registerDisposer(
      nodeFilterTypeModel.changed.add(() => {
        updateDisplay();
      }),
    );

    this.registerDisposer(
      observeWatchable((editableSource) => {
        const readOnly = editableSource === undefined;
        undoButton.hidden = readOnly;
        redoButton.hidden = readOnly;
        editModeButton.hidden = readOnly;
        updateDisplay();
      }, layer.editableSkeletonSource),
    );
    this.registerDisposer(
      observeWatchable(
        () => updateGateStatus(),
        layer.spatialSkeletonEditSession.editMode,
      ),
    );
    this.registerDisposer(
      observeWatchable(
        () => updateGateStatus(),
        layer.spatialSkeletonEditSession.mergeMode,
      ),
    );
    this.registerDisposer(
      observeWatchable(
        () => updateGateStatus(),
        layer.spatialSkeletonEditSession.splitMode,
      ),
    );
    this.registerDisposer(
      layer.layersChanged.add(() => {
        updateGateStatus();
      }),
    );
    this.registerDisposer(
      layer.spatialSkeletonEditSession.commandHistory.canUndo.changed.add(
        () => {
          updateHistoryButtons();
        },
      ),
    );
    this.registerDisposer(
      layer.spatialSkeletonEditSession.commandHistory.canRedo.changed.add(
        () => {
          updateHistoryButtons();
        },
      ),
    );
    this.registerDisposer(
      layer.spatialSkeletonEditSession.commandHistory.undoLabel.changed.add(
        () => {
          updateHistoryButtons();
        },
      ),
    );
    this.registerDisposer(
      layer.spatialSkeletonEditSession.commandHistory.redoLabel.changed.add(
        () => {
          updateHistoryButtons();
        },
      ),
    );
    this.registerDisposer(
      layer.spatialSkeletonEditSession.editQueueVersion.changed.add(() => {
        updateGateStatus();
        updateHistoryButtons();
      }),
    );
    this.registerDisposer(
      layer.manager.root.selectionState.changed.add(() => {
        const nextActiveSegmentId = getSelectedSegmentId();
        if (nextActiveSegmentId !== activeSegmentId) {
          refreshNodes();
        } else {
          updateDisplay();
        }
        updateGateStatus();
      }),
    );
    this.registerDisposer(
      registerNested((context, colorGroupState) => {
        context.registerDisposer(
          colorGroupState.segmentColorHash.changed.add(() => {
            updateDisplay();
          }),
        );
        context.registerDisposer(
          colorGroupState.segmentDefaultColor.changed.add(() => {
            updateDisplay();
          }),
        );
        context.registerDisposer(
          colorGroupState.segmentStatedColors.changed.add(() => {
            updateDisplay();
          }),
        );
      }, layer.displayState.segmentationColorGroupState),
    );
    this.registerDisposer(() => cancelScrollRetry());
    this.registerDisposer(
      layer.skeletonNodeSelection.selected.changed.add(() => {
        pendingScrollToSelectedNode = true;
        applyRowInteractionState({ scrollSelectedIntoView: true });
      }),
    );
    this.registerDisposer(
      layer.skeletonNodeSelection.hovered.changed.add(() => {
        updateHoveredViewerNode();
      }),
    );
    this.registerDisposer(
      layer.layersChanged.add(() => {
        refreshNodes();
      }),
    );
    this.registerDisposer(
      layer.manager.chunkManager.layerChunkStatisticsUpdated.add(() => {
        updateGateStatus();
      }),
    );
    this.registerDisposer(
      registerNestedSync((context, nodeAccess) => {
        if (nodeAccess === undefined) return;
        context.registerDisposer(
          nodeAccess.nodesChanged.add(() => {
            const selectedSegmentId = getSelectedSegmentId();
            const selectedSegmentNodes =
              selectedSegmentId === undefined
                ? undefined
                : nodeAccess.getSegmentNodes(selectedSegmentId);
            const shownNodes =
              activeSegmentId === undefined
                ? undefined
                : nodesBySegment.get(activeSegmentId);
            if (selectedSegmentNodes !== shownNodes) refreshNodes();
          }),
        );
      }, layer.skeletonNodeAccess),
    );
    this.registerDisposer(
      skeletonState.spatialSkeletonDisplay.changed.add(() => {
        updateDisplay();
        updateGateStatus();
      }),
    );
    this.registerDisposer(
      layer.manager.root.coordinateSpace.changed.add(() => {
        updateDisplay();
      }),
    );
    this.registerDisposer(
      layer.localCoordinateSpace.changed.add(() => {
        updateDisplay();
      }),
    );
    updateGateStatus();
    updateHistoryButtons();
    updateHoveredViewerNode();
    refreshNodes();
  }
}

export function registerSkeletonTabs(layer: SegmentationUserLayer) {
  layer.tabs.add("skeleton", {
    label: "Skeleton",
    order: -45,
    getter: () => new SkeletonTab(layer),
    hidden: layer.registerDisposer(
      makeCachedDerivedWatchableValue(
        (nodeAccess) => nodeAccess === undefined,
        [layer.skeletonNodeAccess],
      ),
    ),
  });
  registerSpatialSkeletonEditQueueTab(
    layer,
    layer.registerDisposer(
      makeCachedDerivedWatchableValue(
        (editableSource) => editableSource === undefined,
        [layer.editableSkeletonSource],
      ),
    ),
  );
}
