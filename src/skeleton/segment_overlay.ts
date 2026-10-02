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

// Scratch buffer for GPU-upload-only arrays (segmentIds, selected, edge indices,
// edge segmentIds). Grown monotonically; safe to reuse because SkeletonOverlayChunk
// uploads these to the GPU synchronously and does not retain CPU references to them.
// TODO (SKM): allow to clear or reduce this memory
let gpuScratchBuffer = new ArrayBuffer(0);
let gpuScratchCapacity = 0; // in vertices

// Layout per capacity-slot (cap = gpuScratchCapacity):
//   [0,       cap*4)  — segmentIds  (Uint32, 4 B/vertex)
//   [cap*4,   cap*12) — edgeIndices (Uint32 pairs, 8 B/vertex max)
//   [cap*12,  cap*16) — edgeSegIds  (Uint32, 4 B/vertex max)
function ensureGpuScratch(numVertices: number) {
  if (numVertices > gpuScratchCapacity) {
    const cap = Math.max(numVertices, gpuScratchCapacity * 2, 64);
    gpuScratchBuffer = new ArrayBuffer(cap * 16);
    gpuScratchCapacity = cap;
  }
  const cap = gpuScratchCapacity;
  return {
    segmentIds: new Uint32Array(gpuScratchBuffer, 0, numVertices),
    edgeIndices: new Uint32Array(gpuScratchBuffer, cap * 4, numVertices * 2),
    edgeSegIds: new Uint32Array(gpuScratchBuffer, cap * 12, numVertices),
  };
}

export interface SpatiallyIndexedSkeletonOverlayNodeLike {
  nodeId: number;
  segmentId: number;
  position: ArrayLike<number>;
  parentNodeId?: number;
}

export interface SpatiallyIndexedSkeletonOverlayGeometry {
  positions: Float32Array;
  segmentIds: Uint32Array;
  nodeIds: Int32Array;
  pickSegmentIds: Uint32Array;
  pickEdgeSegmentIds: Uint32Array;
  indices: Uint32Array;
  numVertices: number;
  // Maps nodeId to its packed vertex index. Retained by the overlay chunk so a
  // live node drag can override just the moving vertex's position via a shader
  // uniform, rather than rebuilding or re-uploading the geometry.
  nodeIndex: ReadonlyMap<number, number>;
}

// Writes xyz node positions (one vertex per node, in `orderedNodes` order) into
// `positions`, applying any pending (dragged) position override so the built
// texture is correct at build time. Live-drag position changes between builds
// are applied at render time via a shader uniform, not here.
function writeSpatiallyIndexedSkeletonOverlayNodePositions(
  orderedNodes: readonly SpatiallyIndexedSkeletonOverlayNodeLike[],
  positions: Float32Array,
  getPendingNodePosition?: (nodeId: number) => ArrayLike<number> | undefined,
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
    getPendingNodePosition?: (nodeId: number) => ArrayLike<number> | undefined;
  } = {},
): SpatiallyIndexedSkeletonOverlayGeometry {
  const { getPendingNodePosition } = options;
  const nodeIndex = new Map<number, number>();
  const orderedNodes: SpatiallyIndexedSkeletonOverlayNodeLike[] = [];

  for (const segmentNodes of segmentNodeSets) {
    for (const node of segmentNodes) {
      if (nodeIndex.has(node.nodeId)) continue;
      nodeIndex.set(node.nodeId, orderedNodes.length);
      orderedNodes.push(node);
    }
  }

  const numVertices = orderedNodes.length;

  // CPU-retained arrays: freshly allocated each build because SkeletonOverlayChunk
  // holds references to them for the lifetime of the chunk.
  const positions = new Float32Array(numVertices * 3);
  const nodeIds = new Int32Array(numVertices);
  const pickSegmentIds = new Uint32Array(numVertices);

  // GPU-upload-only arrays: backed by a reusable scratch buffer. The views are
  // valid until SkeletonOverlayChunk uploads them to the GPU (synchronous), after
  // which this buffer is safe to reuse on the next build.
  const scratch = ensureGpuScratch(numVertices);
  const { segmentIds, edgeIndices, edgeSegIds } = scratch;

  writeSpatiallyIndexedSkeletonOverlayNodePositions(
    orderedNodes,
    positions,
    getPendingNodePosition,
  );
  orderedNodes.forEach((node, index) => {
    segmentIds[index] = Math.max(0, Math.round(Number(node.segmentId)));
    pickSegmentIds[index] = segmentIds[index];
    nodeIds[index] = Math.round(Number(node.nodeId));
  });

  let edgeCount = 0;
  orderedNodes.forEach((node) => {
    const childIndex = nodeIndex.get(node.nodeId);
    if (childIndex === undefined) return;
    const parentNodeId = node.parentNodeId;
    if (
      parentNodeId === undefined ||
      !Number.isSafeInteger(parentNodeId) ||
      parentNodeId <= 0
    ) {
      return;
    }
    const parentIndex = nodeIndex.get(parentNodeId);
    if (parentIndex === undefined) return;
    edgeIndices[edgeCount * 2] = childIndex;
    edgeIndices[edgeCount * 2 + 1] = parentIndex;
    edgeSegIds[edgeCount] = segmentIds[childIndex] || segmentIds[parentIndex];
    edgeCount++;
  });

  return {
    positions,
    // Subarray views into the scratch: consumed immediately by GPU upload.
    segmentIds: segmentIds.subarray(0, numVertices),
    nodeIds,
    pickSegmentIds,
    // Compact copy: CPU-retained by SkeletonOverlayChunk for edge picking.
    pickEdgeSegmentIds: edgeSegIds.slice(0, edgeCount),
    // Subarray view: consumed immediately by GLBuffer.fromData.
    indices: edgeIndices.subarray(0, edgeCount * 2),
    numVertices,
    nodeIndex,
  };
}

export const DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS = 24;

function normalizeSegmentId(segmentId: number) {
  const normalizedSegmentId = Math.round(Number(segmentId));
  if (!Number.isSafeInteger(normalizedSegmentId) || normalizedSegmentId <= 0) {
    return undefined;
  }
  return normalizedSegmentId;
}

export function mergeSpatiallyIndexedSkeletonOverlaySegmentIds(
  activeSegmentIds: readonly number[],
  retainedSegmentIds: readonly number[],
) {
  const mergedSegmentIds = new Set<number>();
  for (const segmentId of [...activeSegmentIds, ...retainedSegmentIds]) {
    const normalizedSegmentId = normalizeSegmentId(segmentId);
    if (normalizedSegmentId === undefined) continue;
    mergedSegmentIds.add(normalizedSegmentId);
  }
  return [...mergedSegmentIds].sort((a, b) => a - b);
}

/**
 * Trims to `maxRetained` entries, evicting the oldest (smallest counter)
 * entries first.
 */
function trimRetainedOverlaySegments(
  retainedSegments: Map<number, number>,
  maxRetained: number,
): Map<number, number> {
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
  retainedSegments: ReadonlyMap<number, number>,
  segmentId: number,
  touchCounter: number,
  options: {
    maxRetained?: number;
  } = {},
): Map<number, number> {
  const normalizedSegmentId = normalizeSegmentId(segmentId);
  if (normalizedSegmentId === undefined) {
    return new Map(retainedSegments);
  }
  const nextRetainedSegments = new Map(retainedSegments);
  nextRetainedSegments.set(normalizedSegmentId, touchCounter);
  const maxRetained = Math.max(
    1,
    Math.round(options.maxRetained ?? DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS),
  );
  return trimRetainedOverlaySegments(nextRetainedSegments, maxRetained);
}
