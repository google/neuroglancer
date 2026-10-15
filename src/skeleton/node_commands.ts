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

import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { getSegmentIdFromLayerSelectionValue } from "#src/layer/segmentation/selection.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import {
  SpatialSkeletonActions,
  SpatialSkeletonHistoryActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/command_protocol.js";
import {
  executeSpatialSkeletonNodeTrueEndUpdate,
  redoSpatialSkeletonCommand,
  showSpatialSkeletonActionError,
  undoSpatialSkeletonCommand,
} from "#src/skeleton/commands.js";
import {
  buildSpatiallyIndexedSkeletonNavigationGraph,
  getBranchEnd,
  getBranchStart,
  getNextCollapsedLevelNode,
  getOpenLeaves,
  getParentNode,
  getRandomChildNode,
  getSkeletonRootNode,
} from "#src/skeleton/navigation_graph.js";
import { isSkeletonNodeTrueEnd } from "#src/skeleton/node_attributes.js";
import { SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON } from "#src/skeleton/optimistic_edit/fatal.js";
import { StatusMessage } from "#src/status.js";
import { CallbackCommand } from "#src/ui/command.js";
import { bigintCompare } from "#src/util/bigint.js";
import { RefCounted } from "#src/util/disposable.js";
import type { Viewer } from "#src/viewer.js";

type SkeletonNodeViewer = Pick<
  Viewer,
  "commandRegistry" | "layerManager" | "selectedLayer" | "selectionDetailsState"
>;

type NavigationTarget = Pick<SkeletonNode, "nodeId" | "position">;

interface NavigationContext {
  readonly graph: ReturnType<
    typeof buildSpatiallyIndexedSkeletonNavigationGraph
  >;
  readonly nodeId: bigint | undefined;
}

interface SkeletonNodeCommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly requiredAction: SpatialSkeletonAction;
  readonly run: (
    layer: SegmentationUserLayer,
    viewer: SkeletonNodeViewer,
  ) => void | Promise<unknown>;
}

async function runHistoryCommand(
  layer: SegmentationUserLayer,
  history: "undo" | "redo",
) {
  if (layer.spatialSkeletonState.getOptimisticEditFatalState() !== undefined) {
    StatusMessage.showTemporaryMessage(
      SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON,
    );
    return;
  }
  const { action, execute } =
    history === "undo"
      ? {
          action: SpatialSkeletonHistoryActions.undo,
          execute: undoSpatialSkeletonCommand,
        }
      : {
          action: SpatialSkeletonHistoryActions.redo,
          execute: redoSpatialSkeletonCommand,
        };
  try {
    await execute(layer);
  } catch (error) {
    showSpatialSkeletonActionError(action, error);
  }
}

function requireSelectedInspectedNode(
  layer: SegmentationUserLayer,
): SkeletonNode | undefined {
  const selected = layer.selectedSpatialSkeletonNodeInfo.value;
  if (selected === undefined) {
    StatusMessage.showTemporaryMessage("No skeleton node is selected.");
    return undefined;
  }
  const { nodeId } = selected;
  const { spatialSkeletonState } = layer;
  const segmentId =
    spatialSkeletonState.getCachedNode(nodeId)?.segmentId ?? selected.segmentId;
  if (segmentId === undefined) {
    StatusMessage.showTemporaryMessage(
      `Unable to resolve the skeleton for node ${nodeId}.`,
    );
    return undefined;
  }
  const snapshot =
    spatialSkeletonState.getCachedSegmentSnapshotHandle(segmentId);
  if (snapshot === undefined) {
    StatusMessage.showTemporaryMessage(
      `Inspect skeleton ${segmentId} before editing it.`,
    );
    return undefined;
  }
  const node = snapshot.handle.getNode(nodeId);
  if (node === undefined) {
    StatusMessage.showTemporaryMessage(
      `Node ${nodeId} is not available in inspected skeleton ${segmentId}.`,
    );
  }
  return node;
}

function navigationContext(
  layer: SegmentationUserLayer,
  viewer: SkeletonNodeViewer,
): (NavigationContext & { segmentId: bigint }) | undefined {
  const nodeInfo = layer.selectedSpatialSkeletonNodeInfo.value;
  const cachedNode =
    nodeInfo?.nodeId !== undefined
      ? layer.spatialSkeletonState.getCachedNode(nodeInfo.nodeId)
      : undefined;
  const segmentId =
    cachedNode?.segmentId ??
    nodeInfo?.segmentId ??
    getSegmentIdFromLayerSelectionValue(
      viewer.selectionDetailsState.value?.layers.find(
        (entry) => entry.layer === layer,
      )?.state,
    );
  if (segmentId === undefined) {
    StatusMessage.showTemporaryMessage("No segment/skeleton is selected.");
    return undefined;
  }
  const segmentNodes =
    layer.spatialSkeletonState.getCachedSegmentNodes(segmentId);
  if (segmentNodes === undefined || segmentNodes.length === 0) {
    StatusMessage.showTemporaryMessage(
      "A non-visible segment is selected. Make it visible to use skeleton navigation features.",
    );
    return undefined;
  }
  return {
    segmentId,
    graph: buildSpatiallyIndexedSkeletonNavigationGraph(segmentNodes),
    nodeId: cachedNode?.nodeId ?? nodeInfo?.nodeId,
  };
}

type NavigationFinder<Target> = (
  context: NavigationContext & { nodeId: bigint },
) => Target;

function defineNavigation(
  id: string,
  label: string,
  findTarget: NavigationFinder<NavigationTarget>,
): SkeletonNodeCommandDefinition;
function defineNavigation(
  id: string,
  label: string,
  findTarget: NavigationFinder<NavigationTarget | undefined>,
  missingTargetMessage: string,
): SkeletonNodeCommandDefinition;
function defineNavigation(
  id: string,
  label: string,
  findTarget: NavigationFinder<NavigationTarget | undefined>,
  missingTargetMessage?: string,
): SkeletonNodeCommandDefinition {
  return {
    id,
    label,
    requiredAction: SpatialSkeletonActions.inspect,
    run: (layer, viewer) => {
      const context = navigationContext(layer, viewer);
      if (context === undefined) return;
      const { segmentId, nodeId } = context;
      if (nodeId === undefined) {
        StatusMessage.showTemporaryMessage(
          "No skeleton node is selected, only go to root is supported on skeleton edges.",
        );
        return;
      }
      try {
        const target = findTarget({ graph: context.graph, nodeId });
        if (target === undefined) {
          StatusMessage.showTemporaryMessage(missingTargetMessage!);
          return;
        }
        layer.selectAndMoveToSpatialSkeletonNode({
          nodeId: target.nodeId,
          segmentId,
          position: target.position,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        StatusMessage.showTemporaryMessage(
          `Skeleton navigation failed: ${message}`,
        );
      }
    },
  };
}

const COMMAND_DEFINITIONS: readonly SkeletonNodeCommandDefinition[] = [
  {
    id: "skeleton-go-root",
    label: "Skeleton: Go to Root Node",
    requiredAction: SpatialSkeletonActions.inspect,
    run: (layer, viewer) => {
      const context = navigationContext(layer, viewer);
      if (context === undefined) return;
      try {
        const target = getSkeletonRootNode(context.graph);
        layer.selectAndMoveToSpatialSkeletonNode({
          nodeId: target.nodeId,
          segmentId: context.segmentId,
          position: target.position,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        StatusMessage.showTemporaryMessage(
          `Skeleton navigation failed: ${message}`,
        );
      }
    },
  },
  defineNavigation(
    "skeleton-go-parent",
    "Skeleton: Go to Parent Node",
    ({ graph, nodeId }) => getParentNode(graph, nodeId),
    "Selected node has no parent.",
  ),
  defineNavigation(
    "skeleton-go-child",
    "Skeleton: Go to Child Node",
    ({ graph, nodeId }) => getRandomChildNode(graph, nodeId),
    "Selected node has no child.",
  ),
  defineNavigation(
    "skeleton-go-branch-start",
    "Skeleton: Go to Branch Start Node",
    ({ graph, nodeId }) => getBranchStart(graph, nodeId),
  ),
  defineNavigation(
    "skeleton-go-branch-end",
    "Skeleton: Go to Branch End Node",
    ({ graph, nodeId }) => getBranchEnd(graph, nodeId),
  ),
  defineNavigation(
    "skeleton-cycle-branches",
    "Skeleton: Cycle Through Level Nodes",
    ({ graph, nodeId }) => getNextCollapsedLevelNode(graph, nodeId),
  ),
  defineNavigation(
    "skeleton-go-unfinished-branch",
    "Skeleton: Go to Nearest Unfinished End Node",
    ({ graph, nodeId }) =>
      getOpenLeaves(graph, nodeId).sort((leftLeaf, rightLeaf) =>
        leftLeaf.distance === rightLeaf.distance
          ? bigintCompare(leftLeaf.nodeId, rightLeaf.nodeId)
          : leftLeaf.distance - rightLeaf.distance,
      )[0],
    "No unfinished branch was found in the current skeleton.",
  ),
  {
    id: "skeleton-undo",
    label: "Skeleton: Undo Edit",
    requiredAction: SpatialSkeletonActions.inspect,
    run: (layer) => runHistoryCommand(layer, "undo"),
  },
  {
    id: "skeleton-redo",
    label: "Skeleton: Redo Edit",
    requiredAction: SpatialSkeletonActions.inspect,
    run: (layer) => runHistoryCommand(layer, "redo"),
  },
  {
    id: "skeleton-reroot",
    label: "Skeleton: Set Selected Node as Root",
    requiredAction: SpatialSkeletonActions.reroot,
    run: async (layer) => {
      const node = requireSelectedInspectedNode(layer);
      if (node === undefined) return;
      try {
        await layer.rerootSpatialSkeletonNode(node);
      } catch (error) {
        showSpatialSkeletonActionError(SpatialSkeletonActions.reroot, error);
      }
    },
  },
  {
    id: "skeleton-toggle-true-end",
    label: "Skeleton: Toggle True End on Selected Node",
    requiredAction: SpatialSkeletonActions.editNodeTrueEnd,
    run: async (layer) => {
      const node = requireSelectedInspectedNode(layer);
      if (node === undefined) return;
      try {
        await executeSpatialSkeletonNodeTrueEndUpdate(layer, {
          node,
          nextIsTrueEnd: !isSkeletonNodeTrueEnd(node),
        });
      } catch (error) {
        showSpatialSkeletonActionError(
          SpatialSkeletonActions.editNodeTrueEnd,
          error,
        );
      }
    },
  },
];

/**
 * Registers the commands that act on the selected skeleton node. Each command
 * acts on the one visible skeleton layer that supports it, or on the selected
 * layer when there are several.
 */
export class SkeletonNodeCommands extends RefCounted {
  private readonly enabledUpdaters: (() => void)[] = [];

  constructor(private readonly viewer: SkeletonNodeViewer) {
    super();
    for (const definition of COMMAND_DEFINITIONS) {
      const command = new CallbackCommand(
        definition.id,
        definition.label,
        () => void this.run(definition),
      );
      this.registerDisposer(viewer.commandRegistry.register(command));
      this.enabledUpdaters.push(() => {
        command.enabled =
          this.layersSupporting(definition.requiredAction).length > 0;
      });
    }
    const updateEnabled = () => {
      for (const update of this.enabledUpdaters) update();
    };
    updateEnabled();
    this.registerDisposer(viewer.layerManager.layersChanged.add(updateEnabled));
    this.registerDisposer(
      viewer.layerManager.readyStateChanged.add(updateEnabled),
    );
  }

  private layersSupporting(
    requiredAction: SpatialSkeletonAction,
  ): SegmentationUserLayer[] {
    const layers: SegmentationUserLayer[] = [];
    for (const managedLayer of this.viewer.layerManager.managedLayers) {
      const { layer } = managedLayer;
      if (
        managedLayer.visible &&
        layer instanceof SegmentationUserLayer &&
        layer.getSpatialSkeletonActionsDisabledReason(requiredAction, {
          requireVisibleChunks: false,
        }) === undefined
      ) {
        layers.push(layer);
      }
    }
    return layers;
  }

  private targetLayer(
    requiredAction: SpatialSkeletonAction,
  ): SegmentationUserLayer | undefined {
    const supportingLayers = this.layersSupporting(requiredAction);
    if (supportingLayers.length === 1) return supportingLayers[0];
    const selected = this.viewer.selectedLayer.layer?.layer;
    return selected instanceof SegmentationUserLayer ? selected : undefined;
  }

  private async run(definition: SkeletonNodeCommandDefinition): Promise<void> {
    const layer = this.targetLayer(definition.requiredAction);
    if (layer === undefined) {
      StatusMessage.showTemporaryMessage(
        "Select a skeleton layer to use skeleton commands.",
      );
      return;
    }
    const disabledReason = layer.getSpatialSkeletonActionsDisabledReason(
      definition.requiredAction,
      { requireVisibleChunks: false },
    );
    if (disabledReason !== undefined) {
      StatusMessage.showTemporaryMessage(disabledReason);
      return;
    }
    await definition.run(layer, this.viewer);
  }
}
