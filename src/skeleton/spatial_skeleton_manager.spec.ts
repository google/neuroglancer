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

import { SpatialSkeletonActions } from "#src/skeleton/actions.js";
import {
  buildSpatiallyIndexedSkeletonNavigationGraph,
  getFlatListNodeIds,
  getSkeletonRootNode,
} from "#src/skeleton/navigation_graph.js";
import {
  editableSpatiallyIndexedSkeletonSourceSupportsAction,
  getEditableSpatiallyIndexedSkeletonSource,
  getSpatialSkeletonEditCommandFactoryForAction,
  isSpatiallyIndexedSkeletonSourceReadOnly,
  SpatialSkeletonState,
} from "#src/skeleton/spatial_skeleton_manager.js";

function makeCommandFactory(action: string) {
  return {
    action,
    createCommand: vi.fn(),
  };
}

function makeEditableSourceCommands() {
  return {
    addNodesCommand: makeCommandFactory(SpatialSkeletonActions.addNodes),
    deleteNodesCommand: makeCommandFactory(SpatialSkeletonActions.deleteNodes),
    moveNodesCommand: makeCommandFactory(SpatialSkeletonActions.moveNodes),
    splitSkeletonsCommand: makeCommandFactory(
      SpatialSkeletonActions.splitSkeletons,
    ),
    mergeSkeletonsCommand: makeCommandFactory(
      SpatialSkeletonActions.mergeSkeletons,
    ),
  };
}

describe("skeleton/spatial_skeleton_manager", () => {
  it("returns an editable source when mandatory edit actions are present", () => {
    const source = {
      ...makeEditableSourceCommands(),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(getEditableSpatiallyIndexedSkeletonSource({ source })).toBe(source);
  });

  it("does not treat a source missing mandatory edit actions as editable", () => {
    const source = {
      ...makeEditableSourceCommands(),
      mergeSkeletonsCommand: undefined,
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(
      getEditableSpatiallyIndexedSkeletonSource({ source }),
    ).toBeUndefined();
  });

  it("does not treat a command factory for the wrong action as editable", () => {
    const source = {
      ...makeEditableSourceCommands(),
      moveNodesCommand: makeCommandFactory(SpatialSkeletonActions.addNodes),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(
      getEditableSpatiallyIndexedSkeletonSource({ source }),
    ).toBeUndefined();
  });

  it("does not require optional edit actions for editable source validation", () => {
    const source = {
      ...makeEditableSourceCommands(),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(getEditableSpatiallyIndexedSkeletonSource({ source })).toBe(source);
  });

  it("looks up edit command factories from shared action metadata", () => {
    const source = {
      ...makeEditableSourceCommands(),
      insertNodesCommand: makeCommandFactory(
        SpatialSkeletonActions.insertNodes,
      ),
      rerootCommand: makeCommandFactory(SpatialSkeletonActions.reroot),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(
      getSpatialSkeletonEditCommandFactoryForAction(
        source as any,
        SpatialSkeletonActions.moveNodes,
      ),
    ).toBe(source.moveNodesCommand);
    expect(
      getSpatialSkeletonEditCommandFactoryForAction(
        source as any,
        SpatialSkeletonActions.insertNodes,
      ),
    ).toBe(source.insertNodesCommand);
    expect(
      getSpatialSkeletonEditCommandFactoryForAction(
        source as any,
        SpatialSkeletonActions.inspect,
      ),
    ).toBeUndefined();
  });

  it("validates optional confidence configuration for editable sources", () => {
    const source = {
      ...makeEditableSourceCommands(),
      editNodeConfidenceCommand: makeCommandFactory(
        SpatialSkeletonActions.editNodeConfidence,
      ),
      spatialSkeletonConfidenceConfiguration: {
        values: [0, 50, 100],
      },
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(getEditableSpatiallyIndexedSkeletonSource({ source })).toBe(source);

    expect(
      getEditableSpatiallyIndexedSkeletonSource({
        source: {
          ...source,
          spatialSkeletonConfidenceConfiguration: {
            values: [0, Number.NaN, 100],
          },
        },
      }),
    ).toBeUndefined();
  });

  it("requires confidence configuration only for confidence edit support", () => {
    const source = {
      ...makeEditableSourceCommands(),
      editNodeConfidenceCommand: makeCommandFactory(
        SpatialSkeletonActions.editNodeConfidence,
      ),
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(getEditableSpatiallyIndexedSkeletonSource({ source })).toBe(source);
    expect(
      editableSpatiallyIndexedSkeletonSourceSupportsAction(
        source as any,
        SpatialSkeletonActions.addNodes,
      ),
    ).toBe(true);
    expect(
      editableSpatiallyIndexedSkeletonSourceSupportsAction(
        source as any,
        SpatialSkeletonActions.editNodeConfidence,
      ),
    ).toBe(false);

    expect(
      editableSpatiallyIndexedSkeletonSourceSupportsAction(
        {
          ...source,
          spatialSkeletonConfidenceConfiguration: {
            values: [0, 50, 100],
          },
        } as any,
        SpatialSkeletonActions.editNodeConfidence,
      ),
    ).toBe(true);
  });

  it("does not treat a read-only source with edit commands as editable", () => {
    const source = {
      ...makeEditableSourceCommands(),
      readonly: true,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(
      getEditableSpatiallyIndexedSkeletonSource({ source }),
    ).toBeUndefined();
  });

  it("treats missing or invalid spatial skeleton sources as read-only", () => {
    expect(isSpatiallyIndexedSkeletonSourceReadOnly(undefined)).toBe(true);
    expect(
      isSpatiallyIndexedSkeletonSourceReadOnly({ source: undefined }),
    ).toBe(true);
    expect(
      isSpatiallyIndexedSkeletonSourceReadOnly({
        source: {
          readonly: false,
        },
      }),
    ).toBe(true);
  });

  it("reads spatial skeleton source read-only state", () => {
    const source = {
      readonly: false,
      listSkeletons: async () => [],
      getSkeleton: async () => [],
      fetchNodes: async () => [],
      getSpatialIndexMetadata: async () => null,
    };

    expect(isSpatiallyIndexedSkeletonSourceReadOnly({ source })).toBe(false);
    expect(
      isSpatiallyIndexedSkeletonSourceReadOnly({
        source: {
          ...source,
          readonly: true,
        },
      }),
    ).toBe(true);
  });

  it("clears the full skeleton cache before notifying node data listeners", () => {
    const state = new SpatialSkeletonState();
    const cachedSegmentId = 11;
    (state as any).fullSegmentNodeCache.set(cachedSegmentId, [
      {
        nodeId: 1,
        segmentId: cachedSegmentId,
        position: new Float32Array([1, 2, 3]),
      },
    ]);

    let cachePresentDuringNotification: boolean | undefined;
    state.nodeDataVersion.changed.add(() => {
      cachePresentDuringNotification = (state as any).fullSegmentNodeCache.has(
        cachedSegmentId,
      );
    });

    state.markNodeDataChanged();

    expect(cachePresentDuringNotification).toBe(false);
    expect((state as any).fullSegmentNodeCache.has(cachedSegmentId)).toBe(
      false,
    );
  });

  it("clears inspected cache state and pending node positions together", () => {
    const state = new SpatialSkeletonState();
    (state as any).replaceCachedSegmentNodes(11, [
      {
        nodeId: 5,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
      },
    ]);
    state.setPendingNodePosition(5, [4, 5, 6]);
    const nodeDataVersion = state.nodeDataVersion.value;
    const pendingNodePositionVersion = state.pendingNodePositionVersion.value;

    expect(state.clearInspectedSkeletonCache()).toBe(true);
    expect(state.getCachedSegmentNodes(11)).toBeUndefined();
    expect(state.getCachedNode(5)).toBeUndefined();
    expect(state.getPendingNodePosition(5)).toBeUndefined();
    expect(state.nodeDataVersion.value).toBe(nodeDataVersion + 1);
    expect(state.pendingNodePositionVersion.value).toBe(
      pendingNodePositionVersion + 1,
    );
  });

  it("can seed a brand-new cached segment from a local node mutation", () => {
    const state = new SpatialSkeletonState();

    const changed = state.upsertCachedNode(
      {
        nodeId: 5,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        isTrueEnd: false,
      },
      { allowUncachedSegment: true },
    );

    expect(changed).toBe(true);
    expect(state.getCachedSegmentNodes(11)).toEqual([
      {
        nodeId: 5,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
      },
    ]);
    expect(state.getCachedNode(5)).toEqual({
      nodeId: 5,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      parentNodeId: undefined,
      description: undefined,
      isTrueEnd: false,
    });
  });

  it("updates cached node lookup when a node moves between cached segments", () => {
    const state = new SpatialSkeletonState();
    (state as any).replaceCachedSegmentNodes(11, [
      {
        nodeId: 5,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        isTrueEnd: false,
      },
    ]);
    (state as any).replaceCachedSegmentNodes(13, [
      {
        nodeId: 7,
        segmentId: 13,
        position: new Float32Array([4, 5, 6]),
        parentNodeId: undefined,
        isTrueEnd: false,
      },
    ]);

    expect(
      state.upsertCachedNode({
        nodeId: 5,
        segmentId: 13,
        position: new Float32Array([7, 8, 9]),
        parentNodeId: undefined,
        isTrueEnd: false,
      }),
    ).toBe(true);

    expect(state.getCachedSegmentNodes(11)).toBeUndefined();
    expect(state.getCachedSegmentNodes(13)?.map((node) => node.nodeId)).toEqual(
      [5, 7],
    );
    expect(state.getCachedNode(5)).toEqual({
      nodeId: 5,
      segmentId: 13,
      position: new Float32Array([7, 8, 9]),
      parentNodeId: undefined,
      description: undefined,
      isTrueEnd: false,
    });
  });

  it("does not drop an existing cached node when upserting into an uncached segment without permission", () => {
    const state = new SpatialSkeletonState();
    (state as any).replaceCachedSegmentNodes(11, [
      {
        nodeId: 5,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        isTrueEnd: false,
      },
    ]);

    expect(
      state.upsertCachedNode({
        nodeId: 5,
        segmentId: 13,
        position: new Float32Array([7, 8, 9]),
        parentNodeId: undefined,
        isTrueEnd: false,
      }),
    ).toBe(false);

    expect(state.getCachedSegmentNodes(11)).toEqual([
      {
        nodeId: 5,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
      },
    ]);
    expect(state.getCachedSegmentNodes(13)).toBeUndefined();
    expect(state.getCachedNode(5)).toEqual({
      nodeId: 5,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      parentNodeId: undefined,
      description: undefined,
      isTrueEnd: false,
    });
  });

  it("does not cache a full segment fetch that was evicted while pending", async () => {
    const state = new SpatialSkeletonState();
    let resolveFetch:
      | ((
          value: Array<{
            nodeId: number;
            parentNodeId?: number;
            position: Float32Array;
            segmentId: number;
            isTrueEnd: boolean;
          }>,
        ) => void)
      | undefined;
    const getSkeleton = vi.fn(
      () =>
        new Promise<
          Array<{
            nodeId: number;
            parentNodeId?: number;
            position: Float32Array;
            segmentId: number;
            isTrueEnd: boolean;
          }>
        >((resolve) => {
          resolveFetch = resolve as typeof resolveFetch;
        }),
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

    const pending = state.getFullSegmentNodes(skeletonLayer, 11);

    state.evictInactiveSegmentNodes([]);
    resolveFetch?.([
      {
        nodeId: 5,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 11,
        isTrueEnd: false,
      },
    ]);

    await expect(pending).resolves.toEqual([
      {
        nodeId: 5,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
      },
    ]);
    expect(state.getCachedSegmentNodes(11)).toBeUndefined();
    expect(state.getCachedNode(5)).toBeUndefined();
  });

  it("aborts pending full segment fetches when the cache generation is cleared", async () => {
    const state = new SpatialSkeletonState();
    let receivedSignal: AbortSignal | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: number, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          receivedSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );

    const pending = state.getFullSegmentNodes(
      {
        source: {
          readonly: false,
          listSkeletons: async () => [],
          getSkeleton,
          fetchNodes: async () => [],
          getSpatialIndexMetadata: async () => null,
        },
      } as any,
      11,
    );

    expect(receivedSignal?.aborted).toBe(false);
    expect(state.clearInspectedSkeletonCache()).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.getCachedSegmentNodes(11)).toBeUndefined();
    expect(state.getCachedNode(11)).toBeUndefined();
  });

  it("aborts pending full segment fetches when a segment is invalidated", async () => {
    const state = new SpatialSkeletonState();
    let receivedSignal: AbortSignal | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: number, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          receivedSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );

    const pending = state.getFullSegmentNodes(
      {
        source: {
          readonly: false,
          listSkeletons: async () => [],
          getSkeleton,
          fetchNodes: async () => [],
          getSpatialIndexMetadata: async () => null,
        },
      } as any,
      11,
    );

    expect(receivedSignal?.aborted).toBe(false);
    expect(state.invalidateCachedSegments([11])).toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.getCachedSegmentNodes(11)).toBeUndefined();
    expect(state.getCachedNode(11)).toBeUndefined();
  });

  it("aborts pending full segment fetches when a segment is evicted", async () => {
    const state = new SpatialSkeletonState();
    let receivedSignal: AbortSignal | undefined;
    const getSkeleton = vi.fn(
      (_segmentId: number, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          receivedSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );

    const pending = state.getFullSegmentNodes(
      {
        source: {
          readonly: false,
          listSkeletons: async () => [],
          getSkeleton,
          fetchNodes: async () => [],
          getSpatialIndexMetadata: async () => null,
        },
      } as any,
      11,
    );

    expect(receivedSignal?.aborted).toBe(false);
    expect(state.evictInactiveSegmentNodes([])).toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.getCachedSegmentNodes(11)).toBeUndefined();
    expect(state.getCachedNode(11)).toBeUndefined();
  });

  it("notifies node data listeners after caching a fetched full segment", async () => {
    const state = new SpatialSkeletonState();
    const getSkeleton = vi.fn(async () => [
      {
        nodeId: 5,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 11,
        isTrueEnd: false,
      },
    ]);
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
    } as any;
    let notifications = 0;
    state.nodeDataVersion.changed.add(() => {
      notifications += 1;
    });

    await expect(state.getFullSegmentNodes(skeletonLayer, 11)).resolves.toEqual(
      [
        {
          nodeId: 5,
          segmentId: 11,
          position: new Float32Array([1, 2, 3]),
          parentNodeId: undefined,
          description: undefined,
          isTrueEnd: false,
        },
      ],
    );

    expect(notifications).toBe(1);
    expect(state.getCachedNode(5)).toEqual({
      nodeId: 5,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      parentNodeId: undefined,
      description: undefined,
      isTrueEnd: false,
    });
  });

  it("caches inspected source state from full skeleton inspection", async () => {
    const state = new SpatialSkeletonState();
    const getSkeleton = vi.fn(async () => [
      {
        nodeId: 5,
        parentNodeId: undefined,
        position: new Float32Array([1, 2, 3]),
        segmentId: 11,
        isTrueEnd: false,
        sourceState: { revisionToken: "2026-03-29T12:30:00Z" },
      },
    ]);

    await expect(
      state.getFullSegmentNodes(
        {
          source: {
            readonly: false,
            listSkeletons: async () => [],
            getSkeleton,
            fetchNodes: async () => [],
            getSpatialIndexMetadata: async () => null,
          },
        } as any,
        11,
      ),
    ).resolves.toEqual([
      {
        nodeId: 5,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
        sourceState: { revisionToken: "2026-03-29T12:30:00Z" },
      },
    ]);

    expect(getSkeleton).toHaveBeenCalledTimes(1);
    expect(state.getCachedNode(5)).toEqual({
      nodeId: 5,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      parentNodeId: undefined,
      description: undefined,
      isTrueEnd: false,
      sourceState: { revisionToken: "2026-03-29T12:30:00Z" },
    });
  });

  it("stores merge anchor state only when the node id is valid", () => {
    const state = new SpatialSkeletonState();

    expect(state.setMergeAnchor(5)).toBe(true);
    expect(state.mergeAnchorNodeId.value).toBe(5);

    expect(state.setMergeAnchor(0)).toBe(true);
    expect(state.mergeAnchorNodeId.value).toBeUndefined();
  });

  it("stores provided radius and confidence independently", () => {
    const state = new SpatialSkeletonState();
    (state as any).replaceCachedSegmentNodes(11, [
      {
        nodeId: 1,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: undefined,
        radius: 4,
        confidence: 50,
      },
    ]);

    expect(state.setNodeRadius(1, 6)).toBe(true);
    expect(state.setNodeConfidence(1, 63)).toBe(true);
    expect(state.getCachedNode(1)).toMatchObject({
      radius: 6,
      confidence: 63,
    });
  });

  it("removes and reparents nodes within the affected cached segment only", () => {
    const state = new SpatialSkeletonState();
    (state as any).replaceCachedSegmentNodes(11, [
      {
        nodeId: 1,
        segmentId: 11,
        position: new Float32Array([1, 1, 1]),
        parentNodeId: undefined,
        isTrueEnd: false,
      },
      {
        nodeId: 2,
        segmentId: 11,
        position: new Float32Array([2, 2, 2]),
        parentNodeId: 1,
        isTrueEnd: false,
      },
      {
        nodeId: 3,
        segmentId: 11,
        position: new Float32Array([3, 3, 3]),
        parentNodeId: 1,
        isTrueEnd: false,
      },
    ]);
    (state as any).replaceCachedSegmentNodes(12, [
      {
        nodeId: 4,
        segmentId: 12,
        position: new Float32Array([4, 4, 4]),
        parentNodeId: undefined,
        isTrueEnd: false,
      },
    ]);

    expect(
      state.removeCachedNode(1, {
        parentNodeId: undefined,
        childNodeIds: [2, 3],
      }),
    ).toBe(true);

    expect(state.getCachedSegmentNodes(11)).toEqual([
      {
        nodeId: 2,
        segmentId: 11,
        position: new Float32Array([2, 2, 2]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
      },
      {
        nodeId: 3,
        segmentId: 11,
        position: new Float32Array([3, 3, 3]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
      },
    ]);
    expect(state.getCachedSegmentNodes(12)).toEqual([
      {
        nodeId: 4,
        segmentId: 12,
        position: new Float32Array([4, 4, 4]),
        parentNodeId: undefined,
        description: undefined,
        isTrueEnd: false,
      },
    ]);
  });

  it("reroots cached segment topology, confidence, and derived ordering", () => {
    const state = new SpatialSkeletonState();
    (state as any).replaceCachedSegmentNodes(11, [
      {
        nodeId: 1,
        segmentId: 11,
        position: new Float32Array([1, 1, 1]),
        parentNodeId: undefined,
        confidence: 80,
      },
      {
        nodeId: 2,
        segmentId: 11,
        position: new Float32Array([2, 2, 2]),
        parentNodeId: 1,
        confidence: 20,
      },
      {
        nodeId: 3,
        segmentId: 11,
        position: new Float32Array([3, 3, 3]),
        parentNodeId: 2,
        confidence: 10,
      },
      {
        nodeId: 4,
        segmentId: 11,
        position: new Float32Array([4, 4, 4]),
        parentNodeId: 2,
        confidence: 40,
      },
      {
        nodeId: 5,
        segmentId: 11,
        position: new Float32Array([5, 5, 5]),
        parentNodeId: 1,
        confidence: 50,
      },
    ]);

    expect(state.rerootCachedSegment(3)).toEqual([3, 2, 1]);

    const cachedNodes = state.getCachedSegmentNodes(11)!;
    expect(cachedNodes.find((node) => node.nodeId === 3)).toMatchObject({
      parentNodeId: undefined,
      confidence: 100,
    });
    expect(cachedNodes.find((node) => node.nodeId === 2)).toMatchObject({
      parentNodeId: 3,
      confidence: 10,
    });
    expect(cachedNodes.find((node) => node.nodeId === 1)).toMatchObject({
      parentNodeId: 2,
      confidence: 20,
    });
    expect(cachedNodes.find((node) => node.nodeId === 4)).toMatchObject({
      parentNodeId: 2,
      confidence: 40,
    });
    expect(cachedNodes.find((node) => node.nodeId === 5)).toMatchObject({
      parentNodeId: 1,
      confidence: 50,
    });

    const graph = buildSpatiallyIndexedSkeletonNavigationGraph(cachedNodes);
    expect(getSkeletonRootNode(graph).nodeId).toBe(3);
    expect(getFlatListNodeIds(graph)).toEqual([3, 2, 4, 1, 5]);
  });

  it("stores empty segments in the cache if nothing present for that segment in cache", () => {
    const state = new SpatialSkeletonState();
    (state as any).replaceCachedSegmentNodes(1, []);
    expect(state.getCachedSegmentNodes(1)?.length).toBe(0);
  });

  it("deletes segment from cache if the segment becomes empty", () => {
    const state = new SpatialSkeletonState();
    const node = {
      nodeId: 1,
      segmentId: 1,
      position: new Float32Array([1, 1, 1]),
    };
    (state as any).replaceCachedSegmentNodes(1, [node]);
    expect(state.getCachedSegmentNodes(1)).toStrictEqual([node]);
    expect(state.getCachedNode(1)).toBe(node);
    (state as any).replaceCachedSegmentNodes(1, []);
    expect(state.getCachedSegmentNodes(1)).toBeUndefined();
    expect(state.getCachedNode(1)).toBeUndefined();
  });

  function makeLimiterTestLayer(itemLimit?: number) {
    const resolvers: Array<
      (
        value: Array<{
          nodeId: number;
          parentNodeId?: number;
          position: Float32Array;
          segmentId: number;
          isTrueEnd: boolean;
        }>,
      ) => void
    > = [];
    const getSkeleton = vi.fn(
      (_segmentId: number, options?: { signal?: AbortSignal }) =>
        new Promise<
          Array<{
            nodeId: number;
            parentNodeId?: number;
            position: Float32Array;
            segmentId: number;
            isTrueEnd: boolean;
          }>
        >((resolve, reject) => {
          resolvers.push(resolve);
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const skeletonLayer = {
      source: {
        readonly: false,
        listSkeletons: async () => [],
        getSkeleton,
        fetchNodes: async () => [],
        getSpatialIndexMetadata: async () => null,
      },
      ...(itemLimit === undefined
        ? {}
        : {
            chunkManager: {
              chunkQueueManager: {
                capacities: { download: { itemLimit: { value: itemLimit } } },
              },
            },
          }),
    } as any;
    return { skeletonLayer, getSkeleton, resolvers };
  }

  it("caps concurrent full segment fetches at the download item limit", async () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton, resolvers } = makeLimiterTestLayer(2);

    const pending = [11, 12, 13, 14].map((segmentId) =>
      state.getFullSegmentNodes(skeletonLayer, segmentId),
    );

    expect(getSkeleton).toHaveBeenCalledTimes(2);
    resolvers[0]([]);
    await pending[0];
    expect(getSkeleton).toHaveBeenCalledTimes(3);
    resolvers[1]([]);
    resolvers[2]([]);
    await Promise.all([pending[1], pending[2]]);
    expect(getSkeleton).toHaveBeenCalledTimes(4);
    resolvers[3]([]);
    await pending[3];
  });

  it("caps concurrent full segment fetches when no chunk manager is available", () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton } = makeLimiterTestLayer();

    for (let segmentId = 1; segmentId <= 10; ++segmentId) {
      void state
        .getFullSegmentNodes(skeletonLayer, segmentId)
        .catch(() => undefined);
    }

    expect(getSkeleton).toHaveBeenCalledTimes(8);
  });

  it("never starts a queued full segment fetch that is evicted first", async () => {
    const state = new SpatialSkeletonState();
    const { skeletonLayer, getSkeleton, resolvers } = makeLimiterTestLayer(1);

    const first = state.getFullSegmentNodes(skeletonLayer, 11);
    const queued = state.getFullSegmentNodes(skeletonLayer, 12);
    expect(getSkeleton).toHaveBeenCalledTimes(1);

    expect(state.evictInactiveSegmentNodes([11])).toBe(false);
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    resolvers[0]([]);
    await first;
    expect(getSkeleton).toHaveBeenCalledTimes(1);
  });
});
