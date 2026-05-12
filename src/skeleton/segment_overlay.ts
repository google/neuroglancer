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
//   [cap*4,   cap*8)  — selected    (Float32, 4 B/vertex)
//   [cap*8,   cap*16) — edgeIndices (Uint32 pairs, 8 B/vertex max)
//   [cap*16,  cap*20) — edgeSegIds  (Uint32, 4 B/vertex max)
function ensureGpuScratch(numVertices: number) {
  if (numVertices > gpuScratchCapacity) {
    const cap = Math.max(numVertices, gpuScratchCapacity * 2, 64);
    gpuScratchBuffer = new ArrayBuffer(cap * 20);
    gpuScratchCapacity = cap;
  }
  const cap = gpuScratchCapacity;
  return {
    segmentIds: new Uint32Array(gpuScratchBuffer, 0, numVertices),
    selected: new Float32Array(gpuScratchBuffer, cap * 4, numVertices),
    edgeIndices: new Uint32Array(gpuScratchBuffer, cap * 8, numVertices * 2),
    edgeSegIds: new Uint32Array(gpuScratchBuffer, cap * 16, numVertices),
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
  selected: Float32Array;
  nodeIds: Int32Array;
  pickSegmentIds: Uint32Array;
  pickEdgeSegmentIds: Uint32Array;
  indices: Uint32Array;
  numVertices: number;
}

export function buildSpatiallyIndexedSkeletonOverlayGeometry(
  segmentNodeSets: readonly (readonly SpatiallyIndexedSkeletonOverlayNodeLike[])[],
  options: {
    selectedNodeId?: number;
    getPendingNodePosition?: (nodeId: number) => ArrayLike<number> | undefined;
  } = {},
): SpatiallyIndexedSkeletonOverlayGeometry {
  const { selectedNodeId, getPendingNodePosition } = options;
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
  const { segmentIds, selected, edgeIndices, edgeSegIds } = scratch;

  orderedNodes.forEach((node, index) => {
    const position = getPendingNodePosition?.(node.nodeId) ?? node.position;
    const baseOffset = index * 3;
    positions[baseOffset] = Number(position[0] ?? 0);
    positions[baseOffset + 1] = Number(position[1] ?? 0);
    positions[baseOffset + 2] = Number(position[2] ?? 0);
    segmentIds[index] = Math.max(0, Math.round(Number(node.segmentId)));
    pickSegmentIds[index] = segmentIds[index];
    nodeIds[index] = Math.round(Number(node.nodeId));
    selected[index] =
      selectedNodeId !== undefined && node.nodeId === selectedNodeId ? 1 : 0;
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
    selected: selected.subarray(0, numVertices),
    nodeIds,
    pickSegmentIds,
    // Compact copy: CPU-retained by SkeletonOverlayChunk for edge picking.
    pickEdgeSegmentIds: edgeSegIds.slice(0, edgeCount),
    // Subarray view: consumed immediately by GLBuffer.fromData.
    indices: edgeIndices.subarray(0, edgeCount * 2),
    numVertices,
  };
}

export const DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS = 4;

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

export function retainSpatiallyIndexedSkeletonOverlaySegment(
  retainedSegmentIds: readonly number[],
  segmentId: number,
  options: {
    maxRetained?: number;
  } = {},
) {
  const normalizedSegmentId = normalizeSegmentId(segmentId);
  if (normalizedSegmentId === undefined) {
    return [...retainedSegmentIds];
  }
  const nextRetainedSegmentIds = retainedSegmentIds.filter(
    (candidateSegmentId) => candidateSegmentId !== normalizedSegmentId,
  );
  nextRetainedSegmentIds.push(normalizedSegmentId);
  const maxRetained = Math.max(
    1,
    Math.round(options.maxRetained ?? DEFAULT_MAX_RETAINED_OVERLAY_SEGMENTS),
  );
  if (nextRetainedSegmentIds.length <= maxRetained) {
    return nextRetainedSegmentIds;
  }
  return nextRetainedSegmentIds.slice(
    nextRetainedSegmentIds.length - maxRetained,
  );
}
