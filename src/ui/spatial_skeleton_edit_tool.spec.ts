import { afterEach, describe, expect, it, vi } from "vitest";

import { makeCatmaidNodeSourceState } from "#src/datasource/catmaid/api.js";
import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_commands.js";
import {
  executeSpatialSkeletonAddNode,
  executeSpatialSkeletonMerge,
} from "#src/layer/segmentation/spatial_skeleton_commands.js";
import {
  SpatialSkeletonActions,
  type SpatialSkeletonAction,
} from "#src/skeleton/actions.js";
import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonCommandHistory } from "#src/skeleton/command_history.js";
import { setSpatialSkeletonModesToLinesAndPoints } from "#src/skeleton/edit_mode_rendering.js";
import { SkeletonRenderMode } from "#src/skeleton/render_mode.js";
import { StatusMessage } from "#src/status.js";

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

const { SpatialSkeletonEditModeTool } = await import(
  "#src/ui/spatial_skeleton_edit_tool.js"
);
const { SpatialSkeletonMergeModeTool, SpatialSkeletonSplitModeTool } =
  await import("#src/ui/spatial_skeleton_edit_tool.js");

function makeVisibleSegmentsState(initialVisibleSegments: bigint[] = []) {
  return {
    visibleSegments: new Set<bigint>(initialVisibleSegments),
    selectedSegments: new Set<bigint>(),
    segmentEquivalences: {},
    temporaryVisibleSegments: new Set<bigint>(),
    temporarySegmentEquivalences: {},
    useTemporaryVisibleSegments: { value: false },
    useTemporarySegmentEquivalences: { value: false },
  };
}

const catmaidEditClientMethodNames = new Set([
  "addNode",
  "insertNode",
  "moveNode",
  "deleteNode",
  "rerootSkeleton",
  "updateDescription",
  "toggleTrueEnd",
  "updateRadius",
  "updateConfidence",
  "mergeSkeletons",
  "splitSkeleton",
]);

function makeCatmaidClient(overrides: Record<string, unknown> = {}) {
  return {
    addNode: vi.fn(),
    insertNode: vi.fn(),
    moveNode: vi.fn(),
    deleteNode: vi.fn(),
    rerootSkeleton: vi.fn(),
    updateDescription: vi.fn(),
    toggleTrueEnd: vi.fn(),
    updateRadius: vi.fn(),
    updateConfidence: vi.fn(),
    mergeSkeletons: vi.fn(),
    splitSkeleton: vi.fn(),
    ...overrides,
  };
}

function makeEditableSkeletonSource(overrides: Record<string, unknown> = {}) {
  const clientOverrides: Record<string, unknown> = {};
  const sourceOverrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (catmaidEditClientMethodNames.has(key)) {
      clientOverrides[key] = value;
    } else {
      sourceOverrides[key] = value;
    }
  }
  const client = makeCatmaidClient(clientOverrides);
  const commands = new CatmaidSpatialSkeletonEditCommands({
    getClient: () => client as any,
  });
  return {
    readonly: false,
    addNodesCommand: commands.addNodesCommand,
    insertNodesCommand: commands.insertNodesCommand,
    moveNodesCommand: commands.moveNodesCommand,
    deleteNodesCommand: commands.deleteNodesCommand,
    rerootCommand: commands.rerootCommand,
    editNodeDescriptionCommand: commands.editNodeDescriptionCommand,
    editNodeTrueEndCommand: commands.editNodeTrueEndCommand,
    editNodeRadiusCommand: commands.editNodeRadiusCommand,
    editNodeConfidenceCommand: commands.editNodeConfidenceCommand,
    mergeSkeletonsCommand: commands.mergeSkeletonsCommand,
    splitSkeletonsCommand: commands.splitSkeletonsCommand,
    listSkeletons: vi.fn(),
    getSkeleton: vi.fn(),
    fetchNodes: vi.fn(),
    getSpatialIndexMetadata: vi.fn(),
    getSkeletonRootNode: vi.fn(),
    ...sourceOverrides,
  };
}

function testSourceState(revisionToken: string) {
  return makeCatmaidNodeSourceState(revisionToken);
}

function suppressStatusMessages() {
  const fakeStatusMessage = {
    dispose() {},
  } as unknown as StatusMessage;
  vi.spyOn(StatusMessage, "showTemporaryMessage").mockImplementation(
    (_message: string, _closeAfter?: number) => fakeStatusMessage,
  );
  vi.spyOn(StatusMessage, "showMessage").mockImplementation(
    (_message: string) => fakeStatusMessage,
  );
}

function makeChangedSignal() {
  return {
    add: vi.fn((_listener: () => void) => () => {}),
  };
}

function makeManualChangedSignal() {
  const listeners: Array<() => void> = [];
  return {
    add: vi.fn((listener: () => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    }),
    dispatch() {
      for (const listener of listeners.slice()) {
        listener();
      }
    },
  };
}

function makeModeWatchable(value = false) {
  return { value };
}

function makeSkeletonRenderingOptions() {
  return {
    skeletonRenderingOptions: {
      params2d: { mode: { value: SkeletonRenderMode.LINES } },
      params3d: { mode: { value: SkeletonRenderMode.LINES } },
    },
  };
}

function makeToolActivation() {
  const disposers: unknown[] = [];
  const actions = new Map<string, (event: any) => void>();
  const activation = {
    inputEventMapBinder: vi.fn(),
    bindInputEventMap(inputEventMap: unknown) {
      this.inputEventMapBinder(inputEventMap, this);
    },
    bindAction: vi.fn((action: string, handler: (event: any) => void) => {
      actions.set(action, handler);
    }),
    registerDisposer(disposer: unknown) {
      disposers.push(disposer);
      return disposer;
    },
    cancel: vi.fn(),
  };
  const dispose = () => {
    for (const disposer of disposers.reverse()) {
      if (typeof disposer === "function") {
        disposer();
      } else {
        (disposer as { dispose?: () => void }).dispose?.();
      }
    }
  };
  return { activation, actions, dispose };
}

function makeCommandFactory(
  action: SpatialSkeletonAction,
  execute = vi.fn(async () => {}),
) {
  return {
    action,
    createCommand: vi.fn(() => ({
      label: action,
      execute,
      undo: vi.fn(async () => {}),
    })),
  };
}

function makeCommandSkeletonSource(overrides: Record<string, unknown> = {}) {
  return {
    readonly: false,
    addNodesCommand: makeCommandFactory(SpatialSkeletonActions.addNodes),
    insertNodesCommand: makeCommandFactory(SpatialSkeletonActions.insertNodes),
    moveNodesCommand: makeCommandFactory(SpatialSkeletonActions.moveNodes),
    deleteNodesCommand: makeCommandFactory(SpatialSkeletonActions.deleteNodes),
    rerootCommand: makeCommandFactory(SpatialSkeletonActions.reroot),
    editNodeDescriptionCommand: makeCommandFactory(
      SpatialSkeletonActions.editNodeDescription,
    ),
    editNodeTrueEndCommand: makeCommandFactory(
      SpatialSkeletonActions.editNodeTrueEnd,
    ),
    editNodeRadiusCommand: makeCommandFactory(
      SpatialSkeletonActions.editNodeRadius,
    ),
    editNodeConfidenceCommand: makeCommandFactory(
      SpatialSkeletonActions.editNodeConfidence,
    ),
    mergeSkeletonsCommand: makeCommandFactory(
      SpatialSkeletonActions.mergeSkeletons,
    ),
    splitSkeletonsCommand: makeCommandFactory(
      SpatialSkeletonActions.splitSkeletons,
    ),
    listSkeletons: vi.fn(),
    getSkeleton: vi.fn(),
    fetchNodes: vi.fn(),
    getSpatialIndexMetadata: vi.fn(),
    ...overrides,
  };
}

describe("spatial_skeleton_edit_tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches 2d and 3d skeleton rendering to lines and points", () => {
    const layer = {
      displayState: {
        skeletonRenderingOptions: {
          params2d: { mode: { value: SkeletonRenderMode.LINES } },
          params3d: { mode: { value: SkeletonRenderMode.LINES } },
        },
      },
    } as any;

    setSpatialSkeletonModesToLinesAndPoints(layer);

    expect(
      layer.displayState.skeletonRenderingOptions.params3d.mode.value,
    ).toBe(SkeletonRenderMode.LINES_AND_POINTS);
    expect(
      layer.displayState.skeletonRenderingOptions.params2d.mode.value,
    ).toBe(SkeletonRenderMode.LINES_AND_POINTS);
  });

  it("keeps parented add-node commits overlay-first without refetching chunks", async () => {
    suppressStatusMessages();
    const upsertCachedNode = vi.fn();
    const setCachedNodeSourceState = vi.fn();
    const selectSegment = vi.fn();
    const selectSpatialSkeletonNode = vi.fn();
    const markSpatialSkeletonNodeDataChanged = vi.fn();
    const moveViewToSpatialSkeletonNodePosition = vi.fn();
    const getFullSegmentNodes = vi.fn();
    const parentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 5,
      segmentId: 11,
      position: new Float32Array([8, 9, 10]),
      isTrueEnd: false,
      sourceState: testSourceState("parent-before"),
    };
    const addNode = vi.fn().mockResolvedValue({
      nodeId: 17,
      segmentId: 11,
      sourceState: testSourceState("node-after"),
      parentSourceState: testSourceState("parent-after"),
    });
    const skeletonLayer = {
      source: makeEditableSkeletonSource({ addNode }),
      getNode: vi.fn((nodeId: number) =>
        nodeId === parentNode.nodeId ? parentNode : undefined,
      ),
      retainOverlaySegment: vi.fn(),
    };
    const commandHistory = new SpatialSkeletonCommandHistory();
    const visibleSegmentsState = makeVisibleSegmentsState();
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: visibleSegmentsState,
        },
      },
      spatialSkeletonState: {
        commandHistory,
        getCachedNode: vi.fn((nodeId: number) =>
          nodeId === parentNode.nodeId ? parentNode : undefined,
        ),
        getCachedSegmentNodes: vi.fn((segmentId: number) =>
          segmentId === parentNode.segmentId ? [parentNode] : undefined,
        ),
        getFullSegmentNodes,
        upsertCachedNode,
        setCachedNodeSourceState,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment,
      selectSpatialSkeletonNode,
      markSpatialSkeletonNodeDataChanged,
      moveViewToSpatialSkeletonNodePosition,
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
    };
    const position = new Float32Array([1, 2, 3]);

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 11,
      parentNodeId: 5,
      positionInModelSpace: position,
    });

    expect(addNode).toHaveBeenCalledWith(
      11,
      1,
      2,
      3,
      5,
      expect.objectContaining({
        node: expect.objectContaining({ nodeId: 5 }),
      }),
    );
    expect(upsertCachedNode).toHaveBeenCalledWith(
      {
        nodeId: 17,
        segmentId: 11,
        position: new Float32Array([1, 2, 3]),
        parentNodeId: 5,
        isTrueEnd: false,
        sourceState: testSourceState("node-after"),
      },
      { allowUncachedSegment: false },
    );
    expect(setCachedNodeSourceState).toHaveBeenCalledWith(
      5,
      testSourceState("parent-after"),
    );
    expect(visibleSegmentsState.visibleSegments.has(11n)).toBe(true);
    expect(selectSegment).toHaveBeenCalledWith(11n, true);
    expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(17, true, {
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
    });
    expect(moveViewToSpatialSkeletonNodePosition).toHaveBeenCalledWith(
      new Float32Array([1, 2, 3]),
    );
    expect(skeletonLayer.retainOverlaySegment).toHaveBeenCalledWith(11);
    expect(markSpatialSkeletonNodeDataChanged).toHaveBeenCalledWith({
      invalidateFullSkeletonCache: false,
    });
    expect(getFullSegmentNodes).not.toHaveBeenCalled();
  });

  it("seeds root add-node commits locally without overlay retention or refetching chunks", async () => {
    suppressStatusMessages();
    const upsertCachedNode = vi.fn();
    const setCachedNodeSourceState = vi.fn();
    const selectSegment = vi.fn();
    const selectSpatialSkeletonNode = vi.fn();
    const markSpatialSkeletonNodeDataChanged = vi.fn();
    const moveViewToSpatialSkeletonNodePosition = vi.fn();
    const getFullSegmentNodes = vi.fn();
    const addNode = vi.fn().mockResolvedValue({
      nodeId: 29,
      segmentId: 13,
      sourceState: testSourceState("root-after"),
    });
    const skeletonLayer = {
      source: makeEditableSkeletonSource({ addNode }),
      getNode: vi.fn(),
      retainOverlaySegment: vi.fn(),
    };
    const commandHistory = new SpatialSkeletonCommandHistory();
    const visibleSegmentsState = makeVisibleSegmentsState();
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: visibleSegmentsState,
        },
      },
      spatialSkeletonState: {
        commandHistory,
        getCachedNode: vi.fn(),
        getCachedSegmentNodes: vi.fn(),
        getFullSegmentNodes,
        upsertCachedNode,
        setCachedNodeSourceState,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment,
      selectSpatialSkeletonNode,
      markSpatialSkeletonNodeDataChanged,
      moveViewToSpatialSkeletonNodePosition,
      manager: {
        root: {
          selectionState: {
            pin: {
              value: false,
            },
          },
        },
      },
    };
    const position = new Float32Array([4, 5, 6]);

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: 13,
      parentNodeId: undefined,
      positionInModelSpace: position,
    });

    expect(addNode).toHaveBeenCalledWith(13, 4, 5, 6, undefined, undefined);
    expect(upsertCachedNode).toHaveBeenCalledWith(
      {
        nodeId: 29,
        segmentId: 13,
        position: new Float32Array([4, 5, 6]),
        parentNodeId: undefined,
        isTrueEnd: false,
        sourceState: testSourceState("root-after"),
      },
      { allowUncachedSegment: true },
    );
    expect(setCachedNodeSourceState).not.toHaveBeenCalled();
    expect(visibleSegmentsState.visibleSegments.has(13n)).toBe(true);
    expect(selectSegment).toHaveBeenCalledWith(13n, true);
    expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(29, false, {
      segmentId: 13,
      position: new Float32Array([4, 5, 6]),
    });
    expect(moveViewToSpatialSkeletonNodePosition).toHaveBeenCalledWith(
      new Float32Array([4, 5, 6]),
    );
    expect(skeletonLayer.retainOverlaySegment).not.toHaveBeenCalled();
    expect(markSpatialSkeletonNodeDataChanged).toHaveBeenCalledWith({
      invalidateFullSkeletonCache: false,
    });
    expect(getFullSegmentNodes).not.toHaveBeenCalled();
  });

  it("blocks appending a child to a selected true-end node", () => {
    const getAddNodeBlockedReason = (
      SpatialSkeletonEditModeTool.prototype as any
    ).getAddNodeBlockedReason as (
      this: any,
      skeletonLayer: any,
      parentNodeId: number | undefined,
    ) => string | undefined;
    const getCachedNode = vi.fn((nodeId: number) =>
      nodeId === 17
        ? {
            nodeId: 17,
            segmentId: 11,
            position: new Float32Array([1, 2, 3]),
            isTrueEnd: true,
          }
        : undefined,
    );
    const getNode = vi.fn();
    const tool = {
      layer: {
        spatialSkeletonState: {
          getCachedNode,
        },
      },
      getSelectedParentNodeForAdd: (
        SpatialSkeletonEditModeTool.prototype as any
      ).getSelectedParentNodeForAdd,
    };

    expect(getAddNodeBlockedReason.call(tool, { getNode }, 17)).toBe(
      "Node 17 is marked as a true end. Clear the true end state before appending a child node.",
    );
    expect(getAddNodeBlockedReason.call(tool, { getNode }, 18)).toBe(undefined);
    expect(getAddNodeBlockedReason.call(tool, { getNode }, undefined)).toBe(
      undefined,
    );
    expect(getNode).toHaveBeenCalledTimes(1);
    expect(getNode).toHaveBeenCalledWith(18);
  });

  it("suppresses the deleted merge segment while keeping the surviving result selected", async () => {
    suppressStatusMessages();
    const firstNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
      sourceState: testSourceState("first-before"),
    };
    const secondNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 202,
      segmentId: 17,
      position: new Float32Array([4, 5, 6]),
      isTrueEnd: false,
      sourceState: testSourceState("second-before"),
    };
    const mergeSkeletons = vi.fn().mockResolvedValue({
      resultSegmentId: 17,
      deletedSegmentId: 11,
      directionAdjusted: true,
    });
    const invalidateCachedSegments = vi.fn();
    const getFullSegmentNodes = vi.fn(async () => []);
    const selectSegment = vi.fn();
    const selectSpatialSkeletonNode = vi.fn();
    const markSpatialSkeletonNodeDataChanged = vi.fn();
    const clearSpatialSkeletonMergeAnchor = vi.fn();
    const deleteSegmentColor = vi.fn();
    const skeletonLayer = {
      source: makeEditableSkeletonSource({ mergeSkeletons }),
      getNode: vi.fn((nodeId: number) => {
        if (nodeId === firstNode.nodeId) return firstNode;
        if (nodeId === secondNode.nodeId) return secondNode;
        return undefined;
      }),
      suppressBrowseSegment: vi.fn(),
      invalidateSourceCellsForPositions: vi.fn(),
    };
    const commandHistory = new SpatialSkeletonCommandHistory();
    const visibleSegmentsState = makeVisibleSegmentsState([11n, 17n]);
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: visibleSegmentsState,
        },
        segmentStatedColors: {
          value: {
            delete: deleteSegmentColor,
          },
        },
      },
      spatialSkeletonState: {
        commandHistory,
        getCachedNode: vi.fn((nodeId: number) => {
          if (nodeId === firstNode.nodeId) return firstNode;
          if (nodeId === secondNode.nodeId) return secondNode;
          return undefined;
        }),
        getCachedSegmentNodes: vi.fn((segmentId: number) => {
          if (segmentId === firstNode.segmentId) return [firstNode];
          if (segmentId === secondNode.segmentId) return [secondNode];
          return undefined;
        }),
        getFullSegmentNodes,
        invalidateCachedSegments,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment,
      selectSpatialSkeletonNode,
      markSpatialSkeletonNodeDataChanged,
      clearSpatialSkeletonMergeAnchor,
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
    };

    await executeSpatialSkeletonMerge(
      layer as any,
      { nodeId: 101, segmentId: 11 },
      { nodeId: 202, segmentId: 17 },
    );

    expect(mergeSkeletons).toHaveBeenCalledWith(
      101,
      202,
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: 101 }),
          expect.objectContaining({ nodeId: 202 }),
        ]),
      }),
    );
    expect(invalidateCachedSegments).toHaveBeenCalledWith([17, 11]);
    expect(getFullSegmentNodes).toHaveBeenCalledTimes(2);
    expect(selectSegment).toHaveBeenCalledWith(17n, false);
    expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(101, true, {
      segmentId: 17,
    });
    expect(deleteSegmentColor).toHaveBeenCalledWith(11n);
    expect(skeletonLayer.suppressBrowseSegment).toHaveBeenCalledWith(11);
    expect(markSpatialSkeletonNodeDataChanged).toHaveBeenCalledWith({
      invalidateFullSkeletonCache: false,
    });
    expect(visibleSegmentsState.visibleSegments.has(17n)).toBe(true);
    expect(visibleSegmentsState.visibleSegments.has(11n)).toBe(false);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([firstNode.position, secondNode.position]);
    expect(clearSpatialSkeletonMergeAnchor).toHaveBeenCalledTimes(1);
  });

  it("clears the merge anchor when the clear-selection action runs in merge mode", () => {
    suppressStatusMessages();
    const bindClearSelectionAction = (
      SpatialSkeletonEditModeTool.prototype as any
    ).bindClearSelectionAction as (this: any, activation: any) => void;
    const clearSpatialSkeletonNodeSelection = vi.fn();
    const clearSpatialSkeletonMergeAnchor = vi.fn();
    const unpin = vi.fn();
    let clearSelectionHandler: ((event: any) => void) | undefined;
    const activation = {
      bindAction: vi.fn((action: string, handler: (event: any) => void) => {
        if (action === "spatial-skeleton-clear-node-selection") {
          clearSelectionHandler = handler;
        }
      }),
    };
    const tool = {
      layer: {
        selectedSpatialSkeletonNodeId: { value: undefined },
        spatialSkeletonState: {
          mergeAnchorNodeId: { value: 101 },
        },
        clearSpatialSkeletonNodeSelection,
        clearSpatialSkeletonMergeAnchor,
        manager: {
          root: {
            selectionState: {
              value: undefined,
              unpin,
            },
          },
        },
      },
    };

    bindClearSelectionAction.call(tool, activation);

    expect(clearSelectionHandler).toBeDefined();
    clearSelectionHandler?.({
      stopPropagation: vi.fn(),
      detail: {
        button: 2,
        ctrlKey: true,
        shiftKey: true,
        preventDefault: vi.fn(),
      },
    });

    expect(clearSpatialSkeletonNodeSelection).toHaveBeenCalledWith(
      "force-unpin",
    );
    expect(clearSpatialSkeletonMergeAnchor).toHaveBeenCalledTimes(1);
    expect(unpin).not.toHaveBeenCalled();
  });

  it("uses an existing selected node as the merge anchor when merge mode activates", () => {
    suppressStatusMessages();
    const selectedNode = {
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      sourceState: testSourceState("selected-before"),
    };
    const mergeAnchorNodeId = {
      value: undefined as number | undefined,
      changed: makeChangedSignal(),
    };
    const selectSpatialSkeletonNode = vi.fn();
    const setSpatialSkeletonMergeAnchor = vi.fn((nodeId: number) => {
      mergeAnchorNodeId.value = nodeId;
      return true;
    });
    const clearSpatialSkeletonMergeAnchor = vi.fn(() => {
      mergeAnchorNodeId.value = undefined;
      return true;
    });
    const clearSpatialSkeletonNodeSelection = vi.fn();
    const skeletonLayer = {
      getNode: vi.fn((nodeId: number) =>
        nodeId === selectedNode.nodeId ? selectedNode : undefined,
      ),
    };
    const layer = {
      displayState: {
        ...makeSkeletonRenderingOptions(),
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n]),
        },
      },
      spatialSkeletonMergeMode: makeModeWatchable(),
      selectedSpatialSkeletonNodeId: {
        value: selectedNode.nodeId,
        changed: makeChangedSignal(),
      },
      selectedSpatialSkeletonNodeInfo: { value: selectedNode },
      spatialSkeletonState: {
        mergeAnchorNodeId,
        getCachedNode: vi.fn(),
      },
      manager: {
        root: {
          layerSelectedValues: {
            mouseState: {
              pickedRenderLayer: undefined,
              updateUnconditionally: vi.fn(() => true),
              active: true,
            },
          },
          selectionState: {
            value: undefined,
          },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSpatialSkeletonNode,
      setSpatialSkeletonMergeAnchor,
      clearSpatialSkeletonMergeAnchor,
      clearSpatialSkeletonNodeSelection,
      layersChanged: makeChangedSignal(),
    };
    const { activation, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonMergeModeTool.prototype),
      { layer },
    );

    try {
      SpatialSkeletonMergeModeTool.prototype.activate.call(
        tool,
        activation as any,
      );

      expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(
        selectedNode.nodeId,
        true,
        selectedNode,
      );
      expect(setSpatialSkeletonMergeAnchor).toHaveBeenCalledWith(
        selectedNode.nodeId,
      );
      expect(clearSpatialSkeletonNodeSelection).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("clears the merge anchor when a pick clears the selected node", () => {
    suppressStatusMessages();
    const selectedNode = {
      nodeId: 101,
      segmentId: 11,
      position: new Float32Array([1, 2, 3]),
      sourceState: testSourceState("selected-before"),
    };
    const selectedNodeChanged = makeManualChangedSignal();
    const mergeAnchorNodeId = {
      value: undefined as number | undefined,
      changed: makeChangedSignal(),
    };
    const selectSegment = vi.fn();
    const setSpatialSkeletonMergeAnchor = vi.fn((nodeId: number) => {
      mergeAnchorNodeId.value = nodeId;
      return true;
    });
    const clearSpatialSkeletonMergeAnchor = vi.fn(() => {
      mergeAnchorNodeId.value = undefined;
      return true;
    });
    const skeletonLayer = {
      getNode: vi.fn((nodeId: number) =>
        nodeId === selectedNode.nodeId ? selectedNode : undefined,
      ),
    };
    const mouseState = {
      pickedRenderLayer: undefined,
      pickedSpatialSkeleton: { segmentId: 17 },
      updateUnconditionally: vi.fn(() => true),
      active: true,
    };
    const layer = {
      displayState: {
        ...makeSkeletonRenderingOptions(),
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n, 17n]),
        },
      },
      spatialSkeletonMergeMode: makeModeWatchable(),
      selectedSpatialSkeletonNodeId: {
        value: selectedNode.nodeId as number | undefined,
        changed: selectedNodeChanged,
      },
      selectedSpatialSkeletonNodeInfo: { value: selectedNode },
      spatialSkeletonState: {
        mergeAnchorNodeId,
        getCachedNode: vi.fn(),
      },
      manager: {
        root: {
          layerSelectedValues: {
            mouseState,
          },
          selectionState: {
            value: undefined,
          },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment,
      selectSpatialSkeletonNode: vi.fn(),
      setSpatialSkeletonMergeAnchor,
      clearSpatialSkeletonMergeAnchor,
      clearSpatialSkeletonNodeSelection: vi.fn(),
      layersChanged: makeChangedSignal(),
    };
    const { activation, actions, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonMergeModeTool.prototype),
      { layer },
    );

    try {
      SpatialSkeletonMergeModeTool.prototype.activate.call(
        tool,
        activation as any,
      );
      clearSpatialSkeletonMergeAnchor.mockClear();

      actions.get("spatial-skeleton-pick-node")?.({
        detail: {
          button: 2,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          metaKey: false,
        },
      });
      layer.selectedSpatialSkeletonNodeId.value = undefined;
      selectedNodeChanged.dispatch();

      expect(selectSegment).toHaveBeenCalledWith(17n, true);
      expect(clearSpatialSkeletonMergeAnchor).toHaveBeenCalledTimes(1);
      expect(mergeAnchorNodeId.value).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("splits the existing selected node immediately when split mode activates", () => {
    suppressStatusMessages();
    const selectedNode = {
      nodeId: 77,
      segmentId: 11,
      position: new Float32Array([7, 8, 9]),
      sourceState: testSourceState("selected-before"),
    };
    const splitExecute = vi.fn(async () => {});
    const splitSkeletonsCommand = makeCommandFactory(
      SpatialSkeletonActions.splitSkeletons,
      splitExecute,
    );
    const skeletonLayer = {
      source: makeCommandSkeletonSource({ splitSkeletonsCommand }),
      getNode: vi.fn((nodeId: number) =>
        nodeId === selectedNode.nodeId ? selectedNode : undefined,
      ),
    };
    const selectSegment = vi.fn();
    const selectSpatialSkeletonNode = vi.fn();
    const layer = {
      displayState: {
        ...makeSkeletonRenderingOptions(),
        segmentationGroupState: {
          value: makeVisibleSegmentsState([11n]),
        },
      },
      spatialSkeletonSplitMode: makeModeWatchable(),
      selectedSpatialSkeletonNodeId: { value: selectedNode.nodeId },
      selectedSpatialSkeletonNodeInfo: { value: selectedNode },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: vi.fn(),
      },
      manager: {
        root: {
          layerSelectedValues: {
            mouseState: {
              pickedRenderLayer: undefined,
              updateUnconditionally: vi.fn(() => true),
              active: true,
            },
          },
          selectionState: {
            value: undefined,
          },
        },
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getSpatialSkeletonActionsDisabledReason: vi.fn(() => undefined),
      selectSegment,
      selectSpatialSkeletonNode,
      layersChanged: makeChangedSignal(),
    };
    const { activation, dispose } = makeToolActivation();
    const tool = Object.assign(
      Object.create(SpatialSkeletonSplitModeTool.prototype),
      { layer },
    );

    try {
      SpatialSkeletonSplitModeTool.prototype.activate.call(
        tool,
        activation as any,
      );

      expect(selectSegment).toHaveBeenCalledWith(11n, true);
      expect(selectSpatialSkeletonNode).toHaveBeenCalledWith(
        selectedNode.nodeId,
        true,
        selectedNode,
      );
      expect(splitSkeletonsCommand.createCommand).toHaveBeenCalledWith(layer, {
        nodeId: selectedNode.nodeId,
        segmentId: selectedNode.segmentId,
      });
      expect(splitExecute).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });
});
