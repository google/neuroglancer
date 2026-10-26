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
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import * as skeletonCommands from "#src/skeleton/edit/submit_edits.js";
import {
  SpatialSkeletonStableIdHandles,
  spatialSkeletonStableNode,
} from "#src/skeleton/edit_queue/stable_id_handles.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import svg_addNodeCursor from "#src/ui/images/add_node_cursor.svg?raw";
import svg_deleteCursor from "#src/ui/images/delete_cursor.svg?raw";
import svg_dragCursor from "#src/ui/images/drag_cursor.svg?raw";
import svg_insertNodeCursor from "#src/ui/images/insert_node_cursor.svg?raw";
import svg_mergeCursor from "#src/ui/images/merge_cursor.svg?raw";
import svg_newSkeletonCursor from "#src/ui/images/new_skeleton_cursor.svg?raw";
import svg_splitCursor from "#src/ui/images/split_cursor.svg?raw";
import {
  SKELETON_ADD_NODE,
  SKELETON_CLEAR_SELECTION,
  SKELETON_EDIT_AT_MOUSE,
  SKELETON_ENTER_CREATE,
  SKELETON_ENTER_DELETE_MODE,
  SKELETON_ENTER_INSERT_MODE,
  SKELETON_ENTER_MERGE_MODE,
  SKELETON_ENTER_SPLIT_MODE,
} from "#src/ui/skeleton_edit_tool_shortcuts.js";
import { SpatialSkeletonEditTool } from "#src/ui/skeleton_edit_tools.js";
import {
  makeSpatialSkeletonToolLister,
  SPATIAL_SKELETON_EDIT_MODE_TOOL_ID,
  SPATIAL_SKELETON_FIND_PATH_TOOL_ID,
} from "#src/ui/skeleton_tool_base.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import * as mouseDrag from "#src/util/mouse_drag.js";
import { NullarySignal } from "#src/util/signal.js";

type ExecutionName =
  | "executeSpatialSkeletonAddNode"
  | "executeSpatialSkeletonInsertNode"
  | "executeSpatialSkeletonMoveNode"
  | "executeSpatialSkeletonDeleteNode"
  | "executeSpatialSkeletonSplit"
  | "executeSpatialSkeletonMerge";

const EXECUTION_NAMES: readonly ExecutionName[] = [
  "executeSpatialSkeletonAddNode",
  "executeSpatialSkeletonInsertNode",
  "executeSpatialSkeletonMoveNode",
  "executeSpatialSkeletonDeleteNode",
  "executeSpatialSkeletonSplit",
  "executeSpatialSkeletonMerge",
];

function makeNode(
  nodeId: bigint,
  segmentId: bigint,
  position: [number, number, number],
  parentNodeId?: bigint,
): SkeletonNode {
  return {
    nodeId,
    segmentId,
    parentNodeId,
    position: new Float32Array(position),
  };
}

function makeExecution() {
  return Object.assign(Promise.resolve(), {
    acceptedByQueue: Promise.resolve(),
    settled: Promise.resolve({ outcome: "committed" as const }),
  });
}

function makeHeldExecution() {
  let admit = () => {};
  let finish = () => {};
  const acceptedByQueue = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const execution = Object.assign(finished, {
    acceptedByQueue,
    settled: finished.then(() => ({ outcome: "committed" as const })),
  });
  return {
    execution,
    admit: () => admit(),
    finish: () => {
      admit();
      finish();
    },
  };
}

function makeVisibleSegmentsState(visibleSegmentIds: readonly bigint[]) {
  return {
    visibleSegments: Object.assign(new Set<bigint>(visibleSegmentIds), {
      changed: new NullarySignal(),
    }),
    temporaryVisibleSegments: new Set<bigint>(),
    useTemporaryVisibleSegments: { value: false },
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
      disposers.push(registerActionListener(window, action, handler));
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
  const readStatusElement = () =>
    disposers.find((disposer) => disposer instanceof StatusMessage)!.element;
  return { activation, actions, dispose, readStatusElement };
}

function makePanel(kind: "2d" | "3d") {
  return {
    element: document.createElement("div"),
    translateDataPointByViewportPixels: (
      result: Float32Array,
      anchor: Float32Array,
      deltaX: number,
      deltaY: number,
    ) => result.set([anchor[0] + deltaX, anchor[1] + deltaY, anchor[2]]),
    ...(kind === "2d" ? { sliceView: {} } : {}),
  };
}

function bindPanel(
  panel: ReturnType<typeof makePanel>,
  activation: { inputEventMapBinder: { mock: { calls: unknown[][] } } },
) {
  const inputEventMap = new EventActionMap();
  for (const [boundMap] of activation.inputEventMapBinder.mock.calls) {
    inputEventMap.addParent(
      boundMap as EventActionMap,
      Number.POSITIVE_INFINITY,
    );
  }
  const binder = new MouseEventBinder(panel.element, inputEventMap);
  document.body.appendChild(panel.element);
  return () => {
    binder.dispose();
    panel.element.remove();
  };
}

function makeEditToolHarness(
  options: {
    inspectedNodes?: readonly SkeletonNode[];
    renderedNodes?: SkeletonNode[];
    visibleSegmentIds?: readonly bigint[];
    selectedNodeId?: bigint;
  } = {},
) {
  vi.spyOn(StatusMessage, "showTemporaryMessage").mockImplementation(
    () => ({ dispose() {} }) as unknown as StatusMessage,
  );
  vi.spyOn(StatusMessage, "showErrorMessage").mockImplementation(
    () => ({ dispose() {} }) as unknown as StatusMessage,
  );
  const executions = Object.fromEntries(
    EXECUTION_NAMES.map((name) => [
      name,
      vi.spyOn(skeletonCommands, name).mockImplementation(makeExecution),
    ]),
  ) as Record<ExecutionName, ReturnType<typeof vi.fn>>;
  const startDrag = vi
    .spyOn(mouseDrag, "startRelativeMouseDrag")
    .mockImplementation(() => {});

  const inspectedNodes = options.inspectedNodes ?? [];
  const renderedNodes = options.renderedNodes ?? [...inspectedNodes];
  const state = new SpatialSkeletonEditSession();
  const inspectedSegments = new Map<bigint, SkeletonNode[]>();
  for (const node of inspectedNodes) {
    inspectedSegments.set(node.segmentId, [
      ...(inspectedSegments.get(node.segmentId) ?? []),
      node,
    ]);
  }
  state.replaceCachedSegmentSnapshots(inspectedSegments);
  const getFullSegmentNodes = vi
    .spyOn(state, "getFullSegmentNodes")
    .mockReturnValue(new Promise(() => {}));
  const releasePrefetch = vi.spyOn(state, "releaseFullSegmentNodeFetchOwner");
  vi.spyOn(state, "setPendingNodePosition");
  vi.spyOn(state, "clearPendingNodePositions");
  vi.spyOn(state, "getEditingIdentityService").mockReturnValue({
    getOrCreateNodeHandle: (nodeId: bigint) => nodeId,
    resolveNode: (nodeId: bigint) => nodeId,
  } as unknown as ReturnType<
    SpatialSkeletonEditSession["getEditingIdentityService"]
  >);

  const skeletonLayer = {
    editableSource: {},
    getNode: (nodeId: bigint) =>
      renderedNodes.find((node) => node.nodeId === nodeId),
    chunkTransform: new WatchableValue({
      error: undefined,
      modelTransform: { unpaddedRank: 3 },
      layerRank: 3,
      combinedGlobalLocalToChunkTransform: new Float32Array([
        1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
      ]),
    }),
    localPosition: new WatchableValue(new Float32Array(0)),
  };
  const mouseState = {
    active: true,
    pickedRenderLayer: undefined,
    pickedSpatialSkeleton: undefined as
      | {
          nodeId?: bigint;
          segmentId?: bigint;
          position?: SkeletonNode["position"];
        }
      | undefined,
    position: new Float32Array([1, 2, 3]),
    unsnappedPosition: new Float32Array([7, 8, 9]),
    updateUnconditionally: () => true,
    changed: new NullarySignal(),
  };
  const selected = new WatchableValue<
    { nodeId: bigint; segmentId?: bigint } | undefined
  >(
    options.selectedNodeId === undefined
      ? undefined
      : {
          nodeId: options.selectedNodeId,
          segmentId: renderedNodes.find(
            (node) => node.nodeId === options.selectedNodeId,
          )?.segmentId,
        },
  );
  const panel = makePanel("2d");
  const releaseBrowseExclusion = vi.fn();
  const layer = {
    toolBinder: {},
    displayState: {
      segmentationGroupState: {
        value: makeVisibleSegmentsState(
          options.visibleSegmentIds ?? [
            ...new Set(renderedNodes.map((node) => node.segmentId)),
          ],
        ),
      },
    },
    skeletonNodeSelection: {
      selected,
      select: vi.fn((nodeId: bigint, _pin: boolean, node?: SkeletonNode) => {
        selected.value = { nodeId, segmentId: node?.segmentId };
      }),
      clear: vi.fn(() => {
        selected.value = undefined;
      }),
    },
    skeletonSourceConnection: {
      getActionsDisabledReason: vi.fn(() => undefined),
    },
    spatialSkeletonEditSession: state,
    skeletonOverlaySegments: {
      beginTemporaryBrowseExclusion: vi.fn(() => releaseBrowseExclusion),
    },
    manager: {
      root: {
        layerSelectedValues: { mouseState },
        selectionState: {
          value: undefined,
          changed: new NullarySignal(),
          unpin: vi.fn(),
        },
        display: {
          panels: new Set<object>([panel]),
          container: document.createElement("div"),
        },
      },
    },
    spatiallyIndexedSkeletonLayer: new WatchableValue(skeletonLayer),
    getSpatiallyIndexedSkeletonLayerOf: () => undefined,
    selectSegment: vi.fn(),
    layersChanged: new NullarySignal(),
  };
  const tool = new SpatialSkeletonEditTool(
    layer as unknown as SegmentationUserLayer,
  );
  const activate = () => {
    const toolActivation = makeToolActivation();
    Object.assign(toolActivation.activation, { tool });
    tool.activate(
      toolActivation.activation as unknown as ToolActivation<typeof tool>,
    );
    return toolActivation;
  };
  let current = activate();

  const hover = (
    picked:
      | {
          nodeId?: bigint;
          segmentId?: bigint;
          position?: SkeletonNode["position"];
        }
      | undefined,
  ) => {
    mouseState.pickedSpatialSkeleton = picked;
    mouseState.changed.dispatch();
  };
  const click = (picked?: SkeletonNode) => {
    if (picked !== undefined) hover(picked);
    current.actions.get(SKELETON_EDIT_AT_MOUSE)!({
      target: panel.element,
      detail: new MouseEvent("mousedown", { button: 0 }),
    });
  };
  const pressModeKey = (action: string, code: string) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code }));
    current.actions.get(action)!({});
  };
  const releaseModeKey = (code: string) => {
    window.dispatchEvent(new KeyboardEvent("keyup", { code }));
  };
  const lastDrag = () => {
    const [, move, finish] = startDrag.mock.calls.at(-1)!;
    const event = new MouseEvent("mousemove");
    return {
      move: (deltaX: number, deltaY: number) => move(event, deltaX, deltaY),
      finish: () => finish!(event, 0, 0),
    };
  };
  const readCursor = () =>
    layer.manager.root.display.container.style.getPropertyValue(
      "--neuroglancer-tool-cursor",
    );
  return {
    tool,
    layer,
    state,
    mouseState,
    executions,
    getFullSegmentNodes,
    releasePrefetch,
    releaseBrowseExclusion,
    renderedNodes,
    hover,
    click,
    pressModeKey,
    releaseModeKey,
    lastDrag,
    readCursor,
    get activation() {
      return current.activation;
    },
    get actions() {
      return current.actions;
    },
    readStatusElement: () => current.readStatusElement(),
    deactivate: () => current.dispose(),
    reactivate: () => {
      current = activate();
    },
  };
}

function readFullText(element: HTMLElement) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const words: string[] = [];
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent!.replace(/\s+/g, " ").trim();
    if (text !== "") words.push(text);
  }
  return words.join(" ");
}

function readStatusText(statusMessage: HTMLElement) {
  return statusMessage.querySelector(".neuroglancer-skeleton-tool-status-text")
    ?.textContent;
}

function readHints(statusMessage: HTMLElement) {
  return Array.from(
    statusMessage.querySelectorAll(".neuroglancer-tool-status-chip"),
    (chip) => ({
      key: chip
        .querySelector(".neuroglancer-tool-status-chip-key")
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
      label: chip.querySelector(".neuroglancer-tool-status-chip-label")
        ?.textContent,
    }),
  );
}

function readHintLabels(statusMessage: HTMLElement) {
  return readHints(statusMessage).map(({ label }) => label);
}

function makeActionEvent() {
  return {
    stopPropagation: vi.fn(),
    detail: new MouseEvent("mousedown", { button: 0 }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("spatial skeleton tool lister", () => {
  const makeListerLayer = (hasEditableSource: boolean) =>
    ({
      spatiallyIndexedSkeletonLayer: {
        get value() {
          return {};
        },
      },
      skeletonSourceConnection: {
        getFindPathContext: () => ({}),
      },
      editableSkeletonSource: { value: hasEditableSource ? {} : undefined },
      layersChanged: new NullarySignal(),
    }) as unknown as SegmentationUserLayer;

  it("offers no edit mode tool for a read-only skeleton source", () => {
    const listEditTools = makeSpatialSkeletonToolLister(
      SPATIAL_SKELETON_EDIT_MODE_TOOL_ID,
    );

    expect(listEditTools(makeListerLayer(false))).toEqual([]);
    expect(listEditTools(makeListerLayer(true))).toEqual([
      { type: SPATIAL_SKELETON_EDIT_MODE_TOOL_ID },
    ]);
  });

  it("keeps the find path tool for a read-only skeleton source", () => {
    const listFindPathTools = makeSpatialSkeletonToolLister(
      SPATIAL_SKELETON_FIND_PATH_TOOL_ID,
    );

    expect(listFindPathTools(makeListerLayer(false))).toEqual([
      { type: SPATIAL_SKELETON_FIND_PATH_TOOL_ID },
    ]);
  });
});

describe("skeleton edit tool status", () => {
  it("shows shortcut hints in place of the generic bindings line", () => {
    const harness = makeEditToolHarness();

    expect(readFullText(harness.readStatusElement())).toBe(
      "Skeleton editing No selection" +
        " click Select drag Move" +
        " hold + m Merge hold + i Insert hold + s Split" +
        " hold + n New skeleton hold + d Delete" +
        " middle drag / ctrl drag Rotate/pan",
    );
    harness.deactivate();
  });

  it("ends merge mode when the key named in its release hint is released", () => {
    const harness = makeEditToolHarness();
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    expect(readHints(harness.readStatusElement())).toContainEqual({
      key: "release + m",
      label: "Exit merge",
    });

    harness.releaseModeKey("KeyM");

    expect(harness.state.mergeMode.value).toBe(false);
    harness.deactivate();
  });

  it("offers no release hint for a mode entered without holding its key", () => {
    const harness = makeEditToolHarness();

    harness.actions.get(SKELETON_ENTER_MERGE_MODE)!({});

    expect(readStatusText(harness.readStatusElement())).toBe(
      "Merge · click a node to merge from",
    );
    expect(readHintLabels(harness.readStatusElement())).toEqual([
      "Select",
      "Rotate/pan",
    ]);
    harness.deactivate();
  });

  it.each([
    [
      "merge",
      SKELETON_ENTER_MERGE_MODE,
      "KeyM",
      "Merge · click a node to merge from",
      ["Select", "Exit merge", "Rotate/pan"],
    ],
    [
      "insert",
      SKELETON_ENTER_INSERT_MODE,
      "KeyI",
      "Insert · click the first node",
      ["Select", "Exit insert", "Rotate/pan"],
    ],
    [
      "split",
      SKELETON_ENTER_SPLIT_MODE,
      "KeyS",
      "Split · click a node to form the root of a new skeleton",
      ["Select", "Exit split", "Rotate/pan"],
    ],
    [
      "delete",
      SKELETON_ENTER_DELETE_MODE,
      "KeyD",
      "Delete · no selected nodes",
      ["Delete", "Exit delete", "Rotate/pan"],
    ],
    [
      "create",
      SKELETON_ENTER_CREATE,
      "KeyN",
      "Create · ready to place",
      ["Place", "Exit create", "Rotate/pan"],
    ],
  ])(
    "holding the %s mode key shows the mode's prompt and its release hint",
    (_, action, code, status, hints) => {
      const harness = makeEditToolHarness();

      harness.pressModeKey(action, code);

      expect(readStatusText(harness.readStatusElement())).toBe(status);
      expect(readHintLabels(harness.readStatusElement())).toEqual(hints);
      harness.deactivate();
    },
  );

  it("a node selected on a visible skeleton offers Move and Add node, and holding shift readies a new node", () => {
    const harness = makeEditToolHarness({
      renderedNodes: [makeNode(5n, 11n, [1, 2, 3])],
      selectedNodeId: 5n,
    });
    expect(readStatusText(harness.readStatusElement())).toBe("Node selected");
    expect(readHintLabels(harness.readStatusElement())).toEqual([
      "Select",
      "Move",
      "Add node",
      "Merge",
      "Insert",
      "Split",
      "New skeleton",
      "Delete",
      "Rotate/pan",
    ]);

    window.dispatchEvent(new MouseEvent("mousemove", { shiftKey: true }));

    expect(readStatusText(harness.readStatusElement())).toBe(
      "Ready to place new node",
    );
    harness.deactivate();
  });

  it.each([
    ["without", false],
    ["with", true],
  ])(
    "a node selected on a hidden skeleton offers Show, not Move or Add node, %s shift held",
    (_, shiftKey) => {
      const harness = makeEditToolHarness({
        renderedNodes: [makeNode(5n, 11n, [1, 2, 3])],
        selectedNodeId: 5n,
        visibleSegmentIds: [],
      });

      window.dispatchEvent(new MouseEvent("mousemove", { shiftKey }));

      expect(readStatusText(harness.readStatusElement())).toBe(
        "Node selected from non-visible skeleton",
      );
      expect(readHintLabels(harness.readStatusElement())).toEqual([
        "Show",
        "Merge",
        "Insert",
        "Split",
        "New skeleton",
        "Delete",
        "Rotate/pan",
      ]);
      harness.deactivate();
    },
  );

  it("asks for the node to merge to once the merge start is picked", () => {
    const node = makeNode(101n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [node] });
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");

    harness.click(node);

    expect(readStatusText(harness.readStatusElement())).toBe(
      "Merge · click a node to merge to",
    );
    harness.deactivate();
  });

  it("asks to show the merge start's skeleton, and offers Show, when that skeleton is hidden", () => {
    const node = makeNode(101n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [node] });
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    harness.click(node);

    const { visibleSegments } =
      harness.layer.displayState.segmentationGroupState.value;
    visibleSegments.delete(11n);
    visibleSegments.changed.dispatch();

    expect(readStatusText(harness.readStatusElement())).toBe(
      "Merge · make the from-node skeleton visible",
    );
    expect(readHintLabels(harness.readStatusElement())).toEqual([
      "Show",
      "Exit merge",
      "Rotate/pan",
    ]);
    harness.deactivate();
  });

  it("asks for the second insert node once the first is picked", () => {
    const harness = makeEditToolHarness({
      renderedNodes: [makeNode(1n, 11n, [0, 0, 0])],
    });
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");

    harness.click(harness.renderedNodes[0]);

    expect(readStatusText(harness.readStatusElement())).toBe(
      "Insert · click the parent or a child of the first node",
    );
    harness.deactivate();
  });

  it("shows that an insert is saving while it waits for the queue", () => {
    const root = makeNode(1n, 11n, [0, 0, 0]);
    const child = makeNode(2n, 11n, [2, 4, 6], 1n);
    const harness = makeEditToolHarness({ renderedNodes: [root, child] });
    harness.executions.executeSpatialSkeletonInsertNode.mockImplementation(
      () => makeHeldExecution().execution,
    );
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");
    harness.click(root);

    harness.click(child);

    expect(readStatusText(harness.readStatusElement())).toBe(
      "Insert · inserting node…",
    );
    harness.deactivate();
  });

  it("shows that a delete is saving until the queue accepts it", async () => {
    const node = makeNode(2n, 11n, [2, 4, 6]);
    const harness = makeEditToolHarness({ inspectedNodes: [node] });
    const held = makeHeldExecution();
    harness.executions.executeSpatialSkeletonDeleteNode.mockImplementation(
      () => held.execution,
    );
    harness.pressModeKey(SKELETON_ENTER_DELETE_MODE, "KeyD");

    harness.click(node);

    expect(readStatusText(harness.readStatusElement())).toBe(
      "Delete · deleting node…",
    );

    held.admit();

    await vi.waitFor(() =>
      expect(readStatusText(harness.readStatusElement())).toBe(
        "Delete · no selected nodes",
      ),
    );
    harness.deactivate();
  });

  it("shows that a new skeleton is saving until the queue accepts it", async () => {
    const harness = makeEditToolHarness();
    const held = makeHeldExecution();
    harness.executions.executeSpatialSkeletonAddNode.mockImplementation(
      () => held.execution,
    );
    harness.pressModeKey(SKELETON_ENTER_CREATE, "KeyN");

    harness.click();

    expect(readStatusText(harness.readStatusElement())).toBe(
      "Create · creating skeleton…",
    );

    held.admit();

    await vi.waitFor(() =>
      expect(readStatusText(harness.readStatusElement())).toBe(
        "Create · ready to place",
      ),
    );
    harness.deactivate();
  });
});

describe("skeleton edit tool merge", () => {
  it("clearing the selection also clears a merge start", () => {
    const node = makeNode(101n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [node] });
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    harness.click(node);
    expect(harness.state.mergeAnchorNodeId.value).toBe(101n);

    harness.actions.get(SKELETON_CLEAR_SELECTION)!(makeActionEvent());

    expect(harness.state.mergeAnchorNodeId.value).toBeUndefined();
    expect(harness.layer.skeletonNodeSelection.clear).toHaveBeenCalledWith(
      "force-unpin",
    );
    harness.deactivate();
  });

  it("clearing with no node selected unpins the viewer's selection instead", () => {
    const harness = makeEditToolHarness();

    harness.actions.get(SKELETON_CLEAR_SELECTION)!(makeActionEvent());

    expect(harness.layer.manager.root.selectionState.unpin).toHaveBeenCalled();
    expect(harness.layer.skeletonNodeSelection.clear).not.toHaveBeenCalled();
    harness.deactivate();
  });

  it("starts a merge from the node's current skeleton when the picked skeleton ID was replaced by an earlier edit", () => {
    const node = makeNode(101n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [node] });
    harness.hover({ ...node, segmentId: 6368542n });

    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    expect(harness.layer.skeletonNodeSelection.select).not.toHaveBeenCalled();
    expect(harness.state.mergeAnchorNodeId.value).toBeUndefined();
    harness.click();

    expect(harness.layer.skeletonNodeSelection.select).toHaveBeenCalledWith(
      101n,
      true,
      expect.objectContaining({ nodeId: 101n, segmentId: 11n }),
    );
    expect(harness.state.mergeAnchorNodeId.value).toBe(101n);
    expect(harness.state.mergeMode.value).toBe(true);
    expect(harness.getFullSegmentNodes).not.toHaveBeenCalledWith(
      expect.anything(),
      11n,
      expect.anything(),
    );
    harness.deactivate();
  });

  it.each([
    ["is drawn", { rendered: true, cached: false }, 17n],
    ["is only cached", { rendered: false, cached: true }, 17n],
    [
      "is neither drawn nor cached",
      { rendered: false, cached: false },
      6368542n,
    ],
  ])(
    "merges into the target's current skeleton when the target %s and its pick carries a retired skeleton ID",
    (_, { rendered, cached }, mergedSegmentId) => {
      const fromNode = makeNode(101n, 11n, [1, 2, 3]);
      const toNode = makeNode(202n, 17n, [4, 5, 6]);
      const harness = makeEditToolHarness({
        inspectedNodes: cached ? [fromNode, toNode] : [fromNode],
        renderedNodes: rendered ? [fromNode, toNode] : [fromNode],
        visibleSegmentIds: [11n],
      });
      harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
      harness.click(fromNode);

      harness.click({ ...toNode, segmentId: 6368542n });

      expect(
        harness.executions.executeSpatialSkeletonMerge,
      ).toHaveBeenCalledExactlyOnceWith(
        harness.layer.skeletonSourceConnection,
        expect.objectContaining({ nodeId: 101n, segmentId: 11n }),
        expect.objectContaining({ nodeId: 202n, segmentId: mergedSegmentId }),
      );
      harness.deactivate();
    },
  );

  it("prefetches the skeleton hovered after picking a merge anchor", () => {
    const anchor = makeNode(5n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [anchor] });
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    harness.click(anchor);

    harness.hover({ segmentId: 22n });

    expect(harness.getFullSegmentNodes).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      22n,
      expect.anything(),
    );
    harness.deactivate();
  });

  it("does not prefetch the merge anchor's own skeleton", () => {
    const anchor = makeNode(5n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [anchor] });
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    harness.click(anchor);

    harness.hover({ segmentId: 11n });

    expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    harness.deactivate();
  });

  it("keeps the merge target prefetch while the pointer is outside the view", () => {
    const anchor = makeNode(5n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [anchor] });
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    harness.click(anchor);
    harness.hover({ segmentId: 22n });

    harness.mouseState.active = false;
    harness.hover({ segmentId: 33n });

    expect(harness.getFullSegmentNodes).toHaveBeenCalledOnce();
    expect(harness.releasePrefetch).not.toHaveBeenCalled();
    harness.deactivate();
  });

  it("keeps the merge target prefetch while a merge waits for the queue", () => {
    const anchor = makeNode(5n, 11n, [1, 2, 3]);
    const target = makeNode(6n, 22n, [4, 5, 6]);
    const harness = makeEditToolHarness({
      inspectedNodes: [anchor],
      renderedNodes: [anchor, target],
    });
    harness.executions.executeSpatialSkeletonMerge.mockImplementation(
      () => makeHeldExecution().execution,
    );
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    harness.click(anchor);
    harness.click(target);

    harness.hover({ segmentId: 33n });

    expect(harness.getFullSegmentNodes).toHaveBeenCalledOnce();
    expect(harness.releasePrefetch).not.toHaveBeenCalled();
    harness.deactivate();
  });

  it("stops prefetching hovered skeletons once the merge anchor is cleared", () => {
    const anchor = makeNode(5n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [anchor] });
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    harness.click(anchor);
    harness.hover({ segmentId: 22n });

    harness.state.clearMergeAnchor();
    harness.hover({ segmentId: 33n });

    expect(harness.releasePrefetch).toHaveBeenCalledOnce();
    expect(harness.getFullSegmentNodes).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      22n,
      expect.anything(),
    );
    harness.deactivate();
  });

  it("stops prefetching hovered skeletons when the tool deactivates", () => {
    const anchor = makeNode(5n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [anchor] });
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    harness.click(anchor);
    harness.hover({ segmentId: 22n });

    harness.deactivate();
    harness.hover({ segmentId: 33n });

    expect(harness.releasePrefetch).toHaveBeenCalledOnce();
    expect(harness.getFullSegmentNodes).toHaveBeenCalledOnce();
  });

  it("keeps the selected-node highlight visible when a merge finishes after the tool deactivates", async () => {
    const fromNode = makeNode(101n, 11n, [1, 2, 3]);
    const toNode = makeNode(202n, 17n, [4, 5, 6]);
    const harness = makeEditToolHarness({
      inspectedNodes: [fromNode, toNode],
    });
    const held = makeHeldExecution();
    harness.executions.executeSpatialSkeletonMerge.mockImplementation(
      () => held.execution,
    );
    harness.pressModeKey(SKELETON_ENTER_MERGE_MODE, "KeyM");
    harness.click(fromNode);
    harness.click(toNode);
    expect(
      harness.executions.executeSpatialSkeletonMerge,
    ).toHaveBeenCalledOnce();

    harness.deactivate();
    held.finish();
    await held.execution;

    expect(harness.state.suppressSelectedNodeHighlight.value).toBe(false);
  });
});

describe("skeleton edit tool split", () => {
  it("enters split mode, then splits the node that is clicked", () => {
    const parent = makeNode(76n, 11n, [6, 7, 8]);
    const child = makeNode(77n, 11n, [7, 8, 9], 76n);
    const harness = makeEditToolHarness({ inspectedNodes: [parent, child] });
    harness.hover(child);

    harness.pressModeKey(SKELETON_ENTER_SPLIT_MODE, "KeyS");
    expect(harness.layer.selectSegment).not.toHaveBeenCalled();
    expect(harness.layer.skeletonNodeSelection.select).not.toHaveBeenCalled();
    harness.click();

    expect(harness.layer.selectSegment).toHaveBeenCalledWith(11n, true);
    expect(harness.layer.skeletonNodeSelection.select).toHaveBeenCalledWith(
      77n,
      true,
      expect.objectContaining({ nodeId: 77n }),
    );
    expect(
      harness.executions.executeSpatialSkeletonSplit,
    ).toHaveBeenCalledExactlyOnceWith(
      harness.layer.skeletonSourceConnection,
      expect.objectContaining({
        nodeId: 77n,
        segmentId: 11n,
        parentNodeId: 76n,
      }),
    );
    const [, splitNode] =
      harness.executions.executeSpatialSkeletonSplit.mock.calls[0];
    expect(Array.from(splitNode.position)).toEqual([7, 8, 9]);
    harness.deactivate();
  });

  it("accepts the next split click once the queue admits the split, before its preview loads", async () => {
    const parent = makeNode(76n, 11n, [6, 7, 8]);
    const child = makeNode(77n, 11n, [7, 8, 9], 76n);
    const harness = makeEditToolHarness({ inspectedNodes: [parent, child] });
    const held = makeHeldExecution();
    harness.executions.executeSpatialSkeletonSplit.mockImplementationOnce(
      () => held.execution,
    );
    harness.pressModeKey(SKELETON_ENTER_SPLIT_MODE, "KeyS");
    harness.click(child);
    harness.click(parent);
    expect(
      harness.executions.executeSpatialSkeletonSplit,
    ).toHaveBeenCalledOnce();
    expect(harness.layer.skeletonNodeSelection.clear).not.toHaveBeenCalled();

    held.admit();
    await vi.waitFor(() =>
      expect(harness.layer.skeletonNodeSelection.clear).toHaveBeenCalledWith(
        "force-unpin",
      ),
    );
    harness.click(parent);

    expect(
      harness.executions.executeSpatialSkeletonSplit,
    ).toHaveBeenCalledTimes(2);
    harness.deactivate();
  });

  it("a split admitted after the tool reactivates does not accept clicks for a newer split that waits", async () => {
    const parent = makeNode(76n, 11n, [6, 7, 8]);
    const child = makeNode(77n, 11n, [7, 8, 9], 76n);
    const harness = makeEditToolHarness({ inspectedNodes: [parent, child] });
    const earlier = makeHeldExecution();
    const newer = makeHeldExecution();
    harness.executions.executeSpatialSkeletonSplit
      .mockImplementationOnce(() => earlier.execution)
      .mockImplementationOnce(() => newer.execution);
    harness.pressModeKey(SKELETON_ENTER_SPLIT_MODE, "KeyS");
    harness.click(child);
    harness.deactivate();
    harness.reactivate();
    harness.pressModeKey(SKELETON_ENTER_SPLIT_MODE, "KeyS");
    harness.click(child);

    earlier.admit();
    await earlier.execution.acceptedByQueue;
    await Promise.resolve();
    harness.click(parent);

    expect(
      harness.executions.executeSpatialSkeletonSplit,
    ).toHaveBeenCalledTimes(2);
    harness.deactivate();
  });

  it("a split that fails to start reports the error and accepts the next click", () => {
    const child = makeNode(77n, 11n, [7, 8, 9], 76n);
    const harness = makeEditToolHarness({
      inspectedNodes: [makeNode(76n, 11n, [6, 7, 8]), child],
    });
    harness.executions.executeSpatialSkeletonSplit.mockImplementationOnce(
      () => {
        throw new Error("queue is full");
      },
    );
    harness.pressModeKey(SKELETON_ENTER_SPLIT_MODE, "KeyS");

    harness.click(child);
    harness.click(child);

    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
      expect.stringContaining("queue is full"),
    );
    expect(
      harness.executions.executeSpatialSkeletonSplit,
    ).toHaveBeenCalledTimes(2);
    harness.deactivate();
  });

  it("keeps the selected-node highlight visible when a split finishes after the tool deactivates", async () => {
    const child = makeNode(77n, 11n, [7, 8, 9], 76n);
    const harness = makeEditToolHarness({
      inspectedNodes: [makeNode(76n, 11n, [6, 7, 8]), child],
    });
    const held = makeHeldExecution();
    harness.executions.executeSpatialSkeletonSplit.mockImplementation(
      () => held.execution,
    );
    harness.pressModeKey(SKELETON_ENTER_SPLIT_MODE, "KeyS");
    harness.click(child);
    expect(
      harness.executions.executeSpatialSkeletonSplit,
    ).toHaveBeenCalledOnce();

    harness.deactivate();
    held.finish();
    await held.execution;

    expect(harness.state.suppressSelectedNodeHighlight.value).toBe(false);
  });
});

describe("skeleton edit tool insert", () => {
  it("enters insert mode with the selected-node highlight hidden and no node selected", () => {
    const harness = makeEditToolHarness({
      renderedNodes: [makeNode(1n, 11n, [0, 0, 0])],
      selectedNodeId: 1n,
    });

    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");

    expect(harness.state.suppressSelectedNodeHighlight.value).toBe(true);
    expect(harness.layer.skeletonNodeSelection.select).not.toHaveBeenCalled();
    harness.deactivate();
  });

  it.each([
    ["parent then child", 1n, 2n],
    ["child then parent", 2n, 1n],
  ])(
    "inserts a node at the midpoint of the picked edge (%s)",
    (_, firstPickId, secondPickId) => {
      const harness = makeEditToolHarness({
        renderedNodes: [
          makeNode(1n, 11n, [0, 0, 0]),
          makeNode(2n, 11n, [2, 4, 6], 1n),
        ],
      });
      const pick = (nodeId: bigint) =>
        harness.renderedNodes.find((node) => node.nodeId === nodeId)!;
      harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");

      harness.click(pick(firstPickId));
      harness.click(pick(secondPickId));

      expect(harness.layer.skeletonNodeSelection.select).toHaveBeenCalledOnce();
      expect(harness.layer.skeletonNodeSelection.select).toHaveBeenCalledWith(
        firstPickId,
        true,
        expect.objectContaining({ nodeId: firstPickId }),
      );
      expect(
        harness.executions.executeSpatialSkeletonInsertNode,
      ).toHaveBeenCalledExactlyOnceWith(
        harness.layer.skeletonSourceConnection,
        {
          skeletonId: 11n,
          parentNodeId: 1n,
          childNodeIds: [2n],
          positionInModelSpace: new Float32Array([1, 2, 3]),
        },
      );
      harness.deactivate();
    },
  );

  it("asks for a new first node after an insert", async () => {
    const root = makeNode(1n, 11n, [0, 0, 0]);
    const child = makeNode(2n, 11n, [2, 4, 6], 1n);
    const harness = makeEditToolHarness({ renderedNodes: [root, child] });
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");
    harness.click(root);

    harness.click(child);

    await vi.waitFor(() =>
      expect(readStatusText(harness.readStatusElement())).toBe(
        "Insert · click the first node",
      ),
    );
    harness.deactivate();
  });

  it("rejects a pick on a non-visible skeleton before resolving the node", () => {
    const harness = makeEditToolHarness({ visibleSegmentIds: [11n] });
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");

    harness.click(makeNode(9n, 12n, [1, 1, 1]));

    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
      expect.stringContaining("Make skeleton 12 visible"),
      3000,
    );
    expect(harness.layer.skeletonNodeSelection.select).not.toHaveBeenCalled();
    expect(readStatusText(harness.readStatusElement())).toBe(
      "Insert · click the first node",
    );
    harness.deactivate();
  });

  it("rejects insertion between nodes that are not directly connected and keeps the first pick", () => {
    const root = makeNode(1n, 11n, [0, 0, 0]);
    const middle = makeNode(2n, 11n, [2, 2, 2], 1n);
    const leaf = makeNode(3n, 11n, [4, 4, 4], 2n);
    const harness = makeEditToolHarness({
      renderedNodes: [root, middle, leaf],
    });
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");
    harness.click(root);

    harness.click(leaf);
    expect(
      harness.executions.executeSpatialSkeletonInsertNode,
    ).not.toHaveBeenCalled();
    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
      expect.stringContaining("Node 3 is not connected to node 1"),
    );

    harness.click(middle);
    expect(
      harness.executions.executeSpatialSkeletonInsertNode,
    ).toHaveBeenCalledWith(
      harness.layer.skeletonSourceConnection,
      expect.objectContaining({ parentNodeId: 1n, childNodeIds: [2n] }),
    );
    harness.deactivate();
  });

  it("treats the next pick as a first pick after the selection is cleared", () => {
    const root = makeNode(1n, 11n, [0, 0, 0]);
    const child = makeNode(2n, 11n, [2, 4, 6], 1n);
    const harness = makeEditToolHarness({ renderedNodes: [root, child] });
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");
    harness.click(root);

    harness.actions.get(SKELETON_CLEAR_SELECTION)!(makeActionEvent());
    harness.click(child);

    expect(
      harness.executions.executeSpatialSkeletonInsertNode,
    ).not.toHaveBeenCalled();
    expect(harness.layer.skeletonNodeSelection.select).toHaveBeenLastCalledWith(
      2n,
      true,
      child,
    );
    harness.deactivate();
  });

  it("inserts at the midpoint of the current node positions when the first node moves between picks", () => {
    const child = makeNode(2n, 11n, [2, 4, 6], 1n);
    const harness = makeEditToolHarness({
      renderedNodes: [makeNode(1n, 11n, [10, 10, 10]), child],
    });
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");
    harness.click(harness.renderedNodes[0]);

    harness.renderedNodes[0] = makeNode(1n, 11n, [0, 0, 0]);
    harness.click(child);

    expect(
      harness.executions.executeSpatialSkeletonInsertNode,
    ).toHaveBeenCalledWith(
      harness.layer.skeletonSourceConnection,
      expect.objectContaining({
        positionInModelSpace: new Float32Array([1, 2, 3]),
      }),
    );
    harness.deactivate();
  });

  it("abandons the insert with a message when the first node no longer exists", () => {
    const root = makeNode(1n, 11n, [0, 0, 0]);
    const child = makeNode(2n, 11n, [2, 4, 6], 1n);
    const harness = makeEditToolHarness({ renderedNodes: [root, child] });
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");
    harness.click(root);

    harness.renderedNodes.splice(0, 1);
    harness.click(child);
    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
      "Node 1 is no longer available. Pick the first node again.",
    );

    harness.click(child);
    expect(
      harness.executions.executeSpatialSkeletonInsertNode,
    ).not.toHaveBeenCalled();
    expect(harness.layer.skeletonNodeSelection.select).toHaveBeenLastCalledWith(
      2n,
      true,
      child,
    );
    harness.deactivate();
  });

  it("keeps the selected-node highlight visible when an insert finishes after the tool deactivates", async () => {
    const root = makeNode(1n, 11n, [0, 0, 0]);
    const child = makeNode(2n, 11n, [2, 4, 6], 1n);
    const harness = makeEditToolHarness({ renderedNodes: [root, child] });
    const held = makeHeldExecution();
    harness.executions.executeSpatialSkeletonInsertNode.mockImplementation(
      () => held.execution,
    );
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");
    harness.click(root);
    harness.click(child);
    expect(
      harness.executions.executeSpatialSkeletonInsertNode,
    ).toHaveBeenCalledOnce();

    harness.deactivate();
    held.finish();
    await held.execution;

    expect(harness.state.suppressSelectedNodeHighlight.value).toBe(false);
  });

  it("keeps the first pick of a new activation when an insert from an earlier activation finishes", async () => {
    const root = makeNode(1n, 11n, [0, 0, 0]);
    const child = makeNode(2n, 11n, [2, 4, 6], 1n);
    const harness = makeEditToolHarness({ renderedNodes: [root, child] });
    const held = makeHeldExecution();
    harness.executions.executeSpatialSkeletonInsertNode.mockImplementationOnce(
      () => held.execution,
    );
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");
    harness.click(root);
    harness.click(child);
    harness.deactivate();
    harness.reactivate();
    harness.pressModeKey(SKELETON_ENTER_INSERT_MODE, "KeyI");
    harness.click(root);

    held.finish();
    await held.execution;
    expect(readStatusText(harness.readStatusElement())).toBe(
      "Insert · click the parent or a child of the first node",
    );
    harness.click(child);

    expect(
      harness.executions.executeSpatialSkeletonInsertNode,
    ).toHaveBeenCalledTimes(2);
    harness.deactivate();
  });
});

describe("skeleton edit tool panels and cursors", () => {
  it("selects a node with a left click in a panel created after a layout change", () => {
    const node = makeNode(5n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [node] });
    harness.hover(node);
    const panel = makePanel("2d");
    const unbind = bindPanel(panel, harness.activation);
    harness.layer.manager.root.display.panels.add(panel);

    panel.element.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, bubbles: true }),
    );

    expect(harness.layer.skeletonNodeSelection.select).toHaveBeenCalledWith(
      5n,
      true,
      expect.objectContaining({ nodeId: 5n }),
    );
    unbind();
    harness.deactivate();
  });

  it("pans a 2D panel and rotates a 3D panel with a middle drag", () => {
    const harness = makeEditToolHarness();
    const slice = makePanel("2d");
    const perspective = makePanel("3d");
    const unbindSlice = bindPanel(slice, harness.activation);
    const unbindPerspective = bindPanel(perspective, harness.activation);
    harness.layer.manager.root.display.panels.add(slice);
    harness.layer.manager.root.display.panels.add(perspective);
    const receivedActions = (panel: { element: HTMLElement }) => {
      const received: string[] = [];
      for (const action of [
        "rotate-via-mouse-drag",
        "translate-via-mouse-drag",
      ]) {
        panel.element.addEventListener(`action:${action}`, () =>
          received.push(action),
        );
      }
      return received;
    };
    const sliceActions = receivedActions(slice);
    const perspectiveActions = receivedActions(perspective);

    for (const panel of [slice, perspective]) {
      panel.element.dispatchEvent(
        new MouseEvent("mousedown", { button: 1, bubbles: true }),
      );
    }

    expect(sliceActions).toEqual(["translate-via-mouse-drag"]);
    expect(perspectiveActions).toEqual(["rotate-via-mouse-drag"]);
    unbindSlice();
    unbindPerspective();
    harness.deactivate();
  });

  it("shows the merge, create, split, delete and insert cursors while each mode is active", () => {
    for (const [action, svg] of [
      [SKELETON_ENTER_MERGE_MODE, svg_mergeCursor],
      [SKELETON_ENTER_CREATE, svg_newSkeletonCursor],
      [SKELETON_ENTER_SPLIT_MODE, svg_splitCursor],
      [SKELETON_ENTER_DELETE_MODE, svg_deleteCursor],
      [SKELETON_ENTER_INSERT_MODE, svg_insertNodeCursor],
    ]) {
      const harness = makeEditToolHarness();

      harness.actions.get(action)!({});

      expect(harness.readCursor()).toContain(encodeURIComponent(svg));
      harness.deactivate();
    }
  });

  it("shows the add-node cursor while shift is held without ctrl", () => {
    const harness = makeEditToolHarness();

    window.dispatchEvent(new MouseEvent("mousemove", { shiftKey: true }));
    expect(harness.readCursor()).toContain(
      encodeURIComponent(svg_addNodeCursor),
    );

    window.dispatchEvent(
      new MouseEvent("mousemove", { shiftKey: true, ctrlKey: true }),
    );
    expect(harness.readCursor()).toBe("");
    harness.deactivate();
  });

  it("restores the default panel cursor when the tool deactivates", () => {
    const harness = makeEditToolHarness();
    harness.actions.get(SKELETON_ENTER_MERGE_MODE)!({});
    expect(harness.readCursor()).not.toBe("");

    harness.deactivate();

    expect(harness.readCursor()).toBe("");
  });
});

describe("skeleton edit tool inspection", () => {
  it("asks for a selected node before shift+click adds a child", () => {
    const harness = makeEditToolHarness();

    harness.actions.get(SKELETON_ADD_NODE)!(makeActionEvent());

    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
      expect.stringContaining("Select a node first"),
    );
    harness.deactivate();
  });

  it("asks to inspect a skeleton before adding to, deleting from, splitting or merging it", () => {
    const node = makeNode(101n, 11n, [1, 2, 3], 100n);
    const harness = makeEditToolHarness({
      renderedNodes: [node],
      selectedNodeId: 101n,
    });
    harness.hover(node);

    harness.actions.get(SKELETON_ADD_NODE)!(makeActionEvent());
    harness.lastDrag().finish();
    for (const [action, code] of [
      [SKELETON_ENTER_DELETE_MODE, "KeyD"],
      [SKELETON_ENTER_SPLIT_MODE, "KeyS"],
      [SKELETON_ENTER_MERGE_MODE, "KeyM"],
    ]) {
      harness.pressModeKey(action, code);
      harness.click();
      harness.releaseModeKey(code);
    }

    for (const execution of Object.values(harness.executions)) {
      expect(execution).not.toHaveBeenCalled();
    }
    expect(harness.state.mergeAnchorNodeId.value).toBeUndefined();
    expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    expect(vi.mocked(StatusMessage.showTemporaryMessage).mock.calls).toEqual(
      Array(4).fill(["Inspect skeleton 11 before editing it."]),
    );
    harness.deactivate();
  });

  it("selects a node of an uninspected skeleton without asking to inspect it", () => {
    const node = makeNode(5n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ renderedNodes: [node] });

    harness.click(node);

    expect(harness.layer.skeletonNodeSelection.select).toHaveBeenCalledWith(
      5n,
      true,
      expect.objectContaining({ nodeId: 5n }),
    );
    expect(StatusMessage.showTemporaryMessage).not.toHaveBeenCalled();
    harness.deactivate();
  });

  it("does not ask to inspect an uninspected skeleton when the pointer barely moves", () => {
    const node = makeNode(5n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ renderedNodes: [node] });
    harness.click(node);

    // Below the 2 px drag threshold.
    harness.lastDrag().move(1, 0);

    expect(StatusMessage.showTemporaryMessage).not.toHaveBeenCalled();
    harness.deactivate();
  });

  it("asks once to inspect the skeleton when one of its nodes is dragged", () => {
    const node = makeNode(5n, 11n, [1, 2, 3]);
    const harness = makeEditToolHarness({ renderedNodes: [node] });
    harness.click(node);

    const drag = harness.lastDrag();
    drag.move(10, 20);
    drag.move(10, 20);

    expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledExactlyOnceWith(
      "Inspect skeleton 11 before editing it.",
    );
    expect(harness.state.setPendingNodePosition).not.toHaveBeenCalled();
    expect(
      harness.executions.executeSpatialSkeletonMoveNode,
    ).not.toHaveBeenCalled();
    harness.deactivate();
  });

  it("places a new skeleton without loading any skeleton", () => {
    const harness = makeEditToolHarness();
    harness.pressModeKey(SKELETON_ENTER_CREATE, "KeyN");

    harness.click();

    expect(
      harness.executions.executeSpatialSkeletonAddNode,
    ).toHaveBeenCalledExactlyOnceWith(harness.layer.skeletonSourceConnection, {
      skeletonId: 0n,
      parentNodeId: undefined,
      positionInModelSpace: new Float32Array([7, 8, 9]),
    });
    expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    harness.deactivate();
  });
});

describe("skeleton edit tool node drag", () => {
  function makeDragHarness() {
    const node = makeNode(7n, 4n, [1, 2, 3]);
    const harness = makeEditToolHarness({ inspectedNodes: [node] });
    const handle = spatialSkeletonStableNode("dragged");
    const mappings = new SpatialSkeletonStableIdHandles<bigint, bigint>();
    mappings.bindNodes([[handle, node.nodeId]]);
    vi.spyOn(harness.state, "getEditingIdentityService").mockReturnValue({
      getOrCreateNodeHandle: () => handle,
      resolveNode: (nodeHandle: typeof handle) =>
        mappings.resolveNode(nodeHandle),
    } as unknown as ReturnType<
      SpatialSkeletonEditSession["getEditingIdentityService"]
    >);
    const renumber = (renumbered: SkeletonNode) => {
      harness.state.replaceCachedSegmentSnapshots([
        [node.segmentId, []],
        [renumbered.segmentId, [renumbered]],
      ]);
      mappings.bindNodes([[handle, renumbered.nodeId]]);
    };
    return { ...harness, node, renumber };
  }

  it.each([
    {
      when: "before movement",
      renumberedNodeId: 101n,
      movesBefore: [],
      movesAfter: [[10, 20]],
      previewedNodeId: 101n,
      excludedSegmentId: 17n,
    },
    {
      when: "during movement",
      renumberedNodeId: 101n,
      movesBefore: [[5, 20]],
      movesAfter: [[5, 0]],
      previewedNodeId: 101n,
      excludedSegmentId: 4n,
    },
    {
      when: "after the last movement",
      renumberedNodeId: 101n,
      movesBefore: [[10, 20]],
      movesAfter: [],
      previewedNodeId: 7n,
      excludedSegmentId: 4n,
    },
    {
      when: "before movement",
      renumberedNodeId: 7n,
      movesBefore: [],
      movesAfter: [[10, 20]],
      previewedNodeId: 7n,
      excludedSegmentId: 17n,
    },
    {
      when: "during movement",
      renumberedNodeId: 7n,
      movesBefore: [[5, 20]],
      movesAfter: [[5, 0]],
      previewedNodeId: 7n,
      excludedSegmentId: 4n,
    },
    {
      when: "after the last movement",
      renumberedNodeId: 7n,
      movesBefore: [[10, 20]],
      movesAfter: [],
      previewedNodeId: 7n,
      excludedSegmentId: 4n,
    },
  ])(
    "moves the dragged node to node $renumberedNodeId in skeleton 17 when the server renumbers it $when",
    async ({
      renumberedNodeId,
      movesBefore,
      movesAfter,
      previewedNodeId,
      excludedSegmentId,
    }) => {
      const harness = makeDragHarness();
      harness.click(harness.node);
      const drag = harness.lastDrag();
      for (const [deltaX, deltaY] of movesBefore) drag.move(deltaX, deltaY);
      const renumbered = makeNode(renumberedNodeId, 17n, [1, 2, 3]);

      harness.renumber(renumbered);
      for (const [deltaX, deltaY] of movesAfter) drag.move(deltaX, deltaY);
      drag.finish();

      expect(harness.state.setPendingNodePosition).toHaveBeenLastCalledWith(
        previewedNodeId,
        new Float32Array([11, 22, 3]),
      );
      expect(
        harness.layer.skeletonOverlaySegments.beginTemporaryBrowseExclusion,
      ).toHaveBeenCalledExactlyOnceWith(excludedSegmentId);
      expect(
        harness.executions.executeSpatialSkeletonMoveNode,
      ).toHaveBeenCalledExactlyOnceWith(
        harness.layer.skeletonSourceConnection,
        {
          node: expect.objectContaining({
            nodeId: renumberedNodeId,
            segmentId: 17n,
          }),
          nextPositionInModelSpace: new Float32Array([11, 22, 3]),
        },
      );
      await vi.waitFor(() =>
        expect(harness.releaseBrowseExclusion).toHaveBeenCalledOnce(),
      );
      harness.deactivate();
    },
  );

  it("shows the move cursor and the Moving node status while a node is dragged, and clears both when the drag ends", () => {
    const harness = makeDragHarness();
    harness.click(harness.node);
    const drag = harness.lastDrag();
    expect(harness.readCursor()).toBe("");

    drag.move(10, 20);
    expect(harness.readCursor()).toContain(encodeURIComponent(svg_dragCursor));
    expect(readStatusText(harness.readStatusElement())).toBe("Moving node");

    drag.finish();
    expect(harness.readCursor()).toBe("");
    expect(readStatusText(harness.readStatusElement())).toBe("Node selected");
    harness.deactivate();
  });

  it.each([
    ["pressed", []],
    ["moving", [[10, 20]]],
  ])(
    "a %s node drag that the tool's deactivation cancels no longer previews, clears or saves",
    (_, movesBefore) => {
      const harness = makeDragHarness();
      harness.click(harness.node);
      const stale = harness.lastDrag();
      for (const [deltaX, deltaY] of movesBefore) stale.move(deltaX, deltaY);

      harness.deactivate();
      expect(harness.readCursor()).toBe("");
      expect(harness.releaseBrowseExclusion).toHaveBeenCalledTimes(
        movesBefore.length,
      );
      vi.mocked(harness.state.setPendingNodePosition).mockClear();
      vi.mocked(harness.state.clearPendingNodePositions).mockClear();
      stale.move(30, 40);
      stale.finish();

      expect(harness.state.setPendingNodePosition).not.toHaveBeenCalled();
      expect(harness.state.clearPendingNodePositions).not.toHaveBeenCalled();
      expect(
        harness.executions.executeSpatialSkeletonMoveNode,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["pressed", []],
    ["moving", [[10, 20]]],
  ])(
    "a %s node drag from before the tool reactivates does not disturb a new drag",
    (_, movesBefore) => {
      const harness = makeDragHarness();
      harness.click(harness.node);
      const stale = harness.lastDrag();
      for (const [deltaX, deltaY] of movesBefore) stale.move(deltaX, deltaY);
      harness.deactivate();
      harness.reactivate();
      harness.click(harness.node);
      const current = harness.lastDrag();
      current.move(5, 10);
      vi.mocked(harness.state.setPendingNodePosition).mockClear();
      vi.mocked(harness.state.clearPendingNodePositions).mockClear();

      stale.move(30, 40);
      stale.finish();

      expect(harness.state.setPendingNodePosition).not.toHaveBeenCalled();
      expect(harness.state.clearPendingNodePositions).not.toHaveBeenCalled();
      expect(harness.readCursor()).toContain(
        encodeURIComponent(svg_dragCursor),
      );
      current.finish();
      expect(
        harness.executions.executeSpatialSkeletonMoveNode,
      ).toHaveBeenCalledOnce();
      harness.deactivate();
    },
  );
});
