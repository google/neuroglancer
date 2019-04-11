/**
 * @license
 * Copyright 2019 Google Inc.
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
 * @file Conversion from independent triangles to triangle strips.
 *
 * http://www.codercorner.com/Strips.htm
 */

import {hashCombine} from 'neuroglancer/gpu_hash/hash_function';

const DEBUG_TIMING = false;

/**
 * Sorts the vertex indices for each triangle in ascending order.
 *
 * This ensures later edge comparisons can be done more efficiently.  This can reverse face
 * orientations, which would normally be a problem, but since we render all faces as double-sided it
 * isn't an issue.
 */
function normalizeTriangleVertexOrder(indices: Uint32Array|Uint16Array) {
  let maxVertex = 0;
  for (let i = 0, length = indices.length; i < length; i += 3) {
    let a = indices[i], b = indices[i + 1], c = indices[i + 2];
    let t: number;
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    if (b > c) {
      t = b;
      b = c;
      c = t;
    }
    if (a > b) {
      t = a;
      a = b;
      b = t;
    }
    indices[i] = a;
    indices[i + 1] = b;
    indices[i + 2] = c;
    if (c > maxVertex) maxVertex = c;
  }
  return maxVertex;
}

let collisions = 0;
function hashTableInsert(
    table: Uint32Array, numBuckets: number, value: number, emptyValue: number, hashCode: number,
    equals: (x: number) => boolean) {
  const mask = (numBuckets - 1) >>> 0;
  let bucket = (hashCode & mask) >>> 0;
  for (let probe = 0; true; ++probe) {
    const x = table[bucket];
    if (x === emptyValue) {
      table[bucket] = value;
      return value;
    }
    if (equals(x)) {
      return x;
    }
    ++collisions;
    bucket = ((bucket + probe + 1) & mask) >>> 0;
  }
}

function hashEdge(a: number, b: number) {
  return hashCombine(hashCombine(0, a), b);
}

// edgeIndex: 0, 1, 2
// vertexA:   0  0  1   <-  bit 1
// vertexB:   1  2  2   <-  1 + bit 1  of (edgeIndex + 1)
// vertexC:   2  1  0   <-  2 - edgeIndex

// BC         2  2  1
// BC flipped 0  1  1
// AC         1  0  0
// AC flipped 0  0  1

// Lookup table, where the 3 bits starting at (edgeIndex * 3 + flipped * 12) specify the new value
// of `edgeIndexAndFlipped`.
const nextEdgeTable = 0b1_00_0_00_0_01_000_1_01_1_10_0_10;

/**
 * Computes the edge index and flipped state in a triangle strip for the next edge after the given
 * edge.
 *
 * @param edgeIndexAndFlipped Bits 0,1 specify the `edgeIndex` in the range `[0, 2]` corresponding
 *     to the last edge that was traversed.  Bit 2 specifies the `flipped` state.  If `flipped` is
 *     equal to 0, the last two emitted vertices are B and C relative to `edgeIndex`.  If `flipped`
 *     is equal to 1, the last two emitted vertices are A and C relative to `edgeIndex`.
 * @returns The next `edgeIndexAndFlipped` value specifying `nextEdgeIndex` and `nextFlipped`.  If
 *     `flipped == 0`, `nextEdgeIndex` corresponds to the B-C edge relative to `edgeIndex`; if
 *     `flipped == 1`, `nextEdgeIndex` correspond to the A-C edge relative to `edgeIndex`.  The
 *     `nextFlipped` value is equal to 1 iff `vertexCIndex(edgeIndex) ==
 *     vertexAIndex(nextEdgeIndex)`.
 */
export function getNextEdge(edgeIndexAndFlipped: number) {
  return (nextEdgeTable >>> (edgeIndexAndFlipped * 3)) & 7;
}

export function getBaseIndex(entry: number) {
  return (entry >>> 2) * 3;
}

export function getEdgeIndex(entry: number) {
  return entry & 3;
}

/**
 * Computes the first vertex offset for the given edge.
 *
 * @returns `[0, 0, 1][edgeIndex]`
 */
export function vertexAIndex(edgeIndex: number) {
  return edgeIndex >>> 1;
}

/**
 * Computes the second vertex offset for the given edge.
 *
 * @returns `[1, 2, 2][edgeIndex]`
 */
export function vertexBIndex(edgeIndex: number) {
  return 1 + ((edgeIndex + 1) >>> 1);
}

/**
 * Computes the opposite vertex offset for the given edge.
 *
 * @returns `[2, 1, 0][edgeIndex]`
 */
export function vertexCIndex(edgeIndex: number) {
  return 2 - edgeIndex;
}

export function getEdgeMapSize(numIndices: number) {
  const numEdges = numIndices;

  // Choose quadratic probing hash table size to be the smallest power of 2 greater than `numEdges`.
  const edgeMapSize = 2 ** Math.ceil(Math.log2(numEdges));
  return edgeMapSize * 4;
}

function computeTriangleAdjacencies(
    triangleAdjacencies: Uint32Array, indices: Uint32Array|Uint16Array,
    edgeMap: Uint32Array): Uint32Array {
  const numTriangles = indices.length / 3;
  // Row-major array of shape `[numTriangles, 3]` specifying the triangles adjacent to each
  // triangle.  The triangle index `i` corresponds to elements `[i * 3, (i + 1) * 3)` of the
  // `indices` array.  For each triangle, columns 0 to 2 are the indices of the triangles adjacent
  // to edge 0-1, edge 0-2, and edge 1-2, respectively.

  const edgeMapSize = edgeMap.length;
  const emptyEntry = 0xFFFFFFFF;
  triangleAdjacencies.fill(emptyEntry);
  edgeMap.fill(emptyEntry);

  // Insert edges
  for (let triangle = 0; triangle < numTriangles; ++triangle) {
    const baseIndex = triangle * 3;
    for (let edgeIndex = 0; edgeIndex < 3; ++edgeIndex) {
      const vertexA0 = indices[baseIndex + vertexAIndex(edgeIndex)];
      const vertexB0 = indices[baseIndex + vertexBIndex(edgeIndex)];
      const newEntry = (triangle << 2) | edgeIndex;
      const existingEntry = hashTableInsert(
          edgeMap, edgeMapSize, newEntry, emptyEntry, hashEdge(vertexA0, vertexB0), x => {
            const otherBaseIndex = getBaseIndex(x);
            const otherEdgeIndex = getEdgeIndex(x);
            const vertexA1 = indices[otherBaseIndex + vertexAIndex(otherEdgeIndex)];
            const vertexB1 = indices[otherBaseIndex + vertexBIndex(otherEdgeIndex)];
            // console.log('checking equality', vertexA0, vertexA1, vertexB0, vertexB1);
            return vertexA0 === vertexA1 && vertexB0 === vertexB1;
          });
      if (existingEntry !== newEntry) {
        const otherBaseIndex = getBaseIndex(existingEntry);
        const otherEdgeIndex = getEdgeIndex(existingEntry);
        triangleAdjacencies[otherBaseIndex + otherEdgeIndex] = newEntry;
        triangleAdjacencies[baseIndex + edgeIndex] = existingEntry;
      }
    }
  }

  return triangleAdjacencies;
}

function emitTriangleStrips(
    indices: Uint16Array|Uint32Array, triangleAdjacencies: Uint32Array,
    output: Uint16Array|Uint32Array, outputIndex: number): number {
  const invalidVertex = ~0 >>> (32 - 8 * output.BYTES_PER_ELEMENT);
  const numIndices = indices.length;
  const numTriangles = numIndices / 3;
  const emptyEntry = 0xFFFFFFFF;

  // Extract strips
  startNewStrip: for (let triangle = 0; triangle < numTriangles; ++triangle) {
    let baseIndex = triangle * 3;
    if (indices[baseIndex] === invalidVertex) {
      // Triangle was already emitted.
      continue;
    }
    for (let edgeIndex = 0; edgeIndex < 3; ++edgeIndex) {
      let entry = triangleAdjacencies[baseIndex + edgeIndex];
      if (entry === emptyEntry) continue;
      let otherBaseIndex = getBaseIndex(entry);
      if (indices[otherBaseIndex] === invalidVertex) continue;
      let otherEdgeIndex = getEdgeIndex(entry);
      output[outputIndex++] = indices[baseIndex + vertexCIndex(edgeIndex)];
      output[outputIndex++] = indices[baseIndex + vertexAIndex(edgeIndex)];
      output[outputIndex++] = indices[baseIndex + vertexBIndex(edgeIndex)];

      let edgeIndexAndFlipped = otherEdgeIndex;

      while (true) {
        indices[baseIndex] = invalidVertex;
        baseIndex = otherBaseIndex;
        output[outputIndex++] = indices[baseIndex + vertexCIndex(edgeIndexAndFlipped & 3)];

        edgeIndexAndFlipped = getNextEdge(edgeIndexAndFlipped);

        entry = triangleAdjacencies[baseIndex + (edgeIndexAndFlipped & 3)];
        if (entry === emptyEntry ||
            indices[(otherBaseIndex = getBaseIndex(entry))] === invalidVertex) {
          // console.log(stripLength);
          // End of strip.  Emit restart index.
          output[outputIndex++] = invalidVertex;
          indices[baseIndex] = invalidVertex;
          continue startNewStrip;
        }
        edgeIndexAndFlipped = getEdgeIndex(entry) | (edgeIndexAndFlipped & 4);
      }
    }
    // Emit isolated triangle.
    output[outputIndex++] = indices[baseIndex];
    output[outputIndex++] = indices[baseIndex + 1];
    output[outputIndex++] = indices[baseIndex + 2];
    indices[baseIndex] = invalidVertex;
    output[outputIndex++] = invalidVertex;
  }
  return outputIndex;
}

export function computeTriangleStrips<T extends Uint32Array|Uint16Array>(
    indices: T, subChunkOffsets?: Uint32Array): Uint16Array|Uint32Array {
  if (indices.length === 0) return indices;
  collisions = 0;
  if (subChunkOffsets === undefined) {
    subChunkOffsets = Uint32Array.of(0, indices.length);
  }
  let adjacenciesElapsed = 0;
  let emitElapsed = 0;
  let startTime = 0, midTime = 0, endTime = 0;

  const maxVertexIndex = normalizeTriangleVertexOrder(indices);
  const outputBufferSize = indices.length / 3 * 4;
  const output = maxVertexIndex >= 65535 ? new Uint32Array(outputBufferSize) :
                                           new Uint16Array(outputBufferSize);
  let outputIndex = 0;

  let maxSubChunkIndices = 0;
  const numSubChunks = subChunkOffsets.length - 1;
  for (let subChunk = 0; subChunk < numSubChunks; ++subChunk) {
    maxSubChunkIndices =
        Math.max(maxSubChunkIndices, subChunkOffsets[subChunk + 1] - subChunkOffsets[subChunk]);
  }

  const triangleAdjacencies = new Uint32Array(maxSubChunkIndices);
  const edgeMap = new Uint32Array(getEdgeMapSize(maxSubChunkIndices));

  let subChunkOffset = subChunkOffsets[0];
  for (let subChunk = 0; subChunk < numSubChunks; ++subChunk) {
    subChunkOffsets[subChunk] = outputIndex;
    const subChunkEnd = subChunkOffsets[subChunk + 1];
    const subIndices = indices.subarray(subChunkOffset, subChunkEnd);
    if (DEBUG_TIMING) startTime = Date.now();
    computeTriangleAdjacencies(triangleAdjacencies, subIndices, edgeMap);
    if (DEBUG_TIMING) midTime = Date.now();
    outputIndex = emitTriangleStrips(subIndices, triangleAdjacencies, output, outputIndex);
    if (DEBUG_TIMING) {
      endTime = Date.now();
      adjacenciesElapsed += (midTime - startTime);
      emitElapsed += (endTime - midTime);
    }
    subChunkOffset = subChunkEnd;
  }
  --outputIndex;
  subChunkOffsets[numSubChunks] = outputIndex;
  const shrunkOutput: T = new (output.constructor as any)(outputIndex);
  shrunkOutput.set(output.subarray(0, outputIndex));
  if (DEBUG_TIMING) {
    console.log(`reduced from ${indices.byteLength}(${indices.BYTES_PER_ELEMENT}) -> ${
        shrunkOutput.byteLength}(${shrunkOutput.BYTES_PER_ELEMENT}): adj=${
        adjacenciesElapsed}, emit=${emitElapsed}, ${collisions}/${indices.length} collisions`);
  }
  return shrunkOutput;
}
