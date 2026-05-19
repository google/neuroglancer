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

import svg_arrow_left from "ikonate/icons/arrow-left.svg?raw";
import svg_arrow_right from "ikonate/icons/arrow-right.svg?raw";
import svg_bin from "ikonate/icons/bin.svg?raw";
import svg_chevron_right from "ikonate/icons/chevron-right.svg?raw";
import svg_chevrons_left from "ikonate/icons/chevrons-left.svg?raw";
import svg_chevrons_right from "ikonate/icons/chevrons-right.svg?raw";
import svg_circle from "ikonate/icons/circle.svg?raw";
import svg_flag from "ikonate/icons/flag.svg?raw";
import svg_minus from "ikonate/icons/minus.svg?raw";
import svg_origin from "ikonate/icons/origin.svg?raw";
import svg_redo from "ikonate/icons/redo.svg?raw";
import svg_retweet from "ikonate/icons/retweet.svg?raw";
import svg_share_android from "ikonate/icons/share-android.svg?raw";
import svg_undo from "ikonate/icons/undo.svg?raw";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { getSegmentIdFromLayerSelectionValue } from "#src/layer/segmentation/selection.js";
import {
  executeSpatialSkeletonDeleteNode,
  executeSpatialSkeletonNodeTrueEndUpdate,
  redoSpatialSkeletonCommand,
  showSpatialSkeletonActionError,
  undoSpatialSkeletonCommand,
} from "#src/layer/segmentation/spatial_skeleton_commands.js";
import {
  getSegmentEquivalences,
  getVisibleSegments,
} from "#src/segmentation_display_state/base.js";
import { getBaseObjectColor } from "#src/segmentation_display_state/frontend.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/actions.js";
import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import {
  buildSpatiallyIndexedSkeletonNavigationGraph,
  getBranchEnd as getBranchEndFromGraph,
  getBranchStart as getBranchStartFromGraph,
  getRandomChildNode as getRandomChildNodeFromGraph,
  getNextCollapsedLevelNode as getNextCollapsedLevelNodeFromGraph,
  getOpenLeaves as getOpenLeavesFromGraph,
  getParentNode as getParentNodeFromGraph,
  getSkeletonRootNode as getSkeletonRootNodeFromGraph,
  type SpatiallyIndexedSkeletonNavigationTarget,
  type SpatiallyIndexedSkeletonOpenLeaf,
  type SpatiallyIndexedSkeletonNavigationGraph,
} from "#src/skeleton/navigation_graph.js";
import {
  getSpatialSkeletonNodeFilterLabel,
  getSpatialSkeletonNodeIconFilterType,
  SpatialSkeletonDisplayNodeType,
  SpatialSkeletonNodeFilterType,
} from "#src/skeleton/node_types.js";
import { StatusMessage } from "#src/status.js";
import { observeWatchable, registerNested } from "#src/trackable_value.js";
import {
  buildSpatialSkeletonSegmentRenderState,
  type SpatialSkeletonSegmentRenderRow,
  type SpatialSkeletonSegmentRenderState,
} from "#src/ui/spatial_skeleton_edit_tab_render.js";
import {
  SPATIAL_SKELETON_EDIT_MODE_TOOL_ID,
  SPATIAL_SKELETON_MERGE_MODE_TOOL_ID,
  SPATIAL_SKELETON_SPLIT_MODE_TOOL_ID,
} from "#src/ui/spatial_skeleton_edit_tool.js";
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

export type SegmentDisplayState = SpatialSkeletonSegmentRenderState & {
  segmentLabel: string | undefined;
};

export type SpatialSkeletonListItem =
  | { kind: "segment"; segmentState: SegmentDisplayState }
  | { kind: "node"; row: SpatialSkeletonSegmentRenderRow }
  | { kind: "empty"; text: string };

export function buildSpatialSkeletonVirtualListItems(
  segmentState: SegmentDisplayState | undefined,
  emptyText: string,
) {
  const items: SpatialSkeletonListItem[] = [];
  const listIndexByNodeId = new Map<number, number>();
  if (segmentState !== undefined && segmentState.displayedNodeCount > 0) {
    items.push({ kind: "segment", segmentState });
    for (const row of segmentState.rows) {
      listIndexByNodeId.set(row.node.nodeId, items.length);
      items.push({ kind: "node", row });
    }
  } else {
    items.push({ kind: "empty", text: emptyText });
  }
  return { items, listIndexByNodeId };
}

interface SpatiallyIndexedSkeletonNavigationApi {
  getSkeletonRootNode(
    skeletonId: number,
  ): Promise<SpatiallyIndexedSkeletonNavigationTarget>;
  getBranchStart(
    nodeId: number,
  ): Promise<SpatiallyIndexedSkeletonNavigationTarget>;
  getBranchEnd(
    nodeId: number,
  ): Promise<SpatiallyIndexedSkeletonNavigationTarget>;
  getNextCollapsedLevelNode(
    nodeId: number,
  ): Promise<SpatiallyIndexedSkeletonNavigationTarget>;
  getOpenLeaves(
    skeletonId: number,
    nodeId: number,
  ): Promise<SpatiallyIndexedSkeletonOpenLeaf[]>;
  getParentNode(
    nodeId: number,
  ): Promise<SpatiallyIndexedSkeletonNavigationTarget | undefined>;
  getChildNode(
    nodeId: number,
  ): Promise<SpatiallyIndexedSkeletonNavigationTarget | undefined>;
}

const NODE_TYPE_ICONS: Record<SpatialSkeletonDisplayNodeType, string> = {
  [SpatialSkeletonDisplayNodeType.ROOT]: svg_origin,
  [SpatialSkeletonDisplayNodeType.BRANCH_START]: svg_share_android,
  [SpatialSkeletonDisplayNodeType.REGULAR]: svg_minus,
  [SpatialSkeletonDisplayNodeType.VIRTUAL_END]: svg_circle,
};

const NODE_TYPE_LABELS: Record<SpatialSkeletonDisplayNodeType, string> = {
  [SpatialSkeletonDisplayNodeType.ROOT]: "root",
  [SpatialSkeletonDisplayNodeType.BRANCH_START]: "branch start",
  [SpatialSkeletonDisplayNodeType.REGULAR]: "regular",
  [SpatialSkeletonDisplayNodeType.VIRTUAL_END]: "virtual end",
};

export class SpatialSkeletonEditTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-spatial-skeleton-tab");

    const toolbox = document.createElement("div");
    toolbox.className =
      "neuroglancer-segmentation-toolbox neuroglancer-spatial-skeleton-toolbar";
    toolbox.appendChild(
      makeToolButton(this, layer.toolBinder, {
        toolJson: SPATIAL_SKELETON_EDIT_MODE_TOOL_ID,
        label: "Edit",
        title: "Toggle skeleton node edit mode",
      }),
    );
    toolbox.appendChild(
      makeToolButton(this, layer.toolBinder, {
        toolJson: SPATIAL_SKELETON_MERGE_MODE_TOOL_ID,
        label: "Merge",
        title: "Toggle skeleton merge mode",
      }),
    );
    toolbox.appendChild(
      makeToolButton(this, layer.toolBinder, {
        toolJson: SPATIAL_SKELETON_SPLIT_MODE_TOOL_ID,
        label: "Split",
        title: "Toggle skeleton split mode",
      }),
    );
    const toolbarActions = document.createElement("div");
    toolbarActions.className = "neuroglancer-spatial-skeleton-toolbar-actions";

    const makeIconButton = (
      parent: HTMLElement,
      svg: string,
      title: string,
      onClick: () => void,
    ) => {
      const button = document.createElement("button");
      button.className = "neuroglancer-spatial-skeleton-icon-button";
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
          await undoSpatialSkeletonCommand(layer);
        } catch (error) {
          showSpatialSkeletonActionError("undo", error);
        }
      })();
    });
    const redoButton = makeIconButton(toolbarActions, svg_redo, "Redo", () => {
      if (redoButton.disabled) return;
      void (async () => {
        try {
          await redoSpatialSkeletonCommand(layer);
        } catch (error) {
          showSpatialSkeletonActionError("redo", error);
        }
      })();
    });
    toolbox.appendChild(toolbarActions);

    const navTools = document.createElement("div");
    navTools.className = "neuroglancer-spatial-skeleton-nav-tools";

    const nodesSection = document.createElement("div");
    nodesSection.className = "neuroglancer-spatial-skeleton-section";
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.placeholder = "Enter node ID or description";
    filterInput.className = "neuroglancer-spatial-skeleton-filter";
    const nodeQuery = layer.displayState.spatialSkeletonNodeQuery;
    const nodeFilterTypeModel = layer.displayState.spatialSkeletonNodeFilter;
    filterInput.value = nodeQuery.value;
    const nodeFilterTypeWidget = this.registerDisposer(
      new EnumSelectWidget(nodeFilterTypeModel),
    );
    nodeFilterTypeWidget.element.classList.add(
      "neuroglancer-layer-control-control",
      "neuroglancer-spatial-skeleton-filter-select",
    );
    nodeFilterTypeWidget.element.title = "Filter loaded nodes by node type";
    nodeFilterTypeWidget.element.setAttribute(
      "aria-label",
      nodeFilterTypeWidget.element.title,
    );
    for (const option of nodeFilterTypeWidget.element.options) {
      option.textContent = getSpatialSkeletonNodeFilterLabel(
        nodeFilterTypeModel.enumType[
          option.value.toUpperCase()
        ] as SpatialSkeletonNodeFilterType,
      );
    }
    const nodeFilterTypeRow = document.createElement("label");
    nodeFilterTypeRow.className = "neuroglancer-spatial-skeleton-filter-row";
    const nodeFilterTypeLabel = document.createElement("span");
    nodeFilterTypeLabel.className =
      "neuroglancer-spatial-skeleton-filter-label";
    nodeFilterTypeLabel.textContent = "Filter";
    nodeFilterTypeRow.appendChild(nodeFilterTypeLabel);
    nodeFilterTypeRow.appendChild(nodeFilterTypeWidget.element);
    const nodesNavigationBar = document.createElement("div");
    nodesNavigationBar.className =
      "neuroglancer-spatial-skeleton-navigation-bar";
    const nodesSummaryBar = document.createElement("div");
    nodesSummaryBar.className = "neuroglancer-spatial-skeleton-summary-bar";
    const nodesSummary = document.createElement("div");
    nodesSummary.className = "neuroglancer-spatial-skeleton-summary";
    let virtualItems: SpatialSkeletonListItem[] = [];
    let renderVirtualListItem = (
      _item: SpatialSkeletonListItem | undefined,
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
    nodesList.element.className = "neuroglancer-spatial-skeleton-tree";
    nodesSection.appendChild(filterInput);
    nodesSection.appendChild(nodeFilterTypeRow);
    nodesNavigationBar.appendChild(navTools);
    nodesSection.appendChild(nodesNavigationBar);
    nodesSummaryBar.appendChild(nodesSummary);
    nodesSection.appendChild(nodesSummaryBar);
    nodesSection.appendChild(nodesList.element);
    element.appendChild(nodesSection);

    let allNodes: SpatiallyIndexedSkeletonNode[] = [];
    let activeSegmentId: number | undefined;
    let nodesBySegment = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    let inspectionAllowed = false;
    let navigationAllowed = false;
    let trueEndEditingAllowed = false;
    let nodeDeletionAllowed = false;
    let nodeRerootAllowed = false;
    let pendingScrollToSelectedNode = false;
    let loadedNodeSummarySuffix = "";
    let hoveredViewerNodeId: number | undefined;
    let hoveredListNodeId: number | undefined;
    const pendingDeleteNodes = new Set<number>();
    const pendingRerootNodes = new Set<number>();
    const pendingTrueEndNodes = new Set<number>();
    const listIndexByNodeId = new Map<number, number>();
    const skeletonState = layer.spatialSkeletonState;
    const navigationGraphCache = new Map<
      number,
      {
        nodes: readonly SpatiallyIndexedSkeletonNode[];
        graph: SpatiallyIndexedSkeletonNavigationGraph;
      }
    >();
    const segmentColorScratch = new Float32Array(4);

    const getSkeletonTransform = () => {
      const transform =
        layer.getSpatiallyIndexedSkeletonLayer()?.displayState.transform.value;
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
        const rank = transform.rank;
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

    const getSelectedNode = () => {
      const selectedId = layer.selectedSpatialSkeletonNodeId.value;
      if (selectedId === undefined) return undefined;
      return allNodes.find((node) => node.nodeId === selectedId);
    };

    const getFilterText = () => nodeQuery.value.trim().toLowerCase();

    const ensureActionsAllowed = (
      requiredActions: SpatialSkeletonAction | readonly SpatialSkeletonAction[],
      options: {
        requireVisibleChunks?: boolean;
      } = {},
    ) => {
      const reason = layer.getSpatialSkeletonActionsDisabledReason(
        requiredActions,
        options,
      );
      if (reason !== undefined) {
        StatusMessage.showTemporaryMessage(reason);
        return false;
      }
      return true;
    };

    const selectNode = (
      node: SpatiallyIndexedSkeletonNode | undefined,
      options: {
        moveView?: boolean;
        pin?: boolean;
      } = {},
    ) => {
      if (node === undefined) return;
      const moveView = options.moveView ?? false;
      const pin = options.pin ?? false;
      pendingScrollToSelectedNode = true;
      layer.selectSpatialSkeletonNode(node.nodeId, pin, {
        segmentId: node.segmentId,
        position: node.position,
      });
      if (moveView) {
        moveViewToNodePosition(node.position);
      }
      applyRowInteractionState({ scrollSelectedIntoView: true });
    };

    const moveViewToNodePosition = (position: ArrayLike<number>) => {
      layer.moveViewToSpatialSkeletonNodePosition(position);
    };

    const getNavigationNode = (nodeId: number) => {
      return skeletonState.getCachedNode(nodeId);
    };

    const getSegmentNavigationNodes = (segmentId: number) => {
      return (
        nodesBySegment.get(segmentId) ??
        skeletonState.getCachedSegmentNodes(segmentId)
      );
    };

    const getSegmentNavigationGraph = (segmentId: number) => {
      const segmentNodes = getSegmentNavigationNodes(segmentId);
      if (segmentNodes === undefined || segmentNodes.length === 0) {
        throw new Error(
          `Skeleton graph for segment ${segmentId} is not loaded yet.`,
        );
      }
      const cached = navigationGraphCache.get(segmentId);
      if (cached !== undefined && cached.nodes === segmentNodes) {
        return cached.graph;
      }
      const graph = buildSpatiallyIndexedSkeletonNavigationGraph(segmentNodes);
      navigationGraphCache.set(segmentId, {
        nodes: segmentNodes,
        graph,
      });
      return graph;
    };

    const getSegmentChipColors = (segmentId: number) => {
      const color = getBaseObjectColor(
        layer.displayState,
        BigInt(segmentId),
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
      segmentId: number,
    ) => {
      const id = BigInt(segmentId);
      const hasSegmentSelectionModifiers = (event: MouseEvent) =>
        event.ctrlKey && !event.altKey && !event.metaKey;
      element.addEventListener("mousedown", (event: MouseEvent) => {
        if (event.button !== 2 || !hasSegmentSelectionModifiers(event)) {
          return;
        }
        layer.selectSegment(id, event.shiftKey ? "force-unpin" : true);
        event.preventDefault();
        event.stopPropagation();
      });
      element.addEventListener("contextmenu", (event: MouseEvent) => {
        if (!hasSegmentSelectionModifiers(event)) return;
        if (event.button !== 2) {
          layer.selectSegment(id, event.shiftKey ? "force-unpin" : true);
        }
        event.preventDefault();
        event.stopPropagation();
      });
    };

    const getSegmentSelectionTitle = (segmentId: number) =>
      `segment ${segmentId}\n` +
      "Ctrl+right-click to pin selection\n" +
      "Ctrl+shift+right-click to unpin";

    const getNodeDescriptionText = (node: SpatiallyIndexedSkeletonNode) =>
      layer.getSpatialSkeletonNodeDisplayDescription(node);

    const getHoveredNodeIdFromViewer = () => {
      return layer.hoveredSpatialSkeletonNodeId.value;
    };

    const getSelectedSegmentId = () => {
      const layerSelectionState =
        layer.manager.root.selectionState.value?.layers.find(
          (entry) => entry.layer === layer,
        )?.state;
      return getSegmentIdFromLayerSelectionValue(layerSelectionState);
    };

    const addVisibleSegmentIds = (segmentIds: Set<number>) => {
      const visibleSegments = getVisibleSegments(
        layer.displayState.segmentationGroupState.value,
      );
      for (const segmentId of visibleSegments.keys()) {
        const normalizedSegmentId = Number(segmentId);
        if (
          Number.isSafeInteger(normalizedSegmentId) &&
          normalizedSegmentId > 0
        ) {
          segmentIds.add(normalizedSegmentId);
        }
      }
    };

    const scrollListItemIntoView = (index: number) => {
      if (nodesList.getItemElement(index) !== undefined) {
        nodesList.scrollItemIntoView(index);
        return;
      }
      nodesList.state.anchorIndex = index;
      nodesList.state.anchorClientOffset = 0;
      virtualListRenderChanged.dispatch();
    };

    const applyRowInteractionState = (
      options: { scrollSelectedIntoView?: boolean } = {},
    ) => {
      const selectedNodeId = layer.selectedSpatialSkeletonNodeId.value;
      nodesList.forEachRenderedItem((entry, index) => {
        const item = virtualItems[index];
        if (item?.kind !== "node") return;
        const { nodeId } = item.row.node;
        const isSelected = nodeId === selectedNodeId;
        const isHovered = nodeId === hoveredViewerNodeId;
        const isListHovered = nodeId === hoveredListNodeId;
        entry.dataset.selected = String(isSelected);
        entry.dataset.viewerHovered = String(isHovered);
        entry.dataset.listHovered = String(isListHovered);
      });
      if (options.scrollSelectedIntoView) {
        pendingScrollToSelectedNode = false;
        const selectedIndex =
          selectedNodeId === undefined
            ? undefined
            : listIndexByNodeId.get(selectedNodeId);
        if (selectedIndex !== undefined) {
          scrollListItemIntoView(selectedIndex);
        }
      }
    };

    const updateHoveredViewerNode = () => {
      const nextHoveredNodeId = getHoveredNodeIdFromViewer();
      if (hoveredViewerNodeId === nextHoveredNodeId) return;
      hoveredViewerNodeId = nextHoveredNodeId;
      applyRowInteractionState();
    };

    const updateHoveredListNode = (nextHoveredNodeId: number | undefined) => {
      if (hoveredListNodeId === nextHoveredNodeId) return;
      hoveredListNodeId = nextHoveredNodeId;
      applyRowInteractionState();
    };

    const skeletonNavigationApi: SpatiallyIndexedSkeletonNavigationApi = {
      async getSkeletonRootNode(skeletonId: number) {
        return getSkeletonRootNodeFromGraph(
          getSegmentNavigationGraph(skeletonId),
        );
      },
      async getBranchStart(nodeId: number) {
        const node = getNavigationNode(nodeId);
        if (node === undefined) {
          throw new Error(
            `Node ${nodeId} is not available in the loaded skeleton cache.`,
          );
        }
        return getBranchStartFromGraph(
          getSegmentNavigationGraph(node.segmentId),
          nodeId,
        );
      },
      async getBranchEnd(nodeId: number) {
        const node = getNavigationNode(nodeId);
        if (node === undefined) {
          throw new Error(
            `Node ${nodeId} is not available in the loaded skeleton cache.`,
          );
        }
        return getBranchEndFromGraph(
          getSegmentNavigationGraph(node.segmentId),
          nodeId,
        );
      },
      async getNextCollapsedLevelNode(nodeId: number) {
        const node = getNavigationNode(nodeId);
        if (node === undefined) {
          throw new Error(
            `Node ${nodeId} is not available in the loaded skeleton cache.`,
          );
        }
        return getNextCollapsedLevelNodeFromGraph(
          getSegmentNavigationGraph(node.segmentId),
          nodeId,
        );
      },
      async getOpenLeaves(skeletonId: number, nodeId: number) {
        return getOpenLeavesFromGraph(
          getSegmentNavigationGraph(skeletonId),
          nodeId,
        );
      },
      async getParentNode(nodeId: number) {
        const node = getNavigationNode(nodeId);
        if (node === undefined) {
          throw new Error(
            `Node ${nodeId} is not available in the loaded skeleton cache.`,
          );
        }
        return getParentNodeFromGraph(
          getSegmentNavigationGraph(node.segmentId),
          nodeId,
        );
      },
      async getChildNode(nodeId: number) {
        const node = getNavigationNode(nodeId);
        if (node === undefined) {
          throw new Error(
            `Node ${nodeId} is not available in the loaded skeleton cache.`,
          );
        }
        return getRandomChildNodeFromGraph(
          getSegmentNavigationGraph(node.segmentId),
          nodeId,
        );
      },
    };

    const navigateToNodeTarget = (
      target: SpatiallyIndexedSkeletonNavigationTarget,
    ) => {
      const existingNode = allNodes.find(
        (node) => node.nodeId === target.nodeId,
      );
      if (existingNode !== undefined) {
        selectNode(existingNode, { moveView: true, pin: true });
        return;
      }
      pendingScrollToSelectedNode = true;
      const position = target.position;
      layer.selectSpatialSkeletonNode(target.nodeId, true, { position });
      moveViewToNodePosition(position);
      updateDisplay();
    };

    const getSelectedNavigationContext = () => {
      if (
        !ensureActionsAllowed(SpatialSkeletonActions.inspect, {
          requireVisibleChunks: false,
        })
      ) {
        return undefined;
      }
      const selectedNode = getSelectedNode();
      if (selectedNode === undefined) {
        StatusMessage.showTemporaryMessage("No skeleton node is selected.");
        return undefined;
      }
      try {
        getSegmentNavigationGraph(selectedNode.segmentId);
        return { selectedNode, skeletonApi: skeletonNavigationApi };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        StatusMessage.showTemporaryMessage(
          `Unable to resolve the local skeleton graph for navigation: ${message}`,
        );
        return undefined;
      }
    };

    const updateTrueEndLabel = (
      node: SpatiallyIndexedSkeletonNode,
      present: boolean,
    ) => {
      if (!ensureActionsAllowed(SpatialSkeletonActions.editNodeTrueEnd)) return;
      if (pendingTrueEndNodes.has(node.nodeId)) return;
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
          await executeSpatialSkeletonNodeTrueEndUpdate(layer, {
            node: currentNode,
            nextIsTrueEnd: present,
          });
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

    const goToClosestUnfinishedBranch = () => {
      const context = getSelectedNavigationContext();
      if (context === undefined) return;
      const { selectedNode, skeletonApi } = context;
      void (async () => {
        try {
          const openLeaves = await skeletonApi.getOpenLeaves(
            selectedNode.segmentId,
            selectedNode.nodeId,
          );
          if (openLeaves.length === 0) {
            StatusMessage.showTemporaryMessage(
              "No unfinished branch was found in the current skeleton.",
            );
            return;
          }
          openLeaves.sort((a, b) =>
            a.distance === b.distance
              ? a.nodeId - b.nodeId
              : a.distance - b.distance,
          );
          navigateToNodeTarget(openLeaves[0]);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          StatusMessage.showTemporaryMessage(
            `Failed to locate unfinished branch: ${message}`,
          );
        }
      })();
    };

    const deleteNode = (node: SpatiallyIndexedSkeletonNode) => {
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
          await executeSpatialSkeletonDeleteNode(layer, node);
          refreshNodes();
        } catch (error) {
          showSpatialSkeletonActionError("delete node", error);
          updateDisplay();
        } finally {
          pendingDeleteNodes.delete(node.nodeId);
          updateDisplay();
        }
      })();
    };

    const rerootNode = (node: SpatiallyIndexedSkeletonNode) => {
      if (
        !ensureActionsAllowed(SpatialSkeletonActions.reroot, {
          requireVisibleChunks: false,
        })
      ) {
        return;
      }
      if (node.parentNodeId === undefined) {
        StatusMessage.showTemporaryMessage("Selected node is already root.");
        return;
      }
      if (pendingRerootNodes.has(node.nodeId)) {
        return;
      }
      pendingRerootNodes.add(node.nodeId);
      updateDisplay();
      void (async () => {
        try {
          await layer.rerootSpatialSkeletonNode(node);
        } catch (error) {
          showSpatialSkeletonActionError("set node as root", error);
        } finally {
          pendingRerootNodes.delete(node.nodeId);
          updateDisplay();
        }
      })();
    };

    const goRootButton = makeIconButton(
      navTools,
      svg_origin,
      "Go to root",
      () => {
        const context = getSelectedNavigationContext();
        if (context === undefined) return;
        const { selectedNode, skeletonApi } = context;
        void (async () => {
          try {
            navigateToNodeTarget(
              await skeletonApi.getSkeletonRootNode(selectedNode.segmentId),
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            StatusMessage.showTemporaryMessage(
              `Failed to locate skeleton root: ${message}`,
            );
          }
        })();
      },
    );
    const goBranchStartButton = makeIconButton(
      navTools,
      svg_chevrons_left,
      "Go to start of the branch",
      () => {
        const context = getSelectedNavigationContext();
        if (context === undefined) return;
        const { selectedNode, skeletonApi } = context;
        void (async () => {
          try {
            navigateToNodeTarget(
              await skeletonApi.getBranchStart(selectedNode.nodeId),
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            StatusMessage.showTemporaryMessage(
              `Failed to locate branch start: ${message}`,
            );
          }
        })();
      },
    );
    const goTreeEndButton = makeIconButton(
      navTools,
      svg_chevrons_right,
      "Go to end of the branch",
      () => {
        const context = getSelectedNavigationContext();
        if (context === undefined) return;
        const { selectedNode, skeletonApi } = context;
        void (async () => {
          try {
            navigateToNodeTarget(
              await skeletonApi.getBranchEnd(selectedNode.nodeId),
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            StatusMessage.showTemporaryMessage(
              `Failed to locate branch end: ${message}`,
            );
          }
        })();
      },
    );
    const cycleBranchesButton = makeIconButton(
      navTools,
      svg_retweet,
      "Cycle through level nodes",
      () => {
        const context = getSelectedNavigationContext();
        if (context === undefined) return;
        const { selectedNode, skeletonApi } = context;
        void (async () => {
          try {
            navigateToNodeTarget(
              await skeletonApi.getNextCollapsedLevelNode(selectedNode.nodeId),
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            StatusMessage.showTemporaryMessage(
              `Failed to cycle through level nodes: ${message}`,
            );
          }
        })();
      },
    );
    const goParentButton = makeIconButton(
      navTools,
      svg_arrow_left,
      "Go to parent",
      () => {
        const context = getSelectedNavigationContext();
        if (context === undefined) return;
        const { selectedNode, skeletonApi } = context;
        void (async () => {
          try {
            const target = await skeletonApi.getParentNode(selectedNode.nodeId);
            if (target === undefined) {
              StatusMessage.showTemporaryMessage(
                "Selected node has no parent.",
              );
              return;
            }
            navigateToNodeTarget(target);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            StatusMessage.showTemporaryMessage(
              `Failed to locate parent node: ${message}`,
            );
          }
        })();
      },
    );
    const goChildButton = makeIconButton(
      navTools,
      svg_arrow_right,
      "Go to child",
      () => {
        const context = getSelectedNavigationContext();
        if (context === undefined) return;
        const { selectedNode, skeletonApi } = context;
        void (async () => {
          try {
            const target = await skeletonApi.getChildNode(selectedNode.nodeId);
            if (target === undefined) {
              StatusMessage.showTemporaryMessage("Selected node has no child.");
              return;
            }
            navigateToNodeTarget(target);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            StatusMessage.showTemporaryMessage(
              `Failed to locate child node: ${message}`,
            );
          }
        })();
      },
    );
    const goUnfinishedBranchButton = makeIconButton(
      navTools,
      svg_chevron_right,
      "Go to unfinished node",
      () => {
        goToClosestUnfinishedBranch();
      },
    );
    element.insertBefore(toolbox, nodesSection);

    const gatedControls = [
      goRootButton,
      goBranchStartButton,
      goTreeEndButton,
      cycleBranchesButton,
      goParentButton,
      goChildButton,
      goUnfinishedBranchButton,
    ];

    const makeRowActionButton = (
      svg: string,
      title: string,
      onClick: () => void,
      disabled: boolean,
    ) => {
      const button = document.createElement("button");
      button.className = "neuroglancer-spatial-skeleton-node-action";
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

    const getSegmentDisplayLabel = (segmentId: number) => {
      const segmentationGroupState =
        layer.displayState.segmentationGroupState.value;
      const segmentPropertyMap =
        segmentationGroupState.segmentPropertyMap.value;
      if (segmentPropertyMap === undefined) {
        return undefined;
      }
      const mappedSegmentId = getSegmentEquivalences(
        segmentationGroupState,
      ).get(BigInt(segmentId));
      return segmentPropertyMap.getSegmentLabel(mappedSegmentId);
    };

    const buildSegmentDisplayState = (): SegmentDisplayState | undefined => {
      const segmentId = activeSegmentId;
      if (segmentId === undefined) return undefined;
      const segmentNodes = nodesBySegment.get(segmentId) ?? [];
      const renderState =
        segmentNodes.length === 0
          ? {
              segmentId,
              totalNodeCount: 0,
              matchedNodeCount: 0,
              displayedNodeCount: 0,
              branchCount: 0,
              rows: [],
            }
          : buildSpatialSkeletonSegmentRenderState(
              segmentId,
              getSegmentNavigationGraph(segmentId),
              {
                filterText: getFilterText(),
                nodeFilterType: nodeFilterTypeModel.value,
                getNodeDescription: getNodeDescriptionText,
              },
            );
      return {
        ...renderState,
        segmentLabel: getSegmentDisplayLabel(segmentId),
      };
    };

    const makeListHeader = () => {
      const listHeader = document.createElement("div");
      listHeader.className = "neuroglancer-spatial-skeleton-list-header";
      const headerActionsSpacer = document.createElement("span");
      headerActionsSpacer.className =
        "neuroglancer-spatial-skeleton-list-header-spacer neuroglancer-spatial-skeleton-list-header-actions";
      const headerTypeSpacer = document.createElement("span");
      headerTypeSpacer.className =
        "neuroglancer-spatial-skeleton-list-header-spacer neuroglancer-spatial-skeleton-list-header-type";
      const headerId = document.createElement("span");
      headerId.className = "neuroglancer-spatial-skeleton-list-header-cell";
      headerId.textContent = "id";
      const headerCoordinates = document.createElement("span");
      headerCoordinates.className =
        "neuroglancer-spatial-skeleton-list-header-cell neuroglancer-spatial-skeleton-coordinates-flex";
      for (const dimLabel of getCoordinateDimensionHeaders()) {
        const dimSpan = document.createElement("span");
        dimSpan.className = "neuroglancer-spatial-skeleton-coord-dim";
        dimSpan.textContent = dimLabel;
        headerCoordinates.appendChild(dimSpan);
      }
      listHeader.appendChild(headerActionsSpacer);
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
        "neuroglancer-spatial-skeleton-tree-entry neuroglancer-spatial-skeleton-segment-entry";
      const segmentRow = document.createElement("div");
      segmentRow.className =
        "neuroglancer-spatial-skeleton-tree-row neuroglancer-spatial-skeleton-segment-row";
      const segmentActionsSpacer = document.createElement("span");
      segmentActionsSpacer.className =
        "neuroglancer-spatial-skeleton-list-header-spacer neuroglancer-spatial-skeleton-list-header-actions";
      const segmentTypeSpacer = document.createElement("span");
      segmentTypeSpacer.className =
        "neuroglancer-spatial-skeleton-list-header-spacer neuroglancer-spatial-skeleton-list-header-type";
      const segmentIdCell = document.createElement("span");
      segmentIdCell.className = "neuroglancer-spatial-skeleton-node-id";
      const segmentChip = document.createElement("span");
      segmentChip.className = "neuroglancer-spatial-skeleton-node-segment-chip";
      const segmentChipColors = getSegmentChipColors(segmentState.segmentId);
      segmentChip.textContent = String(segmentState.segmentId);
      segmentChip.style.backgroundColor = segmentChipColors.background;
      segmentChip.style.color = segmentChipColors.foreground;
      segmentChip.title = getSegmentSelectionTitle(segmentState.segmentId);
      bindSegmentSelectionControls(segmentChip, segmentState.segmentId);
      segmentIdCell.appendChild(segmentChip);
      const segmentMeta = document.createElement("div");
      segmentMeta.className =
        "neuroglancer-spatial-skeleton-node-coordinate-cell neuroglancer-spatial-skeleton-segment-meta";
      const segmentMetaLine = document.createElement("div");
      segmentMetaLine.className =
        "neuroglancer-spatial-skeleton-segment-meta-line";
      const segmentName = document.createElement("span");
      segmentName.className = "neuroglancer-spatial-skeleton-segment-name";
      segmentName.textContent = segmentState.segmentLabel ?? "";
      const segmentRatio = document.createElement("span");
      segmentRatio.className = "neuroglancer-spatial-skeleton-segment-ratio";
      segmentRatio.textContent = `${segmentState.displayedNodeCount}/${segmentState.totalNodeCount}`;
      segmentMetaLine.appendChild(segmentName);
      segmentMetaLine.appendChild(segmentRatio);
      segmentMeta.appendChild(segmentMetaLine);
      segmentRow.appendChild(segmentActionsSpacer);
      segmentRow.appendChild(segmentTypeSpacer);
      segmentRow.appendChild(segmentIdCell);
      segmentRow.appendChild(segmentMeta);
      segmentEntry.appendChild(segmentRow);
      return segmentEntry;
    };

    const makeNodeEntry = (rowInfo: SpatialSkeletonSegmentRenderRow) => {
      const { node, type, isLeaf } = rowInfo;
      const entry = document.createElement("div");
      entry.className = "neuroglancer-spatial-skeleton-tree-entry";
      entry.dataset.selected = String(
        node.nodeId === layer.selectedSpatialSkeletonNodeId.value,
      );
      entry.dataset.viewerHovered = String(node.nodeId === hoveredViewerNodeId);
      entry.dataset.listHovered = String(node.nodeId === hoveredListNodeId);
      entry.addEventListener("mouseenter", () => {
        updateHoveredListNode(node.nodeId);
      });
      entry.addEventListener("mouseleave", () => {
        updateHoveredListNode(undefined);
      });

      const row = document.createElement("div");
      row.className = "neuroglancer-spatial-skeleton-tree-row";
      row.dataset.nodeType = type;
      if (inspectionAllowed) {
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.title =
          "Click to move to node and pin selection. Right-click to move to node. Ctrl+right-click to pin selection without moving.";
        row.addEventListener("click", (event: MouseEvent) => {
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            target.closest(
              ".neuroglancer-spatial-skeleton-node-actions, .neuroglancer-spatial-skeleton-node-type-toggle",
            ) !== null
          ) {
            return;
          }
          if (
            !ensureActionsAllowed(SpatialSkeletonActions.inspect, {
              requireVisibleChunks: false,
            })
          ) {
            return;
          }
          selectNode(node, { moveView: true, pin: true });
        });
        row.addEventListener("contextmenu", (event: MouseEvent) => {
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            target.closest(
              ".neuroglancer-spatial-skeleton-node-actions, .neuroglancer-spatial-skeleton-node-type-toggle",
            ) !== null
          ) {
            return;
          }
          event.preventDefault();
          if (
            !ensureActionsAllowed(SpatialSkeletonActions.inspect, {
              requireVisibleChunks: false,
            })
          ) {
            return;
          }
          if (event.ctrlKey || event.metaKey) {
            selectNode(node, { moveView: false, pin: true });
            return;
          }
          moveViewToNodePosition(node.position);
        });
        row.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (
            !ensureActionsAllowed(SpatialSkeletonActions.inspect, {
              requireVisibleChunks: false,
            })
          ) {
            return;
          }
          selectNode(node, { moveView: true, pin: true });
        });
      } else {
        row.setAttribute("aria-disabled", "true");
      }

      const nodeIsTrueEnd = node.isTrueEnd ?? false;
      const iconFilterType = getSpatialSkeletonNodeIconFilterType({
        nodeIsTrueEnd,
        nodeType: type,
      });
      const typeIconSvg =
        iconFilterType === SpatialSkeletonNodeFilterType.TRUE_END
          ? svg_flag
          : iconFilterType === SpatialSkeletonNodeFilterType.VIRTUAL_END
            ? svg_circle
            : NODE_TYPE_ICONS[type];
      const typeIconTitle =
        iconFilterType !== undefined
          ? getSpatialSkeletonNodeFilterLabel(iconFilterType).toLowerCase()
          : NODE_TYPE_LABELS[type];
      const typeButtonPending = pendingTrueEndNodes.has(node.nodeId);
      const typeButtonTitle = typeButtonPending
        ? nodeIsTrueEnd
          ? "removing true end"
          : "setting true end"
        : typeIconTitle;
      const typeIcon =
        isLeaf || nodeIsTrueEnd
          ? document.createElement("button")
          : document.createElement("span");
      typeIcon.className =
        isLeaf || nodeIsTrueEnd
          ? "neuroglancer-spatial-skeleton-node-type-toggle"
          : "neuroglancer-spatial-skeleton-node-type";
      typeIcon.title = typeButtonTitle;
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
          title: typeButtonTitle,
          clickable: false,
        }),
      );

      const idCell = document.createElement("span");
      idCell.className = "neuroglancer-spatial-skeleton-node-id";
      idCell.textContent = String(node.nodeId);

      const coordinatesCell = document.createElement("div");
      coordinatesCell.className =
        "neuroglancer-spatial-skeleton-node-coordinate-cell";
      const coordinatesLine = document.createElement("div");
      coordinatesLine.className =
        "neuroglancer-spatial-skeleton-node-coordinates neuroglancer-spatial-skeleton-coordinates-flex";
      for (const val of formatNodeCoordinates(node.position)) {
        const valSpan = document.createElement("span");
        valSpan.className = "neuroglancer-spatial-skeleton-coord-dim";
        valSpan.textContent = val;
        coordinatesLine.appendChild(valSpan);
      }
      coordinatesCell.appendChild(coordinatesLine);
      const description = getNodeDescriptionText(node);
      if (description !== undefined) {
        const descriptionLine = document.createElement("div");
        descriptionLine.className =
          "neuroglancer-spatial-skeleton-node-description";
        descriptionLine.textContent = description;
        coordinatesCell.appendChild(descriptionLine);
      }

      const actions = document.createElement("div");
      actions.className = "neuroglancer-spatial-skeleton-node-actions";
      let rerootActionTitle =
        node.parentNodeId === undefined ? "already root" : "set as root";
      if (pendingRerootNodes.has(node.nodeId)) {
        rerootActionTitle = "setting root";
      }
      actions.appendChild(
        makeRowActionButton(
          svg_origin,
          rerootActionTitle,
          () => rerootNode(node),
          !nodeRerootAllowed ||
            pendingRerootNodes.has(node.nodeId) ||
            node.parentNodeId === undefined,
        ),
      );
      let deleteActionTitle = "delete node";
      if (pendingDeleteNodes.has(node.nodeId)) {
        deleteActionTitle = "deleting node";
      }
      actions.appendChild(
        makeRowActionButton(
          svg_bin,
          deleteActionTitle,
          () => deleteNode(node),
          !nodeDeletionAllowed || pendingDeleteNodes.has(node.nodeId),
        ),
      );

      row.appendChild(actions);
      row.appendChild(typeIcon);
      row.appendChild(idCell);
      row.appendChild(coordinatesCell);
      entry.appendChild(row);
      return entry;
    };

    const makeEmptyEntry = (text: string) => {
      const empty = document.createElement("div");
      empty.className = "neuroglancer-spatial-skeleton-summary";
      empty.textContent = text;
      return empty;
    };

    renderVirtualListItem = (item: SpatialSkeletonListItem | undefined) => {
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

    const getListItemKey = (item: SpatialSkeletonListItem) => {
      switch (item.kind) {
        case "segment":
          return `segment:${item.segmentState.segmentId}`;
        case "node":
          return `node:${item.row.node.nodeId}`;
        case "empty":
          return `empty:${item.text}`;
      }
    };

    const setVirtualItems = (nextItems: SpatialSkeletonListItem[]) => {
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

    const getEmptyListText = (
      segmentState: SegmentDisplayState | undefined,
    ) => {
      if (activeSegmentId === undefined) {
        return "Select a skeleton segment to inspect editable nodes.";
      }
      if (
        segmentState === undefined ||
        segmentState.totalNodeCount === 0 ||
        (getFilterText().length === 0 &&
          nodeFilterTypeModel.value === SpatialSkeletonNodeFilterType.NONE)
      ) {
        return "No loaded nodes.";
      }
      return "No matching nodes.";
    };

    const updateList = (segmentState: SegmentDisplayState | undefined) => {
      const flattened = buildSpatialSkeletonVirtualListItems(
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
      const segmentState = buildSegmentDisplayState();
      summarizeNodeState(segmentState, summarySuffix);
      updateList(segmentState);
    };

    const applyNodesBySegment = (
      nextNodesBySegment: Map<number, SpatiallyIndexedSkeletonNode[]>,
      summarySuffix = "",
    ) => {
      loadedNodeSummarySuffix = summarySuffix;
      navigationGraphCache.clear();
      nodesBySegment = nextNodesBySegment;
      const allNodesById = new Map<number, SpatiallyIndexedSkeletonNode>();
      for (const segmentNodes of nextNodesBySegment.values()) {
        for (const node of segmentNodes) {
          if (!allNodesById.has(node.nodeId)) {
            allNodesById.set(node.nodeId, node);
          }
        }
      }
      allNodes = [...allNodesById.values()].sort((a, b) =>
        a.segmentId === b.segmentId
          ? a.nodeId - b.nodeId
          : a.segmentId - b.segmentId,
      );
      updateDisplay(summarySuffix);
    };

    const refreshNodes = () => {
      const skeletonLayer = layer.getSpatiallyIndexedSkeletonLayer();
      const selectedSegmentId = getSelectedSegmentId();
      const cachedSelectedSegmentNodes =
        selectedSegmentId === undefined
          ? undefined
          : skeletonState.getCachedSegmentNodes(selectedSegmentId);
      activeSegmentId =
        cachedSelectedSegmentNodes === undefined
          ? undefined
          : selectedSegmentId;
      loadedNodeSummarySuffix = "";
      if (
        skeletonLayer === undefined ||
        activeSegmentId === undefined ||
        cachedSelectedSegmentNodes === undefined
      ) {
        allNodes = [];
        nodesBySegment = new Map();
        navigationGraphCache.clear();
        updateDisplay();
        return;
      }
      allNodes = [];
      nodesBySegment = new Map();
      navigationGraphCache.clear();
      updateDisplay();

      const segmentId = activeSegmentId;
      const cachedSegmentIds = new Set<number>([segmentId]);
      addVisibleSegmentIds(cachedSegmentIds);
      for (const retainedSegmentId of skeletonLayer.getRetainedOverlaySegmentIds()) {
        cachedSegmentIds.add(retainedSegmentId);
      }
      skeletonState.evictInactiveSegmentNodes(cachedSegmentIds);
      applyNodesBySegment(
        new Map<number, SpatiallyIndexedSkeletonNode[]>([
          [segmentId, cachedSelectedSegmentNodes],
        ]),
        " Using inspected full skeleton data.",
      );
    };

    const updateGateStatus = () => {
      const nextInspectionAllowed =
        layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.inspect,
          {
            requireVisibleChunks: false,
          },
        ) === undefined;
      const nextNavigationAllowed = nextInspectionAllowed;
      const nextTrueEndEditingAllowed =
        layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.editNodeTrueEnd,
        ) === undefined;
      const nextNodeDeletionAllowed =
        layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.deleteNodes,
        ) === undefined;
      const nextNodeRerootAllowed =
        layer.getSpatialSkeletonActionsDisabledReason(
          SpatialSkeletonActions.reroot,
          {
            requireVisibleChunks: false,
          },
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
      nodeFilterTypeWidget.element.disabled = !inspectionAllowed;
      for (const control of gatedControls) {
        control.disabled = !navigationAllowed;
      }
      if (gateStateChanged) {
        updateDisplay();
      }
    };

    const updateHistoryButtons = () => {
      const { commandHistory } = layer.spatialSkeletonState;
      const undoLabel = commandHistory.undoLabel.value;
      const redoLabel = commandHistory.redoLabel.value;
      const busy = commandHistory.isBusy.value;
      undoButton.disabled = busy || !commandHistory.canUndo.value;
      redoButton.disabled = busy || !commandHistory.canRedo.value;
      undoButton.title = busy
        ? "Wait for the current skeleton edit to finish."
        : undoLabel === undefined
          ? "Nothing to undo."
          : `Undo ${undoLabel}`;
      redoButton.title = busy
        ? "Wait for the current skeleton edit to finish."
        : redoLabel === undefined
          ? "Nothing to redo."
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
      observeWatchable(() => updateGateStatus(), layer.spatialSkeletonEditMode),
    );
    this.registerDisposer(
      observeWatchable(
        () => updateGateStatus(),
        layer.spatialSkeletonMergeMode,
      ),
    );
    this.registerDisposer(
      observeWatchable(
        () => updateGateStatus(),
        layer.spatialSkeletonSplitMode,
      ),
    );
    this.registerDisposer(
      layer.spatialSkeletonVisibleChunksAvailable.changed.add(() => {
        updateGateStatus();
      }),
    );
    this.registerDisposer(
      layer.spatialSkeletonVisibleChunksNeeded.changed.add(() => {
        updateGateStatus();
      }),
    );
    this.registerDisposer(
      layer.layersChanged.add(() => {
        updateGateStatus();
      }),
    );
    this.registerDisposer(
      layer.spatialSkeletonState.commandHistory.canUndo.changed.add(() => {
        updateHistoryButtons();
      }),
    );
    this.registerDisposer(
      layer.spatialSkeletonState.commandHistory.canRedo.changed.add(() => {
        updateHistoryButtons();
      }),
    );
    this.registerDisposer(
      layer.spatialSkeletonState.commandHistory.isBusy.changed.add(() => {
        updateGateStatus();
        updateHistoryButtons();
      }),
    );
    this.registerDisposer(
      layer.spatialSkeletonState.commandHistory.undoLabel.changed.add(() => {
        updateHistoryButtons();
      }),
    );
    this.registerDisposer(
      layer.spatialSkeletonState.commandHistory.redoLabel.changed.add(() => {
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
    this.registerDisposer(
      layer.selectedSpatialSkeletonNodeId.changed.add(() => {
        pendingScrollToSelectedNode = true;
        applyRowInteractionState({ scrollSelectedIntoView: true });
      }),
    );
    this.registerDisposer(
      layer.hoveredSpatialSkeletonNodeId.changed.add(() => {
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
      layer.spatialSkeletonNodeDataVersion.changed.add(() => {
        refreshNodes();
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
