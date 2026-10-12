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
import { Uint64Set } from "#src/uint64_set.js";
import { getContrastRatio } from "#src/util/color.js";
import { vec3 } from "#src/util/geom.js";

if (!("WebGL2RenderingContext" in globalThis)) {
  Object.defineProperty(globalThis, "WebGL2RenderingContext", {
    value: new Proxy(class WebGL2RenderingContext {} as any, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        return 0;
      },
    }),
    configurable: true,
  });
}

const {
  buildSpatialSkeletonPreparationVisuals,
  commitSpatiallyIndexedSkeletonOverlayReplacement,
  getActiveProvisionalSpatialSkeletonSegmentIds,
  SpatiallyIndexedSkeletonLayer,
  PerspectiveViewSpatiallyIndexedSkeletonLayer,
  SliceViewPanelSpatiallyIndexedSkeletonLayer,
  resolveSpatiallyIndexedSkeletonSegmentPick,
} = await import("#src/skeleton/frontend.js");

describe("getActiveProvisionalSpatialSkeletonSegmentIds", () => {
  it("returns only active non-authoritative segment aliases", () => {
    const presentation = {
      revision: 1,
      exactSegmentSnapshots: [],
      removedSegmentIds: [],
      activeLogicalOwners: [
        {
          segmentId: 17,
          logicalHandle: { kind: "segment" as const, stableId: "split-output" },
        },
        {
          segmentId: 23,
          logicalHandle: { kind: "segment" as const, stableId: "confirmed" },
        },
      ],
      numericAliases: [
        {
          segmentId: 17,
          logicalHandle: { kind: "segment" as const, stableId: "split-output" },
          authoritative: false,
        },
        {
          segmentId: 23,
          logicalHandle: { kind: "segment" as const, stableId: "confirmed" },
          authoritative: true,
        },
        {
          segmentId: 31,
          logicalHandle: { kind: "segment" as const, stableId: "stale" },
          authoritative: false,
        },
      ],
      provisionalNodeIds: [],
      preparations: [],
    };

    expect(getActiveProvisionalSpatialSkeletonSegmentIds(presentation)).toEqual(
      [17],
    );
    expect(
      getActiveProvisionalSpatialSkeletonSegmentIds({
        ...presentation,
        numericAliases: presentation.numericAliases.map((alias) => ({
          ...alias,
          authoritative: true,
        })),
      }),
    ).toEqual([]);
  });
});

describe("commitSpatiallyIndexedSkeletonOverlayReplacement", () => {
  it("publishes a replacement before disposing the previous resource", () => {
    const events: string[] = [];
    const previous = { id: "previous" };
    const replacement = { id: "replacement" };

    expect(
      commitSpatiallyIndexedSkeletonOverlayReplacement(
        previous,
        () => {
          events.push("created");
          return replacement;
        },
        (chunk) => events.push(`published:${chunk.id}`),
        (chunk) => events.push(`disposed:${chunk.id}`),
      ),
    ).toBe(replacement);
    expect(events).toEqual([
      "created",
      "published:replacement",
      "disposed:previous",
    ]);
  });

  it("leaves the previous resource published when replacement creation fails", () => {
    const previous = { id: "previous" };
    const publish = vi.fn();
    const dispose = vi.fn();

    expect(() =>
      commitSpatiallyIndexedSkeletonOverlayReplacement(
        previous,
        () => {
          throw new Error("GPU upload failed");
        },
        publish,
        dispose,
      ),
    ).toThrow("GPU upload failed");
    expect(publish).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe("buildSpatialSkeletonPreparationVisuals", () => {
  it("draws only explicitly known merge endpoints and their requested connector", () => {
    const visuals = buildSpatialSkeletonPreparationVisuals(
      [
        {
          intentId: 1,
          sequence: 1,
          direction: "execute",
          kind: "merge",
          lifecycle: "preparing",
          segmentIds: [11, 17],
          endpointNodeIds: [101, 202],
          lastKnownPositions: [
            { nodeId: 101, position: new Float32Array([1, 2, 3]) },
            { nodeId: 202, position: new Float32Array([4, 5, 6]) },
          ],
        },
      ],
      () => undefined,
    );

    expect(visuals.map((visual: { type: string }) => visual.type)).toEqual([
      "marker",
      "marker",
      "connector",
    ]);
    expect(visuals[2]).toMatchObject({
      type: "connector",
      fromNodeId: 101,
      toNodeId: 202,
    });
  });

  it("omits relationships whose endpoint positions are unavailable", () => {
    const visuals = buildSpatialSkeletonPreparationVisuals(
      [
        {
          intentId: 2,
          sequence: 2,
          direction: "execute",
          kind: "split",
          lifecycle: "preparing",
          segmentIds: [11],
          cutNodeId: 101,
          cutParentNodeId: 99,
          lastKnownPositions: [
            { nodeId: 101, position: new Float32Array([1, 2, 3]) },
          ],
        },
      ],
      () => undefined,
    );

    expect(visuals).toHaveLength(1);
    expect(visuals[0]).toMatchObject({
      type: "marker",
      cueKind: "split",
      nodeId: 101,
    });
  });

  it("draws a known split edge when the live parent position is available", () => {
    const visuals = buildSpatialSkeletonPreparationVisuals(
      [
        {
          intentId: 5,
          sequence: 5,
          direction: "execute",
          kind: "split",
          lifecycle: "preparing",
          segmentIds: [11],
          cutNodeId: 101,
          cutParentNodeId: 99,
          lastKnownPositions: [
            { nodeId: 101, position: new Float32Array([1, 2, 3]) },
          ],
        },
      ],
      (nodeId) => (nodeId === 99 ? new Float32Array([4, 5, 6]) : undefined),
    );

    expect(visuals.map((visual: { type: string }) => visual.type)).toEqual([
      "marker",
      "marker",
      "connector",
    ]);
    expect(visuals[2]).toMatchObject({
      type: "connector",
      fromNodeId: 99,
      toNodeId: 101,
    });
  });

  it("prefers a live node position to a captured fallback", () => {
    const visuals = buildSpatialSkeletonPreparationVisuals(
      [
        {
          intentId: 3,
          sequence: 3,
          direction: "undo",
          kind: "delete",
          lifecycle: "preparing",
          segmentIds: [11],
          nodeId: 101,
          lastKnownPositions: [
            { nodeId: 101, position: new Float32Array([1, 2, 3]) },
          ],
        },
      ],
      () => new Float32Array([7, 8, 9]),
    );

    expect(visuals[0]).toMatchObject({
      type: "marker",
      lifecycle: "preparing",
      position: new Float32Array([7, 8, 9]),
    });
  });

  it("renders restore as a truthful single-node marker", () => {
    const visuals = buildSpatialSkeletonPreparationVisuals(
      [
        {
          intentId: 4,
          sequence: 4,
          direction: "undo",
          kind: "restore",
          lifecycle: "preparing",
          segmentIds: [11],
          nodeId: 101,
          lastKnownPositions: [
            { nodeId: 101, position: new Float32Array([1, 2, 3]) },
          ],
        },
      ],
      () => undefined,
    );

    expect(visuals).toEqual([
      expect.objectContaining({
        type: "marker",
        cueKind: "restore",
        nodeId: 101,
      }),
    ]);
  });
});

describe("SpatiallyIndexedSkeletonLayer inspection overlay chunks", () => {
  function makeNode(nodeId: number, segmentId: number) {
    return {
      nodeId,
      segmentId,
      position: new Float32Array([nodeId, 0, 0]),
    };
  }

  function makeLayer(
    cache: Map<number, readonly ReturnType<typeof makeNode>[]>,
  ) {
    const createdChunks: Array<{
      segmentId: number;
      dispose: ReturnType<typeof vi.fn>;
    }> = [];
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        chunkManager: {
          chunkQueueManager: {
            frameNumberCounter: { frameNumber: 1 },
            gl: {},
          },
        },
        inspectionState: {
          spatialSkeletonPresentation: new SpatialSkeletonState()
            .spatialSkeletonPresentation,
          nodeDataVersion: { value: 0 },
          pendingNodePositionVersion: { value: 0 },
          getCachedSegmentNodes: (segmentId: number) => cache.get(segmentId),
          getFullSegmentNodes: vi.fn(),
          evictInactiveSegmentNodes: vi.fn(),
        },
        overlaySegmentChunks: new Map(),
        failedOverlaySegmentBuilds: new Map(),
        overlayRenderChunks: [],
        pendingOverlayPositionKeys: new Map(),
        overlayRebuildFrame: -1,
        pendingOverlaySegmentLoads: new Set(),
        temporaryBrowseExclusions: new Set(),
        browseExcludedSegmentIdsVersion: 0,
        retainedOverlaySegments: new Map<number, number>(),
        retainedOverlaySegmentIdsVersion: 0,
        overlaySegmentTouchCounter: 0,
        maxRetainedOverlaySegments: 16,
        redrawNeeded: { dispatch: vi.fn() },
        pendingNodePositionVersion: { value: 0 },
        getOverlayRenderSegmentIds: () => [11, 17],
        requestOverlaySegmentLoad: vi.fn(),
        createOverlaySegmentChunk: vi.fn(
          (nodes: readonly ReturnType<typeof makeNode>[]) => {
            const chunk = {
              segmentId: nodes[0]?.segmentId ?? 0,
              dispose: vi.fn(),
            };
            createdChunks.push(chunk);
            return chunk;
          },
        ),
      },
    );
    return { layer: layer as any, createdChunks };
  }

  it("rebuilds only a changed segment", () => {
    const cache = new Map<number, readonly ReturnType<typeof makeNode>[]>([
      [11, [makeNode(1, 11)]],
      [17, [makeNode(2, 17)]],
    ]);
    const { layer, createdChunks } = makeLayer(cache);

    const initial = layer.resolveSourceBackedOverlayChunks();
    expect(initial).toHaveLength(2);
    expect(createdChunks).toHaveLength(2);
    const old11 = initial[0];
    const unchanged17 = initial[1];

    cache.set(11, [makeNode(1, 11), makeNode(3, 11)]);
    layer.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber = 2;
    const updated = layer.resolveSourceBackedOverlayChunks();

    expect(createdChunks).toHaveLength(3);
    expect(updated[0]).not.toBe(old11);
    expect(updated[1]).toBe(unchanged17);
    expect(old11.dispose).toHaveBeenCalledOnce();
    expect(unchanged17.dispose).not.toHaveBeenCalled();
  });

  it("keeps the last complete chunk while refreshed data is missing", () => {
    const cache = new Map<number, readonly ReturnType<typeof makeNode>[]>([
      [11, [makeNode(1, 11)]],
      [17, [makeNode(2, 17)]],
    ]);
    const { layer } = makeLayer(cache);
    const initial = layer.resolveSourceBackedOverlayChunks();

    cache.delete(11);
    layer.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber = 2;
    const whileLoading = layer.resolveSourceBackedOverlayChunks();

    expect(whileLoading[0]).toBe(initial[0]);
    expect(initial[0].dispose).not.toHaveBeenCalled();
    expect(layer.requestOverlaySegmentLoad).toHaveBeenCalledWith(11);
  });

  it("keeps the previous chunk when a replacement build fails", () => {
    const cache = new Map<number, readonly ReturnType<typeof makeNode>[]>([
      [11, [makeNode(1, 11)]],
      [17, [makeNode(2, 17)]],
    ]);
    const { layer } = makeLayer(cache);
    const initial = layer.resolveSourceBackedOverlayChunks();
    const old11 = initial[0];

    cache.set(11, [makeNode(3, 11)]);
    layer.createOverlaySegmentChunk.mockImplementationOnce(() => {
      throw new Error("GPU upload failed");
    });
    layer.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber = 2;
    const afterFailure = layer.resolveSourceBackedOverlayChunks();

    expect(afterFailure[0]).toBe(old11);
    expect(old11.dispose).not.toHaveBeenCalled();
  });

  it("disposes an inactive segment chunk and releases its cache claim", () => {
    const cache = new Map<number, readonly ReturnType<typeof makeNode>[]>([
      [11, [makeNode(1, 11)]],
      [17, [makeNode(2, 17)]],
    ]);
    const { layer } = makeLayer(cache);
    const initial = layer.resolveSourceBackedOverlayChunks();
    const old11 = initial[0];

    layer.getOverlayRenderSegmentIds = () => [17];
    layer.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber = 2;
    const updated = layer.resolveSourceBackedOverlayChunks();

    expect(updated).toEqual([initial[1]]);
    expect(old11.dispose).toHaveBeenCalledOnce();
    expect(
      layer.inspectionState.evictInactiveSegmentNodes,
    ).toHaveBeenLastCalledWith([17]);
  });

  it("atomically remaps retained provisional overlay identities", () => {
    const { layer } = makeLayer(new Map());
    const tempSegmentId = 0xffff_fff8;
    layer.retainedOverlaySegments = new Map([
      [11, 1],
      [17, 2],
      [tempSegmentId, 3],
      [23, 4],
    ]);
    layer.pendingOverlaySegmentLoads = new Set([tempSegmentId, 41]);

    expect(
      layer.remapOverlaySegments(
        new Map([
          [tempSegmentId, 23],
          [17, 11],
        ]),
      ),
    ).toBe(true);

    expect([...layer.retainedOverlaySegments.entries()]).toEqual([
      [11, 2],
      [23, 4],
    ]);
    expect([...layer.pendingOverlaySegmentLoads]).toEqual([41]);
    expect(layer.overlayRebuildFrame).toBe(-1);
    expect(layer.redrawNeeded.dispatch).toHaveBeenCalledOnce();
  });

  it("preserves distinct owners when a remap destination is also a source", () => {
    const { layer } = makeLayer(new Map());
    const provisional = 0xffff_fff8;
    layer.retainedOverlaySegments = new Map([
      [11, 1],
      [provisional, 2],
    ]);
    layer.remapOverlaySegments(
      new Map([
        [11, provisional],
        [provisional, 17],
      ]),
    );
    expect([...layer.retainedOverlaySegments]).toEqual([
      [provisional, 1],
      [17, 2],
    ]);
  });
});

describe("resolveSpatiallyIndexedSkeletonSegmentPick", () => {
  it("returns the node segment id for direct node picks", () => {
    const chunk = {
      indices: new Uint32Array([0, 1, 1, 2]),
      numVertices: 3,
    };
    const segmentIds = new Uint32Array([11, 13, 17]);

    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 1, "node"),
    ).toBe(13);
  });

  it("returns the first valid endpoint segment id for direct edge picks", () => {
    const chunk = {
      indices: new Uint32Array([0, 1, 1, 2]),
      numVertices: 3,
    };
    const segmentIds = new Uint32Array([0, 19, 23]);

    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 0, "edge"),
    ).toBe(19);
    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 1, "edge"),
    ).toBe(19);
  });

  it("returns undefined for out-of-range direct picks", () => {
    const chunk = {
      indices: new Uint32Array([0, 1]),
      numVertices: 2,
    };
    const segmentIds = new Uint32Array([5, 7]);

    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 4, "node"),
    ).toBeUndefined();
    expect(
      resolveSpatiallyIndexedSkeletonSegmentPick(chunk, segmentIds, 2, "edge"),
    ).toBeUndefined();
  });
});

describe("SpatiallyIndexedSkeletonLayer browse node picks", () => {
  it("resolves browse node picks with node identity and position", () => {
    const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
    const segmentIds = new Uint32Array([11, 17]);
    const vertexBytes = new Uint8Array(
      positions.byteLength + segmentIds.byteLength,
    );
    vertexBytes.set(new Uint8Array(positions.buffer), 0);
    vertexBytes.set(new Uint8Array(segmentIds.buffer), positions.byteLength);
    const chunk = {
      vertexAttributes: vertexBytes,
      vertexAttributeOffsets: new Uint32Array([0, positions.byteLength]),
      numVertices: 2,
      indices: new Uint32Array([0, 1]),
      nodeIds: new Int32Array([101, 202]),
    };
    const layer = Object.create(SpatiallyIndexedSkeletonLayer.prototype);

    expect((layer as any).resolveNodePickFromChunk(chunk, 1)).toEqual({
      nodeId: 202,
      segmentId: 17,
      position: new Float32Array([4, 5, 6]),
    });
  });
});

describe("spatial node picks after a skeleton ownership change", () => {
  it.each([
    PerspectiveViewSpatiallyIndexedSkeletonLayer,
    SliceViewPanelSpatiallyIndexedSkeletonLayer,
  ])("uses inspected ownership for both pick formats in %s", (RenderLayer) => {
    const nodeId = 210684811;
    const oldSegmentId = 6368542;
    const node = {
      nodeId,
      segmentId: 6368977,
      position: new Float32Array([7, 8, 9]),
    };
    const getCachedNodeInfo = vi.fn(() => node);
    const base = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        getCachedNodeInfo,
        displayState: { transform: { value: { error: "no transform" } } },
      },
    );
    const rawPosition = new Float32Array([1, 2, 3]);
    const rawSegmentIds = new Uint32Array([oldSegmentId]);
    const vertexAttributes = new Uint8Array(
      rawPosition.byteLength + rawSegmentIds.byteLength,
    );
    vertexAttributes.set(new Uint8Array(rawPosition.buffer), 0);
    vertexAttributes.set(
      new Uint8Array(rawSegmentIds.buffer),
      rawPosition.byteLength,
    );
    const chunk = {
      vertexAttributes,
      vertexAttributeOffsets: new Uint32Array([0, rawPosition.byteLength]),
      numVertices: 1,
      nodeIds: new Int32Array([nodeId]),
    };
    const pickFormats = [
      {
        kind: "node",
        nodeIds: new Int32Array([nodeId]),
        segmentIds: rawSegmentIds,
        nodePositions: rawPosition,
      },
      { kind: "segment-node", chunk },
    ];
    for (const data of pickFormats) {
      const mouseState: any = {};
      RenderLayer.prototype.updateMouseState.call(
        { base } as any,
        mouseState,
        0n,
        0,
        data,
      );
      expect(mouseState.pickedSpatialSkeleton).toEqual(node);
      expect(mouseState.pickedSpatialSkeleton.position).not.toBe(node.position);
    }
    // The correction must not mutate browse cells or old pick buffers.
    expect(rawSegmentIds[0]).toBe(oldSegmentId);
    expect(rawPosition).toEqual(new Float32Array([1, 2, 3]));
    getCachedNodeInfo.mockReturnValue(undefined as any);
    for (const data of pickFormats) {
      const mouseState: any = {};
      RenderLayer.prototype.updateMouseState.call(
        { base } as any,
        mouseState,
        0n,
        0,
        data,
      );
      expect(mouseState.pickedSpatialSkeleton).toEqual({
        nodeId,
        segmentId: oldSegmentId,
        position: rawPosition,
      });
    }
  });
});

describe("SpatiallyIndexedSkeletonLayer selected node outline color", () => {
  it("derives the selected-node outline color from the selected segment color", () => {
    const sourceColor = vec3.fromValues(1, 0, 0);
    const isSelected = vi.fn(() => true);
    const displayState = {
      segmentationColorGroupState: {
        value: {
          segmentStatedColors: new Map(),
          segmentDefaultColor: { value: sourceColor },
          segmentColorHash: { compute: vi.fn() },
        },
      },
      saturation: { value: 0 },
      hoverHighlight: { value: true },
      segmentSelectionState: { isSelected, baseValue: 101n },
    };
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        selectedNodeInfo: { value: { nodeId: 101 } },
        selectedNodeOutlineColor: vec3.create(),
        highlightedNodeOutlineColor: vec3.create(),
        nodeOutlineColorGeneration: 0,
        cachedNodeOutlineColorGeneration: -1,
        displayState,
      },
    );

    (layer as any).updateNodeOutlineColorPair();
    const outlineColor = (layer as any).selectedNodeOutlineColor;
    (layer as any).updateNodeOutlineColorPair();
    const cachedOutlineColor = (layer as any).selectedNodeOutlineColor;

    expect(isSelected).not.toHaveBeenCalled();
    expect(cachedOutlineColor).toBe(outlineColor);
    // The outline color is chosen for high contrast against the segment color.
    expect(getContrastRatio(outlineColor, sourceColor)).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("recomputes the outline color when the selected node changes", () => {
    const computeSegmentColor = vi.fn((color: Float32Array) => {
      color[0] = 1;
      color[1] = 0;
      color[2] = 0;
      return color;
    });
    const selectedNodeId = { value: 101 };
    const displayState = {
      segmentationColorGroupState: {
        value: {
          segmentStatedColors: new Map(),
          segmentDefaultColor: { value: undefined },
          segmentColorHash: { compute: computeSegmentColor },
        },
      },
      saturation: { value: 1 },
      hoverHighlight: { value: false },
      segmentSelectionState: {
        isSelected: vi.fn(() => false),
        baseValue: 101n,
      },
    };
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        selectedNodeInfo: { value: { nodeId: 101 } },
        selectedNodeOutlineColor: vec3.create(),
        highlightedNodeOutlineColor: vec3.create(),
        nodeOutlineColorGeneration: 0,
        cachedNodeOutlineColorGeneration: -1,
        displayState,
      },
    );

    (layer as any).updateNodeOutlineColorPair();
    selectedNodeId.value = 202;
    ++(layer as any).nodeOutlineColorGeneration;
    (layer as any).updateNodeOutlineColorPair();

    expect(computeSegmentColor).toHaveBeenCalledTimes(2);
  });

  it("invalidates the selected-node outline cache when the input generation changes", () => {
    const computeSegmentColor = vi.fn((color: Float32Array) => {
      color[0] = 1;
      color[1] = 0;
      color[2] = 0;
      return color;
    });
    const displayState = {
      segmentationColorGroupState: {
        value: {
          segmentStatedColors: new Map(),
          segmentDefaultColor: { value: undefined },
          segmentColorHash: { compute: computeSegmentColor },
        },
      },
      saturation: { value: 1 },
      hoverHighlight: { value: false },
      segmentSelectionState: {
        isSelected: vi.fn(() => false),
        baseValue: 101n,
      },
    };
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        selectedNodeInfo: { value: { nodeId: 101 } },
        selectedNodeOutlineColor: vec3.create(),
        highlightedNodeOutlineColor: vec3.create(),
        nodeOutlineColorGeneration: 0,
        cachedNodeOutlineColorGeneration: -1,
        displayState,
      },
    );

    (layer as any).updateNodeOutlineColorPair();
    ++(layer as any).nodeOutlineColorGeneration;
    (layer as any).updateNodeOutlineColorPair();

    expect(computeSegmentColor).toHaveBeenCalledTimes(2);
  });

  it("derives each outline from its own segment when selected and hovered nodes belong to different segments", () => {
    // Selected node on a dark segment, hovered node on a bright segment, as
    // happens when hovering a merge target on a differently colored skeleton.
    const selectedSegmentColor = vec3.fromValues(0, 0, 0);
    const displayState = {
      segmentationColorGroupState: {
        value: {
          segmentStatedColors: new Map([
            [101n, 0x000000n],
            [202n, 0xffffffn],
          ]),
          segmentDefaultColor: { value: undefined },
          segmentColorHash: { compute: vi.fn() },
        },
      },
      saturation: { value: 0 },
      hoverHighlight: { value: true },
      segmentSelectionState: { isSelected: vi.fn(() => false), baseValue: 0n },
    };
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        selectedNodeInfo: { value: { nodeId: 101, segmentId: 101 } },
        hoveredNodeInfo: { value: { nodeId: 303, segmentId: 202 } },
        selectedNodeOutlineColor: vec3.create(),
        highlightedNodeOutlineColor: vec3.create(),
        nodeOutlineColorGeneration: 0,
        cachedNodeOutlineColorGeneration: -1,
        displayState,
      },
    );

    (layer as any).updateNodeOutlineColorPair();
    const selectedColor = (layer as any).selectedNodeOutlineColor;
    const highlightedColor = (layer as any).highlightedNodeOutlineColor;

    // The selected outline is picked from the contrast palette, so it stands off its own segment
    // color. The hovered outline is instead a saturation adjustment of its own segment color, which
    // carries no contrast guarantee, so only the selected one is checked here.
    expect(
      getContrastRatio(selectedColor, selectedSegmentColor),
    ).toBeGreaterThanOrEqual(3);
    // Each outline still derives from its own segment, so the two differ.
    expect([...selectedColor]).not.toEqual([...highlightedColor]);
  });
});

describe("SpatiallyIndexedSkeletonLayer browse exclusions", () => {
  function getExcludedSegmentIds(layer: any) {
    const excluded = layer.getBrowsePassExcludedSegments() as
      | Uint64Set
      | undefined;
    return excluded === undefined
      ? undefined
      : [...excluded].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  function makeLayer(
    options: {
      maxRetained?: number;
      visible?: readonly number[];
      cached?: readonly number[];
      existingChunks?: readonly number[];
    } = {},
  ) {
    const visibleSegments = new Uint64Set();
    visibleSegments.add((options.visible ?? []).map(BigInt));
    const temporaryVisibleSegments = new Uint64Set();
    const cachedNodes = new Map<number, readonly unknown[]>(
      (options.cached ?? []).map((segmentId) => [segmentId, [{}]]),
    );
    const nodeDataVersion = { value: 0 };
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        displayState: {
          segmentationGroupState: {
            value: {
              visibleSegments,
              temporaryVisibleSegments,
              useTemporaryVisibleSegments: { value: false },
            },
          },
        },
        inspectionState: {
          spatialSkeletonPresentation: new SpatialSkeletonState()
            .spatialSkeletonPresentation,
          nodeDataVersion,
          getCachedSegmentNodes: (segmentId: number) =>
            cachedNodes.get(segmentId),
        },
        overlaySegmentChunks: new Map(
          (options.existingChunks ?? []).map((segmentId) => [segmentId, {}]),
        ),
        failedOverlaySegmentBuilds: new Map(),
        overlayRenderChunks: [],
        pendingOverlayPositionKeys: new Map(),
        pendingOverlaySegmentLoads: new Set<number>(),
        overlayRebuildFrame: 0,
        temporaryBrowseExclusions: new Set(),
        browseExcludedSegmentIdsVersion: 0,
        cachedBrowseExcludedVersion: -1,
        cachedBrowseExcludedVisibleSet: undefined,
        cachedBrowseExcludedVisibleGeneration: -1,
        cachedBrowseExcludedNodeDataVersion: undefined,
        browseExcludedSegments: new Uint64Set(),
        retainedOverlaySegments: new Map<number, number>(),
        retainedOverlaySegmentIdsVersion: 0,
        overlaySegmentTouchCounter: 0,
        maxRetainedOverlaySegments: options.maxRetained ?? 24,
        redrawNeeded: { dispatch: vi.fn() },
      },
    );
    return {
      layer: layer as any,
      visibleSegments,
      cachedNodes,
      nodeDataVersion,
    };
  }

  it("uses the retained LRU as permanent browse ownership", () => {
    const { layer } = makeLayer({ maxRetained: 2 });

    expect(layer.retainOverlaySegment(11)).toBe(true);
    expect(layer.retainOverlaySegment(17)).toBe(true);
    expect(layer.retainOverlaySegment(11)).toBe(false);
    expect(layer.retainOverlaySegment(23)).toBe(true);

    expect([...layer.retainedOverlaySegments.keys()]).toEqual([11, 23]);
    const excludedSegments = layer.getBrowsePassExcludedSegments();
    expect(excludedSegments).toBeInstanceOf(Uint64Set);
    expect(getExcludedSegmentIds(layer)).toEqual([11n, 23n]);
    expect(layer.redrawNeeded.dispatch).toHaveBeenCalledTimes(3);
  });

  it("strictly evicts the oldest layer ownership on the 25th retain", () => {
    const { layer } = makeLayer();
    for (let segmentId = 1; segmentId <= 25; ++segmentId) {
      layer.retainOverlaySegment(segmentId);
    }

    // Layer retention deliberately has no queue-settlement exemption: every
    // retain participates in the same strict default-cap LRU.
    const expected = Array.from({ length: 24 }, (_, index) => index + 2);
    expect([...layer.retainedOverlaySegments.keys()]).toEqual(expected);
    expect(getExcludedSegmentIds(layer)).toEqual(expected.map(BigInt));
  });

  it("keeps a cold visible segment in browse until its exact overlay is ready", () => {
    const { layer, cachedNodes, nodeDataVersion } = makeLayer({
      visible: [29],
    });

    expect(layer.getBrowsePassExcludedSegments()).toBeUndefined();

    cachedNodes.set(29, [{}]);
    ++nodeDataVersion.value;
    expect([...layer.getBrowsePassExcludedSegments()]).toEqual([29n]);

    cachedNodes.delete(29);
    layer.overlaySegmentChunks.set(29, {});
    ++nodeDataVersion.value;
    ++layer.browseExcludedSegmentIdsVersion;
    expect([...layer.getBrowsePassExcludedSegments()]).toEqual([29n]);

    layer.overlaySegmentChunks.delete(29);
    ++layer.browseExcludedSegmentIdsVersion;
    expect(layer.getBrowsePassExcludedSegments()).toBeUndefined();
  });

  it("keeps a render-ready visible LRU victim excluded until it is hidden", () => {
    const { layer, visibleSegments } = makeLayer({
      maxRetained: 2,
      visible: [11],
      cached: [11],
    });

    layer.retainOverlaySegment(11);
    layer.retainOverlaySegment(17);
    layer.retainOverlaySegment(23);

    expect([...layer.retainedOverlaySegments.keys()]).toEqual([17, 23]);
    expect(getExcludedSegmentIds(layer)).toEqual([11n, 17n, 23n]);

    visibleSegments.delete(11n);
    expect(getExcludedSegmentIds(layer)).toEqual([17n, 23n]);
  });

  it("does not apply the retained cap to render-ready visible segments", () => {
    const visibleSegmentIds = Array.from(
      { length: 30 },
      (_, index) => index + 1,
    );
    const { layer } = makeLayer({
      maxRetained: 2,
      visible: visibleSegmentIds,
      cached: visibleSegmentIds,
    });
    layer.retainOverlaySegment(101);
    layer.retainOverlaySegment(102);
    layer.retainOverlaySegment(103);

    expect([...layer.retainedOverlaySegments.keys()]).toEqual([102, 103]);
    expect(getExcludedSegmentIds(layer)).toEqual([
      ...visibleSegmentIds.map(BigInt),
      102n,
      103n,
    ]);
  });

  it("releases drag-only exclusions without retiring adopted ownership", () => {
    const { layer } = makeLayer();

    const releaseCanceledDrag = layer.beginTemporaryBrowseExclusion(29);
    expect([...layer.getBrowsePassExcludedSegments()]).toEqual([29n]);
    expect([...layer.retainedOverlaySegments]).toEqual([]);
    expect(releaseCanceledDrag()).toBe(true);
    expect(releaseCanceledDrag()).toBe(false);
    expect(layer.getBrowsePassExcludedSegments()).toBeUndefined();

    const releaseAdoptedDrag = layer.beginTemporaryBrowseExclusion(31);
    layer.retainOverlaySegment(31);
    expect(releaseAdoptedDrag()).toBe(true);
    expect([...layer.getBrowsePassExcludedSegments()]).toEqual([31n]);
  });

  it("keeps an evicted segment excluded while a drag token still owns it", () => {
    const { layer } = makeLayer({ maxRetained: 2 });
    layer.retainOverlaySegment(11);
    layer.retainOverlaySegment(17);
    const release = layer.beginTemporaryBrowseExclusion(11);

    layer.retainOverlaySegment(23);

    expect([...layer.retainedOverlaySegments.keys()]).toEqual([17, 23]);
    expect(getExcludedSegmentIds(layer)).toEqual([11n, 17n, 23n]);
    expect(release()).toBe(true);
    expect(getExcludedSegmentIds(layer)).toEqual([17n, 23n]);
  });

  it("remaps and releases an active drag exclusion", () => {
    const { layer } = makeLayer();

    const release = layer.beginTemporaryBrowseExclusion(41);
    expect(layer.remapOverlaySegments(new Map([[41, 43]]))).toBe(true);
    expect([...layer.getBrowsePassExcludedSegments()]).toEqual([43n]);
    expect(release()).toBe(true);
    expect(layer.getBrowsePassExcludedSegments()).toBeUndefined();
  });

  it("preserves the newest recency when remapped identities collide", () => {
    const { layer } = makeLayer({ maxRetained: 2 });
    const provisionalSegmentId = 0xffff_fff8;
    layer.retainedOverlaySegments = new Map([
      [11, 8],
      [17, 6],
      [provisionalSegmentId, 3],
    ]);
    layer.overlaySegmentTouchCounter = 8;

    expect(
      layer.remapOverlaySegments(new Map([[11, provisionalSegmentId]])),
    ).toBe(true);
    expect([...layer.retainedOverlaySegments.entries()]).toEqual([
      [provisionalSegmentId, 8],
      [17, 6],
    ]);

    layer.retainOverlaySegment(23);
    expect([...layer.retainedOverlaySegments.keys()]).toEqual([
      provisionalSegmentId,
      23,
    ]);
  });

  it("clears retained and temporary ownership together on runtime reset", () => {
    const { layer } = makeLayer();
    layer.retainOverlaySegment(41);
    const release = layer.beginTemporaryBrowseExclusion(43);
    expect(getExcludedSegmentIds(layer)).toEqual([41n, 43n]);

    expect(layer.clearOverlayRuntimeState()).toBe(true);

    expect([...layer.retainedOverlaySegments]).toEqual([]);
    expect([...layer.temporaryBrowseExclusions]).toEqual([]);
    expect(layer.getBrowsePassExcludedSegments()).toBeUndefined();
    expect(release()).toBe(false);
  });
});

describe("SpatiallyIndexedSkeletonLayer projected removals", () => {
  function makeRenderer() {
    const state = new SpatialSkeletonState();
    const node = { nodeId: 1, segmentId: 23, position: [1, 2, 3] };
    state.replaceCachedSegmentSnapshots([[23, [node]]]);
    const snapshot = state.getCachedSegmentSnapshotHandle(23)!.handle;
    const oldChunk = { dispose: vi.fn(), pickNodeIds: [1] };
    const replacementChunk = { dispose: vi.fn(), pickNodeIds: [1] };
    const visibleSegments = new Uint64Set();
    const frame = { frameNumber: 1 };
    const layer = Object.assign(
      Object.create(SpatiallyIndexedSkeletonLayer.prototype),
      {
        chunkManager: { chunkQueueManager: { frameNumberCounter: frame } },
        inspectionState: state,
        displayState: {
          segmentationGroupState: {
            value: {
              visibleSegments,
              temporaryVisibleSegments: new Uint64Set(),
              useTemporaryVisibleSegments: { value: false },
            },
          },
        },
        retainedOverlaySegments: new Map([[23, 1]]),
        retainedOverlaySegmentIdsVersion: 1,
        overlayRebuildFrame: -1,
        overlaySegmentChunks: new Map([
          [
            23,
            {
              nodes: snapshot.materialize(),
              pendingPositionKey: "",
              chunk: oldChunk,
            },
          ],
        ]),
        failedOverlaySegmentBuilds: new Map(),
        pendingOverlayPositionKeys: new Map(),
        overlayRenderChunks: [],
        requestOverlaySegmentLoad: vi.fn(),
        createOverlaySegmentChunk: vi.fn(() => replacementChunk),
        browseExcludedSegments: new Uint64Set(),
        temporaryBrowseExclusions: new Set(),
        browseExcludedSegmentIdsVersion: 0,
        cachedBrowseExcludedVersion: -1,
      },
    );
    function publish(handle: typeof snapshot | undefined) {
      const presentation = state.spatialSkeletonPresentation.value;
      const prepared = state.prepareSpatialSkeletonProjectionStatePublication({
        snapshots: [[23, handle]],
        expectedRevisions: new Map([[23, state.getCachedSegmentRevision(23)]]),
        activeLogicalOwners: presentation.activeLogicalOwners,
        numericAliases: presentation.numericAliases,
        provisionalNodeIds: presentation.provisionalNodeIds,
        preparationIntentIdsToRemove: [],
        notify: true,
      })!;
      state.runSpatialSkeletonPresentationTransaction(() => {
        state.adoptPreparedSpatialSkeletonProjectionStatePublication(prepared);
      });
      state.finalizePreparedSpatialSkeletonProjectionStatePublication(prepared);
      ++frame.frameNumber;
    }
    publish(snapshot);
    return {
      state,
      layer,
      snapshot,
      oldChunk,
      replacementChunk,
      publish,
      frame,
    };
  }

  it("disposes a removed singleton chunk, suppresses its browse copy and renders Undo", () => {
    const { layer, snapshot, oldChunk, replacementChunk, publish } =
      makeRenderer();
    expect(layer.resolveSourceBackedOverlayChunks()).toEqual([oldChunk]);
    publish(undefined);
    expect(layer.resolveSourceBackedOverlayChunks()).toEqual([]);
    expect(oldChunk.dispose).toHaveBeenCalledOnce();
    expect(layer.requestOverlaySegmentLoad).not.toHaveBeenCalled();
    // A removed skeleton stays excluded even after leaving the retained LRU.
    layer.retainedOverlaySegments.clear();
    ++layer.browseExcludedSegmentIdsVersion;
    expect([...layer.getBrowsePassExcludedSegments()]).toEqual([23n]);
    layer.retainedOverlaySegments.set(23, 2);
    publish(snapshot);
    expect(layer.resolveSourceBackedOverlayChunks()).toEqual([
      replacementChunk,
    ]);
  });

  it("keeps a temporarily evicted chunk and reuses identical immutable geometry", () => {
    const { state, layer, oldChunk, snapshot, publish } = makeRenderer();
    state.evictInactiveSegmentNodes([]);
    expect(layer.resolveSourceBackedOverlayChunks()).toEqual([oldChunk]);
    expect(layer.requestOverlaySegmentLoad).toHaveBeenCalledWith(23);
    const previousRevision = state.getCachedSegmentRevision(23);
    publish(snapshot);
    expect(state.getCachedSegmentRevision(23)).toBeGreaterThan(
      previousRevision,
    );
    // The cache revision fences reads; array identity determines GPU geometry.
    expect(state.getCachedSegmentNodes(23)).toBe(snapshot.materialize());
    expect(layer.resolveSourceBackedOverlayChunks()).toEqual([oldChunk]);
    expect(layer.createOverlaySegmentChunk).not.toHaveBeenCalled();
  });
});
