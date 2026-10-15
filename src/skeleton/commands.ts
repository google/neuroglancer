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

import type {
  EditableSpatiallyIndexedSkeletonSource,
  SpatiallyIndexedSkeletonNode,
} from "#src/skeleton/api.js";
import type { SpatialSkeletonCommandPayload } from "#src/skeleton/command_factories.js";
import {
  SpatialSkeletonActions,
  SpatialSkeletonHistoryActions,
  type SpatialSkeletonAction,
  type SpatialSkeletonErrorAction,
  type SpatialSkeletonEditCommand,
} from "#src/skeleton/command_protocol.js";
import { getSpatialSkeletonActionErrorMessage } from "#src/skeleton/edit_errors.js";
import { ensureSpatialSkeletonOptimisticEditQueue } from "#src/skeleton/optimistic_edit/host.js";
import { prepareAndSubmitSpatialSkeletonEdit } from "#src/skeleton/queue_admission.js";
import {
  getSpatialSkeletonEditCommandFactoryForAction,
  type SpatialSkeletonLayerContext,
  type SpatialSkeletonOptimisticEditExecution,
} from "#src/skeleton/spatial_skeleton_manager.js";
import { StatusMessage } from "#src/status.js";
import { withPromiseProperties } from "#src/util/promise.js";

function executeCommand(
  layer: SpatialSkeletonLayerContext,
  command: SpatialSkeletonEditCommand,
  action?: SpatialSkeletonAction,
): SpatialSkeletonOptimisticEditExecution<void> {
  return prepareAndSubmitSpatialSkeletonEdit(
    layer,
    command,
    (queueInput) =>
      layer.spatialSkeletonState.executeOptimisticEdit(command, queueInput),
    action,
  );
}

function withPendingMessage<T>(
  execution: SpatialSkeletonOptimisticEditExecution<T>,
  message: string,
): SpatialSkeletonOptimisticEditExecution<T> {
  const status = StatusMessage.showMessage(message);
  // finally() creates a new preview promise, so carry its other milestones over.
  return withPromiseProperties(
    execution.finally(() => status.dispose()),
    {
      acceptedByQueue: execution.acceptedByQueue,
      settled: execution.settled,
    },
  );
}

const spatialSkeletonErrorLabels: Record<SpatialSkeletonErrorAction, string> = {
  [SpatialSkeletonActions.inspect]: "inspect skeleton",
  [SpatialSkeletonActions.addNodes]: "create node",
  [SpatialSkeletonActions.insertNodes]: "insert node",
  [SpatialSkeletonActions.moveNodes]: "move node",
  [SpatialSkeletonActions.deleteNodes]: "delete node",
  [SpatialSkeletonActions.reroot]: "reroot",
  [SpatialSkeletonActions.editNodeDescription]: "update node description",
  [SpatialSkeletonActions.editNodeTrueEnd]: "toggle true end",
  [SpatialSkeletonActions.editNodeRadius]: "update node radius",
  [SpatialSkeletonActions.editNodeConfidence]: "update node confidence",
  [SpatialSkeletonActions.mergeSkeletons]: "merge skeletons",
  [SpatialSkeletonActions.splitSkeletons]: "split skeleton",
  [SpatialSkeletonHistoryActions.undo]: "undo",
  [SpatialSkeletonHistoryActions.redo]: "redo",
};

export function showSpatialSkeletonActionError(
  action: SpatialSkeletonErrorAction,
  error: unknown,
  label = spatialSkeletonErrorLabels[action],
) {
  const { message, requiresDismissal } = getSpatialSkeletonActionErrorMessage(
    label,
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
  // Source capabilities are validated when the layer enables editing. Dispatch
  // checks the current write permission and resolves the requested factory.
  const source = layer.getSpatiallyIndexedSkeletonLayer()?.source as
    | EditableSpatiallyIndexedSkeletonSource
    | undefined;
  if (source?.readonly !== false) {
    throw new Error(unsupportedMessage);
  }
  const commandFactory = getSpatialSkeletonEditCommandFactoryForAction(
    source,
    action,
  );
  if (commandFactory === undefined) {
    throw new Error(unsupportedMessage);
  }
  // Queue ownership is a generic source capability. Install the state-owned
  // engine before constructing the datasource-specific intent descriptor.
  ensureSpatialSkeletonOptimisticEditQueue(layer, source);
  return commandFactory.createCommand(payload);
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
  layer.spatialSkeletonState.assertOptimisticEditingAllowed();
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
  const execution = executeCommand(layer, command, action);
  return metadata.pendingMessage === undefined
    ? execution
    : withPendingMessage(execution, metadata.pendingMessage);
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

export function undoSpatialSkeletonCommand(
  layer: SpatialSkeletonLayerContext,
): SpatialSkeletonOptimisticEditExecution<boolean> {
  const state = layer.spatialSkeletonState;
  state.assertOptimisticEditingAllowed();
  return state.undoLatestOptimisticEdit();
}

export function redoSpatialSkeletonCommand(
  layer: SpatialSkeletonLayerContext,
): SpatialSkeletonOptimisticEditExecution<boolean> {
  const state = layer.spatialSkeletonState;
  state.assertOptimisticEditingAllowed();
  return state.redoLatestOptimisticEdit();
}
