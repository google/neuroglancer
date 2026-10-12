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

// Regression coverage for confirmed retirement; see the automated-test guide.
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

it("fences a read started during final-node deletion when deletion becomes authoritative", () => {
  const root = { nodeId: 1, segmentId: 10, position: [1, 2, 3] };
  const snapshot = createCompleteSkeletonSnapshot([root]);
  const state = new SpatialSkeletonState();
  state.replaceCachedSegmentSnapshots([[10, [root]]]);
  const segment = spatialSkeletonLogicalSegment("singleton");
  const node = spatialSkeletonLogicalNode("root");
  const mappings = new SpatialSkeletonLogicalHandleMappings<number, number>();
  mappings.apply({ segments: [[segment, 10]], nodes: [[node, 1]] });
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
  expect(state.getCachedNode(1)).toBeUndefined();
  // Rendering can start another read after the preview evicts the complete
  // snapshot, while CATMAID still has the node. Hold that read's old response.
  const expectedCacheRevisions = new Map([
    [10, state.getCachedSegmentRevision(10)],
  ]);
  runtime.publishAuthoritative({
    intentId: 1,
    reconciliation: { retiredResources: [node, segment] },
    activePreviews: [],
  });
  expect(
    runtime.publishAuthoritativeRead([{ segmentId: 10, snapshot }], {
      expectedCacheRevisions,
    }),
  ).toBe(false);
  expect(state.getCachedNode(1)).toBeUndefined();
});

it.each([false, true])(
  "fences a retained Merge target read after confirmation (evict survivor: %s)",
  async (evictSurvivor) => {
    const node = (
      nodeId: number,
      segmentId: number,
      parentNodeId?: number,
    ) => ({
      nodeId,
      segmentId,
      parentNodeId,
      position: [nodeId, 2, 3],
    });
    const firstNodes = [node(101, 11), node(102, 11, 101)];
    const secondNodes = [node(201, 17), node(202, 17, 201)];
    const state = new SpatialSkeletonState();
    state.replaceCachedSegmentSnapshots([
      [11, firstNodes],
      [17, secondNodes],
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
            snapshot: state.getCachedSegmentSnapshotHandle(11)!.handle,
          },
          {
            segment: second,
            snapshot: state.getCachedSegmentSnapshotHandle(17)!.handle,
          },
        ],
        authoritativeBindings: {
          segments: [
            [first, 11],
            [second, 17],
          ],
          nodes: [
            [from, 102],
            [to, 201],
          ],
        },
        expectedCacheRevisions: new Map(
          [11, 17].map((id) => [id, state.getCachedSegmentRevision(id)]),
        ),
      },
    });
    runtime.publishExact(1, prepared.projection);
    expect(state.getCachedSegmentNodes(17)).toBeUndefined();
    const expectedCacheRevisions = new Map([
      [17, state.getCachedSegmentRevision(17)],
    ]);
    let release!: (nodes: typeof secondNodes) => void;
    const response = new Promise<typeof secondNodes>((resolve) => {
      release = resolve;
    });
    // The source deliberately ignores cancellation and delivers its old topology.
    const getSkeleton = vi.fn(
      (_segmentId: number, _options: { signal: AbortSignal }) => response,
    );
    const layer = {
      source: {
        readonly: true,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;
    const read = state
      .getFullSegmentNodes(layer, 17, { retainWhileInactive: true })
      .then(
        () => undefined,
        (error) => error,
      );
    expect(getSkeleton).toHaveBeenCalledOnce();
    runtime.publishAuthoritative({
      intentId: 1,
      reconciliation: {
        bindings: {
          segments: [
            [first, 11],
            [second, 11],
          ],
        },
        retiredSegmentIds: [17],
      },
      activePreviews: [],
    });
    expect(getSkeleton.mock.calls[0][1].signal.aborted).toBe(true);
    expect(await read).toMatchObject({ name: "AbortError" });
    expect(state.getCachedSegmentRevision(17)).toBeGreaterThan(
      expectedCacheRevisions.get(17)!,
    );
    expect(runtime.resolveSegment(first)).toBe(11);
    expect(runtime.resolveSegment(second)).toBe(11);
    if (evictSurvivor) state.evictInactiveSegmentNodes([]);
    release(secondNodes);
    await response;
    // The revision fence also protects publication independently of cancellation.
    expect(
      runtime.publishAuthoritativeRead(
        [
          {
            segmentId: 17,
            snapshot: createCompleteSkeletonSnapshot(secondNodes),
          },
        ],
        { expectedCacheRevisions },
      ),
    ).toBe(false);
    expect(state.getCachedSegmentNodes(17)).toBeUndefined();
    if (evictSurvivor) {
      expect(state.getCachedNode(201)).toBeUndefined();
    } else {
      expect(state.getCachedNode(201)).toMatchObject({
        segmentId: 11,
        parentNodeId: 102,
      });
    }
  },
);
