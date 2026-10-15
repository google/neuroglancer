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

import { expect, it, vi } from "vitest";
import { createCompleteSkeletonSnapshot } from "#src/skeleton/complete_skeleton_snapshot.js";
import {
  SpatialSkeletonLogicalHandleMappings,
  spatialSkeletonLogicalNode,
  spatialSkeletonLogicalSegment,
} from "#src/skeleton/logical_identity.js";
import { SpatialSkeletonOptimisticProjectionRuntime } from "#src/skeleton/optimistic_edit/projection_runtime.js";
import { SpatialSkeletonState } from "#src/skeleton/spatial_skeleton_manager.js";
import { SpatialSkeletonProjectionWorkspace } from "#src/skeleton/spatial_skeleton_projection_reducer.js";

function makeWholeSkeletonReads(
  getSkeleton: (
    skeletonId: bigint,
    options: { signal: AbortSignal },
  ) => unknown,
) {
  return {
    getSkeletonManifest: async () => ({ fragmentKeys: ["skeleton"] }),
    getSkeletonFragment: async (
      skeletonId: bigint,
      _fragmentKey: string,
      signal: AbortSignal,
    ) => ({ nodes: await getSkeleton(skeletonId, { signal }) }),
  };
}

async function flushMicrotasks() {
  for (let iteration = 0; iteration < 10; ++iteration) {
    await Promise.resolve();
  }
}

it("fences a read started during final-node deletion when deletion becomes authoritative", () => {
  const root = { nodeId: 1n, segmentId: 10n, position: [1, 2, 3] };
  const snapshot = createCompleteSkeletonSnapshot([root]);
  const state = new SpatialSkeletonState();
  state.replaceCachedSegmentSnapshots([[10n, [root]]]);
  const segment = spatialSkeletonLogicalSegment("singleton");
  const node = spatialSkeletonLogicalNode("root");
  const mappings = new SpatialSkeletonLogicalHandleMappings<bigint, bigint>();
  mappings.apply({ segments: [[segment, 10n]], nodes: [[node, 1n]] });
  const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state, {
    retainedHistoryWorkspace: new SpatialSkeletonProjectionWorkspace([
      { segment, snapshot },
    ]),
    mappings,
  });
  const deletion = runtime.prepareExact(1, {
    delta: { kind: "delete", segment, node },
  });
  runtime.publishExact(1, deletion.projection);
  expect(state.getCachedNode(1n)).toBeUndefined();
  // Rendering can start another read after the preview evicts the complete
  // snapshot, while CATMAID still has the node. Hold that read's old response.
  const expectedCacheRevisions = new Map([
    [10n, state.getCachedSegmentRevision(10n)],
  ]);
  runtime.publishAuthoritative({
    intentId: 1,
    reconciliation: { retiredResources: [node, segment] },
    activePreviews: [],
  });
  expect(
    runtime.publishAuthoritativeRead([{ segmentId: 10n, snapshot }], {
      expectedCacheRevisions,
    }),
  ).toBe(false);
  expect(state.getCachedNode(1n)).toBeUndefined();
});

it.each([false, true])(
  "fences a retained Merge target read after confirmation (evict survivor: %s)",
  async (evictSurvivor) => {
    const node = (
      nodeId: bigint,
      segmentId: bigint,
      parentNodeId?: bigint,
    ) => ({
      nodeId,
      segmentId,
      parentNodeId,
      position: [Number(nodeId), 2, 3],
    });
    const firstNodes = [node(101n, 11n), node(102n, 11n, 101n)];
    const secondNodes = [node(201n, 17n), node(202n, 17n, 201n)];
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots([
      [11n, firstNodes],
      [17n, secondNodes],
    ]);
    const first = spatialSkeletonLogicalSegment("first");
    const second = spatialSkeletonLogicalSegment("second");
    const from = spatialSkeletonLogicalNode("from");
    const to = spatialSkeletonLogicalNode("to");
    const runtime = new SpatialSkeletonOptimisticProjectionRuntime(state);
    const prepared = runtime.prepareExact(1, {
      delta: {
        kind: "merge",
        firstSegment: first,
        secondSegment: second,
        resultSegment: first,
        firstNode: from,
        secondNode: to,
      },
      inspectionSeed: {
        segments: [
          {
            segment: first,
            snapshot: state.getCachedSegmentSnapshotHandle(11n)!.handle,
          },
          {
            segment: second,
            snapshot: state.getCachedSegmentSnapshotHandle(17n)!.handle,
          },
        ],
        authoritativeBindings: {
          segments: [
            [first, 11n],
            [second, 17n],
          ],
          nodes: [
            [from, 102n],
            [to, 201n],
          ],
        },
        expectedCacheRevisions: new Map(
          [11n, 17n].map((id) => [id, state.getCachedSegmentRevision(id)]),
        ),
      },
    });
    runtime.publishExact(1, prepared.projection);
    expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
    const expectedCacheRevisions = new Map([
      [17n, state.getCachedSegmentRevision(17n)],
    ]);
    let release!: (nodes: typeof secondNodes) => void;
    const response = new Promise<typeof secondNodes>((resolve) => {
      release = resolve;
    });
    // The source deliberately ignores cancellation and delivers its old topology.
    const getSkeleton = vi.fn(
      (_segmentId: bigint, _options: { signal: AbortSignal }) => response,
    );
    const layer = {
      fragmentSource: makeWholeSkeletonReads(getSkeleton),
    } as any;
    const read = state
      .getFullSegmentNodes(layer, 17n, { retainWhileInactive: true })
      .then(
        () => undefined,
        (error) => error,
      );
    await flushMicrotasks();
    expect(getSkeleton).toHaveBeenCalledOnce();
    runtime.publishAuthoritative({
      intentId: 1,
      reconciliation: {
        bindings: {
          segments: [
            [first, 11n],
            [second, 11n],
          ],
        },
        retiredSegmentIds: [17n],
      },
      activePreviews: [],
    });
    expect(getSkeleton.mock.calls[0][1].signal.aborted).toBe(true);
    expect(await read).toMatchObject({ name: "AbortError" });
    expect(state.getCachedSegmentRevision(17n)).toBeGreaterThan(
      expectedCacheRevisions.get(17n)!,
    );
    expect(runtime.resolveSegment(first)).toBe(11n);
    expect(runtime.resolveSegment(second)).toBe(11n);
    if (evictSurvivor) state.evictInactiveSegmentNodes([]);
    release(secondNodes);
    await response;
    // The revision fence also protects publication independently of cancellation.
    expect(
      runtime.publishAuthoritativeRead(
        [
          {
            segmentId: 17n,
            snapshot: createCompleteSkeletonSnapshot(secondNodes),
          },
        ],
        { expectedCacheRevisions },
      ),
    ).toBe(false);
    expect(state.getCachedSegmentNodes(17n)).toBeUndefined();
    if (evictSurvivor) {
      expect(state.getCachedNode(201n)).toBeUndefined();
    } else {
      expect(state.getCachedNode(201n)).toMatchObject({
        segmentId: 11n,
        parentNodeId: 102n,
      });
    }
  },
);
