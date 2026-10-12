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

import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import { SpatialSkeletonActions } from "#src/skeleton/command_protocol.js";
import { SkeletonDataSourceState } from "#src/skeleton/find_path.js";
import { WatchableValue } from "#src/trackable_value.js";

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

const { SegmentationUserLayer } = await import(
  "#src/layer/segmentation/index.js"
);

const {
  PerspectiveViewSpatiallyIndexedSkeletonLayer,
  SliceViewPanelSpatiallyIndexedSkeletonLayer,
  SpatiallyIndexedSkeletonSource,
} = await import("#src/skeleton/frontend.js");

const { SegmentSelectionState } = await import(
  "#src/segmentation_display_state/frontend.js"
);

const { TrackableDataSelectionState } = await import("#src/layer/index.js");
const { CatmaidSpatialSkeletonEditCommands } = await import(
  "#src/datasource/catmaid/spatial_skeleton_commands.js"
);
const { SpatialSkeletonState } = await import(
  "#src/skeleton/spatial_skeleton_manager.js"
);
const { executeSpatialSkeletonDeleteNode } = await import(
  "#src/skeleton/commands.js"
);

function makeQueuedSelectionLayer(pin = true) {
  const layer = Object.create(SegmentationUserLayer.prototype);
  const selectionState: any = {
    value: undefined,
    pin: new WatchableValue(pin),
    coordinateSpace: { value: {} },
    location: { visible: true },
    captureSingleLayerState:
      TrackableDataSelectionState.prototype.captureSingleLayerState,
  };
  const state = new SpatialSkeletonState();
  const group = {
    visibleSegments: new Set<bigint>(),
    temporaryVisibleSegments: new Set<bigint>(),
    selectedSegments: new Set<bigint>(),
    useTemporaryVisibleSegments: { value: false },
  };
  Object.defineProperty(layer, "manager", {
    value: { root: { selectionState } },
  });
  const commands = new CatmaidSpatialSkeletonEditCommands({
    getClient: () => client as any,
  });
  const client = {
    baseUrl: "https://catmaid.example.test",
    projectId: 1,
    addNode: vi.fn(),
    deleteNode: vi.fn(),
    getSkeleton: vi.fn(async () => []),
  };
  const source = {
    readonly: false,
    optimisticEditing: commands.optimisticEditing,
    addNodesCommand: commands.addNodesCommand,
    deleteNodesCommand: commands.deleteNodesCommand,
    getSkeleton: client.getSkeleton,
  };
  const skeletonLayer = {
    source,
    getNode: (id: number) => state.getCachedNode(id),
    retainOverlaySegment: vi.fn(),
    remapOverlaySegments: vi.fn(),
  };
  Object.assign(layer, {
    spatialSkeletonState: state,
    displayState: {
      segmentationGroupState: { value: group },
      segmentSelectionState: { baseValue: 999n },
    },
    selectedSpatialSkeletonNodeInfo: new WatchableValue(undefined),
    getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
    initializeSelectionState: (value: any) => {
      value.nodeId = undefined;
      value.value = undefined;
    },
    selectSegment: (id: bigint, pin: boolean) =>
      selectionState.captureSingleLayerState(
        layer,
        (value: any) => {
          value.value = id;
          return true;
        },
        pin,
      ),
    selectSpatialSkeletonNode: (nodeId: number, pin: boolean, options: any) => {
      layer.selectedSpatialSkeletonNodeInfo.value = { nodeId, ...options };
      (layer as any).captureSpatialSkeletonSelectionState((value: any) => {
        value.nodeId = String(nodeId);
        value.value = BigInt(options.segmentId);
        return true;
      }, pin);
    },
    clearSpatialSkeletonNodeSelection: (pin: boolean) => {
      layer.selectedSpatialSkeletonNodeInfo.value = undefined;
      (layer as any).captureSpatialSkeletonSelectionState(() => true, pin);
    },
    moveViewToSpatialSkeletonNodePosition: vi.fn(),
  });
  return { layer, selectionState, state, group, client, skeletonLayer };
}

function makeEditableSpatialSkeletonSource(
  options: {
    confidenceConfiguration?: boolean;
    rerootCommand?: boolean;
  } = {},
) {
  const createCommand = () => ({
    label: "test command",
    execute: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  });
  const makeCommand = (action: string) => ({
    action,
    createCommand,
  });
  return {
    readonly: false,
    optimisticEditing: {
      createDriver: vi.fn(),
    },
    addNodesCommand: makeCommand(SpatialSkeletonActions.addNodes),
    moveNodesCommand: makeCommand(SpatialSkeletonActions.moveNodes),
    deleteNodesCommand: makeCommand(SpatialSkeletonActions.deleteNodes),
    editNodeDescriptionCommand: makeCommand(
      SpatialSkeletonActions.editNodeDescription,
    ),
    editNodeTrueEndCommand: makeCommand(SpatialSkeletonActions.editNodeTrueEnd),
    editNodeRadiusCommand: makeCommand(SpatialSkeletonActions.editNodeRadius),
    editNodeConfidenceCommand: makeCommand(
      SpatialSkeletonActions.editNodeConfidence,
    ),
    mergeSkeletonsCommand: makeCommand(SpatialSkeletonActions.mergeSkeletons),
    splitSkeletonsCommand: makeCommand(SpatialSkeletonActions.splitSkeletons),
    listSkeletons: async () => [],
    getSkeleton: async () => [],
    fetchNodes: async () => [],
    getSpatialIndexMetadata: async () => null,
    ...(options.confidenceConfiguration !== true
      ? {}
      : {
          spatialSkeletonConfidenceConfiguration: {
            values: [0, 50, 100],
          },
        }),
    ...(options.rerootCommand !== true
      ? {}
      : {
          rerootCommand: makeCommand(SpatialSkeletonActions.reroot),
        }),
  };
}

function makeSpatialSkeletonLayerWithSource(source: unknown) {
  return {
    source,
  };
}

function makeSpatialSkeletonActionGateLayer(options: {
  source: unknown;
  visibleChunksLoaded?: boolean;
  visibleChunksNeeded?: number;
  visibleChunksAvailable?: number;
  fatalState?: object;
  driverSetupError?: unknown;
}) {
  return Object.assign(Object.create(SegmentationUserLayer.prototype), {
    getSpatiallyIndexedSkeletonLayer: () =>
      makeSpatialSkeletonLayerWithSource(options.source),
    spatialSkeletonState: {
      ensureOptimisticEditingEngine: vi.fn(() => {
        if (options.driverSetupError !== undefined) {
          throw options.driverSetupError;
        }
        return {};
      }),
      getOptimisticEditFatalState: vi.fn(() => options.fatalState),
    },
    spatialSkeletonVisibleChunksLoaded: new WatchableValue(
      options.visibleChunksLoaded ?? true,
    ),
    spatialSkeletonVisibleChunksNeeded: new WatchableValue(
      options.visibleChunksNeeded ?? 0,
    ),
    spatialSkeletonVisibleChunksAvailable: new WatchableValue(
      options.visibleChunksAvailable ?? 0,
    ),
  });
}

describe("layer/segmentation spatial skeleton chunk stats", () => {
  it("tracks combined chunk load state from the loading render layers only", () => {
    // After the 2D/3D backend unification, only PerspectiveViewSpatiallyIndexedSkeletonLayer
    // contributes to the chunk stats (it handles both 2D and 3D views via the shared backend).
    const perspectiveLayer = Object.assign(
      Object.create(PerspectiveViewSpatiallyIndexedSkeletonLayer.prototype),
      {
        layerChunkProgressInfo: {
          numVisibleChunksNeeded: 9,
          numVisibleChunksAvailable: 7,
        },
      },
    );
    const slicePanelLayer = Object.assign(
      Object.create(SliceViewPanelSpatiallyIndexedSkeletonLayer.prototype),
      {
        layerChunkProgressInfo: {
          numVisibleChunksNeeded: 100,
          numVisibleChunksAvailable: 100,
        },
      },
    );

    const layer = Object.assign(
      Object.create(SegmentationUserLayer.prototype),
      {
        renderLayers: [perspectiveLayer, slicePanelLayer],
        spatialSkeletonVisibleChunksNeeded: new WatchableValue(0),
        spatialSkeletonVisibleChunksAvailable: new WatchableValue(0),
        spatialSkeletonVisibleChunksLoaded: new WatchableValue(false),
        updateSpatialSkeletonSourceState: vi.fn(),
      },
    );

    layer.updateSpatialSkeletonChunkLoadState();

    expect(layer.spatialSkeletonVisibleChunksNeeded.value).toBe(9);
    expect(layer.spatialSkeletonVisibleChunksAvailable.value).toBe(7);
    expect(layer.spatialSkeletonVisibleChunksLoaded.value).toBe(false);
  });
});

describe("layer/segmentation spatial skeleton source teardown", () => {
  it("disposes the queue before clearing its inspected snapshot cache", () => {
    const order: string[] = [];
    const layer = Object.assign(
      Object.create(SegmentationUserLayer.prototype),
      {
        renderLayers: [],
        spatialSkeletonState: {
          updateCommandHistorySource: vi.fn(() => order.push("dispose")),
          clearInspectedSkeletonCache: vi.fn(() => order.push("clear")),
        },
      },
    );

    layer.updateSpatialSkeletonSourceState();

    expect(order).toEqual(["dispose", "clear"]);
    expect(
      layer.spatialSkeletonState.updateCommandHistorySource,
    ).toHaveBeenCalledWith(undefined);
  });
});

describe("layer/segmentation optimistic projection UI hints", () => {
  it("migrates persistent, temporary, selected, and current identities together", () => {
    const group = {
      visibleSegments: new Set([100n]),
      temporaryVisibleSegments: new Set([100n]),
      selectedSegments: new Set([100n]),
    };
    const selectedSpatialSkeletonNodeInfo = new WatchableValue<any>({
      nodeId: 10,
      segmentId: 100,
      position: [1, 2, 3],
    });
    const selectSpatialSkeletonNode = vi.fn();
    const retainOverlaySegment = vi.fn();
    const remapOverlaySegments = vi.fn();
    const remapPendingNodePositions = vi.fn();
    const layer = Object.assign(
      Object.create(SegmentationUserLayer.prototype),
      {
        displayState: {
          segmentationGroupState: { value: group },
          segmentSelectionState: { baseValue: 100n },
        },
        selectedSpatialSkeletonNodeInfo,
        selectSpatialSkeletonNode,
        selectSegment: vi.fn(),
        clearSpatialSkeletonNodeSelection: vi.fn(),
        spatialSkeletonState: {
          getCachedNode: vi.fn(),
          remapPendingNodePositions,
        },
        managedLayer: {
          manager: { root: { selectionState: { pin: { value: true } } } },
        },
        getSpatiallyIndexedSkeletonLayer: () => ({
          retainOverlaySegment,
          remapOverlaySegments,
        }),
      },
    );

    layer.applySpatialSkeletonProjectionUiHints({
      nodeIdRemappings: new Map([[10, 20]]),
      segmentIdRemappings: new Map([[100, 200]]),
      segmentVisibility: [],
      retainSegmentIds: [200],
    });

    for (const set of [
      group.visibleSegments,
      group.temporaryVisibleSegments,
      group.selectedSegments,
    ]) {
      expect(set.has(100n)).toBe(false);
      expect(set.has(200n)).toBe(true);
    }
    expect(selectedSpatialSkeletonNodeInfo.value).toEqual({
      nodeId: 20,
      segmentId: 200,
      position: [1, 2, 3],
    });
    expect(selectSpatialSkeletonNode).not.toHaveBeenCalled();
    expect(remapPendingNodePositions).toHaveBeenCalledWith(new Map([[10, 20]]));
    expect(remapOverlaySegments).toHaveBeenCalledWith(new Map([[100, 200]]));
    expect(retainOverlaySegment).toHaveBeenCalledWith(200);
  });

  it.each([true, false])(
    "remaps a stored segment-only selection while preserving pin %s, position, and other layers",
    (pin) => {
      const { layer, selectionState } = makeQueuedSelectionLayer(pin);
      const otherEntry = { layer: {}, state: { value: 42n } };
      const position = new Float32Array([1, 2, 3]);
      selectionState.value = {
        layers: [{ layer, state: { value: 4294967290n } }, otherEntry],
        position,
      };
      layer.applySpatialSkeletonProjectionUiHints({
        nodeIdRemappings: new Map(),
        segmentIdRemappings: new Map([[4294967290, 114]]),
        segmentVisibility: [],
        retainSegmentIds: [],
      });
      expect(selectionState.value.layers[0].state.value).toBe(114n);
      expect(selectionState.value.layers[1]).toBe(otherEntry);
      expect(selectionState.value.position).toBe(position);
      expect(selectionState.pin.value).toBe(pin);
    },
  );

  it.each([true, false])(
    "applies restored node hints while preserving pin %s",
    (pin) => {
      const { layer, selectionState } = makeQueuedSelectionLayer(pin);
      layer.applySpatialSkeletonProjectionUiHints({
        nodeIdRemappings: new Map(),
        segmentIdRemappings: new Map(),
        segmentVisibility: [
          { segmentId: 87, visible: true, deselect: false, select: "preserve" },
        ],
        selectedNode: {
          kind: "select",
          nodeId: 725,
          segmentId: 87,
          pin: "preserve",
          moveView: false,
        },
        retainSegmentIds: [87],
      });
      expect(selectionState.value.layers[0].state).toEqual({
        nodeId: "725",
        value: 87n,
      });
      expect(selectionState.pin.value).toBe(pin);
    },
  );

  it("restores visibility and the pinned node after a final-node rejection through the real queue", async () => {
    const { layer, state, selectionState, group, client } =
      makeQueuedSelectionLayer();
    const node = {
      nodeId: 725,
      segmentId: 87,
      position: new Float32Array([4, 5, 6]),
    };
    state.replaceCachedSegmentSnapshots([[87, [node]]]);
    group.visibleSegments.add(87n);
    layer.selectSpatialSkeletonNode(node.nodeId, true, node);
    let rejectDelete!: (error: Error) => void;
    client.deleteNode.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectDelete = reject;
        }),
    );
    const execution = executeSpatialSkeletonDeleteNode(layer, node);
    await execution;
    for (let i = 0; i < 20 && rejectDelete === undefined; i++)
      await Promise.resolve();
    expect(selectionState.value.layers[0].state.nodeId).toBeUndefined();
    expect(group.visibleSegments.has(87n)).toBe(false);
    // A plain provider rejection must be classified as definitive, as HTTP 409 is.
    const { HttpError } = await import("#src/util/http_request.js");
    rejectDelete(
      new HttpError(
        "https://catmaid.example.test/1/treenode/delete",
        409,
        "Conflict",
      ),
    );
    expect(await execution.settled).toMatchObject({
      outcome: "unchanged",
      reason: "rejected",
    });
    expect(selectionState.value.layers[0].state).toEqual({
      nodeId: "725",
      value: 87n,
    });
    expect(group.visibleSegments.has(87n)).toBe(true);
    expect(state.getCachedNode(725)).toMatchObject(node);
    expect(
      state.spatialSkeletonPresentation.value.removedSegmentIds,
    ).not.toContain(87);
    expect(state.getOptimisticEditFatalState()).toBeUndefined();
    state.dispose();
  });
});

describe("layer/segmentation spatial skeleton action gating", () => {
  it("blocks every edit after Reload required but keeps inspection available", () => {
    const layer = makeSpatialSkeletonActionGateLayer({
      source: makeEditableSpatialSkeletonSource({ rerootCommand: true }),
      visibleChunksLoaded: false,
      fatalState: {
        reason: "authority-indeterminate",
        authority: "indeterminate",
      },
    });

    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.moveNodes,
        { requireVisibleChunks: true },
      ),
    ).toBe("Reload the page before making more skeleton edits.");
    expect(
      layer.getSpatialSkeletonActionsDisabledReason([
        SpatialSkeletonActions.inspect,
        SpatialSkeletonActions.splitSkeletons,
      ]),
    ).toBe("Reload the page before making more skeleton edits.");
    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.inspect,
        { requireVisibleChunks: false },
      ),
    ).toBeUndefined();
  });

  it("does not require a specific grid level for skeleton actions", () => {
    const layer = makeSpatialSkeletonActionGateLayer({
      source: makeEditableSpatialSkeletonSource({
        rerootCommand: true,
      }),
    });

    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.mergeSkeletons,
      ),
    ).toBeUndefined();
    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.reroot,
        {
          requireVisibleChunks: false,
        },
      ),
    ).toBeUndefined();
    expect(
      layer.getSpatialSkeletonActionsDisabledReason([
        SpatialSkeletonActions.addNodes,
        SpatialSkeletonActions.moveNodes,
      ]),
    ).toBeUndefined();
  });

  it("allows every factory-advertised edit and inspection", () => {
    const layer = makeSpatialSkeletonActionGateLayer({
      source: makeEditableSpatialSkeletonSource({
        confidenceConfiguration: true,
        rerootCommand: true,
      }),
    });

    for (const action of [
      SpatialSkeletonActions.addNodes,
      SpatialSkeletonActions.moveNodes,
      SpatialSkeletonActions.deleteNodes,
      SpatialSkeletonActions.mergeSkeletons,
      SpatialSkeletonActions.splitSkeletons,
      SpatialSkeletonActions.reroot,
      SpatialSkeletonActions.editNodeDescription,
      SpatialSkeletonActions.editNodeTrueEnd,
      SpatialSkeletonActions.editNodeRadius,
      SpatialSkeletonActions.editNodeConfidence,
    ]) {
      expect(
        layer.getSpatialSkeletonActionsDisabledReason(action),
      ).toBeUndefined();
    }

    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.inspect,
      ),
    ).toBeUndefined();
    expect(
      layer.getSpatialSkeletonActionsDisabledReason([
        SpatialSkeletonActions.inspect,
        SpatialSkeletonActions.addNodes,
      ]),
    ).toBeUndefined();
  });

  it("still reports visible chunk loading when requested", () => {
    const layer = makeSpatialSkeletonActionGateLayer({
      source: makeEditableSpatialSkeletonSource(),
      visibleChunksLoaded: false,
      visibleChunksNeeded: 3,
      visibleChunksAvailable: 1,
    });

    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.splitSkeletons,
        {
          requireVisibleChunks: true,
        },
      ),
    ).toBe("Wait for visible skeleton chunks to load (1/3).");
  });

  it("reports missing reroot support explicitly", () => {
    const layer = makeSpatialSkeletonActionGateLayer({
      source: makeEditableSpatialSkeletonSource(),
    });

    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.reroot,
        {
          requireVisibleChunks: false,
        },
      ),
    ).toBe(
      "The active spatial skeleton source does not support skeleton rerooting.",
    );
  });

  it("treats an invalid datasource driver registration as inspect-only", () => {
    const layer = makeSpatialSkeletonActionGateLayer({
      source: makeEditableSpatialSkeletonSource(),
      driverSetupError: new Error("invalid registration"),
    });

    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.moveNodes,
      ),
    ).toBe(
      "The active spatial skeleton source does not support node movement.",
    );
    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.inspect,
      ),
    ).toBeUndefined();
  });

  it("requires confidence configuration for confidence edit support", () => {
    const layer = makeSpatialSkeletonActionGateLayer({
      source: makeEditableSpatialSkeletonSource(),
    });

    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.editNodeConfidence,
      ),
    ).toBe(
      "The active spatial skeleton source does not support node confidence editing.",
    );

    layer.getSpatiallyIndexedSkeletonLayer = () =>
      makeSpatialSkeletonLayerWithSource(
        makeEditableSpatialSkeletonSource({
          confidenceConfiguration: true,
        }),
      );

    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.editNodeConfidence,
      ),
    ).toBeUndefined();
  });

  it("reports read-only spatial skeleton sources explicitly", () => {
    const layer = makeSpatialSkeletonActionGateLayer({
      source: {
        ...makeEditableSpatialSkeletonSource({
          rerootCommand: true,
        }),
        readonly: true,
      },
    });

    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.addNodes,
      ),
    ).toBe("The active spatial skeleton source is read-only.");
    expect(
      layer.getSpatialSkeletonActionsDisabledReason(
        SpatialSkeletonActions.inspect,
      ),
    ).toBeUndefined();
  });
});

describe("layer/segmentation spatial skeleton selection serialization", () => {
  it("accepts bigint segment selections for runtime spatial skeleton state", () => {
    const selectionState = new SegmentSelectionState();

    selectionState.set(7n);

    expect(selectionState.value).toBe(7n);
    expect(selectionState.baseValue).toBe(7n);
  });

  it("round-trips node id and segment value for spatial skeleton selections", () => {
    const layer = Object.create(SegmentationUserLayer.prototype);
    Object.defineProperty(layer, "localCoordinateSpace", {
      value: { value: { rank: 0 } },
      configurable: true,
    });
    const state: any = {};
    layer.initializeSelectionState(state);

    layer.selectionStateFromJson(state, {
      nodeId: "23",
      value: "7",
    });

    expect(state.nodeId).toBe("23");
    expect(state.value).toBe(7n);
    expect(layer.selectionStateToJson(state, false)).toEqual({
      nodeId: "23",
      value: "7",
    });

    const copiedState: any = {};
    layer.initializeSelectionState(copiedState);
    layer.copySelectionState(copiedState, state);
    expect(copiedState.nodeId).toBe("23");
    expect(copiedState.value).toBe(7n);
  });

  it("ignores legacy spatial skeleton selection keys", () => {
    const layer = Object.create(SegmentationUserLayer.prototype);
    Object.defineProperty(layer, "localCoordinateSpace", {
      value: { value: { rank: 0 } },
      configurable: true,
    });
    const state: any = {};
    layer.initializeSelectionState(state);

    layer.selectionStateFromJson(state, {
      spatialSkeletonNodeId: "23",
      spatialSkeletonSegmentId: "7",
    });

    expect(state.nodeId).toBeUndefined();
    expect(state.value).toBeUndefined();
    expect(layer.selectionStateToJson(state, false)).toEqual({});
  });

  it("reconciles a retired skeleton ID with the selected node owner", () => {
    const layer = Object.create(SegmentationUserLayer.prototype);
    const otherEntry = { layer: {}, state: { value: 42n } };
    const position = new Float32Array([1, 2, 3]);
    const selectionState = {
      pin: { value: true },
      value: {
        position,
        layers: [
          { layer, state: { nodeId: "210701784", value: 6369475n } },
          otherEntry,
        ],
      },
    };
    Object.defineProperty(layer, "manager", {
      value: { root: { selectionState } },
    });
    layer.getSpatiallyIndexedSkeletonLayer = () => undefined;
    const getCachedNode = vi.fn(() => ({
      nodeId: 210701784,
      segmentId: 6368977,
    }));
    layer.spatialSkeletonState = { getCachedNode };
    layer.reconcileSpatialSkeletonSelectionOwnership();
    expect(selectionState.value.layers[0].state).toEqual({
      nodeId: "210701784",
      value: 6368977n,
    });
    expect(selectionState.value.layers[1]).toBe(otherEntry);
    expect(selectionState.value.position).toBe(position);
    expect(selectionState.pin.value).toBe(true);
    const reconciled = selectionState.value;
    layer.reconcileSpatialSkeletonSelectionOwnership();
    expect(selectionState.value).toBe(reconciled);
    getCachedNode.mockReturnValue(undefined as any);
    layer.reconcileSpatialSkeletonSelectionOwnership();
    expect(selectionState.value).toBe(reconciled);
  });

  it("captures and clears spatial skeleton nodes using nodeId and segment value", () => {
    const selectionState = {
      pin: { value: false },
      coordinateSpace: { value: undefined },
      value: undefined as any,
    };
    const layer = Object.create(SegmentationUserLayer.prototype);
    Object.defineProperty(layer, "localCoordinateSpace", {
      value: { value: { rank: 0 } },
      configurable: true,
    });
    Object.defineProperty(layer, "manager", {
      value: {
        root: {
          selectionState,
        },
      },
      configurable: true,
    });
    layer.captureSpatialSkeletonSelectionState((state: any) => {
      state.nodeId = "31";
      state.value = 9n;
      return true;
    }, false);

    expect(selectionState.value.layers[0].state.nodeId).toBe("31");
    expect(selectionState.value.layers[0].state.value).toBe(9n);

    layer.captureSpatialSkeletonSelectionState((state: any) => {
      state.nodeId = undefined;
      state.value = undefined;
      return true;
    }, false);

    expect(selectionState.value.layers[0].state.nodeId).toBeUndefined();
    expect(selectionState.value.layers[0].state.value).toBeUndefined();
  });

  it("captures spatial skeleton node ids from unpinned hover selection", () => {
    const renderLayer = {};
    const layer = Object.create(SegmentationUserLayer.prototype);
    Object.defineProperty(layer, "localCoordinateSpace", {
      value: { value: { rank: 0 } },
      configurable: true,
    });
    Object.defineProperty(layer, "localPosition", {
      value: { value: new Float32Array(0) },
      configurable: true,
    });
    Object.defineProperty(layer, "renderLayers", {
      value: [renderLayer],
      configurable: true,
    });
    Object.defineProperty(layer, "getValueAt", {
      value: vi.fn(() => 7n),
      configurable: true,
    });
    const state = {} as any;
    layer.initializeSelectionState(state);

    layer.captureSelectionState(state, {
      active: true,
      position: new Float32Array(0),
      pickedRenderLayer: renderLayer,
      pickedSpatialSkeleton: { nodeId: 31, segmentId: 9 },
    } as any);

    expect(state.nodeId).toBe("31");
    expect(state.value).toBe(9n);
  });

  it("ignores spatial skeleton node ids from other render layers", () => {
    const renderLayer = {};
    const otherRenderLayer = {};
    const layer = Object.create(SegmentationUserLayer.prototype);
    Object.defineProperty(layer, "localCoordinateSpace", {
      value: { value: { rank: 0 } },
      configurable: true,
    });
    Object.defineProperty(layer, "localPosition", {
      value: { value: new Float32Array(0) },
      configurable: true,
    });
    Object.defineProperty(layer, "renderLayers", {
      value: [renderLayer],
      configurable: true,
    });
    Object.defineProperty(layer, "getValueAt", {
      value: vi.fn(() => 7n),
      configurable: true,
    });
    const state = {} as any;
    layer.initializeSelectionState(state);

    layer.captureSelectionState(state, {
      active: true,
      position: new Float32Array(0),
      pickedRenderLayer: otherRenderLayer,
      pickedSpatialSkeleton: { nodeId: 31, segmentId: 9 },
    } as any);

    expect(state.nodeId).toBeUndefined();
    expect(state.value).toBe(7n);
  });

  it("renders only segment and node ids for non-inspected spatial index node selections", () => {
    const state = {
      nodeId: "22242672",
      value: "2836850",
    };
    const layer = Object.assign(
      Object.create(SegmentationUserLayer.prototype),
      {
        displayState: undefined,
        getSpatiallyIndexedSkeletonLayer: () => undefined,
        selectSegment: vi.fn(),
        selectedSpatialSkeletonNodeInfo: new WatchableValue(undefined),
        spatialSkeletonNodeDataVersion: new WatchableValue(0),
        spatialSkeletonState: {
          getCachedNode: () => undefined,
        },
      },
    );
    Object.defineProperty(layer, "manager", {
      value: {
        root: {
          selectionState: {
            value: {
              layers: [{ layer, state }],
            },
          },
        },
      },
      configurable: true,
    });
    const parent = document.createElement("div");
    const context = {
      redraw: vi.fn(),
      registerDisposer: vi.fn((disposer: unknown) => disposer),
    };

    expect(
      (layer as any).displaySpatialSkeletonSelection(state, parent, context),
    ).toBe(true);

    expect(parent.textContent).toContain("2836850");
    expect(parent.textContent).toContain("22242672");
    expect(parent.textContent).not.toContain("Unknown");
    expect(parent.textContent).not.toContain("Unavailable");
    expect(parent.textContent).not.toContain("Radius");
    expect(parent.textContent).not.toContain("Confidence");

    (layer.spatialSkeletonState as any).spatialSkeletonPresentation = {
      value: { provisionalNodeIds: [22242672] },
    };
    const provisionalParent = document.createElement("div");
    expect(
      (layer as any).displaySpatialSkeletonSelection(
        state,
        provisionalParent,
        context,
      ),
    ).toBe(true);
    expect(provisionalParent.textContent).toContain("Preview");
    expect(provisionalParent.textContent).not.toContain("22242672");
    expect(
      [...provisionalParent.querySelectorAll<HTMLElement>("[title]")].find(
        (element) => element.textContent === "Preview",
      )?.title,
    ).toBe(
      "Preview node. The skeleton source has not yet confirmed its permanent node ID.",
    );
  });
});

describe("layer/segmentation spatial skeleton node navigation helpers", () => {
  it("maps model-space node positions through non-identity transforms before updating view state", () => {
    const dispatchGlobalPositionChanged = vi.fn();
    const dispatchLocalPositionChanged = vi.fn();
    const transform: RenderLayerTransform = {
      rank: 3,
      unpaddedRank: 3,
      localToRenderLayerDimensions: [1, -1, 2],
      globalToRenderLayerDimensions: [2, 0, 1, -1],
      channelToRenderLayerDimensions: [],
      channelToModelDimensions: [],
      channelSpaceShape: new Uint32Array(0),
      modelToRenderLayerTransform: new Float32Array([
        2, 0, 0, 0, 0, 0, 1, 0, 0, 3, 0, 0, 10, -5, 1, 1,
      ]),
      modelDimensionNames: ["x", "y", "z"],
      layerDimensionNames: ["a", "b", "c"],
    };
    const layer = Object.create(SegmentationUserLayer.prototype);
    Object.assign(layer, {
      getSpatiallyIndexedSkeletonLayer: () => ({
        displayState: {
          transform: {
            value: transform,
          },
        },
      }),
    });
    Object.defineProperty(layer, "manager", {
      value: {
        root: {
          globalPosition: {
            value: new Float32Array([100, 101, 102, 103]),
            changed: {
              dispatch: dispatchGlobalPositionChanged,
            },
          },
        },
      },
      configurable: true,
    });
    Object.defineProperty(layer, "localPosition", {
      value: {
        value: new Float32Array([200, 201, 202]),
        changed: {
          dispatch: dispatchLocalPositionChanged,
        },
      },
      configurable: true,
    });

    layer.moveViewToSpatialSkeletonNodePosition([4, 5, 6]);

    expect(Array.from(layer.manager.root.globalPosition.value)).toEqual([
      6, 18, 13, 103,
    ]);
    expect(Array.from(layer.localPosition.value)).toEqual([13, 201, 6]);
    expect(dispatchLocalPositionChanged).toHaveBeenCalledTimes(1);
    expect(dispatchGlobalPositionChanged).toHaveBeenCalledTimes(1);
  });

  it("selects and moves to the provided node, or clears selection when absent", () => {
    const selectSpatialSkeletonNode = vi.fn();
    const moveViewToSpatialSkeletonNodePosition = vi.fn();
    const clearSpatialSkeletonNodeSelection = vi.fn();
    const layer = Object.assign(
      Object.create(SegmentationUserLayer.prototype),
      {
        selectSpatialSkeletonNode,
        moveViewToSpatialSkeletonNodePosition,
        clearSpatialSkeletonNodeSelection,
      },
    );
    Object.defineProperty(layer, "manager", {
      value: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
      configurable: true,
    });
    const node = {
      nodeId: 31,
      segmentId: 9,
      position: new Float32Array([4, 5, 6]),
    };

    expect(layer.selectAndMoveToSpatialSkeletonNode(node)).toBe(true);
    expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(31, true, {
      segmentId: 9,
      position: new Float32Array([4, 5, 6]),
    });
    expect(moveViewToSpatialSkeletonNodePosition).toHaveBeenCalledWith(
      node.position,
    );
    expect(clearSpatialSkeletonNodeSelection).not.toHaveBeenCalled();

    expect(layer.selectAndMoveToSpatialSkeletonNode(undefined, false)).toBe(
      false,
    );
    expect(clearSpatialSkeletonNodeSelection).toHaveBeenCalledWith(false);
  });
});

describe("layer/segmentation spatial skeleton find-path state", () => {
  const serializedFindPathState = {
    source: { nodeId: "1", segmentId: "7", position: [1, 2, 3] },
    target: { nodeId: "3", segmentId: "7", position: [7, 8, 9] },
    result: [
      { nodeId: "1", position: [1, 2, 3] },
      { nodeId: "2", position: [4, 5, 6] },
      { nodeId: "3", position: [7, 8, 9] },
    ],
  };

  function makeContextTestLayer(dataSourceState: SkeletonDataSourceState) {
    const context = {
      skeletonLayer: { source: {} },
      state: dataSourceState.findPathState,
      annotationController: {},
    };
    const layer = Object.assign(
      Object.create(SegmentationUserLayer.prototype),
      {
        spatialSkeletonFindPathContext: context,
        spatialSkeletonState: {
          nodeDataVersion: new WatchableValue(0),
          markNodeDataChanged: vi.fn(),
          hasUnconfirmedOptimisticEdits: vi.fn(() => false),
        },
      },
    );
    const activated = { registerDisposer: vi.fn() };
    (layer as any).registerSpatialSkeletonFindPathInvalidation(
      context,
      activated,
    );
    return { layer, context };
  }

  it("selects a compatible spatial skeleton subsource", () => {
    const spatialMesh = Object.create(SpatiallyIndexedSkeletonSource.prototype);
    const makeLoadedSubsource = (state: unknown, mesh: unknown) => ({
      subsourceEntry: { subsource: { mesh } },
      loadedDataSource: { dataSource: { state } },
    });
    const unsupported = makeLoadedSubsource(undefined, spatialMesh);
    const compatible = makeLoadedSubsource(
      new SkeletonDataSourceState(),
      spatialMesh,
    );
    const regularSkeleton = makeLoadedSubsource(
      new SkeletonDataSourceState(),
      {},
    );
    const layer = Object.create(SegmentationUserLayer.prototype);
    const select = (values: unknown[]) =>
      (layer as any).getSpatialSkeletonFindPathSubsource(values);

    expect(select([unsupported, compatible])).toBe(compatible);
    expect(select([regularSkeleton])).toBeUndefined();
  });

  it("exposes only the singular owning spatial skeleton context", () => {
    const state = new SkeletonDataSourceState();
    const { layer, context } = makeContextTestLayer(state);

    expect(layer.getSpatialSkeletonFindPathContext()).toBe(context);
    expect(layer.getSpatialSkeletonFindPathContext(context.skeletonLayer)).toBe(
      context,
    );
    expect(layer.getSpatialSkeletonFindPathContext({ source: {} })).toBe(
      undefined,
    );
  });

  function makeLayerWithLoadedFindPathResult() {
    const active = new SkeletonDataSourceState({
      findPath: serializedFindPathState,
    });
    const inactive = new SkeletonDataSourceState({
      findPath: serializedFindPathState,
    });
    const { layer } = makeContextTestLayer(active);
    return { active, inactive, layer };
  }

  it("preserves restored results after a cache-only node-data notification", () => {
    const { active, layer } = makeLayerWithLoadedFindPathResult();

    layer.spatialSkeletonState.nodeDataVersion.value++;

    expect(active.findPathState.toJSON()).toEqual(serializedFindPathState);
  });

  it("invalidates an inactive Find Path result when the optimistic cache changes", () => {
    const { active, inactive, layer } = makeLayerWithLoadedFindPathResult();
    layer.spatialSkeletonState.hasUnconfirmedOptimisticEdits.mockReturnValue(
      true,
    );

    layer.spatialSkeletonState.nodeDataVersion.value++;

    expect(active.findPathState.result).toBeUndefined();
    expect(active.findPathState.source?.nodeId).toBe(1n);
    expect(active.findPathState.target?.nodeId).toBe(3n);
    expect(inactive.findPathState.toJSON()).toEqual(serializedFindPathState);
  });

  it("invalidates only the active datasource result after a skeleton data change", () => {
    const { active, inactive, layer } = makeLayerWithLoadedFindPathResult();

    layer.markSpatialSkeletonNodeDataChanged({
      invalidateFullSkeletonCache: false,
    });

    expect(active.findPathState.result).toBeUndefined();
    expect(active.findPathState.source?.nodeId).toBe(1n);
    expect(active.findPathState.target?.nodeId).toBe(3n);
    expect(inactive.findPathState.toJSON()).toEqual(serializedFindPathState);
    expect(layer.spatialSkeletonState.markNodeDataChanged).toHaveBeenCalledWith(
      { invalidateFullSkeletonCache: false },
    );
  });
});
