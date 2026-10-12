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
  remapCompleteSkeletonSnapshot,
  type CompleteSkeletonSnapshotHandle,
} from "#src/skeleton/complete_skeleton_snapshot.js";
import type {
  SpatialSkeletonLogicalHandleMappings,
  SpatialSkeletonLogicalSegmentHandle,
} from "#src/skeleton/logical_identity.js";
import {
  SpatialSkeletonProjectionValidationError,
  SpatialSkeletonProjectionWorkspace,
} from "#src/skeleton/spatial_skeleton_projection_reducer.js";

export function materializePhysicalSpatialSkeletonWorkspace(
  workspace: SpatialSkeletonProjectionWorkspace,
  mappings: SpatialSkeletonLogicalHandleMappings<number, number>,
) {
  const result = new Map<
    number,
    {
      readonly segment: SpatialSkeletonLogicalSegmentHandle;
      readonly snapshot: CompleteSkeletonSnapshotHandle;
    }
  >();
  for (const entry of workspace.segments) {
    const segmentId = mappings.resolveSegment(entry.segment);
    if (
      !Number.isSafeInteger(segmentId) ||
      segmentId === undefined ||
      segmentId <= 0
    ) {
      throw new SpatialSkeletonProjectionValidationError(
        `Logical segment ${entry.segment.stableId} requires a positive numeric id for publication.`,
      );
    }
    if (result.has(segmentId)) {
      throw new SpatialSkeletonProjectionValidationError(
        `Physical segment ${segmentId} has multiple active logical owners.`,
      );
    }
    result.set(segmentId, entry);
  }
  return result;
}

export function ownsPhysicalSpatialSkeletonSegment(
  workspace: SpatialSkeletonProjectionWorkspace,
  mappings: SpatialSkeletonLogicalHandleMappings<number, number>,
  segmentId: number,
) {
  return workspace.segments.some(
    ({ segment }) => mappings.resolveSegment(segment) === segmentId,
  );
}

export function remapSpatialSkeletonProjectionWorkspace(
  workspace: SpatialSkeletonProjectionWorkspace,
  nodeIds: ReadonlyMap<number, number>,
  segmentIds: ReadonlyMap<number, number>,
) {
  if (nodeIds.size === 0 && segmentIds.size === 0) return workspace;
  return new SpatialSkeletonProjectionWorkspace(
    workspace.segments.map(({ segment, snapshot }) => ({
      segment,
      snapshot: remapCompleteSkeletonSnapshot(snapshot, {
        nodeIds,
        segmentIds,
      }),
    })),
  );
}
