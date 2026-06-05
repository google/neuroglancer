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

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeCatmaidNodeSourceState } from "#src/datasource/catmaid/api.js";
import { buildCatmaidNeighborhoodEditContext } from "#src/datasource/catmaid/edit_state.js";
import { CatmaidSpatialSkeletonEditCommands } from "#src/datasource/catmaid/spatial_skeleton_commands.js";
import {
  executeSpatialSkeletonAddNode,
  executeSpatialSkeletonDeleteNode,
  executeSpatialSkeletonInsertNode,
  executeSpatialSkeletonMerge,
  executeSpatialSkeletonMoveNode,
  executeSpatialSkeletonNodeConfidenceUpdate,
  executeSpatialSkeletonNodeDescriptionUpdate,
  executeSpatialSkeletonNodeRadiusUpdate,
  executeSpatialSkeletonNodeTrueEndUpdate,
  executeSpatialSkeletonReroot,
  executeSpatialSkeletonSplit,
  redoSpatialSkeletonCommand,
  undoSpatialSkeletonCommand,
} from "#src/layer/segmentation/spatial_skeleton_commands.js";
import { SpatialSkeletonActions } from "#src/skeleton/actions.js";
import type { SpatiallyIndexedSkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonCommandHistory } from "#src/skeleton/command_history.js";
import {
  findSpatiallyIndexedSkeletonNode,
  getSpatiallyIndexedSkeletonDirectChildren,
  getSpatiallyIndexedSkeletonNodeParent,
} from "#src/skeleton/node_traversal.js";
import { SpatialSkeletonState } from "#src/skeleton/spatial_skeleton_manager.js";
import { StatusMessage } from "#src/status.js";

function cloneNode(
  node: SpatiallyIndexedSkeletonNode,
): SpatiallyIndexedSkeletonNode {
  return {
    ...node,
    position: new Float32Array(node.position),
    description: node.description,
    isTrueEnd: node.isTrueEnd,
  };
}

function cloneNodes(
  nodes: readonly SpatiallyIndexedSkeletonNode[] | undefined,
): SpatiallyIndexedSkeletonNode[] {
  return (nodes ?? []).map((node) => cloneNode(node));
}

function setSegmentNodes(
  cacheBySegment: Map<number, SpatiallyIndexedSkeletonNode[]>,
  cacheByNode: Map<number, SpatiallyIndexedSkeletonNode>,
  segmentId: number,
  nodes: readonly SpatiallyIndexedSkeletonNode[],
) {
  if (nodes.length === 0) {
    cacheBySegment.delete(segmentId);
  } else {
    cacheBySegment.set(segmentId, cloneNodes(nodes));
  }
  cacheByNode.clear();
  for (const segmentNodes of cacheBySegment.values()) {
    for (const node of segmentNodes) {
      cacheByNode.set(node.nodeId, node);
    }
  }
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

function makeCatmaidEditCommands(client = makeCatmaidClient()) {
  return new CatmaidSpatialSkeletonEditCommands({
    getClient: () => client as any,
  });
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
  const commands = makeCatmaidEditCommands(makeCatmaidClient(clientOverrides));
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

function makeDisplayState(visibleSegmentIds: readonly number[]) {
  return {
    segmentationGroupState: {
      value: {
        visibleSegments: new Set(
          visibleSegmentIds.map((segmentId) => BigInt(segmentId)),
        ),
        selectedSegments: new Set<bigint>(),
        segmentEquivalences: {},
        temporaryVisibleSegments: new Set<bigint>(),
        temporarySegmentEquivalences: {},
        useTemporaryVisibleSegments: { value: false },
        useTemporarySegmentEquivalences: { value: false },
      },
    },
    segmentStatedColors: {
      value: {
        delete: vi.fn(),
      },
    },
  };
}

function makePinnedManager() {
  return {
    root: {
      selectionState: {
        pin: {
          value: true,
        },
      },
    },
  };
}

describe("spatial_skeleton_commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes opaque source-created commands through a valid edit source", async () => {
    const execute = vi.fn();
    const undo = vi.fn();
    const redo = vi.fn();
    const command = {
      label: "Backend-owned move",
      execute,
      undo,
      redo,
    };
    const createCommand = vi.fn(() => command);
    const layer = {
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
      },
      getSpatiallyIndexedSkeletonLayer: () => ({
        source: {
          ...makeEditableSkeletonSource({
            moveNodesCommand: {
              action: SpatialSkeletonActions.moveNodes,
              createCommand,
            },
          }),
        },
      }),
    };
    const node: SpatiallyIndexedSkeletonNode = {
      nodeId: 17,
      segmentId: 23,
      position: new Float32Array([1, 2, 3]),
    };
    const nextPositionInModelSpace = new Float32Array([7, 8, 9]);

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace,
    });
    await undoSpatialSkeletonCommand(layer as any);
    await redoSpatialSkeletonCommand(layer as any);

    expect(createCommand).toHaveBeenCalledWith(layer, {
      node,
      nextPositionInModelSpace,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("does not treat a source with an invalid command factory as editable", () => {
    const layer = {
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
      },
      getSpatiallyIndexedSkeletonLayer: () => ({
        source: {
          ...makeEditableSkeletonSource(),
          readonly: false,
          editNodeDescriptionCommand: {
            action: SpatialSkeletonActions.editNodeDescription,
          },
        },
      }),
    };

    expect(() =>
      executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
        node: {
          nodeId: 17,
          segmentId: 23,
          position: new Float32Array([1, 2, 3]),
        },
        nextDescription: "next",
      }),
    ).toThrow(
      "Unable to resolve editable skeleton source for the active layer.",
    );
  });

  it("reports unsupported commands clearly", () => {
    const layer = {
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
      },
      getSpatiallyIndexedSkeletonLayer: () => ({
        source: {
          ...makeEditableSkeletonSource({
            editNodeDescriptionCommand: undefined,
          }),
          readonly: false,
        },
      }),
    };
    const node: SpatiallyIndexedSkeletonNode = {
      nodeId: 17,
      segmentId: 23,
      position: new Float32Array([1, 2, 3]),
    };

    expect(() =>
      executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
        node,
        nextDescription: "next",
      }),
    ).toThrow(
      "The active skeleton source does not support node description editing.",
    );
  });

  it("routes public wrappers through shared execution metadata", async () => {
    const showMessage = vi.spyOn(StatusMessage, "showMessage").mockReturnValue({
      dispose: vi.fn(),
    } as unknown as StatusMessage);
    const makeCommandFactory = (action: string) => ({
      action,
      createCommand: vi.fn(() => ({
        label: action,
        execute: vi.fn(async () => {}),
        undo: vi.fn(async () => {}),
      })),
    });
    const source = {
      readonly: false,
      addNodesCommand: makeCommandFactory(SpatialSkeletonActions.addNodes),
      insertNodesCommand: makeCommandFactory(
        SpatialSkeletonActions.insertNodes,
      ),
      moveNodesCommand: makeCommandFactory(SpatialSkeletonActions.moveNodes),
      deleteNodesCommand: makeCommandFactory(
        SpatialSkeletonActions.deleteNodes,
      ),
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
    };
    const layer = {
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
      },
      getSpatiallyIndexedSkeletonLayer: () => ({ source }),
    };
    const node: SpatiallyIndexedSkeletonNode = {
      nodeId: 17,
      segmentId: 23,
      position: new Float32Array([1, 2, 3]),
    };
    const firstNode = { nodeId: 17, segmentId: 23 };
    const secondNode = { nodeId: 29, segmentId: 31 };
    const cases = [
      {
        commandFactory: source.addNodesCommand,
        execute: () =>
          executeSpatialSkeletonAddNode(layer as any, {
            skeletonId: 23,
            positionInModelSpace: new Float32Array([4, 5, 6]),
          }),
        pendingMessage: "Creating node...",
      },
      {
        commandFactory: source.insertNodesCommand,
        execute: () =>
          executeSpatialSkeletonInsertNode(layer as any, {
            skeletonId: 23,
            parentNodeId: 17,
            childNodeIds: [29],
            positionInModelSpace: new Float32Array([4, 5, 6]),
          }),
        pendingMessage: "Inserting node...",
      },
      {
        commandFactory: source.moveNodesCommand,
        execute: () =>
          executeSpatialSkeletonMoveNode(layer as any, {
            node,
            nextPositionInModelSpace: new Float32Array([7, 8, 9]),
          }),
      },
      {
        commandFactory: source.deleteNodesCommand,
        execute: () => executeSpatialSkeletonDeleteNode(layer as any, node),
        pendingMessage: "Deleting node...",
      },
      {
        commandFactory: source.editNodeDescriptionCommand,
        execute: () =>
          executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
            node,
            nextDescription: "next",
          }),
      },
      {
        commandFactory: source.editNodeTrueEndCommand,
        execute: () =>
          executeSpatialSkeletonNodeTrueEndUpdate(layer as any, {
            node,
            nextIsTrueEnd: true,
          }),
      },
      {
        commandFactory: source.editNodeRadiusCommand,
        execute: () =>
          executeSpatialSkeletonNodeRadiusUpdate(layer as any, {
            node,
            nextRadius: 42,
          }),
      },
      {
        commandFactory: source.editNodeConfidenceCommand,
        execute: () =>
          executeSpatialSkeletonNodeConfidenceUpdate(layer as any, {
            node,
            nextConfidence: 5,
          }),
      },
      {
        commandFactory: source.rerootCommand,
        execute: () => executeSpatialSkeletonReroot(layer as any, node),
      },
      {
        commandFactory: source.splitSkeletonsCommand,
        execute: () => executeSpatialSkeletonSplit(layer as any, node),
        pendingMessage: "Splitting skeleton...",
      },
      {
        commandFactory: source.mergeSkeletonsCommand,
        execute: () =>
          executeSpatialSkeletonMerge(layer as any, firstNode, secondNode),
        pendingMessage: "Merging skeletons...",
      },
    ];

    for (const testCase of cases) {
      const dispose = vi.fn();
      showMessage.mockReturnValue({ dispose } as unknown as StatusMessage);
      showMessage.mockClear();

      await testCase.execute();

      expect(testCase.commandFactory.createCommand).toHaveBeenCalledTimes(1);
      if (testCase.pendingMessage === undefined) {
        expect(showMessage).not.toHaveBeenCalled();
      } else {
        expect(showMessage).toHaveBeenCalledWith(testCase.pendingMessage);
        expect(dispose).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("exposes CATMAID command factories for supported edit actions", () => {
    const commandSource = makeCatmaidEditCommands();

    expect(commandSource.moveNodesCommand.action).toBe(
      SpatialSkeletonActions.moveNodes,
    );
    expect(commandSource.editNodeRadiusCommand.action).toBe(
      SpatialSkeletonActions.editNodeRadius,
    );
    expect(commandSource.editNodeConfidenceCommand.action).toBe(
      SpatialSkeletonActions.editNodeConfidence,
    );
    expect((commandSource as any).inspectCommand).toBeUndefined();
  });

  it("creates CATMAID commands from valid opaque payloads", () => {
    const commandSource = makeCatmaidEditCommands();
    const layer = {
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
      },
    };
    const node: SpatiallyIndexedSkeletonNode = {
      nodeId: 17,
      segmentId: 23,
      position: new Float32Array([1, 2, 3]),
    };

    const command = commandSource.moveNodesCommand.createCommand(layer as any, {
      node,
      nextPositionInModelSpace: new Float32Array([7, 8, 9]),
    });

    expect(command?.label).toBe("Move node");
  });

  it("reports invalid CATMAID command payloads clearly", () => {
    const commandSource = makeCatmaidEditCommands();
    const layer = {
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
      },
    };

    expect(() =>
      commandSource.moveNodesCommand.createCommand(layer as any, {
        node: {},
        nextPositionInModelSpace: new Float32Array([7, 8, 9]),
      }),
    ).toThrow("CATMAID move-node command received an invalid payload.");
  });

  it("commits radius and confidence commands independently", async () => {
    suppressStatusMessages();

    const node: SpatiallyIndexedSkeletonNode = {
      nodeId: 17,
      segmentId: 23,
      position: new Float32Array([1, 2, 3]),
      radius: 4,
      confidence: 50,
      sourceState: testSourceState("before"),
    };
    let cachedNode = node;
    const updateRadius = vi.fn().mockResolvedValue({
      sourceState: testSourceState("after-radius"),
    });
    const updateConfidence = vi.fn().mockResolvedValue({
      sourceState: testSourceState("after-confidence"),
    });
    const skeletonLayer = {
      source: makeEditableSkeletonSource({ updateRadius, updateConfidence }),
      getNode: vi.fn((nodeId: number) =>
        nodeId === cachedNode.nodeId ? cachedNode : undefined,
      ),
      invalidateSourceCellsForPositions: vi.fn(),
    };
    const commandHistory = new SpatialSkeletonCommandHistory();
    const setNodeRadius = vi.fn((nodeId: number, radius: number) => {
      if (nodeId === cachedNode.nodeId) {
        cachedNode = { ...cachedNode, radius };
      }
    });
    const setNodeConfidence = vi.fn((nodeId: number, confidence: number) => {
      if (nodeId === cachedNode.nodeId) {
        cachedNode = { ...cachedNode, confidence };
      }
    });
    const setCachedNodeSourceState = vi.fn(
      (nodeId: number, sourceState: unknown) => {
        if (nodeId === cachedNode.nodeId) {
          cachedNode = { ...cachedNode, sourceState: sourceState as any };
        }
      },
    );
    const markSpatialSkeletonNodeDataChanged = vi.fn();
    const layer = {
      spatialSkeletonState: {
        commandHistory,
        getCachedNode: vi.fn((nodeId: number) =>
          nodeId === cachedNode.nodeId ? cachedNode : undefined,
        ),
        getCachedSegmentNodes: vi.fn((segmentId: number) =>
          segmentId === cachedNode.segmentId ? [cachedNode] : undefined,
        ),
        setNodeRadius,
        setNodeConfidence,
        setCachedNodeSourceState,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      markSpatialSkeletonNodeDataChanged,
    };

    await executeSpatialSkeletonNodeRadiusUpdate(layer as any, {
      node: cachedNode,
      nextRadius: 6,
    });
    await executeSpatialSkeletonNodeConfidenceUpdate(layer as any, {
      node: cachedNode,
      nextConfidence: 75,
    });

    expect(updateRadius).toHaveBeenCalledWith(
      17,
      6,
      expect.objectContaining({
        node: expect.objectContaining({ nodeId: 17 }),
      }),
    );
    expect(updateConfidence).toHaveBeenCalledWith(
      17,
      75,
      expect.objectContaining({
        node: expect.objectContaining({ nodeId: 17 }),
      }),
    );
    expect(setNodeRadius).toHaveBeenCalledWith(17, 6);
    expect(setNodeConfidence).toHaveBeenCalledWith(17, 75);
    expect(setCachedNodeSourceState).toHaveBeenCalledWith(
      17,
      testSourceState("after-radius"),
    );
    expect(setCachedNodeSourceState).toHaveBeenCalledWith(
      17,
      testSourceState("after-confidence"),
    );
    expect(markSpatialSkeletonNodeDataChanged).toHaveBeenCalledTimes(2);
  });

  it("commits move-node commands using model-space positions", async () => {
    suppressStatusMessages();

    const node: SpatiallyIndexedSkeletonNode = {
      nodeId: 17,
      segmentId: 23,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
      sourceState: testSourceState("before"),
    };
    const nextPositionInModelSpace = new Float32Array([7, 8, 9]);
    const moveNode = vi.fn().mockResolvedValue({
      sourceState: testSourceState("after"),
    });
    const skeletonLayer = {
      source: makeEditableSkeletonSource({ moveNode }),
      getNode: vi.fn((nodeId: number) =>
        nodeId === node.nodeId ? node : undefined,
      ),
      retainOverlaySegment: vi.fn(),
      invalidateSourceCellsForPositions: vi.fn(),
    };
    const commandHistory = new SpatialSkeletonCommandHistory();
    const moveCachedNode = vi.fn();
    const setCachedNodeSourceState = vi.fn();
    const markSpatialSkeletonNodeDataChanged = vi.fn();
    const layer = {
      spatialSkeletonState: {
        commandHistory,
        getCachedNode: vi.fn((nodeId: number) =>
          nodeId === node.nodeId ? node : undefined,
        ),
        getCachedSegmentNodes: vi.fn((segmentId: number) =>
          segmentId === node.segmentId ? [node] : undefined,
        ),
        moveCachedNode,
        setCachedNodeSourceState,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      markSpatialSkeletonNodeDataChanged,
    };

    await executeSpatialSkeletonMoveNode(layer as any, {
      node,
      nextPositionInModelSpace,
    });

    expect(moveNode).toHaveBeenCalledWith(
      17,
      7,
      8,
      9,
      expect.objectContaining({
        node: expect.objectContaining({ nodeId: 17 }),
      }),
    );
    expect(skeletonLayer.retainOverlaySegment).toHaveBeenCalledWith(23);
    expect(moveCachedNode).toHaveBeenCalledWith(
      17,
      new Float32Array([7, 8, 9]),
    );
    expect(setCachedNodeSourceState).toHaveBeenCalledWith(
      17,
      testSourceState("after"),
    );
    expect(markSpatialSkeletonNodeDataChanged).toHaveBeenCalledWith({
      invalidateFullSkeletonCache: false,
    });
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).not.toHaveBeenCalled();
  });

  it("preserves CATMAID true-end labels when editing node descriptions", async () => {
    suppressStatusMessages();

    let cachedNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 17,
      segmentId: 23,
      position: new Float32Array([1, 2, 3]),
      description: "before",
      isTrueEnd: true,
      sourceState: testSourceState("before"),
    };
    const updateDescription = vi.fn().mockResolvedValue({
      description: "after",
      sourceState: testSourceState("after"),
    });
    const toggleTrueEnd = vi.fn();
    const skeletonLayer = {
      source: makeEditableSkeletonSource({ updateDescription, toggleTrueEnd }),
      getNode: vi.fn((nodeId: number) =>
        nodeId === cachedNode.nodeId ? cachedNode : undefined,
      ),
      invalidateSourceCellsForPositions: vi.fn(),
    };
    const commandHistory = new SpatialSkeletonCommandHistory();
    const updateCachedNode = vi.fn(
      (
        nodeId: number,
        updater: (
          candidate: SpatiallyIndexedSkeletonNode,
        ) => SpatiallyIndexedSkeletonNode,
      ) => {
        if (nodeId === cachedNode.nodeId) {
          cachedNode = updater(cachedNode);
        }
      },
    );
    const setCachedNodeSourceState = vi.fn(
      (nodeId: number, sourceState: unknown) => {
        if (nodeId === cachedNode.nodeId) {
          cachedNode = { ...cachedNode, sourceState: sourceState as any };
        }
      },
    );
    const markSpatialSkeletonNodeDataChanged = vi.fn();
    const layer = {
      spatialSkeletonState: {
        commandHistory,
        getCachedNode: vi.fn((nodeId: number) =>
          nodeId === cachedNode.nodeId ? cachedNode : undefined,
        ),
        getCachedSegmentNodes: vi.fn((segmentId: number) =>
          segmentId === cachedNode.segmentId ? [cachedNode] : undefined,
        ),
        updateCachedNode,
        setCachedNodeSourceState,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      markSpatialSkeletonNodeDataChanged,
    };

    await executeSpatialSkeletonNodeDescriptionUpdate(layer as any, {
      node: cachedNode,
      nextDescription: "after",
    });

    expect(updateDescription).toHaveBeenCalledWith(17, "after", {
      isTrueEnd: true,
    });
    expect(toggleTrueEnd).not.toHaveBeenCalled();
    expect(cachedNode).toMatchObject({
      description: "after",
      isTrueEnd: true,
      sourceState: testSourceState("after"),
    });
    expect(markSpatialSkeletonNodeDataChanged).toHaveBeenCalledWith({
      invalidateFullSkeletonCache: false,
    });
  });

  it("deletes node when undoing an add-node command", async () => {
    suppressStatusMessages();

    const segmentId = 23;
    const parentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId,
      position: new Float32Array([4, 5, 6]),
      isTrueEnd: false,
      sourceState: testSourceState("parent-before-add"),
    };
    const addNode = vi.fn().mockResolvedValue({
      nodeId: 2,
      segmentId,
      sourceState: testSourceState("added-after-add"),
      parentSourceState: testSourceState("parent-after-add"),
    });
    const deleteNode = vi.fn().mockResolvedValue({
      nodeSourceStateUpdates: [
        {
          nodeId: parentNode.nodeId,
          sourceState: testSourceState("parent-after-undo"),
        },
      ],
    });
    const skeletonSource = makeEditableSkeletonSource({
      addNode,
      deleteNode,
    });
    const spatialSkeletonState = new SpatialSkeletonState();
    spatialSkeletonState.upsertCachedNode(parentNode, {
      allowUncachedSegment: true,
    });
    const skeletonLayer = {
      source: skeletonSource,
      getNode: vi.fn((nodeId: number) =>
        spatialSkeletonState.getCachedNode(nodeId),
      ),
      retainOverlaySegment: vi.fn(),
      invalidateSourceCellsForPositions: vi.fn(),
    };
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: {
            visibleSegments: new Set<bigint>([BigInt(segmentId)]),
            selectedSegments: new Set<bigint>(),
            segmentEquivalences: {},
            temporaryVisibleSegments: new Set<bigint>(),
            temporarySegmentEquivalences: {},
            useTemporaryVisibleSegments: { value: false },
            useTemporarySegmentEquivalences: { value: false },
          },
        },
      },
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
      spatialSkeletonState,
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      async getSpatialSkeletonDeleteOperationContext(
        node: SpatiallyIndexedSkeletonNode,
      ) {
        const segmentNodes =
          spatialSkeletonState.getCachedSegmentNodes(node.segmentId) ?? [];
        const currentNode = findSpatiallyIndexedSkeletonNode(
          segmentNodes,
          node.nodeId,
        );
        if (currentNode === undefined) {
          throw new Error(`Unable to resolve cached node ${node.nodeId}.`);
        }
        const childNodes = getSpatiallyIndexedSkeletonDirectChildren(
          segmentNodes,
          currentNode.nodeId,
        );
        return {
          node: currentNode,
          parentNode: getSpatiallyIndexedSkeletonNodeParent(
            segmentNodes,
            currentNode,
          ),
          childNodes,
        };
      },
      selectSegment: vi.fn(),
      selectAndMoveToSpatialSkeletonNode: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      clearSpatialSkeletonNodeSelection: vi.fn(),
      moveViewToSpatialSkeletonNodePosition: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
    };

    await executeSpatialSkeletonAddNode(layer as any, {
      skeletonId: segmentId,
      parentNodeId: parentNode.nodeId,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });

    layer.selectAndMoveToSpatialSkeletonNode.mockClear();
    layer.selectSpatialSkeletonNode.mockClear();
    layer.moveViewToSpatialSkeletonNodePosition.mockClear();

    await undoSpatialSkeletonCommand(layer as any);

    expect(deleteNode).toHaveBeenCalledWith(2, {
      childNodeIds: [],
      editContext: expect.objectContaining({
        node: expect.objectContaining({ nodeId: 2 }),
        parent: expect.objectContaining({ nodeId: parentNode.nodeId }),
      }),
    });
    expect(spatialSkeletonState.getCachedNode(2)).toBeUndefined();
  });

  it("restores internal-node delete undo as an insertion in the local cache", async () => {
    suppressStatusMessages();

    const segmentId = 23;
    const rootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
      sourceState: testSourceState("root-before-delete"),
    };
    const deletedNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 2,
      segmentId,
      parentNodeId: rootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
      isTrueEnd: false,
      sourceState: testSourceState("deleted-before-delete"),
    };
    const firstChildNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 3,
      segmentId,
      parentNodeId: deletedNode.nodeId,
      position: new Float32Array([7, 8, 9]),
      isTrueEnd: false,
      sourceState: testSourceState("first-child-before-delete"),
    };
    const secondChildNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 4,
      segmentId,
      parentNodeId: deletedNode.nodeId,
      position: new Float32Array([10, 11, 12]),
      isTrueEnd: false,
      sourceState: testSourceState("second-child-before-delete"),
    };

    const deleteNode = vi.fn().mockResolvedValue({
      nodeSourceStateUpdates: [
        {
          nodeId: rootNode.nodeId,
          sourceState: testSourceState("root-after-delete"),
        },
        {
          nodeId: firstChildNode.nodeId,
          sourceState: testSourceState("first-child-after-delete"),
        },
        {
          nodeId: secondChildNode.nodeId,
          sourceState: testSourceState("second-child-after-delete"),
        },
      ],
    });
    const addNode = vi.fn();
    const insertNode = vi.fn().mockResolvedValue({
      nodeId: 20,
      segmentId,
      sourceState: testSourceState("restored-after-undo"),
      parentSourceState: testSourceState("root-after-undo"),
      nodeSourceStateUpdates: [
        {
          nodeId: firstChildNode.nodeId,
          sourceState: testSourceState("first-child-after-undo"),
        },
        {
          nodeId: secondChildNode.nodeId,
          sourceState: testSourceState("second-child-after-undo"),
        },
      ],
    });
    const skeletonSource = makeEditableSkeletonSource({
      addNode,
      deleteNode,
      insertNode,
    });
    const skeletonLayer = {
      source: skeletonSource,
      getNode: vi.fn(),
      invalidateSourceCellsForPositions: vi.fn(),
      retainOverlaySegment: vi.fn(),
    };
    const spatialSkeletonState = new SpatialSkeletonState();
    spatialSkeletonState.upsertCachedNode(rootNode, {
      allowUncachedSegment: true,
    });
    spatialSkeletonState.upsertCachedNode(deletedNode);
    spatialSkeletonState.upsertCachedNode(firstChildNode);
    spatialSkeletonState.upsertCachedNode(secondChildNode);
    skeletonLayer.getNode.mockImplementation((nodeId: number) =>
      spatialSkeletonState.getCachedNode(nodeId),
    );

    const layer = {
      displayState: {
        segmentationGroupState: {
          value: {
            visibleSegments: new Set<bigint>([BigInt(segmentId)]),
            selectedSegments: new Set<bigint>(),
            segmentEquivalences: {},
            temporaryVisibleSegments: new Set<bigint>(),
            temporarySegmentEquivalences: {},
            useTemporaryVisibleSegments: { value: false },
            useTemporarySegmentEquivalences: { value: false },
          },
        },
      },
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
      spatialSkeletonState,
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getCachedSpatialSkeletonSegmentNodesForEdit: (
        requestedSegmentId: number,
      ) => spatialSkeletonState.getCachedSegmentNodes(requestedSegmentId) ?? [],
      async getSpatialSkeletonDeleteOperationContext(
        node: SpatiallyIndexedSkeletonNode,
      ) {
        const segmentNodes =
          spatialSkeletonState.getCachedSegmentNodes(node.segmentId) ?? [];
        const currentNode = findSpatiallyIndexedSkeletonNode(
          segmentNodes,
          node.nodeId,
        );
        if (currentNode === undefined) {
          throw new Error(`Unable to resolve cached node ${node.nodeId}.`);
        }
        const childNodes = getSpatiallyIndexedSkeletonDirectChildren(
          segmentNodes,
          currentNode.nodeId,
        );
        return {
          node: currentNode,
          parentNode: getSpatiallyIndexedSkeletonNodeParent(
            segmentNodes,
            currentNode,
          ),
          childNodes,
          editContext: buildCatmaidNeighborhoodEditContext(
            currentNode,
            segmentNodes,
          ),
        };
      },
      selectAndMoveToSpatialSkeletonNode: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      clearSpatialSkeletonNodeSelection: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
    };

    await executeSpatialSkeletonDeleteNode(layer as any, deletedNode);

    expect(
      spatialSkeletonState.getCachedNode(deletedNode.nodeId),
    ).toBeUndefined();
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([
      deletedNode.position,
      rootNode.position,
      firstChildNode.position,
      secondChildNode.position,
    ]);
    expect(
      spatialSkeletonState.getCachedNode(firstChildNode.nodeId)?.parentNodeId,
    ).toBe(rootNode.nodeId);
    expect(
      spatialSkeletonState.getCachedNode(secondChildNode.nodeId)?.parentNodeId,
    ).toBe(rootNode.nodeId);

    await undoSpatialSkeletonCommand(layer as any);

    expect(addNode).not.toHaveBeenCalled();
    expect(insertNode).toHaveBeenCalledWith(
      segmentId,
      4,
      5,
      6,
      rootNode.nodeId,
      [firstChildNode.nodeId, secondChildNode.nodeId],
      expect.objectContaining({
        node: expect.objectContaining({ nodeId: rootNode.nodeId }),
        children: expect.arrayContaining([
          expect.objectContaining({ nodeId: firstChildNode.nodeId }),
          expect.objectContaining({ nodeId: secondChildNode.nodeId }),
        ]),
      }),
    );

    const restoredNode = spatialSkeletonState.getCachedNode(20);
    expect(restoredNode).toMatchObject({
      nodeId: 20,
      parentNodeId: rootNode.nodeId,
      segmentId,
    });
    expect(
      spatialSkeletonState.getCachedNode(firstChildNode.nodeId)?.parentNodeId,
    ).toBe(restoredNode?.nodeId);
    expect(
      spatialSkeletonState.getCachedNode(secondChildNode.nodeId)?.parentNodeId,
    ).toBe(restoredNode?.nodeId);
    const restoredEditContext = buildCatmaidNeighborhoodEditContext(
      restoredNode!,
      spatialSkeletonState.getCachedSegmentNodes(segmentId)!,
    );
    expect(restoredEditContext.children?.map((child) => child.nodeId)).toEqual([
      firstChildNode.nodeId,
      secondChildNode.nodeId,
    ]);
  });

  it("invalidates only the split subtree and former parent when splitting and redoing", async () => {
    suppressStatusMessages();

    const originalSegmentId = 11;
    const splitSegmentId = 17;
    const rootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 1,
      segmentId: originalSegmentId,
      position: new Float32Array([1, 0, 0]),
      isTrueEnd: false,
      sourceState: testSourceState("root-before"),
    };
    const formerParentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 2,
      segmentId: originalSegmentId,
      parentNodeId: rootNode.nodeId,
      position: new Float32Array([2, 0, 0]),
      isTrueEnd: false,
      sourceState: testSourceState("parent-before"),
    };
    const parentSideSiblingNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 3,
      segmentId: originalSegmentId,
      parentNodeId: formerParentNode.nodeId,
      position: new Float32Array([3, 0, 0]),
      isTrueEnd: false,
      sourceState: testSourceState("sibling-before"),
    };
    const splitNodeBefore: SpatiallyIndexedSkeletonNode = {
      nodeId: 4,
      segmentId: originalSegmentId,
      parentNodeId: formerParentNode.nodeId,
      position: new Float32Array([4, 0, 0]),
      isTrueEnd: false,
      sourceState: testSourceState("split-before"),
    };
    const splitChildNodeBefore: SpatiallyIndexedSkeletonNode = {
      nodeId: 5,
      segmentId: originalSegmentId,
      parentNodeId: splitNodeBefore.nodeId,
      position: new Float32Array([5, 0, 0]),
      isTrueEnd: false,
      sourceState: testSourceState("split-child-before"),
    };
    const splitGrandchildNodeBefore: SpatiallyIndexedSkeletonNode = {
      nodeId: 6,
      segmentId: originalSegmentId,
      parentNodeId: splitChildNodeBefore.nodeId,
      position: new Float32Array([6, 0, 0]),
      isTrueEnd: false,
      sourceState: testSourceState("split-grandchild-before"),
    };
    const originalNodes = [
      rootNode,
      formerParentNode,
      parentSideSiblingNode,
      splitNodeBefore,
      splitChildNodeBefore,
      splitGrandchildNodeBefore,
    ];
    const existingSideNodes = [
      rootNode,
      formerParentNode,
      parentSideSiblingNode,
    ];
    const splitSideNodes = [
      {
        ...splitNodeBefore,
        segmentId: splitSegmentId,
        parentNodeId: undefined,
        sourceState: testSourceState("split-after"),
      },
      {
        ...splitChildNodeBefore,
        segmentId: splitSegmentId,
        sourceState: testSourceState("split-child-after"),
      },
      {
        ...splitGrandchildNodeBefore,
        segmentId: splitSegmentId,
        sourceState: testSourceState("split-grandchild-after"),
      },
    ];

    const serverSegments = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheBySegment = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheByNode = new Map<number, SpatiallyIndexedSkeletonNode>();

    const syncCacheFromServer = (segmentId: number) => {
      setSegmentNodes(
        cacheBySegment,
        cacheByNode,
        segmentId,
        serverSegments.get(segmentId) ?? [],
      );
      return cacheBySegment.get(segmentId) ?? [];
    };

    serverSegments.set(originalSegmentId, originalNodes.map(cloneNode));
    syncCacheFromServer(originalSegmentId);

    const splitSkeleton = vi.fn(async () => {
      serverSegments.set(originalSegmentId, existingSideNodes.map(cloneNode));
      serverSegments.set(splitSegmentId, splitSideNodes.map(cloneNode));
      return {
        existingSegmentId: originalSegmentId,
        newSegmentId: splitSegmentId,
      };
    });
    const mergeSkeletons = vi.fn(async () => {
      serverSegments.set(originalSegmentId, originalNodes.map(cloneNode));
      serverSegments.delete(splitSegmentId);
      return {
        resultSegmentId: originalSegmentId,
        deletedSegmentId: splitSegmentId,
        directionAdjusted: false,
      };
    });
    const skeletonSource = makeEditableSkeletonSource({
      splitSkeleton,
      mergeSkeletons,
    });
    const invalidateCachedSegments = vi.fn((segmentIds: Iterable<number>) => {
      for (const segmentId of segmentIds) {
        setSegmentNodes(cacheBySegment, cacheByNode, segmentId, []);
      }
    });
    const getFullSegmentNodes = vi.fn(
      async (_skeletonLayer: unknown, segmentId: number) =>
        syncCacheFromServer(segmentId),
    );
    const skeletonLayer = {
      source: skeletonSource,
      getNode: vi.fn((nodeId: number) => cacheByNode.get(nodeId)),
      invalidateSourceCellsForPositions: vi.fn(),
      suppressBrowseSegment: vi.fn(),
    };
    const layer = {
      displayState: makeDisplayState([originalSegmentId]),
      manager: makePinnedManager(),
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: (nodeId: number) => cacheByNode.get(nodeId),
        getCachedSegmentNodes: (segmentId: number) =>
          cacheBySegment.get(segmentId),
        getFullSegmentNodes,
        invalidateCachedSegments,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getCachedSpatialSkeletonSegmentNodesForEdit: (segmentId: number) =>
        cacheBySegment.get(segmentId) ?? [],
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
    };

    await executeSpatialSkeletonSplit(layer as any, {
      nodeId: splitNodeBefore.nodeId,
      segmentId: originalSegmentId,
    });

    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([
      splitNodeBefore.position,
      splitChildNodeBefore.position,
      splitGrandchildNodeBefore.position,
      formerParentNode.position,
    ]);
    await undoSpatialSkeletonCommand(layer as any);
    skeletonLayer.invalidateSourceCellsForPositions.mockClear();

    await redoSpatialSkeletonCommand(layer as any);

    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([
      splitNodeBefore.position,
      splitChildNodeBefore.position,
      splitGrandchildNodeBefore.position,
      formerParentNode.position,
    ]);
  });

  it("suppresses and clears the deleted segment when undoing a split", async () => {
    suppressStatusMessages();

    const originalSegmentId = 2973964;
    const splitSegmentId = 2973946;
    const formerParentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 21893039,
      segmentId: originalSegmentId,
      position: new Float32Array([10, 20, 30]),
      isTrueEnd: false,
      sourceState: testSourceState("parent-before"),
    };
    const splitNodeBefore: SpatiallyIndexedSkeletonNode = {
      nodeId: 21893038,
      segmentId: originalSegmentId,
      parentNodeId: formerParentNode.nodeId,
      position: new Float32Array([11, 21, 31]),
      isTrueEnd: false,
      sourceState: testSourceState("split-before"),
    };
    const splitNodeAfter: SpatiallyIndexedSkeletonNode = {
      ...splitNodeBefore,
      segmentId: splitSegmentId,
      parentNodeId: undefined,
      sourceState: testSourceState("split-after"),
    };
    const splitNodeMergedBack: SpatiallyIndexedSkeletonNode = {
      ...splitNodeBefore,
      sourceState: testSourceState("split-merged-back"),
    };

    const serverSegments = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheBySegment = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheByNode = new Map<number, SpatiallyIndexedSkeletonNode>();

    const syncCacheFromServer = (segmentId: number) => {
      setSegmentNodes(
        cacheBySegment,
        cacheByNode,
        segmentId,
        serverSegments.get(segmentId) ?? [],
      );
      return cacheBySegment.get(segmentId) ?? [];
    };

    serverSegments.set(originalSegmentId, [
      cloneNode(formerParentNode),
      cloneNode(splitNodeBefore),
    ]);
    syncCacheFromServer(originalSegmentId);

    const splitSkeleton = vi.fn(async () => {
      serverSegments.set(originalSegmentId, [cloneNode(formerParentNode)]);
      serverSegments.set(splitSegmentId, [cloneNode(splitNodeAfter)]);
      return {
        existingSegmentId: originalSegmentId,
        newSegmentId: splitSegmentId,
      };
    });
    const mergeSkeletons = vi.fn(async () => {
      serverSegments.set(originalSegmentId, [
        cloneNode(formerParentNode),
        cloneNode(splitNodeMergedBack),
      ]);
      serverSegments.delete(splitSegmentId);
      return {
        resultSegmentId: originalSegmentId,
        deletedSegmentId: splitSegmentId,
        directionAdjusted: false,
      };
    });
    const skeletonSource = makeEditableSkeletonSource({
      splitSkeleton,
      mergeSkeletons,
    });

    const deleteSegmentColor = vi.fn();
    const invalidateCachedSegments = vi.fn((segmentIds: Iterable<number>) => {
      for (const segmentId of segmentIds) {
        setSegmentNodes(cacheBySegment, cacheByNode, segmentId, []);
      }
    });
    const getFullSegmentNodes = vi.fn(
      async (_skeletonLayer: unknown, segmentId: number) =>
        syncCacheFromServer(segmentId),
    );
    const skeletonLayer = {
      source: skeletonSource,
      getNode: vi.fn((nodeId: number) => cacheByNode.get(nodeId)),
      invalidateSourceCellsForPositions: vi.fn(),
      suppressBrowseSegment: vi.fn(),
    };
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: {
            visibleSegments: new Set<bigint>([BigInt(originalSegmentId)]),
            selectedSegments: new Set<bigint>(),
            segmentEquivalences: {},
            temporaryVisibleSegments: new Set<bigint>(),
            temporarySegmentEquivalences: {},
            useTemporaryVisibleSegments: { value: false },
            useTemporarySegmentEquivalences: { value: false },
          },
        },
        segmentStatedColors: {
          value: {
            delete: deleteSegmentColor,
          },
        },
      },
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: (nodeId: number) => cacheByNode.get(nodeId),
        getCachedSegmentNodes: (segmentId: number) =>
          cacheBySegment.get(segmentId),
        getFullSegmentNodes,
        invalidateCachedSegments,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getCachedSpatialSkeletonSegmentNodesForEdit: (segmentId: number) =>
        cacheBySegment.get(segmentId) ?? [],
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
    };

    await executeSpatialSkeletonSplit(layer as any, {
      nodeId: splitNodeBefore.nodeId,
      segmentId: originalSegmentId,
    });

    skeletonLayer.suppressBrowseSegment.mockClear();
    deleteSegmentColor.mockClear();
    layer.selectSpatialSkeletonNode.mockClear();
    layer.markSpatialSkeletonNodeDataChanged.mockClear();
    skeletonLayer.invalidateSourceCellsForPositions.mockClear();
    invalidateCachedSegments.mockClear();
    getFullSegmentNodes.mockClear();

    await undoSpatialSkeletonCommand(layer as any);

    expect(mergeSkeletons).toHaveBeenCalledWith(
      formerParentNode.nodeId,
      splitNodeBefore.nodeId,
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: formerParentNode.nodeId }),
          expect.objectContaining({ nodeId: splitNodeBefore.nodeId }),
        ]),
      }),
    );
    expect(deleteSegmentColor).toHaveBeenCalledWith(BigInt(splitSegmentId));
    expect(skeletonLayer.suppressBrowseSegment).toHaveBeenCalledWith(
      splitSegmentId,
    );
    expect(layer.selectSpatialSkeletonNode).toHaveBeenCalledWith(
      splitNodeBefore.nodeId,
      true,
      { segmentId: originalSegmentId },
    );
    expect(invalidateCachedSegments).toHaveBeenCalledWith([
      originalSegmentId,
      splitSegmentId,
    ]);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([
      splitNodeAfter.position,
      formerParentNode.position,
    ]);
    expect(getFullSegmentNodes).toHaveBeenCalledTimes(2);
    expect(
      layer.displayState.segmentationGroupState.value.visibleSegments.has(
        BigInt(originalSegmentId),
      ),
    ).toBe(true);
    expect(
      layer.displayState.segmentationGroupState.value.visibleSegments.has(
        BigInt(splitSegmentId),
      ),
    ).toBe(false);
    expect(cacheBySegment.get(splitSegmentId)).toBeUndefined();
    expect(
      cacheBySegment.get(originalSegmentId)?.map((node) => node.nodeId),
    ).toEqual([formerParentNode.nodeId, splitNodeBefore.nodeId]);
  });

  it("uses the original skeleton side as the join winner when undoing a split", async () => {
    suppressStatusMessages();

    const originalSegmentId = 2973964;
    const splitSegmentId = 2973946;
    const originalRootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 21893001,
      segmentId: originalSegmentId,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
      sourceState: testSourceState("root-before"),
    };
    const formerParentNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 21893039,
      segmentId: originalSegmentId,
      parentNodeId: originalRootNode.nodeId,
      position: new Float32Array([10, 20, 30]),
      isTrueEnd: false,
      sourceState: testSourceState("parent-before"),
    };
    const splitNodeBefore: SpatiallyIndexedSkeletonNode = {
      nodeId: 21893038,
      segmentId: originalSegmentId,
      parentNodeId: formerParentNode.nodeId,
      position: new Float32Array([11, 21, 31]),
      isTrueEnd: false,
      sourceState: testSourceState("split-before"),
    };
    const splitNodeAfter: SpatiallyIndexedSkeletonNode = {
      ...splitNodeBefore,
      segmentId: splitSegmentId,
      parentNodeId: undefined,
      sourceState: testSourceState("split-after"),
    };
    const restoredNodes: SpatiallyIndexedSkeletonNode[] = [
      {
        ...originalRootNode,
        parentNodeId: undefined,
        sourceState: testSourceState("root-rerooted"),
      },
      {
        ...formerParentNode,
        parentNodeId: originalRootNode.nodeId,
        sourceState: testSourceState("parent-rerooted"),
      },
      {
        ...splitNodeBefore,
        segmentId: originalSegmentId,
        parentNodeId: formerParentNode.nodeId,
        sourceState: testSourceState("split-rerooted"),
      },
    ];

    const serverSegments = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheBySegment = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheByNode = new Map<number, SpatiallyIndexedSkeletonNode>();

    const syncCacheFromServer = (segmentId: number) => {
      setSegmentNodes(
        cacheBySegment,
        cacheByNode,
        segmentId,
        serverSegments.get(segmentId) ?? [],
      );
      return cacheBySegment.get(segmentId) ?? [];
    };

    serverSegments.set(originalSegmentId, [
      cloneNode(originalRootNode),
      cloneNode(formerParentNode),
      cloneNode(splitNodeBefore),
    ]);
    syncCacheFromServer(originalSegmentId);

    const splitSkeleton = vi.fn(async () => {
      serverSegments.set(originalSegmentId, [
        cloneNode(originalRootNode),
        cloneNode(formerParentNode),
      ]);
      serverSegments.set(splitSegmentId, [cloneNode(splitNodeAfter)]);
      return {
        existingSegmentId: originalSegmentId,
        newSegmentId: splitSegmentId,
      };
    });
    const mergeSkeletons = vi.fn(async () => {
      serverSegments.set(originalSegmentId, restoredNodes.map(cloneNode));
      serverSegments.delete(splitSegmentId);
      return {
        resultSegmentId: originalSegmentId,
        deletedSegmentId: splitSegmentId,
        directionAdjusted: false,
      };
    });
    const rerootSkeleton = vi.fn();
    const skeletonSource = makeEditableSkeletonSource({
      splitSkeleton,
      mergeSkeletons,
      rerootSkeleton,
    });

    const invalidateCachedSegments = vi.fn((segmentIds: Iterable<number>) => {
      for (const segmentId of segmentIds) {
        setSegmentNodes(cacheBySegment, cacheByNode, segmentId, []);
      }
    });
    const getFullSegmentNodes = vi.fn(
      async (_skeletonLayer: unknown, segmentId: number) =>
        syncCacheFromServer(segmentId),
    );
    const skeletonLayer = {
      source: skeletonSource,
      getNode: vi.fn((nodeId: number) => cacheByNode.get(nodeId)),
      invalidateSourceCellsForPositions: vi.fn(),
      suppressBrowseSegment: vi.fn(),
    };
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: {
            visibleSegments: new Set<bigint>([BigInt(originalSegmentId)]),
            selectedSegments: new Set<bigint>(),
            segmentEquivalences: {},
            temporaryVisibleSegments: new Set<bigint>(),
            temporarySegmentEquivalences: {},
            useTemporaryVisibleSegments: { value: false },
            useTemporarySegmentEquivalences: { value: false },
          },
        },
        segmentStatedColors: {
          value: {
            delete: vi.fn(),
          },
        },
      },
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: (nodeId: number) => cacheByNode.get(nodeId),
        getCachedSegmentNodes: (segmentId: number) =>
          cacheBySegment.get(segmentId),
        getFullSegmentNodes,
        invalidateCachedSegments,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      getCachedSpatialSkeletonSegmentNodesForEdit: (segmentId: number) =>
        cacheBySegment.get(segmentId) ?? [],
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
    };

    await executeSpatialSkeletonSplit(layer as any, {
      nodeId: splitNodeBefore.nodeId,
      segmentId: originalSegmentId,
    });

    rerootSkeleton.mockClear();
    getFullSegmentNodes.mockClear();
    invalidateCachedSegments.mockClear();

    await undoSpatialSkeletonCommand(layer as any);

    expect(mergeSkeletons).toHaveBeenCalledWith(
      formerParentNode.nodeId,
      splitNodeBefore.nodeId,
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: formerParentNode.nodeId }),
          expect.objectContaining({ nodeId: splitNodeBefore.nodeId }),
        ]),
      }),
    );
    expect(rerootSkeleton).not.toHaveBeenCalled();
    expect(invalidateCachedSegments).toHaveBeenCalledTimes(1);
    expect(invalidateCachedSegments).toHaveBeenCalledWith([
      originalSegmentId,
      splitSegmentId,
    ]);
    expect(getFullSegmentNodes).toHaveBeenCalledTimes(2);
    expect(cacheBySegment.get(splitSegmentId)).toBeUndefined();
    expect(
      cacheBySegment.get(originalSegmentId)?.map((node) => ({
        nodeId: node.nodeId,
        parentNodeId: node.parentNodeId,
      })),
    ).toEqual([
      {
        nodeId: originalRootNode.nodeId,
        parentNodeId: undefined,
      },
      {
        nodeId: formerParentNode.nodeId,
        parentNodeId: originalRootNode.nodeId,
      },
      {
        nodeId: splitNodeBefore.nodeId,
        parentNodeId: formerParentNode.nodeId,
      },
    ]);
  });

  it("preserves full merge undo behavior for a hidden second pick", async () => {
    suppressStatusMessages();

    const visibleSegmentId = 11;
    const hiddenSegmentId = 17;
    const visibleRootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 101,
      segmentId: visibleSegmentId,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
      sourceState: testSourceState("visible-root-before"),
    };
    const visibleAnchorNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 102,
      segmentId: visibleSegmentId,
      parentNodeId: visibleRootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
      isTrueEnd: false,
      sourceState: testSourceState("visible-anchor-before"),
    };
    const hiddenRootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 201,
      segmentId: hiddenSegmentId,
      position: new Float32Array([7, 8, 9]),
      isTrueEnd: false,
      sourceState: testSourceState("hidden-root-before"),
    };
    const hiddenAttachNodeBefore: SpatiallyIndexedSkeletonNode = {
      nodeId: 202,
      segmentId: hiddenSegmentId,
      parentNodeId: hiddenRootNode.nodeId,
      position: new Float32Array([10, 11, 12]),
      isTrueEnd: false,
      sourceState: testSourceState("hidden-attach-before"),
    };
    const mergedNodes: SpatiallyIndexedSkeletonNode[] = [
      cloneNode(visibleRootNode),
      cloneNode(visibleAnchorNode),
      {
        ...cloneNode(hiddenAttachNodeBefore),
        segmentId: visibleSegmentId,
        parentNodeId: visibleAnchorNode.nodeId,
      },
      {
        ...cloneNode(hiddenRootNode),
        segmentId: visibleSegmentId,
        parentNodeId: hiddenAttachNodeBefore.nodeId,
      },
    ];
    const splitOnlyRestoredNodes: SpatiallyIndexedSkeletonNode[] = [
      {
        ...cloneNode(hiddenAttachNodeBefore),
        parentNodeId: undefined,
        sourceState: testSourceState("hidden-attach-split"),
      },
      {
        ...cloneNode(hiddenRootNode),
        parentNodeId: hiddenAttachNodeBefore.nodeId,
        sourceState: testSourceState("hidden-root-split"),
      },
    ];
    const rerootedHiddenNodes: SpatiallyIndexedSkeletonNode[] = [
      {
        ...cloneNode(hiddenRootNode),
        parentNodeId: undefined,
        sourceState: testSourceState("hidden-root-rerooted"),
      },
      {
        ...cloneNode(hiddenAttachNodeBefore),
        parentNodeId: hiddenRootNode.nodeId,
        sourceState: testSourceState("hidden-attach-rerooted"),
      },
    ];

    const serverSegments = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheBySegment = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheByNode = new Map<number, SpatiallyIndexedSkeletonNode>();
    const hiddenSegmentVisibleDuringFetches: boolean[] = [];

    const syncCacheFromServer = (segmentId: number) => {
      setSegmentNodes(
        cacheBySegment,
        cacheByNode,
        segmentId,
        serverSegments.get(segmentId) ?? [],
      );
      return cacheBySegment.get(segmentId) ?? [];
    };

    serverSegments.set(visibleSegmentId, [
      cloneNode(visibleRootNode),
      cloneNode(visibleAnchorNode),
    ]);
    serverSegments.set(hiddenSegmentId, [
      cloneNode(hiddenRootNode),
      cloneNode(hiddenAttachNodeBefore),
    ]);
    syncCacheFromServer(visibleSegmentId);

    const mergeSkeletons = vi.fn(async () => {
      serverSegments.set(visibleSegmentId, mergedNodes.map(cloneNode));
      serverSegments.delete(hiddenSegmentId);
      return {
        resultSegmentId: visibleSegmentId,
        deletedSegmentId: hiddenSegmentId,
        directionAdjusted: false,
      };
    });
    const splitSkeleton = vi.fn(async () => {
      serverSegments.set(visibleSegmentId, [
        cloneNode(visibleRootNode),
        cloneNode(visibleAnchorNode),
      ]);
      serverSegments.set(
        hiddenSegmentId,
        splitOnlyRestoredNodes.map(cloneNode),
      );
      return {
        existingSegmentId: visibleSegmentId,
        newSegmentId: hiddenSegmentId,
      };
    });
    const rerootSkeleton = vi.fn(async () => {
      serverSegments.set(hiddenSegmentId, rerootedHiddenNodes.map(cloneNode));
      return {};
    });
    const skeletonSource = makeEditableSkeletonSource({
      getSkeletonRootNode: vi.fn(async () => ({
        nodeId: hiddenRootNode.nodeId,
        position: hiddenRootNode.position,
      })),
      mergeSkeletons,
      splitSkeleton,
      rerootSkeleton,
    });

    const invalidateCachedSegments = vi.fn((segmentIds: Iterable<number>) => {
      for (const segmentId of segmentIds) {
        setSegmentNodes(cacheBySegment, cacheByNode, segmentId, []);
      }
    });
    const getFullSegmentNodes = vi.fn(
      async (_skeletonLayer: unknown, segmentId: number) => {
        if (segmentId === hiddenSegmentId) {
          hiddenSegmentVisibleDuringFetches.push(
            layer.displayState.segmentationGroupState.value.visibleSegments.has(
              BigInt(hiddenSegmentId),
            ),
          );
        }
        return syncCacheFromServer(segmentId);
      },
    );
    const skeletonLayer = {
      source: skeletonSource,
      getNode: vi.fn((nodeId: number) => cacheByNode.get(nodeId)),
      invalidateSourceCellsForPositions: vi.fn(),
      suppressBrowseSegment: vi.fn(),
    };
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: {
            visibleSegments: new Set<bigint>([BigInt(visibleSegmentId)]),
            selectedSegments: new Set<bigint>(),
            segmentEquivalences: {},
            temporaryVisibleSegments: new Set<bigint>(),
            temporarySegmentEquivalences: {},
            useTemporaryVisibleSegments: { value: false },
            useTemporarySegmentEquivalences: { value: false },
          },
        },
        segmentStatedColors: {
          value: {
            delete: vi.fn(),
          },
        },
      },
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: (nodeId: number) => cacheByNode.get(nodeId),
        getCachedSegmentNodes: (segmentId: number) =>
          cacheBySegment.get(segmentId),
        getFullSegmentNodes,
        invalidateCachedSegments,
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
      clearSpatialSkeletonMergeAnchor: vi.fn(),
    };

    await executeSpatialSkeletonMerge(
      layer as any,
      {
        nodeId: visibleAnchorNode.nodeId,
        segmentId: visibleSegmentId,
        position: visibleAnchorNode.position,
      },
      {
        nodeId: hiddenAttachNodeBefore.nodeId,
        segmentId: hiddenSegmentId,
        position: hiddenAttachNodeBefore.position,
        sourceState: hiddenAttachNodeBefore.sourceState,
      },
    );

    expect(skeletonSource.getSkeletonRootNode).toHaveBeenCalledWith(
      hiddenSegmentId,
    );
    expect(mergeSkeletons).toHaveBeenCalledWith(
      visibleAnchorNode.nodeId,
      hiddenAttachNodeBefore.nodeId,
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: visibleAnchorNode.nodeId }),
          expect.objectContaining({ nodeId: hiddenAttachNodeBefore.nodeId }),
        ]),
      }),
    );
    expect(getFullSegmentNodes).toHaveBeenCalledTimes(2);
    expect(mergeSkeletons.mock.invocationCallOrder[0]).toBeLessThan(
      getFullSegmentNodes.mock.invocationCallOrder[0],
    );
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([
      hiddenRootNode.position,
      hiddenAttachNodeBefore.position,
      visibleAnchorNode.position,
    ]);

    skeletonLayer.invalidateSourceCellsForPositions.mockClear();
    rerootSkeleton.mockClear();
    hiddenSegmentVisibleDuringFetches.length = 0;

    await undoSpatialSkeletonCommand(layer as any);

    expect(splitSkeleton).toHaveBeenCalledWith(
      hiddenAttachNodeBefore.nodeId,
      expect.objectContaining({
        node: expect.objectContaining({
          nodeId: hiddenAttachNodeBefore.nodeId,
        }),
      }),
    );
    expect(rerootSkeleton).toHaveBeenCalledWith(
      hiddenRootNode.nodeId,
      expect.objectContaining({
        node: expect.objectContaining({ nodeId: hiddenRootNode.nodeId }),
      }),
    );
    expect(hiddenSegmentVisibleDuringFetches.length).toBeGreaterThan(0);
    expect(hiddenSegmentVisibleDuringFetches.every(Boolean)).toBe(true);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenNthCalledWith(1, [
      hiddenAttachNodeBefore.position,
      hiddenRootNode.position,
      visibleAnchorNode.position,
    ]);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenNthCalledWith(2, [
      hiddenRootNode.position,
      hiddenAttachNodeBefore.position,
    ]);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledTimes(2);
    expect(
      cacheBySegment.get(hiddenSegmentId)?.map((node) => ({
        nodeId: node.nodeId,
        parentNodeId: node.parentNodeId,
      })),
    ).toEqual([
      {
        nodeId: hiddenRootNode.nodeId,
        parentNodeId: undefined,
      },
      {
        nodeId: hiddenAttachNodeBefore.nodeId,
        parentNodeId: hiddenRootNode.nodeId,
      },
    ]);

    skeletonLayer.invalidateSourceCellsForPositions.mockClear();

    await redoSpatialSkeletonCommand(layer as any);

    expect(mergeSkeletons).toHaveBeenCalledTimes(2);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([
      hiddenRootNode.position,
      hiddenAttachNodeBefore.position,
      visibleAnchorNode.position,
    ]);
  });

  it("reports reroot failure during merge undo as a split-only undo", async () => {
    const fakeStatusMessage = {
      dispose() {},
    } as unknown as StatusMessage;
    const statusSpy = vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockImplementation(
        (_message: string, _closeAfter?: number) => fakeStatusMessage,
      );

    const visibleSegmentId = 11;
    const hiddenSegmentId = 17;
    const visibleRootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 101,
      segmentId: visibleSegmentId,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
      sourceState: testSourceState("visible-root-before"),
    };
    const visibleAnchorNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 102,
      segmentId: visibleSegmentId,
      parentNodeId: visibleRootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
      isTrueEnd: false,
      sourceState: testSourceState("visible-anchor-before"),
    };
    const hiddenRootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 201,
      segmentId: hiddenSegmentId,
      position: new Float32Array([7, 8, 9]),
      isTrueEnd: false,
      sourceState: testSourceState("hidden-root-before"),
    };
    const hiddenAttachNodeBefore: SpatiallyIndexedSkeletonNode = {
      nodeId: 202,
      segmentId: hiddenSegmentId,
      parentNodeId: hiddenRootNode.nodeId,
      position: new Float32Array([10, 11, 12]),
      isTrueEnd: false,
      sourceState: testSourceState("hidden-attach-before"),
    };
    const mergedNodes: SpatiallyIndexedSkeletonNode[] = [
      cloneNode(visibleRootNode),
      cloneNode(visibleAnchorNode),
      {
        ...cloneNode(hiddenAttachNodeBefore),
        segmentId: visibleSegmentId,
        parentNodeId: visibleAnchorNode.nodeId,
      },
      {
        ...cloneNode(hiddenRootNode),
        segmentId: visibleSegmentId,
        parentNodeId: hiddenAttachNodeBefore.nodeId,
      },
    ];
    const splitOnlyRestoredNodes: SpatiallyIndexedSkeletonNode[] = [
      {
        ...cloneNode(hiddenAttachNodeBefore),
        parentNodeId: undefined,
        sourceState: testSourceState("hidden-attach-split"),
      },
      {
        ...cloneNode(hiddenRootNode),
        parentNodeId: hiddenAttachNodeBefore.nodeId,
        sourceState: testSourceState("hidden-root-split"),
      },
    ];

    const serverSegments = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheBySegment = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheByNode = new Map<number, SpatiallyIndexedSkeletonNode>();

    const syncCacheFromServer = (segmentId: number) => {
      setSegmentNodes(
        cacheBySegment,
        cacheByNode,
        segmentId,
        serverSegments.get(segmentId) ?? [],
      );
      return cacheBySegment.get(segmentId) ?? [];
    };

    serverSegments.set(visibleSegmentId, [
      cloneNode(visibleRootNode),
      cloneNode(visibleAnchorNode),
    ]);
    serverSegments.set(hiddenSegmentId, [
      cloneNode(hiddenRootNode),
      cloneNode(hiddenAttachNodeBefore),
    ]);
    syncCacheFromServer(visibleSegmentId);

    const mergeSkeletons = vi.fn(async () => {
      serverSegments.set(visibleSegmentId, mergedNodes.map(cloneNode));
      serverSegments.delete(hiddenSegmentId);
      return {
        resultSegmentId: visibleSegmentId,
        deletedSegmentId: hiddenSegmentId,
        directionAdjusted: false,
      };
    });
    const splitSkeleton = vi.fn(async () => {
      serverSegments.set(visibleSegmentId, [
        cloneNode(visibleRootNode),
        cloneNode(visibleAnchorNode),
      ]);
      serverSegments.set(
        hiddenSegmentId,
        splitOnlyRestoredNodes.map(cloneNode),
      );
      return {
        existingSegmentId: visibleSegmentId,
        newSegmentId: hiddenSegmentId,
      };
    });
    const rerootSkeleton = vi.fn(async () => {
      throw new Error("reroot failed");
    });
    const skeletonSource = makeEditableSkeletonSource({
      getSkeletonRootNode: vi.fn(async () => ({
        nodeId: hiddenRootNode.nodeId,
        position: hiddenRootNode.position,
      })),
      mergeSkeletons,
      splitSkeleton,
      rerootSkeleton,
    });

    const getFullSegmentNodes = vi.fn(
      async (_skeletonLayer: unknown, segmentId: number) =>
        syncCacheFromServer(segmentId),
    );
    const skeletonLayer = {
      source: skeletonSource,
      getNode: vi.fn((nodeId: number) => cacheByNode.get(nodeId)),
      invalidateSourceCellsForPositions: vi.fn(),
      suppressBrowseSegment: vi.fn(),
    };
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: {
            visibleSegments: new Set<bigint>([BigInt(visibleSegmentId)]),
            selectedSegments: new Set<bigint>(),
            segmentEquivalences: {},
            temporaryVisibleSegments: new Set<bigint>(),
            temporarySegmentEquivalences: {},
            useTemporaryVisibleSegments: { value: false },
            useTemporarySegmentEquivalences: { value: false },
          },
        },
        segmentStatedColors: {
          value: {
            delete: vi.fn(),
          },
        },
      },
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: (nodeId: number) => cacheByNode.get(nodeId),
        getCachedSegmentNodes: (segmentId: number) =>
          cacheBySegment.get(segmentId),
        getFullSegmentNodes,
        invalidateCachedSegments: vi.fn((segmentIds: Iterable<number>) => {
          for (const segmentId of segmentIds) {
            setSegmentNodes(cacheBySegment, cacheByNode, segmentId, []);
          }
        }),
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
      clearSpatialSkeletonMergeAnchor: vi.fn(),
    };

    await executeSpatialSkeletonMerge(
      layer as any,
      {
        nodeId: visibleAnchorNode.nodeId,
        segmentId: visibleSegmentId,
        position: visibleAnchorNode.position,
      },
      {
        nodeId: hiddenAttachNodeBefore.nodeId,
        segmentId: hiddenSegmentId,
        position: hiddenAttachNodeBefore.position,
        sourceState: hiddenAttachNodeBefore.sourceState,
      },
    );
    statusSpy.mockClear();
    skeletonLayer.invalidateSourceCellsForPositions.mockClear();

    await expect(undoSpatialSkeletonCommand(layer as any)).resolves.toBe(true);

    expect(splitSkeleton).toHaveBeenCalledWith(
      hiddenAttachNodeBefore.nodeId,
      expect.objectContaining({
        node: expect.objectContaining({
          nodeId: hiddenAttachNodeBefore.nodeId,
        }),
      }),
    );
    expect(rerootSkeleton).toHaveBeenCalledWith(
      hiddenRootNode.nodeId,
      expect.objectContaining({
        node: expect.objectContaining({ nodeId: hiddenRootNode.nodeId }),
      }),
    );
    expect(
      cacheBySegment.get(hiddenSegmentId)?.map((node) => ({
        nodeId: node.nodeId,
        parentNodeId: node.parentNodeId,
      })),
    ).toEqual([
      {
        nodeId: hiddenAttachNodeBefore.nodeId,
        parentNodeId: undefined,
      },
      {
        nodeId: hiddenRootNode.nodeId,
        parentNodeId: hiddenAttachNodeBefore.nodeId,
      },
    ]);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenNthCalledWith(1, [
      hiddenAttachNodeBefore.position,
      hiddenRootNode.position,
      visibleAnchorNode.position,
    ]);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenNthCalledWith(2, [
      hiddenRootNode.position,
      hiddenAttachNodeBefore.position,
    ]);
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledTimes(2);
    expect(statusSpy).toHaveBeenCalledWith(
      expect.stringContaining("Only the split completed."),
    );
  });

  it("falls back to broad merge invalidation when the source omits the deleted segment id", async () => {
    suppressStatusMessages();

    const firstSegmentId = 11;
    const secondSegmentId = 17;
    const firstRootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 101,
      segmentId: firstSegmentId,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
      sourceState: testSourceState("first-root-before"),
    };
    const firstAnchorNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 102,
      segmentId: firstSegmentId,
      parentNodeId: firstRootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
      isTrueEnd: false,
      sourceState: testSourceState("first-anchor-before"),
    };
    const secondRootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 201,
      segmentId: secondSegmentId,
      position: new Float32Array([7, 8, 9]),
      isTrueEnd: false,
      sourceState: testSourceState("second-root-before"),
    };
    const secondAttachNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 202,
      segmentId: secondSegmentId,
      parentNodeId: secondRootNode.nodeId,
      position: new Float32Array([10, 11, 12]),
      isTrueEnd: false,
      sourceState: testSourceState("second-attach-before"),
    };

    const serverSegments = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheBySegment = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheByNode = new Map<number, SpatiallyIndexedSkeletonNode>();

    const syncCacheFromServer = (segmentId: number) => {
      setSegmentNodes(
        cacheBySegment,
        cacheByNode,
        segmentId,
        serverSegments.get(segmentId) ?? [],
      );
      return cacheBySegment.get(segmentId) ?? [];
    };

    serverSegments.set(firstSegmentId, [
      cloneNode(firstRootNode),
      cloneNode(firstAnchorNode),
    ]);
    serverSegments.set(secondSegmentId, [
      cloneNode(secondRootNode),
      cloneNode(secondAttachNode),
    ]);
    syncCacheFromServer(firstSegmentId);

    const mergeSkeletons = vi.fn(async () => ({
      resultSegmentId: firstSegmentId,
      deletedSegmentId: undefined,
      directionAdjusted: false,
    }));
    const skeletonSource = makeEditableSkeletonSource({
      getSkeletonRootNode: vi.fn(async () => ({
        nodeId: secondRootNode.nodeId,
        position: secondRootNode.position,
      })),
      mergeSkeletons,
    });

    const getFullSegmentNodes = vi.fn(
      async (_skeletonLayer: unknown, segmentId: number) =>
        syncCacheFromServer(segmentId),
    );
    const skeletonLayer = {
      source: skeletonSource,
      getNode: vi.fn((nodeId: number) => cacheByNode.get(nodeId)),
      invalidateSourceCellsForPositions: vi.fn(),
      suppressBrowseSegment: vi.fn(),
    };
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: {
            visibleSegments: new Set<bigint>([BigInt(firstSegmentId)]),
            selectedSegments: new Set<bigint>(),
            segmentEquivalences: {},
            temporaryVisibleSegments: new Set<bigint>(),
            temporarySegmentEquivalences: {},
            useTemporaryVisibleSegments: { value: false },
            useTemporarySegmentEquivalences: { value: false },
          },
        },
        segmentStatedColors: {
          value: {
            delete: vi.fn(),
          },
        },
      },
      manager: {
        root: {
          selectionState: {
            pin: {
              value: true,
            },
          },
        },
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: (nodeId: number) => cacheByNode.get(nodeId),
        getCachedSegmentNodes: (segmentId: number) =>
          cacheBySegment.get(segmentId),
        getFullSegmentNodes,
        invalidateCachedSegments: vi.fn((segmentIds: Iterable<number>) => {
          for (const segmentId of segmentIds) {
            setSegmentNodes(cacheBySegment, cacheByNode, segmentId, []);
          }
        }),
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
      clearSpatialSkeletonMergeAnchor: vi.fn(),
    };

    await executeSpatialSkeletonMerge(
      layer as any,
      {
        nodeId: firstAnchorNode.nodeId,
        segmentId: firstSegmentId,
      },
      {
        nodeId: secondAttachNode.nodeId,
        segmentId: secondSegmentId,
      },
    );

    expect(skeletonSource.getSkeletonRootNode).not.toHaveBeenCalled();
    expect(getFullSegmentNodes).toHaveBeenCalledWith(
      expect.anything(),
      secondSegmentId,
    );
    expect(mergeSkeletons).toHaveBeenCalledWith(
      firstAnchorNode.nodeId,
      secondAttachNode.nodeId,
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: firstAnchorNode.nodeId }),
          expect.objectContaining({ nodeId: secondAttachNode.nodeId }),
        ]),
      }),
    );
    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([
      firstRootNode.position,
      firstAnchorNode.position,
      secondRootNode.position,
      secondAttachNode.position,
    ]);
  });

  it("uses the returned deleted segment id to choose the merge invalidation side", async () => {
    suppressStatusMessages();

    const firstSegmentId = 11;
    const secondSegmentId = 17;
    const firstRootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 101,
      segmentId: firstSegmentId,
      position: new Float32Array([1, 2, 3]),
      isTrueEnd: false,
      sourceState: testSourceState("first-root-before"),
    };
    const firstAnchorNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 102,
      segmentId: firstSegmentId,
      parentNodeId: firstRootNode.nodeId,
      position: new Float32Array([4, 5, 6]),
      isTrueEnd: false,
      sourceState: testSourceState("first-anchor-before"),
    };
    const secondRootNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 201,
      segmentId: secondSegmentId,
      position: new Float32Array([7, 8, 9]),
      isTrueEnd: false,
      sourceState: testSourceState("second-root-before"),
    };
    const secondAnchorNode: SpatiallyIndexedSkeletonNode = {
      nodeId: 202,
      segmentId: secondSegmentId,
      parentNodeId: secondRootNode.nodeId,
      position: new Float32Array([10, 11, 12]),
      isTrueEnd: false,
      sourceState: testSourceState("second-anchor-before"),
    };

    const serverSegments = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheBySegment = new Map<number, SpatiallyIndexedSkeletonNode[]>();
    const cacheByNode = new Map<number, SpatiallyIndexedSkeletonNode>();
    const syncCacheFromServer = (segmentId: number) => {
      setSegmentNodes(
        cacheBySegment,
        cacheByNode,
        segmentId,
        serverSegments.get(segmentId) ?? [],
      );
      return cacheBySegment.get(segmentId) ?? [];
    };

    serverSegments.set(firstSegmentId, [
      cloneNode(firstRootNode),
      cloneNode(firstAnchorNode),
    ]);
    serverSegments.set(secondSegmentId, [
      cloneNode(secondRootNode),
      cloneNode(secondAnchorNode),
    ]);
    syncCacheFromServer(firstSegmentId);
    syncCacheFromServer(secondSegmentId);

    const mergeSkeletons = vi.fn(async () => ({
      resultSegmentId: secondSegmentId,
      deletedSegmentId: firstSegmentId,
      directionAdjusted: true,
    }));
    const skeletonSource = makeEditableSkeletonSource({ mergeSkeletons });
    const getFullSegmentNodes = vi.fn(
      async (_skeletonLayer: unknown, segmentId: number) =>
        syncCacheFromServer(segmentId),
    );
    const skeletonLayer = {
      source: skeletonSource,
      getNode: vi.fn((nodeId: number) => cacheByNode.get(nodeId)),
      invalidateSourceCellsForPositions: vi.fn(),
      suppressBrowseSegment: vi.fn(),
    };
    const layer = {
      displayState: makeDisplayState([firstSegmentId, secondSegmentId]),
      manager: makePinnedManager(),
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
        getCachedNode: (nodeId: number) => cacheByNode.get(nodeId),
        getCachedSegmentNodes: (segmentId: number) =>
          cacheBySegment.get(segmentId),
        getFullSegmentNodes,
        invalidateCachedSegments: vi.fn((segmentIds: Iterable<number>) => {
          for (const segmentId of segmentIds) {
            setSegmentNodes(cacheBySegment, cacheByNode, segmentId, []);
          }
        }),
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
      clearSpatialSkeletonMergeAnchor: vi.fn(),
    };

    await executeSpatialSkeletonMerge(
      layer as any,
      {
        nodeId: firstAnchorNode.nodeId,
        segmentId: firstSegmentId,
      },
      {
        nodeId: secondAnchorNode.nodeId,
        segmentId: secondSegmentId,
      },
    );

    expect(
      skeletonLayer.invalidateSourceCellsForPositions,
    ).toHaveBeenCalledWith([
      firstRootNode.position,
      firstAnchorNode.position,
      secondAnchorNode.position,
    ]);
  });

  it("shows and clears a pending status while a merge is in flight", async () => {
    const pendingStatus = {
      dispose: vi.fn(),
    } as unknown as StatusMessage;
    const showMessage = vi
      .spyOn(StatusMessage, "showMessage")
      .mockReturnValue(pendingStatus);
    vi.spyOn(StatusMessage, "showTemporaryMessage").mockImplementation(
      () => ({ dispose() {} }) as unknown as StatusMessage,
    );

    let resolveMerge:
      | ((value: {
          resultSegmentId: number;
          deletedSegmentId: number;
          directionAdjusted: boolean;
        }) => void)
      | undefined;
    const mergeSkeletons = vi.fn(
      () =>
        new Promise<{
          resultSegmentId: number;
          deletedSegmentId: number;
          directionAdjusted: boolean;
        }>((resolve) => {
          resolveMerge = resolve;
        }),
    );
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
    const layer = {
      displayState: {
        segmentationGroupState: {
          value: {
            visibleSegments: new Set<bigint>([11n, 17n]),
            selectedSegments: new Set<bigint>(),
            segmentEquivalences: {},
            temporaryVisibleSegments: new Set<bigint>(),
            temporarySegmentEquivalences: {},
            useTemporaryVisibleSegments: { value: false },
            useTemporarySegmentEquivalences: { value: false },
          },
        },
        segmentStatedColors: {
          value: {
            delete: vi.fn(),
          },
        },
      },
      spatialSkeletonState: {
        commandHistory: new SpatialSkeletonCommandHistory(),
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
        getFullSegmentNodes: vi.fn(async () => []),
        invalidateCachedSegments: vi.fn(),
      },
      getSpatiallyIndexedSkeletonLayer: () => skeletonLayer,
      selectSegment: vi.fn(),
      selectSpatialSkeletonNode: vi.fn(),
      markSpatialSkeletonNodeDataChanged: vi.fn(),
      clearSpatialSkeletonMergeAnchor: vi.fn(),
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

    const mergePromise = executeSpatialSkeletonMerge(
      layer as any,
      { nodeId: firstNode.nodeId, segmentId: firstNode.segmentId },
      { nodeId: secondNode.nodeId, segmentId: secondNode.segmentId },
    );

    expect(showMessage).toHaveBeenCalledWith("Merging skeletons...");
    expect(pendingStatus.dispose).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mergeSkeletons).toHaveBeenCalledTimes(1);
    });

    resolveMerge?.({
      resultSegmentId: firstNode.segmentId,
      deletedSegmentId: secondNode.segmentId,
      directionAdjusted: false,
    });
    await mergePromise;

    expect(pendingStatus.dispose).toHaveBeenCalledTimes(1);
  });
});
