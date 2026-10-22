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
import { SpatialSkeletonActions } from "#src/skeleton/edit_commands.js";
import { SkeletonFindPathState } from "#src/skeleton/find_path/find_path.js";
import { buildSkeletonNavigationGraph } from "#src/skeleton/navigation_graph.js";
import { SkeletonNavigator } from "#src/skeleton/skeleton_navigator.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { SKELETON_FIND_PATH_SELECT_ENDPOINT } from "#src/ui/skeleton_edit_tool_shortcuts.js";
import {
  getSpatialSkeletonFindPathEndpointDescription,
  SpatialSkeletonFindPathTool,
} from "#src/ui/skeleton_find_path_tool.js";
import type { ToolActivation } from "#src/ui/tool.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import { NullarySignal } from "#src/util/signal.js";

function makeVisibleSegmentsState(initialVisibleSegments: bigint[] = []) {
  return {
    visibleSegments: Object.assign(new Set<bigint>(initialVisibleSegments), {
      changed: makeChangedSignal(),
    }),
    selectedSegments: new Set<bigint>(),
    segmentEquivalences: {},
    temporaryVisibleSegments: new Set<bigint>(),
    temporarySegmentEquivalences: {},
    useTemporaryVisibleSegments: { value: false },
    useTemporarySegmentEquivalences: { value: false },
  };
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
    dispatch: vi.fn(),
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

function withConnectionContext(layer: {
  spatialSkeletonEditSession?: unknown;
  spatiallyIndexedSkeletonLayer?: { readonly value: unknown };
  skeletonSourceConnection?: object;
}) {
  const connection = (layer.skeletonSourceConnection ??= {});
  Object.defineProperties(connection, {
    spatialSkeletonEditSession: { get: () => layer.spatialSkeletonEditSession },
    getSpatiallyIndexedSkeletonLayer: {
      value: () => layer.spatiallyIndexedSkeletonLayer?.value,
    },
  });
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

function makeFindPathActionEvent() {
  return {
    stopPropagation: vi.fn(),
    detail: {
      preventDefault: vi.fn(),
    },
  };
}

function makeFindPathNode(
  nodeId: bigint,
  segmentId = 11n,
  parentNodeId?: bigint,
): SkeletonNode {
  return {
    nodeId,
    segmentId,
    parentNodeId,
    position: new Float32Array([
      Number(nodeId),
      Number(nodeId) + 1,
      Number(nodeId) + 2,
    ]),
  };
}

function makeFindPathToolHarness(
  options: {
    cachedSegmentNodes?: readonly SkeletonNode[];
    disabledReason?: string;
    hasSource?: boolean;
    hasSecondSource?: boolean;
    readonly?: boolean;
    state?: SkeletonFindPathState;
    visibleSegmentIds?: bigint[];
  } = {},
) {
  const state = options.state ?? new SkeletonFindPathState();
  const mouseState: any = {
    pickedRenderLayer: undefined,
    pickedSpatialSkeleton: undefined,
    updateUnconditionally: vi.fn(() => true),
    active: true,
  };
  const cachedSegmentNodes = new Map<bigint, readonly SkeletonNode[]>();
  if (options.cachedSegmentNodes !== undefined) {
    cachedSegmentNodes.set(11n, options.cachedSegmentNodes);
  }
  const getFullSegmentNodes = vi.fn();
  const nodeDataVersion = new WatchableValue(0);
  const visibleSegmentsState = makeVisibleSegmentsState(
    options.visibleSegmentIds ?? [11n, 12n],
  );
  const skeletonLayer =
    options.hasSource === false
      ? undefined
      : {
          fragmentSource: {},
          editableSource: options.readonly === false ? {} : undefined,
          getNode: vi.fn(),
        };
  const secondSkeletonLayer =
    options.hasSecondSource === true
      ? {
          fragmentSource: {},
          editableSource: options.readonly === false ? {} : undefined,
          getNode: vi.fn(),
        }
      : undefined;
  const context =
    skeletonLayer === undefined
      ? undefined
      : {
          skeletonLayer,
          state,
          annotationController: {
            annotationState: {
              source: [],
            },
          },
        };
  const secondRenderLayer = {};
  const getSpatialSkeletonActionsDisabledReason = vi.fn(
    (requiredActions: unknown) =>
      options.readonly === true &&
      requiredActions !== SpatialSkeletonActions.inspect
        ? "The active spatial skeleton source is read-only."
        : options.disabledReason,
  );
  const layer = {
    displayState: {
      segmentationGroupState: { value: visibleSegmentsState },
    },
    annotationDisplayState: {
      hoverState: { value: undefined },
    },
    spatialSkeletonEditSession: {
      getFullSegmentNodes,
      getCachedSegmentNodes: vi.fn((segmentId: bigint) =>
        cachedSegmentNodes.get(segmentId),
      ),
      nodeDataVersion,
    },
    manager: {
      root: {
        layerSelectedValues: { mouseState },
        display: {
          panels: new Set(),
          container: document.createElement("div"),
        },
      },
    },
    skeletonNodeSelection: {
      navigator: new SkeletonNavigator(
        new WatchableValue({
          getSegmentNodes: (
            segmentId: bigint,
          ): readonly SkeletonNode[] | undefined =>
            layer.spatialSkeletonEditSession.getCachedSegmentNodes(segmentId),
          nodesChanged: new NullarySignal(),
          hasPickableNodes: false,
          parentsInferred: false,
          displayState: { transform: new WatchableValue(undefined as any) },
        }),
      ),
    },
    spatiallyIndexedSkeletonLayer: {
      get value() {
        return skeletonLayer;
      },
    },
    getSpatiallyIndexedSkeletonLayerOf: (renderLayer: unknown) =>
      renderLayer === secondRenderLayer ? secondSkeletonLayer : undefined,
    toolBinder: {},
    skeletonSourceConnection: {
      getFindPathContext: (candidate?: unknown) =>
        candidate === undefined || context?.skeletonLayer === candidate
          ? context
          : undefined,
      getActionsDisabledReason: getSpatialSkeletonActionsDisabledReason,
    },
    layersChanged: makeChangedSignal(),
  };
  withConnectionContext(layer);
  const { activation, actions, dispose, readStatusElement } =
    makeToolActivation();
  const tool = new SpatialSkeletonFindPathTool(
    layer as unknown as SegmentationUserLayer,
  );
  Object.assign(activation, { tool });
  tool.activate(activation as unknown as ToolActivation<typeof tool>);

  const pickNode = (
    node: SkeletonNode,
    candidateSkeletonLayer = skeletonLayer,
  ) => {
    mouseState.pickedRenderLayer =
      candidateSkeletonLayer === skeletonLayer ? undefined : secondRenderLayer;
    mouseState.pickedSpatialSkeleton = node;
    actions.get(SKELETON_FIND_PATH_SELECT_ENDPOINT)?.(
      makeFindPathActionEvent(),
    );
  };

  return {
    actions,
    activation,
    cachedSegmentNodes,
    context,
    dispose,
    getFullSegmentNodes,
    skeletonSourceConnection: {
      getActionsDisabledReason: getSpatialSkeletonActionsDisabledReason,
    },
    layer,
    mouseState,
    nodeDataVersion,
    pickNode,
    readStatusElement,
    skeletonLayer,
    secondSkeletonLayer,
    state,
    visibleSegmentsState,
  };
}

describe("skeleton Find Path tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows no generic bindings line in the Find Path status", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness();
    try {
      expect(readFullText(harness.readStatusElement())).toBe(
        "Find Path Clear Left-click the source node.",
      );
    } finally {
      harness.dispose();
    }
  });

  it("describes Find Path endpoints using their derived topology type", () => {
    const nodes = [
      makeFindPathNode(1n),
      makeFindPathNode(2n, 11n, 1n),
      makeFindPathNode(3n, 11n, 1n),
      makeFindPathNode(4n, 11n, 2n),
      makeFindPathNode(5n, 11n, 2n),
    ];
    nodes[3] = { ...nodes[3], attributes: { true_end: [1] } };
    const graph = buildSkeletonNavigationGraph(nodes);

    expect(
      getSpatialSkeletonFindPathEndpointDescription(
        "Source",
        {
          nodeId: 1n,
          segmentId: 11n,
          position: new Float32Array(3),
        },
        graph,
      ),
    ).toBe("Source · Root");
    expect(
      getSpatialSkeletonFindPathEndpointDescription(
        "Target",
        {
          nodeId: 2n,
          segmentId: 11n,
          position: new Float32Array(3),
        },
        graph,
      ),
    ).toBe("Target · Branch point");
    expect(
      getSpatialSkeletonFindPathEndpointDescription(
        "Target",
        {
          nodeId: 3n,
          segmentId: 11n,
          position: new Float32Array(3),
        },
        graph,
      ),
    ).toBe("Target · Leaf");
    expect(
      getSpatialSkeletonFindPathEndpointDescription(
        "Target",
        {
          nodeId: 4n,
          segmentId: 11n,
          position: new Float32Array(3),
        },
        graph,
      ),
    ).toBe("Target · True end");
  });

  it("collects two exact Find Path nodes and rejects invalid or extra picks", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness();
    const source = makeFindPathNode(1n);
    const target = makeFindPathNode(2n);

    try {
      harness.pickNode(source);
      expect(harness.state.source).toEqual({
        nodeId: 1n,
        segmentId: 11n,
        position: source.position,
      });
      expect(harness.state.target).toBeUndefined();

      harness.pickNode(makeFindPathNode(1n));
      expect(harness.state.target).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path endpoints must be distinct skeleton nodes.",
      );

      harness.pickNode(makeFindPathNode(2n, 12n));
      expect(harness.state.target).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path endpoints must belong to the same skeleton segment.",
      );

      harness.pickNode(target);
      expect(harness.state.target).toEqual({
        nodeId: 2n,
        segmentId: 11n,
        position: target.position,
      });

      harness.pickNode(makeFindPathNode(3n));
      expect(harness.state.source?.nodeId).toBe(1n);
      expect(harness.state.target?.nodeId).toBe(2n);
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Clear Find Path or delete an endpoint before selecting another node.",
      );
    } finally {
      harness.dispose();
    }
  });

  it("rejects edge-only picks and permits a new endpoint after Clear", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness();

    try {
      harness.mouseState.pickedSpatialSkeleton = { segmentId: 11n };
      harness.actions.get(SKELETON_FIND_PATH_SELECT_ENDPOINT)?.(
        makeFindPathActionEvent(),
      );
      expect(harness.state.source).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path endpoints must be exact skeleton nodes, not edges.",
      );

      harness.pickNode(makeFindPathNode(1n));
      harness
        .readStatusElement()
        .querySelector<HTMLElement>('[title="Clear Find Path"]')!
        .click();
      harness.pickNode(makeFindPathNode(2n));
      expect(harness.state.source?.nodeId).toBe(2n);
    } finally {
      harness.dispose();
    }
  });

  it("rejects picks from a non-owning spatial skeleton source", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness({ hasSecondSource: true });

    try {
      harness.pickNode(makeFindPathNode(1n));
      harness.pickNode(makeFindPathNode(2n), harness.secondSkeletonLayer);

      expect(harness.state.source?.nodeId).toBe(1n);
      expect(harness.state.target).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path is only available for the first active spatial skeleton datasource in this layer.",
      );

      harness.state.clear();
      harness.pickNode(makeFindPathNode(2n), harness.secondSkeletonLayer);
      expect(harness.state.toJSON()).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenLastCalledWith(
        "Find Path is only available for the first active spatial skeleton datasource in this layer.",
      );
    } finally {
      harness.dispose();
    }
  });

  it("automatically uses the cached skeleton and stores an endpoint-inclusive path", () => {
    suppressStatusMessages();
    const nodes = [
      makeFindPathNode(1n),
      makeFindPathNode(2n, 11n, 1n),
      makeFindPathNode(3n, 11n, 2n),
    ];
    const harness = makeFindPathToolHarness({ cachedSegmentNodes: nodes });
    try {
      harness.pickNode(nodes[2]);
      harness.pickNode(nodes[0]);

      expect(harness.state.result?.map(({ nodeId }) => nodeId)).toEqual([
        3n,
        2n,
        1n,
      ]);
      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
      expect(
        harness.layer.spatialSkeletonEditSession.getCachedSegmentNodes,
      ).toHaveBeenCalledWith(11n);
      expect(harness.state.result?.map(({ position }) => position)).toEqual([
        nodes[2].position,
        nodes[1].position,
        nodes[0].position,
      ]);
      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        "Path found!",
        5000,
      );
    } finally {
      harness.dispose();
    }
  });

  it("reports missing endpoints and disconnected cached skeletons distinctly", () => {
    suppressStatusMessages();
    const cases = [
      {
        nodes: [makeFindPathNode(3n)],
        expected:
          "Failed to find path: Source node 1 is missing from the loaded skeleton.",
      },
      {
        nodes: [makeFindPathNode(1n)],
        expected:
          "Failed to find path: Target node 3 is missing from the loaded skeleton.",
      },
      {
        nodes: [makeFindPathNode(1n), makeFindPathNode(3n)],
        expected: "Failed to find path: No route exists between nodes 1 and 3.",
      },
    ] as const;

    for (const { nodes, expected } of cases) {
      const harness = makeFindPathToolHarness({ cachedSegmentNodes: nodes });
      try {
        harness.pickNode(makeFindPathNode(1n));
        harness.pickNode(makeFindPathNode(3n));

        expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
          expected,
        );
        expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
        expect(harness.state.result).toBeUndefined();
      } finally {
        harness.dispose();
      }
    }
  });

  it("waits for cached node data without requesting it", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness();

    try {
      harness.pickNode(makeFindPathNode(1n));
      harness.pickNode(makeFindPathNode(3n));

      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
      expect(harness.state.result).toBeUndefined();
      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        "Full data for skeleton 11 is not cached. Make it visible and wait for loading.",
      );
    } finally {
      harness.dispose();
    }
  });

  it("finds a path between nodes whose IDs are above 2^53", () => {
    suppressStatusMessages();
    const rootNodeId = 2n ** 53n + 1n;
    const nodes = [
      makeFindPathNode(rootNodeId),
      makeFindPathNode(rootNodeId + 2n, 11n, rootNodeId),
    ];
    const harness = makeFindPathToolHarness({ cachedSegmentNodes: nodes });
    try {
      harness.pickNode(nodes[1]);
      harness.pickNode(nodes[0]);

      expect(harness.state.result?.map(({ nodeId }) => nodeId)).toEqual([
        rootNodeId + 2n,
        rootNodeId,
      ]);
    } finally {
      harness.dispose();
    }
  });

  it("uses a cached skeleton even when it is not visible", () => {
    suppressStatusMessages();
    const nodes = [
      makeFindPathNode(1n),
      makeFindPathNode(2n, 11n, 1n),
      makeFindPathNode(3n, 11n, 2n),
    ];
    const harness = makeFindPathToolHarness({
      cachedSegmentNodes: nodes,
      visibleSegmentIds: [],
    });

    try {
      harness.pickNode(nodes[0]);
      harness.pickNode(nodes[2]);

      expect(harness.state.result?.map(({ nodeId }) => nodeId)).toEqual([
        1n,
        2n,
        3n,
      ]);
      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("automatically retries when the full skeleton enters the cache", () => {
    suppressStatusMessages();
    const nodes = [
      makeFindPathNode(1n),
      makeFindPathNode(2n, 11n, 1n),
      makeFindPathNode(3n, 11n, 2n),
    ];
    const harness = makeFindPathToolHarness();

    try {
      harness.pickNode(nodes[0]);
      harness.pickNode(nodes[2]);
      expect(harness.state.result).toBeUndefined();

      harness.cachedSegmentNodes.set(11n, nodes);
      harness.nodeDataVersion.value++;

      expect(harness.state.result?.map(({ nodeId }) => nodeId)).toEqual([
        1n,
        2n,
        3n,
      ]);
      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("Clear resets a result computed from cached nodes", () => {
    suppressStatusMessages();
    const nodes = [
      makeFindPathNode(1n),
      makeFindPathNode(2n, 11n, 1n),
      makeFindPathNode(3n, 11n, 2n),
    ];
    const harness = makeFindPathToolHarness({ cachedSegmentNodes: nodes });

    try {
      harness.pickNode(nodes[0]);
      harness.pickNode(nodes[2]);
      expect(harness.state.result).toBeDefined();

      const clearButton = harness
        .readStatusElement()
        .querySelector<HTMLElement>('[title="Clear Find Path"]');
      expect(clearButton).not.toBeNull();
      clearButton!.click();

      expect(harness.state.source).toBeUndefined();
      expect(harness.state.target).toBeUndefined();
      expect(harness.state.result).toBeUndefined();
      expect(harness.getFullSegmentNodes).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("allows Find Path for a read-only source using inspect permission", () => {
    suppressStatusMessages();
    const harness = makeFindPathToolHarness({ readonly: true });

    try {
      expect(harness.actions.has(SKELETON_FIND_PATH_SELECT_ENDPOINT)).toBe(
        true,
      );
      expect(harness.activation.cancel).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it("cancels Find Path when inspect is disabled or no source is loaded", async () => {
    suppressStatusMessages();
    const disabledHarness = makeFindPathToolHarness({
      disabledReason: "Skeleton inspection is unavailable.",
    });
    const noSourceHarness = makeFindPathToolHarness({ hasSource: false });

    try {
      await Promise.resolve();

      expect(disabledHarness.activation.cancel).toHaveBeenCalledTimes(1);
      expect(disabledHarness.actions.size).toBe(0);
      expect(noSourceHarness.activation.cancel).toHaveBeenCalledTimes(1);
      expect(noSourceHarness.actions.size).toBe(0);
      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        "Skeleton inspection is unavailable.",
      );
      expect(StatusMessage.showTemporaryMessage).toHaveBeenCalledWith(
        "No spatially indexed skeleton source is currently loaded.",
      );
    } finally {
      disabledHarness.dispose();
      noSourceHarness.dispose();
    }
  });
});
