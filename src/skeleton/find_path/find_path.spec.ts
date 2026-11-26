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

import type { SkeletonFindPathEndpoint } from "#src/skeleton/find_path/find_path.js";
import {
  SkeletonDataSourceState,
  SkeletonFindPathState,
} from "#src/skeleton/find_path/find_path.js";

function endpoint(
  nodeId: bigint,
  segmentId = 100n,
  position: ArrayLike<number> = [
    Number(nodeId),
    Number(nodeId) + 1,
    Number(nodeId) + 2,
  ],
): SkeletonFindPathEndpoint {
  return {
    nodeId,
    segmentId,
    position: new Float32Array(position),
  };
}

describe("SkeletonFindPathState", () => {
  it("round-trips uint64 endpoint identities in persisted state", () => {
    const state = new SkeletonFindPathState();
    const largeSegmentId = 9_007_199_254_740_993n;
    state.setEndpoints(
      endpoint(1n, largeSegmentId),
      endpoint(4n, largeSegmentId),
    );
    state.setResult([
      { nodeId: 1n, position: new Float32Array([1, 2, 3]) },
      { nodeId: 3n, position: new Float32Array([3, 4, 5]) },
      { nodeId: 4n, position: new Float32Array([4, 5, 6]) },
    ]);

    const json = state.toJSON();
    expect(json).toEqual({
      source: {
        nodeId: "1",
        segmentId: largeSegmentId.toString(),
        position: [1, 2, 3],
      },
      target: {
        nodeId: "4",
        segmentId: largeSegmentId.toString(),
        position: [4, 5, 6],
      },
      result: [
        { nodeId: "1", position: [1, 2, 3] },
        { nodeId: "3", position: [3, 4, 5] },
        { nodeId: "4", position: [4, 5, 6] },
      ],
    });

    const restored = new SkeletonFindPathState();
    restored.restoreState(json);
    expect(restored.toJSON()).toEqual(json);
    expect(restored.source?.position).toBeInstanceOf(Float32Array);
    expect(restored.result?.map((node) => node.nodeId)).toEqual([1n, 3n, 4n]);
  });

  it.each([
    null,
    [],
    { source: { nodeId: "01", segmentId: "1", position: [1, 2, 3] } },
    { source: { nodeId: "1", segmentId: "-1", position: [1, 2, 3] } },
    { source: { nodeId: "0", segmentId: "1", position: [1, 2, 3] } },
    { target: { nodeId: "1", segmentId: "0", position: [1, 2, 3] } },
    { result: [{ nodeId: "0", position: [1, 2, 3] }] },
    {
      source: {
        nodeId: "18446744073709551616",
        segmentId: "1",
        position: [1, 2, 3],
      },
    },
    { source: { nodeId: "1", segmentId: "1", position: [1, 2] } },
    { source: { nodeId: "1", segmentId: "1", position: [1, NaN, 3] } },
    { result: {} },
  ])("rejects malformed serialized values %#", (json) => {
    expect(() => new SkeletonFindPathState().restoreState(json)).toThrow();
  });

  it("clears the result when either endpoint changes", () => {
    const state = new SkeletonFindPathState();
    state.setEndpoints(endpoint(1n), endpoint(2n));
    state.setResult([endpoint(1n), endpoint(2n)]);
    expect(state.result).toHaveLength(2);

    state.setTarget(endpoint(3n));
    expect(state.result).toBeUndefined();
  });

  it("a change to the skeleton clears the route and keeps both endpoints", () => {
    const state = new SkeletonFindPathState();
    state.setEndpoints(endpoint(1n), endpoint(2n));
    state.setResult([endpoint(1n), endpoint(2n)]);

    expect(state.invalidateResult()).toBe(true);
    expect(state.source?.nodeId).toBe(1n);
    expect(state.target?.nodeId).toBe(2n);
    expect(state.result).toBeUndefined();
  });

  it("clear and reset return the state to its default", () => {
    const state = new SkeletonFindPathState();
    state.setEndpoints(endpoint(1n), endpoint(2n));
    state.setResult([endpoint(1n), endpoint(2n)]);

    expect(state.clear()).toBe(true);
    expect(state.toJSON()).toBeUndefined();
    expect(state.clear()).toBe(false);

    state.setSource(endpoint(3n));
    state.reset();
    expect(state.toJSON()).toBeUndefined();
  });

  it("preserves the other endpoint when one endpoint is removed", () => {
    const state = new SkeletonFindPathState();
    state.setEndpoints(endpoint(1n), endpoint(2n));
    state.setSource(undefined);

    const restored = new SkeletonFindPathState();
    restored.restoreState(state.toJSON());
    expect(restored.source).toBeUndefined();
    expect(restored.target?.nodeId).toBe(2n);
  });
});

describe("SkeletonDataSourceState", () => {
  it("omits empty state before use and after Clear", () => {
    const state = new SkeletonDataSourceState();

    expect(state.toJSON()).toBeUndefined();

    state.findPathState.setSource(endpoint(1n));
    expect(state.toJSON()?.findPath?.source?.nodeId).toBe("1");

    state.findPathState.clear();
    expect(state.toJSON()).toBeUndefined();
  });

  it("saves and restores Find Path in the layer's saved state", () => {
    const state = new SkeletonDataSourceState();
    state.findPathState.setEndpoints(endpoint(1n, 7n), endpoint(3n, 7n));

    expect(state.toJSON()).toEqual({
      findPath: {
        source: { nodeId: "1", segmentId: "7", position: [1, 2, 3] },
        target: { nodeId: "3", segmentId: "7", position: [3, 4, 5] },
      },
    });

    const restored = new SkeletonDataSourceState(state.toJSON());
    expect(restored.toJSON()).toEqual(state.toJSON());
  });

  it("saves the layer state whenever a Find Path endpoint or route changes", () => {
    const state = new SkeletonDataSourceState();
    let changes = 0;
    state.changed.add(() => ++changes);
    state.findPathState.setEndpoints(endpoint(1n), endpoint(2n));
    state.findPathState.setResult([endpoint(1n), endpoint(2n)]);

    expect(changes).toBe(3);
    expect(state.toJSON()?.findPath?.result).toHaveLength(2);
  });

  it("rejects malformed datasource state", () => {
    expect(
      () =>
        new SkeletonDataSourceState({
          findPath: {
            source: { nodeId: "-1", segmentId: "1", position: [1, 2, 3] },
          },
        }),
    ).toThrow();
  });
});
