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

import type { VisibleSegmentsState } from "#src/segmentation_display_state/base.js";
import { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  buildSpatiallyIndexedSkeletonOverlayGeometry,
  getPendingNodeOverride,
  SkeletonOverlaySegments,
} from "#src/skeleton/spatial/overlay_segments.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import { WatchableValue } from "#src/trackable_value.js";
import { Uint64Set } from "#src/uint64_set.js";
import { bigintCompare } from "#src/util/bigint.js";

describe("buildSpatiallyIndexedSkeletonOverlayGeometry", () => {
  it("draws each node of an edited skeleton once", () => {
    const geometry = buildSpatiallyIndexedSkeletonOverlayGeometry(
      [
        [
          {
            nodeId: 1n,
            segmentId: 11n,
            position: new Float32Array([1, 2, 3]),
          },
          {
            nodeId: 2n,
            segmentId: 11n,
            position: new Float32Array([4, 5, 6]),
            parentNodeId: 1n,
          },
        ],
        [
          {
            nodeId: 2n,
            segmentId: 11n,
            position: new Float32Array([40, 50, 60]),
            parentNodeId: 1n,
          },
          {
            nodeId: 3n,
            segmentId: 13n,
            position: new Float32Array([7, 8, 9]),
          },
        ],
      ],
      {
        getPendingNodePosition: (nodeId) =>
          nodeId === 3n ? new Float32Array([70, 80, 90]) : undefined,
      },
    );

    expect(geometry.numVertices).toBe(3);
    expect([...geometry.nodeIds]).toEqual([1n, 2n, 3n]);
    expect([...geometry.segmentIds]).toEqual([11n, 11n, 13n]);
    expect([...geometry.positions]).toEqual([1, 2, 3, 4, 5, 6, 70, 80, 90]);
    expect([...geometry.indices]).toEqual([1, 0]);
  });

  it("a click can pick the newest unsaved node", () => {
    const maxProvisionalNodeId = 2n ** 63n + 0x7fff_ffffn;
    const geometry = buildSpatiallyIndexedSkeletonOverlayGeometry([
      [
        {
          nodeId: maxProvisionalNodeId,
          segmentId: 11n,
          position: new Float32Array([1, 2, 3]),
        },
      ],
    ]);

    expect(geometry.nodeIds[0]).toBe(maxProvisionalNodeId);
    expect(geometry.nodeIds[0]).toBeGreaterThan(0n);
  });

  it("a picked vertex finds its node", () => {
    const geometry = buildSpatiallyIndexedSkeletonOverlayGeometry([
      [
        { nodeId: 5n, segmentId: 11n, position: new Float32Array([1, 2, 3]) },
        {
          nodeId: 6n,
          segmentId: 11n,
          position: new Float32Array([4, 5, 6]),
          parentNodeId: 5n,
        },
      ],
      // Duplicate of node 5 in a second segment must not create a new vertex.
      [{ nodeId: 5n, segmentId: 13n, position: new Float32Array([9, 9, 9]) }],
    ]);
    expect(geometry.numVertices).toBe(2);
    // The nodeIndex maps each nodeId to its packed vertex index, so a live drag
    // can override the right vertex's position via a shader uniform.
    expect(geometry.nodeIndex.get(5n)).toBe(0);
    expect(geometry.nodeIndex.get(6n)).toBe(1);
    expect([...geometry.nodeIds]).toEqual([5n, 6n]);
  });
});

function makeNode(nodeId: bigint, segmentId: bigint) {
  return { nodeId, segmentId, position: [Number(nodeId), 0, 0] };
}

function makeOverlaySegments(
  options: {
    visible?: readonly bigint[];
    skeletonLayer?: SpatiallyIndexedSkeletonLayer;
  } = {},
) {
  const state = new SpatialSkeletonEditSession();
  const visibleSegments = new Uint64Set();
  visibleSegments.add([...(options.visible ?? [])]);
  const overlaySegments = new SkeletonOverlaySegments({
    segmentationGroupState: new WatchableValue({
      visibleSegments,
      temporaryVisibleSegments: new Uint64Set(),
      useTemporaryVisibleSegments: new WatchableValue(false),
    } as unknown as VisibleSegmentsState),
    editSession: state,
  });
  const skeletonLayer =
    options.skeletonLayer ?? ({} as SpatiallyIndexedSkeletonLayer);
  let frameNumber = 0;
  const drawFrame = () =>
    overlaySegments.updateGeometries(skeletonLayer, ++frameNumber);
  return { overlaySegments, state, visibleSegments, drawFrame };
}

function makeLoadingSkeletonLayer() {
  const requestedSegmentIds: bigint[] = [];
  const skeletonLayer = {
    fragmentSource: {
      async getSkeletonManifest(segmentId: bigint) {
        requestedSegmentIds.push(segmentId);
        return { fragmentKeys: [] };
      },
      async getSkeletonFragment() {
        return { nodes: [], edges: [] };
      },
    },
  } as unknown as SpatiallyIndexedSkeletonLayer;
  return { skeletonLayer, requestedSegmentIds };
}

function removeSegment(state: SpatialSkeletonEditSession, segmentId: bigint) {
  const presentation = state.spatialSkeletonDisplay.value;
  const prepared = state.prepareSpatialSkeletonPreviewCachePublication({
    snapshots: [[segmentId, undefined]],
    expectedRevisions: new Map([
      [segmentId, state.getCachedSegmentRevision(segmentId)],
    ]),
    activeStableOwners: presentation.activeStableOwners,
    numericAliases: presentation.numericAliases,
    provisionalNodeIds: presentation.provisionalNodeIds,
    pendingEditIntentIdsToRemove: [],
    notify: true,
  })!;
  state.runSpatialSkeletonDisplayTransaction(() => {
    state.adoptPreparedSpatialSkeletonPreviewCachePublication(prepared);
  });
  state.finalizePreparedSpatialSkeletonPreviewCachePublication(prepared);
}

function getExcludedSegmentIds(overlaySegments: SkeletonOverlaySegments) {
  overlaySegments.updateBrowseExcludedSegments();
  return [...overlaySegments.browseExcludedSegments].sort(bigintCompare);
}

describe("SkeletonOverlaySegments", () => {
  it("keeps the 24 most recently edited skeletons drawn from full data, dropping the oldest", () => {
    const { overlaySegments } = makeOverlaySegments();
    for (let segmentId = 1n; segmentId <= 25n; ++segmentId) {
      overlaySegments.retain(segmentId);
    }

    const retained = overlaySegments.getRetainedSegmentIds();
    expect(retained).toHaveLength(24);
    expect(retained).not.toContain(1n);
    expect(retained).toContain(25n);
  });

  it("a skeleton keeps its overlay when the server assigns its real ID", () => {
    const { overlaySegments } = makeOverlaySegments();
    overlaySegments.retain(5n);

    overlaySegments.remap(new Map([[5n, 9n]]));

    expect(overlaySegments.getRetainedSegmentIds()).toEqual([9n]);
    expect(getExcludedSegmentIds(overlaySegments)).toEqual([9n]);
  });

  it("two provisional skeletons that become one keep the newer edit's place in the pool", () => {
    const { overlaySegments } = makeOverlaySegments();
    overlaySegments.retain(1n);
    overlaySegments.retain(100n);
    overlaySegments.retain(2n);
    overlaySegments.remap(
      new Map([
        [1n, 50n],
        [2n, 50n],
      ]),
    );

    // Two skeletons and 23 more edits overflow the pool of 24 by one.
    for (let segmentId = 200n; segmentId < 223n; ++segmentId) {
      overlaySegments.retain(segmentId);
    }

    const retained = overlaySegments.getRetainedSegmentIds();
    expect(retained).toContain(50n);
    expect(retained).not.toContain(100n);
  });

  it("hides the browse copy of a skeleton while its node is dragged, and shows it again on release", () => {
    const { overlaySegments } = makeOverlaySegments();

    const release = overlaySegments.beginTemporaryBrowseExclusion(7n);
    expect(getExcludedSegmentIds(overlaySegments)).toEqual([7n]);

    release();
    expect(getExcludedSegmentIds(overlaySegments)).toEqual([]);
    expect(overlaySegments.getRetainedSegmentIds()).toEqual([]);
  });

  it("hides the browse copy of a visible skeleton only once its full data is ready to draw", () => {
    const { overlaySegments, state } = makeOverlaySegments({ visible: [7n] });
    expect(getExcludedSegmentIds(overlaySegments)).toEqual([]);

    state.replaceCachedSegmentSnapshots([[7n, [makeNode(1n, 7n)]]]);

    expect(getExcludedSegmentIds(overlaySegments)).toEqual([7n]);
  });

  it("hides the browse copy of a skeleton that a pending edit removed", () => {
    const { overlaySegments, state, drawFrame } = makeOverlaySegments();
    state.replaceCachedSegmentSnapshots([[23n, [makeNode(1n, 23n)]]]);

    removeSegment(state, 23n);

    expect(getExcludedSegmentIds(overlaySegments)).toEqual([23n]);
    expect(drawFrame().has(23n)).toBe(false);
  });

  it("rebuilds the geometry of only the skeleton whose nodes changed", () => {
    const { state, drawFrame } = makeOverlaySegments({
      visible: [11n, 17n],
    });
    state.replaceCachedSegmentSnapshots([
      [11n, [makeNode(1n, 11n)]],
      [17n, [makeNode(2n, 17n)]],
    ]);
    const before = new Map(drawFrame());

    state.replaceCachedSegmentSnapshots([[17n, [makeNode(3n, 17n)]]]);
    const after = drawFrame();

    expect(after.get(11n)).toBe(before.get(11n));
    expect(after.get(17n)).not.toBe(before.get(17n));
    expect([...after.get(17n)!.nodeIds]).toEqual([3n]);
  });

  it("keeps a skeleton's last geometry while its refreshed nodes load", () => {
    const { skeletonLayer, requestedSegmentIds } = makeLoadingSkeletonLayer();
    const { state, drawFrame } = makeOverlaySegments({
      visible: [11n],
      skeletonLayer,
    });
    state.replaceCachedSegmentSnapshots([[11n, [makeNode(1n, 11n)]]]);
    const drawn = drawFrame().get(11n);

    state.replaceCachedSegmentSnapshots([[11n, undefined]]);

    expect(drawFrame().get(11n)).toBe(drawn);
    expect(requestedSegmentIds).toEqual([11n]);
  });

  it("forgets edited skeletons and their drawn geometry when the source changes", () => {
    const { overlaySegments, state, drawFrame } = makeOverlaySegments({
      visible: [11n],
    });
    overlaySegments.retain(5n);
    state.replaceCachedSegmentSnapshots([[11n, [makeNode(1n, 11n)]]]);
    drawFrame();

    overlaySegments.clear();
    state.replaceCachedSegmentSnapshots([[11n, undefined]]);

    expect(overlaySegments.getRetainedSegmentIds()).toEqual([]);
    expect(drawFrame().has(11n)).toBe(false);
  });

  it("drops the geometry of a skeleton that is no longer shown or edited", () => {
    const { state, visibleSegments, drawFrame } = makeOverlaySegments({
      visible: [11n],
    });
    state.replaceCachedSegmentSnapshots([[11n, [makeNode(1n, 11n)]]]);
    expect(drawFrame().has(11n)).toBe(true);

    visibleSegments.delete(11n);

    expect(drawFrame().has(11n)).toBe(false);
  });
});

describe("getPendingNodeOverride", () => {
  it("moves only the dragged node, not the node at the same index in another skeleton", () => {
    const state = new SpatialSkeletonEditSession();
    const dragged = buildSpatiallyIndexedSkeletonOverlayGeometry([
      [makeNode(1n, 11n)],
    ]);
    const other = buildSpatiallyIndexedSkeletonOverlayGeometry([
      [makeNode(2n, 17n)],
    ]);

    state.setPendingNodePosition(1n, [40, 5, 0]);

    const override = getPendingNodeOverride(dragged.nodeIndex, state);
    expect(override?.vertexIndex).toBe(0);
    expect(Array.from(override!.position)).toEqual([40, 5, 0]);
    expect(getPendingNodeOverride(other.nodeIndex, state)).toBeUndefined();
  });
});
