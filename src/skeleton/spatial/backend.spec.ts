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

import { describe, expect, it } from "vitest";

import { numChunkStatistics } from "#src/chunk_manager/base.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import {
  SpatiallyIndexedSkeletonChunk,
  SpatiallyIndexedSkeletonSourceBackend,
} from "#src/skeleton/spatial/backend.js";

function makeSpatialSkeletonChunk() {
  const chunk = new SpatiallyIndexedSkeletonChunk();
  chunk.source = {
    statistics: new Float64Array(numChunkStatistics),
    chunkManager: {
      queueManager: {
        adjustCapacitiesForChunk() {},
        scheduleUpdate() {},
        moveChunkToFrontend() {},
        updateChunkState() {},
      },
    },
  } as unknown as SpatiallyIndexedSkeletonSourceBackend;
  chunk.chunkGridPosition = Float32Array.of(0, 0, 0);
  return chunk;
}

describe("skeleton/backend spatial chunk memory", () => {
  it("counts every array a spatial skeleton chunk sends to the frontend toward its memory budget", () => {
    const chunk = makeSpatialSkeletonChunk();
    chunk.vertexPositions = Float32Array.of(1, 2, 3, 4, 5, 6);
    chunk.indices = Uint32Array.of(0, 1);
    chunk.nodeIds = BigUint64Array.of(2n ** 63n, 7n);
    chunk.segmentIds = BigUint64Array.of(2n ** 40n, 2n ** 40n);
    chunk.downloadSucceeded();

    const transfers: ArrayBuffer[] = [];
    chunk.serialize({}, transfers);
    const transferredBytes = transfers.reduce(
      (total, buffer) => total + buffer.byteLength,
      0,
    );
    const positionBytes = 2 * 3 * 4;
    const indexBytes = 2 * 4;
    const nodeIdBytes = 2 * 8;
    const segmentIdBytes = 2 * 8;
    expect(transferredBytes).toBe(
      positionBytes + indexBytes + nodeIdBytes + segmentIdBytes,
    );
    expect(chunk.systemMemoryBytes).toBe(transferredBytes);
  });
});

function makeSpatialIndexSource(nodes: SkeletonNode[]) {
  const source = Object.create(
    SpatiallyIndexedSkeletonSourceBackend.prototype,
  ) as SpatiallyIndexedSkeletonSourceBackend;
  source.downloadChunk = async () => nodes;
  return source;
}

function makeChunk() {
  const chunk = new SpatiallyIndexedSkeletonChunk();
  chunk.chunkGridPosition = Float32Array.of(0, 0, 0);
  return chunk;
}

describe("skeleton/backend chunk download", () => {
  it("draws an edge to a parent only when the parent is in the same chunk", async () => {
    const source = makeSpatialIndexSource([
      { nodeId: 1n, position: [1, 2, 3], segmentId: 10n },
      { nodeId: 2n, parentNodeId: 1n, position: [4, 5, 6], segmentId: 10n },
      { nodeId: 3n, parentNodeId: 99n, position: [7, 8, 9], segmentId: 11n },
    ]);
    const chunk = makeChunk();

    await source.download(chunk, new AbortController().signal);

    expect(chunk.vertexPositions).toEqual(
      Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
    );
    expect(chunk.segmentIds).toEqual(BigUint64Array.of(10n, 10n, 11n));
    expect(chunk.indices).toEqual(Uint32Array.of(1, 0));
    expect(chunk.nodeIds).toEqual(BigUint64Array.of(1n, 2n, 3n));
  });

  it("never joins two skeletons that reuse a node id", async () => {
    const source = makeSpatialIndexSource([
      { nodeId: 0n, position: [1, 2, 3], segmentId: 10n },
      { nodeId: 1n, parentNodeId: 0n, position: [4, 5, 6], segmentId: 10n },
      { nodeId: 0n, position: [7, 8, 9], segmentId: 11n },
      { nodeId: 1n, parentNodeId: 0n, position: [10, 11, 12], segmentId: 11n },
    ]);
    const chunk = makeChunk();

    await source.download(chunk, new AbortController().signal);

    expect(chunk.indices).toEqual(Uint32Array.of(1, 0, 3, 2));
  });

  it("keeps skeleton and node IDs above 2^32 exact in a downloaded chunk", async () => {
    const source = makeSpatialIndexSource([
      {
        nodeId: 2n ** 53n + 1n,
        position: [1, 2, 3],
        segmentId: 2n ** 63n + 5n,
      },
      {
        nodeId: 4_294_967_297n,
        parentNodeId: 2n ** 53n + 1n,
        position: [4, 5, 6],
        segmentId: 2n ** 63n + 5n,
      },
    ]);
    const chunk = makeChunk();

    await source.download(chunk, new AbortController().signal);

    expect(chunk.segmentIds).toEqual(
      BigUint64Array.of(2n ** 63n + 5n, 2n ** 63n + 5n),
    );
    expect(chunk.nodeIds).toEqual(
      BigUint64Array.of(2n ** 53n + 1n, 4_294_967_297n),
    );
    expect(chunk.indices).toEqual(Uint32Array.of(1, 0));
  });
});
