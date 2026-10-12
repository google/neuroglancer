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
  SpatialSkeletonCommandContext,
  SpatialSkeletonQueueInputRequirement,
  SpatialSkeletonQueueInputRequirements,
} from "#src/skeleton/command_protocol.js";

/** Resolve the current skeleton/node IDs required by a CATMAID queue input. */
export function getCatmaidQueueInputRequirement(
  context: SpatialSkeletonCommandContext,
  stableSegmentId: number | undefined,
  stableNodeId: number | undefined,
): SpatialSkeletonQueueInputRequirement | undefined {
  const segmentId =
    stableSegmentId === undefined
      ? undefined
      : (context.identities.resolveSegment(
          context.identities.getOrCreateSegmentHandle(stableSegmentId),
        ) ?? stableSegmentId);
  if (
    segmentId === undefined ||
    !Number.isSafeInteger(segmentId) ||
    segmentId <= 0
  ) {
    return undefined;
  }
  const nodeId =
    stableNodeId === undefined
      ? undefined
      : (context.identities.resolveNode(
          context.identities.getOrCreateNodeHandle(stableNodeId),
        ) ?? stableNodeId);
  return {
    segmentId,
    nodeId:
      nodeId !== undefined && Number.isSafeInteger(nodeId) && nodeId > 0
        ? nodeId
        : undefined,
  };
}

export function getCatmaidQueueInputRequirements(
  ...requirements: readonly (SpatialSkeletonQueueInputRequirement | undefined)[]
): SpatialSkeletonQueueInputRequirements {
  const unique = new Map<string, SpatialSkeletonQueueInputRequirement>();
  for (const requirement of requirements) {
    if (requirement === undefined) continue;
    const key = `${requirement.segmentId}:${requirement.nodeId ?? ""}`;
    if (!unique.has(key)) unique.set(key, Object.freeze({ ...requirement }));
  }
  return Object.freeze({ required: Object.freeze([...unique.values()]) });
}

export function getCatmaidMergeQueueInputRequirements(
  required: SpatialSkeletonQueueInputRequirement | undefined,
  mergeTarget: SpatialSkeletonQueueInputRequirement | undefined,
): SpatialSkeletonQueueInputRequirements {
  if (
    required !== undefined &&
    mergeTarget !== undefined &&
    required.segmentId === mergeTarget.segmentId &&
    required.nodeId === mergeTarget.nodeId
  ) {
    return getCatmaidQueueInputRequirements(required);
  }
  return Object.freeze({
    required: getCatmaidQueueInputRequirements(required).required,
    ...(mergeTarget === undefined
      ? {}
      : { loadable: Object.freeze([Object.freeze({ ...mergeTarget })]) }),
  });
}
