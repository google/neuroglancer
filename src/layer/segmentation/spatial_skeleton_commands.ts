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
import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/actions.js";
import type {
  SpatialSkeletonCommandPayload,
  SpatialSkeletonEditCommandSource,
} from "#src/skeleton/edit_command_source.js";
import type { SpatialSkeletonCommand } from "#src/skeleton/command_history.js";
import { getEditableSpatiallyIndexedSkeletonSource } from "#src/skeleton/spatial_skeleton_manager.js";
import { StatusMessage } from "#src/status.js";

interface SpatialSkeletonSourceAccess {
  source: object;
}

export function getSpatialSkeletonEditCommandSource(
  value: SpatialSkeletonSourceAccess | undefined,
): SpatialSkeletonEditCommandSource | undefined {
  const source = getEditableSpatiallyIndexedSkeletonSource(value);
  if (source === undefined) return undefined;
  return source.spatialSkeletonEditCommandSource;
}

function getEditSource(
  layer: SegmentationUserLayer,
): SpatialSkeletonEditCommandSource {
  const source = getSpatialSkeletonEditCommandSource(
    layer.getSpatiallyIndexedSkeletonLayer(),
  );
  if (source === undefined) {
    throw new Error(
      "Unable to resolve editable skeleton source for the active layer.",
    );
  }
  return source;
}

function requireCommand(
  command: SpatialSkeletonCommand | undefined,
  message: string,
) {
  if (command === undefined) {
    throw new Error(message);
  }
  return command;
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
  return requireCommand(
    getEditSource(layer).createCommand(action, layer, payload),
    unsupportedMessage,
  );
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

export function executeSpatialSkeletonNodePropertiesUpdate(
  layer: SegmentationUserLayer,
  options: SpatialSkeletonCommandPayload,
) {
  const command = createSpatialSkeletonCommand(
    layer,
    SpatialSkeletonActions.editNodeProperties,
    options,
    "The active skeleton source does not support node property editing.",
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
