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
  EditableSpatiallyIndexedSkeletonSource,
  SpatiallyIndexedSkeletonNode,
} from "#src/skeleton/api.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/actions.js";
import type {
  SpatialSkeletonCommandPayload,
  SpatialSkeletonEditCommandFactory,
} from "#src/skeleton/edit_command_source.js";
import type { SpatialSkeletonCommand } from "#src/skeleton/command_history.js";
import { getEditableSpatiallyIndexedSkeletonSource } from "#src/skeleton/spatial_skeleton_manager.js";
import { StatusMessage } from "#src/status.js";

interface SpatialSkeletonSourceAccess {
  source: object;
}

function getEditSource(
  layer: SegmentationUserLayer,
): EditableSpatiallyIndexedSkeletonSource {
  const source = getEditableSpatiallyIndexedSkeletonSource(
    layer.getSpatiallyIndexedSkeletonLayer(),
  );
  if (source === undefined) {
    throw new Error(
      "Unable to resolve editable skeleton source for the active layer.",
    );
  }
  return source;
}

export function getSpatialSkeletonEditCommandFactory(
  value: SpatialSkeletonSourceAccess | undefined,
  action: SpatialSkeletonAction,
): SpatialSkeletonEditCommandFactory | undefined {
  const source = getEditableSpatiallyIndexedSkeletonSource(value);
  if (source === undefined) return undefined;
  switch (action) {
    case SpatialSkeletonActions.addNodes:
      return source.addNodesCommand;
    case SpatialSkeletonActions.insertNodes:
      return source.insertNodesCommand;
    case SpatialSkeletonActions.moveNodes:
      return source.moveNodesCommand;
    case SpatialSkeletonActions.deleteNodes:
      return source.deleteNodesCommand;
    case SpatialSkeletonActions.reroot:
      return source.rerootCommand;
    case SpatialSkeletonActions.editNodeDescription:
      return source.editNodeDescriptionCommand;
    case SpatialSkeletonActions.editNodeTrueEnd:
      return source.editNodeTrueEndCommand;
    case SpatialSkeletonActions.editNodeRadius:
      return source.editNodeRadiusCommand;
    case SpatialSkeletonActions.editNodeConfidence:
      return source.editNodeConfidenceCommand;
    case SpatialSkeletonActions.mergeSkeletons:
      return source.mergeSkeletonsCommand;
    case SpatialSkeletonActions.splitSkeletons:
      return source.splitSkeletonsCommand;
    case SpatialSkeletonActions.inspect:
      return undefined;
  }
}

function executeCommand(
  layer: SegmentationUserLayer,
  command: SpatialSkeletonCommand,
) {
  return layer.spatialSkeletonState.commandHistory.execute(command);
}

function executeCommandWithPendingMessage<T>(
  promise: Promise<T>,
  message: string,
) {
  const status = StatusMessage.showMessage(message);
  return promise.finally(() => status.dispose());
}

function createSpatialSkeletonCommand(
  layer: SegmentationUserLayer,
  action: SpatialSkeletonAction,
  payload: SpatialSkeletonCommandPayload,
  unsupportedMessage: string,
) {
  const source = getEditSource(layer);
  const commandFactory = getSpatialSkeletonEditCommandFactory(
    { source },
    action,
  );
  if (commandFactory === undefined) {
    throw new Error(unsupportedMessage);
  }
  return commandFactory.createCommand(layer, payload);
}

export function executeSpatialSkeletonAddNode(
  layer: SegmentationUserLayer,
  options: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.addNodes,
    options,
    "The active skeleton source does not support node creation.",
  );
  return executeCommandWithPendingMessage(
    executeCommand(layer, command),
    "Creating node...",
  );
}

export function executeSpatialSkeletonInsertNode(
  layer: SegmentationUserLayer,
  options: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.insertNodes,
    options,
    "The active skeleton source does not support node insertion.",
  );
  return executeCommandWithPendingMessage(
    executeCommand(layer, command),
    "Inserting node...",
  );
}

export function executeSpatialSkeletonMoveNode(
  layer: SegmentationUserLayer,
  options: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.moveNodes,
    options,
    "The active skeleton source does not support node movement.",
  );
  return executeCommand(layer, command);
}

export function executeSpatialSkeletonDeleteNode(
  layer: SegmentationUserLayer,
  node: SpatiallyIndexedSkeletonNode,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.deleteNodes,
    node,
    "The active skeleton source does not support node deletion.",
  );
  return executeCommandWithPendingMessage(
    executeCommand(layer, command),
    "Deleting node...",
  );
}

export function executeSpatialSkeletonNodeDescriptionUpdate(
  layer: SegmentationUserLayer,
  options: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.editNodeDescription,
    options,
    "The active skeleton source does not support node description editing.",
  );
  return executeCommand(layer, command);
}

export function executeSpatialSkeletonNodeTrueEndUpdate(
  layer: SegmentationUserLayer,
  options: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.editNodeTrueEnd,
    options,
    "The active skeleton source does not support node true-end editing.",
  );
  return executeCommand(layer, command);
}

export function executeSpatialSkeletonNodeRadiusUpdate(
  layer: SegmentationUserLayer,
  options: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.editNodeRadius,
    options,
    "The active skeleton source does not support node radius editing.",
  );
  return executeCommand(layer, command);
}

export function executeSpatialSkeletonNodeConfidenceUpdate(
  layer: SegmentationUserLayer,
  options: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.editNodeConfidence,
    options,
    "The active skeleton source does not support node confidence editing.",
  );
  return executeCommand(layer, command);
}

export function executeSpatialSkeletonReroot(
  layer: SegmentationUserLayer,
  node: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.reroot,
    node,
    "The active skeleton source does not support skeleton rerooting.",
  );
  return executeCommand(layer, command);
}

export function executeSpatialSkeletonSplit(
  layer: SegmentationUserLayer,
  node: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.splitSkeletons,
    node,
    "The active skeleton source does not support skeleton splitting.",
  );
  return executeCommandWithPendingMessage(
    executeCommand(layer, command),
    "Splitting skeleton...",
  );
}

export function executeSpatialSkeletonMerge(
  layer: SegmentationUserLayer,
  firstNode: SpatialSkeletonCommandPayload,
  secondNode: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.mergeSkeletons,
    { firstNode, secondNode },
    "The active skeleton source does not support skeleton merging.",
  );
  return executeCommandWithPendingMessage(
    executeCommand(layer, command),
    "Merging skeletons...",
  );
}

export async function undoSpatialSkeletonCommand(layer: SegmentationUserLayer) {
  const changed = await layer.spatialSkeletonState.commandHistory.undo();
  if (!changed) {
    return false;
  }
  return true;
}

export async function redoSpatialSkeletonCommand(layer: SegmentationUserLayer) {
  const changed = await layer.spatialSkeletonState.commandHistory.redo();
  if (!changed) {
    return false;
  }
  return true;
}
