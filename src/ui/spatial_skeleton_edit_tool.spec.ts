import { afterEach, describe, expect, it, vi } from "vitest";

import { makeCatmaidNodeSourceState } from "#src/datasource/catmaid/api.js";
import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_commands.js";
import {
  executeSpatialSkeletonAddNode,
  executeSpatialSkeletonMerge,
} from "#src/layer/segmentation/spatial_skeleton_commands.js";
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
      invalidateSourceCaches: vi.fn(),
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
    expect(skeletonLayer.invalidateSourceCaches).not.toHaveBeenCalled();
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
      invalidateSourceCaches: vi.fn(),
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
    expect(skeletonLayer.invalidateSourceCaches).not.toHaveBeenCalled();
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
      invalidateSourceCaches: vi.fn(),
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
    expect(skeletonLayer.invalidateSourceCaches).toHaveBeenCalledTimes(1);
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
});
