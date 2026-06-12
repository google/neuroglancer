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

import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/actions.js";
import type {
  EditableSpatiallyIndexedSkeletonSource,
  SpatiallyIndexedSkeletonNode,
} from "#src/skeleton/api.js";
import type {
  SpatialSkeletonCommandPayload,
  SpatialSkeletonEditCommandFactory,
} from "#src/skeleton/command_factories.js";
import type { SpatialSkeletonCommand } from "#src/skeleton/command_history.js";
import { getSpatialSkeletonActionErrorMessage } from "#src/skeleton/edit_errors.js";
import {
  getEditableSpatiallyIndexedSkeletonSource,
  getSpatialSkeletonEditCommandFactoryForAction,
  type SpatialSkeletonLayerContext,
} from "#src/skeleton/spatial_skeleton_manager.js";
import { StatusMessage } from "#src/status.js";

interface SpatialSkeletonSourceAccess {
  source: object;
}

function getEditSource(
  layer: SpatialSkeletonLayerContext,
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
  return getSpatialSkeletonEditCommandFactoryForAction(source, action);
}

function executeCommand(
  layer: SpatialSkeletonLayerContext,
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

export function showSpatialSkeletonActionError(action: string, error: unknown) {
  const { message, requiresDismissal } = getSpatialSkeletonActionErrorMessage(
    action,
    error,
  );
  return requiresDismissal
    ? StatusMessage.showErrorMessage(message)
    : StatusMessage.showTemporaryMessage(message);
}

function createSpatialSkeletonCommand(
  layer: SpatialSkeletonLayerContext,
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
  // The concrete createCommand implementations expect the full layer type; the
  // cast is safe because in practice layer always satisfies those requirements.

  return commandFactory.createCommand(layer as any, payload);
}

interface SpatialSkeletonExecutionMetadata {
  readonly unsupportedMessage: string;
  readonly pendingMessage?: string;
}

const spatialSkeletonExecutionMetadata = new Map<
  SpatialSkeletonAction,
  SpatialSkeletonExecutionMetadata
>([
  [
    SpatialSkeletonActions.addNodes,
    {
      unsupportedMessage:
        "The active skeleton source does not support node creation.",
      pendingMessage: "Creating node...",
    },
  ],
  [
    SpatialSkeletonActions.insertNodes,
    {
      unsupportedMessage:
        "The active skeleton source does not support node insertion.",
      pendingMessage: "Inserting node...",
    },
  ],
  [
    SpatialSkeletonActions.moveNodes,
    {
      unsupportedMessage:
        "The active skeleton source does not support node movement.",
    },
  ],
  [
    SpatialSkeletonActions.deleteNodes,
    {
      unsupportedMessage:
        "The active skeleton source does not support node deletion.",
      pendingMessage: "Deleting node...",
    },
  ],
  [
    SpatialSkeletonActions.editNodeDescription,
    {
      unsupportedMessage:
        "The active skeleton source does not support node description editing.",
    },
  ],
  [
    SpatialSkeletonActions.editNodeTrueEnd,
    {
      unsupportedMessage:
        "The active skeleton source does not support node true-end editing.",
    },
  ],
  [
    SpatialSkeletonActions.editNodeRadius,
    {
      unsupportedMessage:
        "The active skeleton source does not support node radius editing.",
    },
  ],
  [
    SpatialSkeletonActions.editNodeConfidence,
    {
      unsupportedMessage:
        "The active skeleton source does not support node confidence editing.",
    },
  ],
  [
    SpatialSkeletonActions.reroot,
    {
      unsupportedMessage:
        "The active skeleton source does not support skeleton rerooting.",
    },
  ],
  [
    SpatialSkeletonActions.splitSkeletons,
    {
      unsupportedMessage:
        "The active skeleton source does not support skeleton splitting.",
      pendingMessage: "Splitting skeleton...",
    },
  ],
  [
    SpatialSkeletonActions.mergeSkeletons,
    {
      unsupportedMessage:
        "The active skeleton source does not support skeleton merging.",
      pendingMessage: "Merging skeletons...",
    },
  ],
]);

function executeSpatialSkeletonAction(
  layer: SpatialSkeletonLayerContext,
  action: SpatialSkeletonAction,
  payload: SpatialSkeletonCommandPayload,
) {
  const metadata = spatialSkeletonExecutionMetadata.get(action);
  if (metadata === undefined) {
    throw new Error(`Unsupported spatial skeleton edit action: ${action}`);
  }
  const command = createSpatialSkeletonCommand(
    layer,
    action,
    payload,
    metadata.unsupportedMessage,
  );
  const execution = executeCommand(layer, command);
  return metadata.pendingMessage === undefined
    ? execution
    : executeCommandWithPendingMessage(execution, metadata.pendingMessage);
}

export function executeSpatialSkeletonAddNode(
  layer: SpatialSkeletonLayerContext,
  options: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.addNodes,
    options,
  );
}

export function executeSpatialSkeletonInsertNode(
  layer: SpatialSkeletonLayerContext,
  options: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.insertNodes,
    options,
  );
}

export function executeSpatialSkeletonMoveNode(
  layer: SpatialSkeletonLayerContext,
  options: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.moveNodes,
    options,
  );
}

export function executeSpatialSkeletonDeleteNode(
  layer: SpatialSkeletonLayerContext,
  node: SpatiallyIndexedSkeletonNode,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.deleteNodes,
    node,
  );
}

export function executeSpatialSkeletonNodeDescriptionUpdate(
  layer: SpatialSkeletonLayerContext,
  options: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.editNodeDescription,
    options,
  );
}

export function executeSpatialSkeletonNodeTrueEndUpdate(
  layer: SpatialSkeletonLayerContext,
  options: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.editNodeTrueEnd,
    options,
  );
}

export function executeSpatialSkeletonNodeRadiusUpdate(
  layer: SpatialSkeletonLayerContext,
  options: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.editNodeRadius,
    options,
  );
}

export function executeSpatialSkeletonNodeConfidenceUpdate(
  layer: SpatialSkeletonLayerContext,
  options: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.editNodeConfidence,
    options,
  );
}

export function executeSpatialSkeletonReroot(
  layer: SpatialSkeletonLayerContext,
  node: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.reroot,
    node,
  );
}

export function executeSpatialSkeletonSplit(
  layer: SpatialSkeletonLayerContext,
  node: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.splitSkeletons,
    node,
  );
}

export function executeSpatialSkeletonMerge(
  layer: SpatialSkeletonLayerContext,
  firstNode: SpatialSkeletonCommandPayload,
  secondNode: SpatialSkeletonCommandPayload,
) {
  return executeSpatialSkeletonAction(
    layer,
    SpatialSkeletonActions.mergeSkeletons,
    { firstNode, secondNode },
  );
}

export async function undoSpatialSkeletonCommand(
  layer: SpatialSkeletonLayerContext,
) {
  const changed = await layer.spatialSkeletonState.commandHistory.undo();
  if (!changed) {
    return false;
  }
  return true;
}

export async function redoSpatialSkeletonCommand(
  layer: SpatialSkeletonLayerContext,
) {
  const changed = await layer.spatialSkeletonState.commandHistory.redo();
  if (!changed) {
    return false;
  }
  return true;
}
