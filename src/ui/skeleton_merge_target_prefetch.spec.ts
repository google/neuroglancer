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

import { SpatialSkeletonState } from "#src/skeleton/spatial_skeleton_manager.js";
import { SpatialSkeletonMergeTargetPrefetch } from "#src/ui/skeleton_merge_target_prefetch.js";
import { createDeferred } from "#src/util/promise.js";

function makeSkeletonNode(segmentId: number, nodeId: number) {
  return {
    nodeId,
    position: new Float32Array([nodeId, 0, 0]),
    segmentId,
    isTrueEnd: false,
  };
}

function makeSkeletonLayer() {
  const reads = new Map<
    number,
    {
      deferred: ReturnType<
        typeof createDeferred<ReturnType<typeof makeSkeletonNode>[]>
      >;
      signal: AbortSignal | undefined;
    }
  >();
  const getSkeleton = vi.fn(
    (segmentId: number, options?: { signal?: AbortSignal }) => {
      const deferred = createDeferred<ReturnType<typeof makeSkeletonNode>[]>();
      options?.signal?.addEventListener(
        "abort",
        () => deferred.reject(options.signal?.reason),
        { once: true },
      );
      reads.set(segmentId, { deferred, signal: options?.signal });
      return deferred.promise;
    },
  );
  const skeletonLayer = {
    source: {
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton,
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    },
  } as any;
  return { skeletonLayer, getSkeleton, reads };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve));
}

describe("SpatialSkeletonMergeTargetPrefetch", () => {
  it("protects an already-cached merge target before rendering can evict it", () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);
    state.replaceCachedSegmentSnapshots([[7, [makeSkeletonNode(7, 70)]]]);

    prefetch.setTarget(skeletonLayer, 7);
    // Picking can update the target immediately before rendering evicts nodes,
    // without allowing promise callbacks to run between the two operations.
    state.evictInactiveSegmentNodes([]);

    expect(state.getCachedSegmentNodes(7)).toBeDefined();
    expect(getSkeleton).not.toHaveBeenCalled();

    prefetch.clear();
    state.evictInactiveSegmentNodes([]);
    expect(state.getCachedSegmentNodes(7)).toBeUndefined();
  });

  it("keeps the loaded merge target cached while other skeletons are evicted", async () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    prefetch.setTarget(skeletonLayer, 7);
    reads.get(7)!.deferred.resolve([makeSkeletonNode(7, 70)]);
    await flushPromises();
    state.evictInactiveSegmentNodes([]);
    expect(state.getCachedSegmentNodes(7)).toBeDefined();

    prefetch.clear();
    state.evictInactiveSegmentNodes([]);
    expect(state.getCachedSegmentNodes(7)).toBeUndefined();
  });

  it("keeps the merge target cached after its snapshot is replaced while hovered", async () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    prefetch.setTarget(skeletonLayer, 7);
    reads.get(7)!.deferred.resolve([makeSkeletonNode(7, 70)]);
    await flushPromises();
    state.replaceCachedSegmentSnapshots([[7, [makeSkeletonNode(7, 71)]]]);
    prefetch.setTarget(skeletonLayer, 7);
    state.evictInactiveSegmentNodes([]);

    expect(state.getCachedSegmentNodes(7)?.map((node) => node.nodeId)).toEqual([
      71,
    ]);
    expect(getSkeleton).toHaveBeenCalledTimes(1);
  });

  it("cancels the previous target's download when the pointer moves to another skeleton", () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    prefetch.setTarget(skeletonLayer, 7);
    prefetch.setTarget(skeletonLayer, 8);

    expect(reads.get(7)!.signal?.aborted).toBe(true);
    expect(reads.get(8)!.signal?.aborted).toBe(false);
  });

  it("keeps a download the display also awaits when the target changes", () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    void state.getFullSegmentNodes(skeletonLayer, 7).catch(() => undefined);
    prefetch.setTarget(skeletonLayer, 7);
    prefetch.setTarget(skeletonLayer, 8);

    expect(reads.get(7)!.signal?.aborted).toBe(false);
  });

  it("does not retry a failed download while the pointer stays on that skeleton", async () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    prefetch.setTarget(skeletonLayer, 7);
    reads.get(7)!.deferred.reject(new Error("network"));
    await flushPromises();
    prefetch.setTarget(skeletonLayer, 7);

    expect(getSkeleton).toHaveBeenCalledTimes(1);
  });
});
