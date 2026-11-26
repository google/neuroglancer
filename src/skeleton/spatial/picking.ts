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
 * @file Resolves a pick in skeleton geometry to the picked skeleton and node,
 * preferring the node as the edit session displays it.
 */

import type { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import type { SkeletonPickGeometry } from "#src/skeleton/spatial/frontend.js";

export function resolveSpatiallyIndexedSkeletonSegmentPick(
  geometry: Pick<
    SkeletonPickGeometry,
    "indices" | "numVertices" | "segmentIds"
  >,
  pickedOffset: number,
  kind: "node" | "edge",
): bigint | undefined {
  const { indices, segmentIds } = geometry;
  let segmentId: bigint | undefined;
  if (kind === "node") {
    if (pickedOffset < 0 || pickedOffset >= geometry.numVertices) {
      return undefined;
    }
    segmentId = segmentIds[pickedOffset];
  } else {
    const indexOffset = pickedOffset * 2;
    if (pickedOffset < 0 || indexOffset + 1 >= indices.length) {
      return undefined;
    }
    segmentId =
      segmentIds[indices[indexOffset]] || segmentIds[indices[indexOffset + 1]];
  }
  return segmentId === 0n ? undefined : segmentId;
}

export function resolveSpatiallyIndexedSkeletonNodePick(
  geometry: SkeletonPickGeometry,
  pickedOffset: number,
  editSession: Pick<SpatialSkeletonEditSession, "getDisplayedNode">,
) {
  const segmentId = resolveSpatiallyIndexedSkeletonSegmentPick(
    geometry,
    pickedOffset,
    "node",
  );
  if (segmentId === undefined) return undefined;
  const nodeId = geometry.nodeIds[pickedOffset];
  // A pick buffer can outlive a topology update or come from a stale
  // spatial cell. Use the complete node snapshot whenever it is available.
  const cachedNode = editSession.getDisplayedNode(nodeId);
  const baseOffset = pickedOffset * 3;
  return {
    nodeId,
    segmentId: cachedNode?.segmentId ?? segmentId,
    position: new Float32Array(
      cachedNode?.position ??
        geometry.nodePositions.subarray(baseOffset, baseOffset + 3),
    ),
  };
}
