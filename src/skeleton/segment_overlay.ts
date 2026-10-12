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
 * @file GPU geometry and segment retention used for the skeleton overlay rendering pass.
 */

import { bigintCompare } from "#src/util/bigint.js";

export interface SpatiallyIndexedSkeletonOverlayNodeLike {
  nodeId: bigint;
  segmentId: bigint;
  position: ArrayLike<number>;
  parentNodeId?: bigint;
}

export interface SpatiallyIndexedSkeletonOverlayGeometry {
  positions: Float32Array;
  segmentIds: BigUint64Array;
  nodeIds: BigUint64Array;
  indices: Uint32Array;
  numVertices: number;
  // Maps nodeId to its packed vertex index. Retained by the overlay chunk so a
  // live node drag can override just the moving vertex's position via a shader
  // uniform, rather than rebuilding or re-uploading the geometry.
  nodeIndex: ReadonlyMap<bigint, number>;
}

// Writes xyz node positions (one vertex per node, in `orderedNodes` order) into
// `positions`, applying any pending (dragged) position override so the built
// texture is correct at build time. Live-drag position changes between builds
// are applied at render time via a shader uniform, not here.
function writeSpatiallyIndexedSkeletonOverlayNodePositions(
  orderedNodes: readonly SpatiallyIndexedSkeletonOverlayNodeLike[],
  positions: Float32Array,
  getPendingNodePosition?: (nodeId: bigint) => ArrayLike<number> | undefined,
) {
  for (let index = 0; index < orderedNodes.length; ++index) {
    const node = orderedNodes[index];
    const position = getPendingNodePosition?.(node.nodeId) ?? node.position;
    const baseOffset = index * 3;
    positions[baseOffset] = Number(position[0] ?? 0);
    positions[baseOffset + 1] = Number(position[1] ?? 0);
    positions[baseOffset + 2] = Number(position[2] ?? 0);
  }
}

export function buildSpatiallyIndexedSkeletonOverlayGeometry(
  segmentNodeSets: readonly (readonly SpatiallyIndexedSkeletonOverlayNodeLike[])[],
  options: {
    getPendingNodePosition?: (nodeId: bigint) => ArrayLike<number> | undefined;
  } = {},
): SpatiallyIndexedSkeletonOverlayGeometry {
  const { getPendingNodePosition } = options;
  const nodeIndex = new Map<bigint, number>();
  const orderedNodes: SpatiallyIndexedSkeletonOverlayNodeLike[] = [];

  for (const segmentNodes of segmentNodeSets) {
    for (const node of segmentNodes) {
      if (nodeIndex.has(node.nodeId)) continue;
      nodeIndex.set(node.nodeId, orderedNodes.length);
      orderedNodes.push(node);
    }
  }

  const numVertices = orderedNodes.length;
  const positions = new Float32Array(numVertices * 3);
  const nodeIds = new BigUint64Array(numVertices);
  const segmentIds = new BigUint64Array(numVertices);
  writeSpatiallyIndexedSkeletonOverlayNodePositions(
    orderedNodes,
    positions,
    getPendingNodePosition,
  );
  orderedNodes.forEach((node, index) => {
    segmentIds[index] = node.segmentId;
    nodeIds[index] = node.nodeId;
  });

  const indices: number[] = [];
  orderedNodes.forEach((node, childIndex) => {
    if (node.parentNodeId === undefined) return;
    const parentIndex = nodeIndex.get(node.parentNodeId);
    if (parentIndex === undefined) return;
    indices.push(childIndex, parentIndex);
  });

  return {
    positions,
    segmentIds,
    nodeIds,
    indices: new Uint32Array(indices),
    numVertices,
    nodeIndex,
  };
}

export const DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS = 24;

export function mergeSpatiallyIndexedSkeletonOverlaySegmentIds(
  activeSegmentIds: readonly bigint[],
  retainedSegmentIds: readonly bigint[],
) {
  const mergedSegmentIds = new Set<bigint>();
  for (const segmentId of [...activeSegmentIds, ...retainedSegmentIds]) {
    if (segmentId === 0n) continue;
    mergedSegmentIds.add(segmentId);
  }
  return [...mergedSegmentIds].sort(bigintCompare);
}

/**
 * Trims to `maxRetained` entries, evicting the oldest (smallest counter)
 * entries first.
 */
function trimRetainedOverlaySegments(
  retainedSegments: Map<bigint, number>,
  maxRetained: number,
): Map<bigint, number> {
  const excess = retainedSegments.size - maxRetained;
  if (excess <= 0) {
    return retainedSegments;
  }
  const oldestSegmentIdsFirst = [...retainedSegments.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([candidateSegmentId]) => candidateSegmentId);
  const nextRetainedSegments = new Map(retainedSegments);
  for (const candidateSegmentId of oldestSegmentIdsFirst.slice(0, excess)) {
    nextRetainedSegments.delete(candidateSegmentId);
  }
  return nextRetainedSegments;
}

/**
 * Adds or refreshes `segmentId` at recency `touchCounter`, then trims to
 * `maxRetained` by evicting the oldest-touched entries. Only the relative
 * order of `touchCounter` values across entries matters.
 */
export function retainSpatiallyIndexedSkeletonOverlaySegment(
  retainedSegments: ReadonlyMap<bigint, number>,
  segmentId: bigint,
  touchCounter: number,
  options: {
    maxRetained?: number;
  } = {},
): Map<bigint, number> {
  if (segmentId === 0n) {
    return new Map(retainedSegments);
  }
  const nextRetainedSegments = new Map(retainedSegments);
  nextRetainedSegments.set(segmentId, touchCounter);
  const maxRetained = Math.max(
    1,
    Math.round(options.maxRetained ?? DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS),
  );
  return trimRetainedOverlaySegments(nextRetainedSegments, maxRetained);
}
