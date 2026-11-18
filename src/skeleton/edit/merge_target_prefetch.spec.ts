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

import { SkeletonEdgeDirection, type SkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonMergeTargetPrefetch } from "#src/skeleton/edit/merge_target_prefetch.js";
import { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";

function makeWholeSkeletonReads(
  getSkeleton: (
    skeletonId: bigint,
    options: { signal: AbortSignal },
  ) => unknown,
) {
  return {
    edgeDirection: SkeletonEdgeDirection.CHILD_TO_PARENT,
    getSkeletonManifest: async () => ({ fragmentKeys: ["skeleton"] }),
    getSkeletonFragment: async (
      skeletonId: bigint,
      _fragmentKey: string,
      signal: AbortSignal,
    ) => {
      const skeletonNodes = (await getSkeleton(skeletonId, {
        signal,
      })) as SkeletonNode[];
      return {
        nodes: skeletonNodes.map(({ parentNodeId: _, ...node }) => node),
        edges: skeletonNodes.flatMap(({ nodeId, parentNodeId }) =>
          parentNodeId === undefined
            ? []
            : [{ firstNodeId: nodeId, secondNodeId: parentNodeId }],
        ),
      };
    },
  };
}

function makeSkeletonNode(segmentId: bigint, nodeId: bigint) {
  return {
    nodeId,
    position: new Float32Array([Number(nodeId), 0, 0]),
    segmentId,
    isTrueEnd: false,
  };
}

function makeSkeletonLayer() {
  const reads = new Map<
    bigint,
    {
      deferred: PromiseWithResolvers<ReturnType<typeof makeSkeletonNode>[]>;
      signal: AbortSignal | undefined;
    }
  >();
  const getSkeleton = vi.fn(
    (segmentId: bigint, options?: { signal?: AbortSignal }) => {
      const deferred =
        Promise.withResolvers<ReturnType<typeof makeSkeletonNode>[]>();
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
    fragmentSource: makeWholeSkeletonReads(getSkeleton),
  } as any;
  return { skeletonLayer, getSkeleton, reads };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve));
}

describe("SpatialSkeletonMergeTargetPrefetch", () => {
  it("protects an already-cached merge target before rendering can evict it", () => {
    const state = new SpatialSkeletonEditSession();
    const { skeletonLayer, getSkeleton } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);
    state.replaceCachedSegmentSnapshots([[7n, [makeSkeletonNode(7n, 70n)]]]);

    prefetch.setTarget(skeletonLayer, 7n);
    // Picking can update the target immediately before rendering evicts nodes,
    // without allowing promise callbacks to run between the two operations.
    state.evictInactiveSegmentNodes([]);

    expect(state.getCachedSegmentNodes(7n)).toBeDefined();
    expect(getSkeleton).not.toHaveBeenCalled();

    prefetch.clear();
    state.evictInactiveSegmentNodes([]);
    expect(state.getCachedSegmentNodes(7n)).toBeUndefined();
  });

  it("keeps the loaded merge target cached while other skeletons are evicted", async () => {
    const state = new SpatialSkeletonEditSession();
    const { skeletonLayer, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    prefetch.setTarget(skeletonLayer, 7n);
    await flushPromises();
    reads.get(7n)!.deferred.resolve([makeSkeletonNode(7n, 70n)]);
    await flushPromises();
    state.evictInactiveSegmentNodes([]);
    expect(state.getCachedSegmentNodes(7n)).toBeDefined();

    prefetch.clear();
    state.evictInactiveSegmentNodes([]);
    expect(state.getCachedSegmentNodes(7n)).toBeUndefined();
  });

  it("keeps the merge target cached after an edit changes it while hovered", async () => {
    const state = new SpatialSkeletonEditSession();
    const { skeletonLayer, getSkeleton, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    prefetch.setTarget(skeletonLayer, 7n);
    await flushPromises();
    reads.get(7n)!.deferred.resolve([makeSkeletonNode(7n, 70n)]);
    await flushPromises();
    state.replaceCachedSegmentSnapshots([[7n, [makeSkeletonNode(7n, 71n)]]]);
    prefetch.setTarget(skeletonLayer, 7n);
    state.evictInactiveSegmentNodes([]);

    expect(state.getCachedSegmentNodes(7n)?.map((node) => node.nodeId)).toEqual(
      [71n],
    );
    expect(getSkeleton).toHaveBeenCalledTimes(1);
  });

  it("never downloads the previous target when the pointer moves to another skeleton", async () => {
    const state = new SpatialSkeletonEditSession();
    const { skeletonLayer, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    prefetch.setTarget(skeletonLayer, 7n);
    prefetch.setTarget(skeletonLayer, 8n);
    await flushPromises();

    expect(reads.has(7n)).toBe(false);
    expect(reads.get(8n)!.signal?.aborted).toBe(false);
  });

  it("keeps a download the display also awaits when the target changes", async () => {
    const state = new SpatialSkeletonEditSession();
    const { skeletonLayer, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    void state.getFullSegmentNodes(skeletonLayer, 7n).catch(() => undefined);
    prefetch.setTarget(skeletonLayer, 7n);
    prefetch.setTarget(skeletonLayer, 8n);
    await flushPromises();

    expect(reads.get(7n)!.signal?.aborted).toBe(false);
  });

  it("does not retry a failed download while the pointer stays on that skeleton", async () => {
    const state = new SpatialSkeletonEditSession();
    const { skeletonLayer, getSkeleton, reads } = makeSkeletonLayer();
    const prefetch = new SpatialSkeletonMergeTargetPrefetch(state);

    prefetch.setTarget(skeletonLayer, 7n);
    await flushPromises();
    reads.get(7n)!.deferred.reject(new Error("network"));
    await flushPromises();
    prefetch.setTarget(skeletonLayer, 7n);

    expect(getSkeleton).toHaveBeenCalledTimes(1);
  });
});
