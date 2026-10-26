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

import { describe, expect, it, vi } from "vitest";

import { ChunkState } from "#src/chunk_manager/base.js";
import { SkeletonLayer, SkeletonSource } from "#src/skeleton/frontend.js";
import { NullarySignal } from "#src/util/signal.js";

function makePackedSkeletonChunk(
  positions: readonly (readonly number[])[],
  edges: readonly (readonly [number, number])[],
) {
  return {
    numVertices: positions.length,
    vertexAttributes: new Uint8Array(new Float32Array(positions.flat()).buffer),
    vertexAttributeOffsets: new Uint32Array([0]),
    indices: new Uint32Array(edges.flat()),
  };
}

function makeSkeletonLayer() {
  const source = Object.assign(Object.create(SkeletonSource.prototype), {
    chunks: new Map(),
    chunksChanged: new NullarySignal(),
  });
  const layer = Object.assign(Object.create(SkeletonLayer.prototype), {
    source,
    chunkNodes: new WeakMap(),
  });
  return { source, layer };
}

describe("precomputed skeleton layer", () => {
  it("tells listeners when a segment's skeleton enters or leaves memory", () => {
    const { source, layer } = makeSkeletonLayer();
    const listener = vi.fn();
    layer.nodesChanged.add(listener);
    const chunk = {
      ...makePackedSkeletonChunk(
        [
          [0, 0, 0],
          [10, 0, 0],
        ],
        [[0, 1]],
      ),
      state: ChunkState.SYSTEM_MEMORY,
    };

    source.addChunk("5", chunk);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(layer.getSegmentNodes(5n)).toHaveLength(2);

    source.deleteChunk("5");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(layer.getSegmentNodes(5n)).toBeUndefined();
  });
});
