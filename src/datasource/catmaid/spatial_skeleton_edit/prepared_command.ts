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

import type { CatmaidSpatialSkeletonCommandPayload } from "#src/datasource/catmaid/spatial_skeleton_edit/command_payloads.js";
import type { CatmaidSpatialSkeletonCommandDescriptor } from "#src/datasource/catmaid/spatial_skeleton_edit/workflow_driver.js";
import type { SpatialSkeletonQueueInput } from "#src/skeleton/command_protocol.js";
import type { SpatialSkeletonOptimisticIdentityService } from "#src/skeleton/optimistic_edit/api.js";

/** Resolve a queued user intent against the complete, ordered input bundle. */
export function resolveCatmaidPreparedCommand(
  command: CatmaidSpatialSkeletonCommandDescriptor,
  queueInput: SpatialSkeletonQueueInput,
  identity: SpatialSkeletonOptimisticIdentityService,
): CatmaidSpatialSkeletonCommandDescriptor {
  const resolveNode = <T extends { nodeId: number; segmentId: number }>(
    node: T,
  ): T => {
    const nodeId =
      identity.resolveNode(identity.getOrCreateNodeHandle(node.nodeId)) ??
      node.nodeId;
    const current = queueInput.segments
      .map(({ snapshot }) => snapshot.getNode(nodeId))
      .find((node) => node !== undefined);
    const segmentId =
      current?.segmentId ??
      identity.resolveSegment(
        identity.getOrCreateSegmentHandle(node.segmentId),
      ) ??
      node.segmentId;
    return Object.freeze({ ...node, nodeId, segmentId });
  };
  const payload = command.payload;
  let resolved: CatmaidSpatialSkeletonCommandPayload;
  switch (payload.kind) {
    case "merge":
      resolved = {
        ...payload,
        options: {
          ...payload.options,
          firstNode: resolveNode(payload.options.firstNode),
          secondNode: resolveNode(payload.options.secondNode),
        },
      };
      break;
    case "add-node": {
      const options = payload.options;
      if (options.parentNodeId === undefined) return command;
      const parent = resolveNode({
        nodeId: options.parentNodeId,
        segmentId: options.skeletonId,
      });
      resolved = {
        ...payload,
        options: {
          ...options,
          parentNodeId: parent.nodeId,
          skeletonId: parent.segmentId,
        },
      };
      break;
    }
    case "delete-node":
      resolved = { ...payload, node: resolveNode(payload.node) };
      break;
    case "reroot":
      resolved = { ...payload, node: resolveNode(payload.node) };
      break;
    case "split":
      resolved = { ...payload, node: resolveNode(payload.node) };
      break;
    case "move-node":
      resolved = {
        ...payload,
        options: {
          ...payload.options,
          node: resolveNode(payload.options.node),
        },
      };
      break;
    case "description":
      resolved = {
        ...payload,
        options: {
          ...payload.options,
          node: resolveNode(payload.options.node),
        },
      };
      break;
    case "true-end":
      resolved = {
        ...payload,
        options: {
          ...payload.options,
          node: resolveNode(payload.options.node),
        },
      };
      break;
    case "radius":
      resolved = {
        ...payload,
        options: {
          ...payload.options,
          node: resolveNode(payload.options.node),
        },
      };
      break;
    case "confidence":
      resolved = {
        ...payload,
        options: {
          ...payload.options,
          node: resolveNode(payload.options.node),
        },
      };
      break;
  }
  return Object.freeze({ ...command, payload: Object.freeze(resolved) });
}
