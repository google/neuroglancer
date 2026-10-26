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
 * @file Registers the viewer commands that navigate from or edit the selected
 * skeleton node.
 */

import type { UserLayer } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import {
  executeSpatialSkeletonNodeTrueEndUpdate,
  redoSpatialSkeletonCommand,
  showSpatialSkeletonActionError,
  undoSpatialSkeletonCommand,
  executeSpatialSkeletonReroot,
} from "#src/skeleton/edit/submit_edits.js";
import type { SpatialSkeletonAction } from "#src/skeleton/edit_commands.js";
import {
  DEFAULT_SPATIAL_SKELETON_EDIT_ACTIONS,
  SpatialSkeletonActions,
  SpatialSkeletonHistoryActions,
} from "#src/skeleton/edit_commands.js";
import { SPATIAL_SKELETON_RELOAD_REQUIRED_EDIT_REASON } from "#src/skeleton/edit_queue/types.js";
import { isSkeletonNodeTrueEnd } from "#src/skeleton/node_attributes.js";
import { SkeletonNavigation } from "#src/skeleton/skeleton_navigator.js";
import { StatusMessage } from "#src/status.js";
import { CallbackCommand } from "#src/ui/command.js";
import { RefCounted } from "#src/util/disposable.js";
import type { Viewer } from "#src/viewer.js";

type SkeletonNodeViewer = Pick<
  Viewer,
  | "commandRegistry"
  | "layerManager"
  | "selectedLayer"
  | "selectionDetailsState"
  | "registerDisposer"
>;

type SkeletonNodeCommandLayer = Pick<
  SegmentationUserLayer,
  | "skeletonNodeSelection"
  | "skeletonSourceConnection"
  | "spatialSkeletonEditSession"
>;

function isSkeletonNodeCommandLayer(
  layer: UserLayer | null | undefined,
): layer is UserLayer & SkeletonNodeCommandLayer {
  return (
    layer != null &&
    ("skeletonSourceConnection" satisfies keyof SkeletonNodeCommandLayer) in
      layer
  );
}

interface SkeletonNodeCommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly requiredActions: readonly SpatialSkeletonAction[];
  readonly run: (
    layer: SkeletonNodeCommandLayer,
    viewer: SkeletonNodeViewer,
  ) => void | Promise<unknown>;
}

async function runHistoryCommand(
  layer: SkeletonNodeCommandLayer,
  history: "undo" | "redo",
) {
  if (layer.spatialSkeletonEditSession.getReloadRequired() !== undefined) {
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
    await execute(layer.skeletonSourceConnection);
  } catch (error) {
    showSpatialSkeletonActionError(action, error);
  }
}

function requireSelectedInspectedNode(
  layer: SkeletonNodeCommandLayer,
): SkeletonNode | undefined {
  const selected = layer.skeletonNodeSelection.selected.value;
  if (selected === undefined) {
    StatusMessage.showTemporaryMessage("No skeleton node is selected.");
    return undefined;
  }
  const { nodeId } = selected;
  const { spatialSkeletonEditSession } = layer;
  const segmentId =
    spatialSkeletonEditSession.getCachedNode(nodeId)?.segmentId ??
    selected.segmentId;
  if (segmentId === undefined) {
    StatusMessage.showTemporaryMessage(
      `Unable to resolve the skeleton for node ${nodeId}.`,
    );
    return undefined;
  }
  const snapshot =
    spatialSkeletonEditSession.getCachedSegmentSnapshotHandle(segmentId);
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

function defineNavigation(
  id: string,
  label: string,
  navigation: SkeletonNavigation,
): SkeletonNodeCommandDefinition {
  return {
    id,
    label,
    requiredActions: [SpatialSkeletonActions.inspect],
    run: (layer) => layer.skeletonNodeSelection.navigate(navigation),
  };
}

const COMMAND_DEFINITIONS: readonly SkeletonNodeCommandDefinition[] = [
  defineNavigation(
    "skeleton-go-root",
    "Skeleton: Go to Root Node",
    SkeletonNavigation.ROOT,
  ),
  defineNavigation(
    "skeleton-go-parent",
    "Skeleton: Go to Parent Node",
    SkeletonNavigation.PARENT,
  ),
  defineNavigation(
    "skeleton-go-child",
    "Skeleton: Go to Child Node",
    SkeletonNavigation.CHILD,
  ),
  defineNavigation(
    "skeleton-go-branch-start",
    "Skeleton: Go to Branch Start Node",
    SkeletonNavigation.BRANCH_START,
  ),
  defineNavigation(
    "skeleton-go-branch-end",
    "Skeleton: Go to Branch End Node",
    SkeletonNavigation.BRANCH_END,
  ),
  defineNavigation(
    "skeleton-cycle-branches",
    "Skeleton: Cycle Through Level Nodes",
    SkeletonNavigation.NEXT_LEVEL_NODE,
  ),
  defineNavigation(
    "skeleton-go-unfinished-branch",
    "Skeleton: Go to Nearest Unfinished End Node",
    SkeletonNavigation.NEAREST_OPEN_LEAF,
  ),
  {
    id: "skeleton-undo",
    label: "Skeleton: Undo Edit",
    requiredActions: DEFAULT_SPATIAL_SKELETON_EDIT_ACTIONS,
    run: (layer) => runHistoryCommand(layer, "undo"),
  },
  {
    id: "skeleton-redo",
    label: "Skeleton: Redo Edit",
    requiredActions: DEFAULT_SPATIAL_SKELETON_EDIT_ACTIONS,
    run: (layer) => runHistoryCommand(layer, "redo"),
  },
  {
    id: "skeleton-reroot",
    label: "Skeleton: Set Selected Node as Root",
    requiredActions: [SpatialSkeletonActions.reroot],
    run: async (layer) => {
      const node = requireSelectedInspectedNode(layer);
      if (node === undefined) return;
      try {
        await executeSpatialSkeletonReroot(
          layer.skeletonSourceConnection,
          node,
        );
      } catch (error) {
        showSpatialSkeletonActionError(SpatialSkeletonActions.reroot, error);
      }
    },
  },
  {
    id: "skeleton-toggle-true-end",
    label: "Skeleton: Toggle True End on Selected Node",
    requiredActions: [SpatialSkeletonActions.editNodeTrueEnd],
    run: async (layer) => {
      const node = requireSelectedInspectedNode(layer);
      if (node === undefined) return;
      try {
        await executeSpatialSkeletonNodeTrueEndUpdate(
          layer.skeletonSourceConnection,
          {
            node,
            nextIsTrueEnd: !isSkeletonNodeTrueEnd(node),
          },
        );
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
export function bindSkeletonNodeCommands(viewer: SkeletonNodeViewer): void {
  viewer.registerDisposer(new SkeletonNodeCommands(viewer));
}

class SkeletonNodeCommands extends RefCounted {
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
          this.layersSupporting(definition.requiredActions).length > 0;
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
    requiredActions: readonly SpatialSkeletonAction[],
  ): SkeletonNodeCommandLayer[] {
    const layers: SkeletonNodeCommandLayer[] = [];
    for (const managedLayer of this.viewer.layerManager.managedLayers) {
      const { layer } = managedLayer;
      if (
        managedLayer.visible &&
        isSkeletonNodeCommandLayer(layer) &&
        layer.skeletonSourceConnection.getActionsDisabledReason(
          requiredActions,
        ) === undefined
      ) {
        layers.push(layer);
      }
    }
    return layers;
  }

  private targetLayer(
    requiredActions: readonly SpatialSkeletonAction[],
  ): SkeletonNodeCommandLayer | undefined {
    const supportingLayers = this.layersSupporting(requiredActions);
    if (supportingLayers.length === 1) return supportingLayers[0];
    const selected = this.viewer.selectedLayer.layer?.layer;
    return isSkeletonNodeCommandLayer(selected) ? selected : undefined;
  }

  private async run(definition: SkeletonNodeCommandDefinition): Promise<void> {
    const layer = this.targetLayer(definition.requiredActions);
    if (layer === undefined) {
      StatusMessage.showTemporaryMessage(
        "Select a skeleton layer to use skeleton commands.",
      );
      return;
    }
    const disabledReason =
      layer.skeletonSourceConnection.getActionsDisabledReason(
        definition.requiredActions,
      );
    if (disabledReason !== undefined) {
      StatusMessage.showTemporaryMessage(disabledReason);
      return;
    }
    await definition.run(layer, this.viewer);
  }
}
