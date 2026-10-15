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

import type { SkeletonNode } from "#src/skeleton/api.js";
import { NullarySignal } from "#src/util/signal.js";

vi.mock("#src/skeleton/commands.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeSpatialSkeletonNodeTrueEndUpdate: vi.fn(async () => true),
}));

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
const { executeSpatialSkeletonNodeTrueEndUpdate } = await import(
  "#src/skeleton/commands.js"
);
const { StatusMessage } = await import("#src/status.js");
const { CommandRegistry } = await import("#src/ui/command_registry.js");
const { SkeletonNodeCommands } = await import("#src/skeleton/node_commands.js");

function makeNode(
  nodeId: bigint,
  parentNodeId: bigint | undefined,
): SkeletonNode {
  return {
    nodeId,
    segmentId: 42n,
    position: new Float32Array([Number(nodeId), 0, 0]),
    parentNodeId,
  };
}

function makeSkeletonLayer(selectedNodeId: bigint, { inspected = true } = {}) {
  const nodes = [makeNode(1n, undefined), makeNode(2n, 1n), makeNode(3n, 2n)];
  const layer = Object.create(SegmentationUserLayer.prototype);
  const selectAndMoveToSpatialSkeletonNode = vi.fn();
  const rerootSpatialSkeletonNode = vi.fn(async () => true);
  Object.assign(layer, {
    getSpatialSkeletonActionsDisabledReason: () => undefined,
    selectedSpatialSkeletonNodeInfo: {
      value: { nodeId: selectedNodeId, segmentId: 42n },
    },
    spatialSkeletonState: {
      getOptimisticEditFatalState: () => undefined,
      assertOptimisticEditingAllowed: () => {},
      getCachedNode: (nodeId: bigint) =>
        nodes.find((node) => node.nodeId === nodeId),
      getCachedSegmentNodes: () => nodes,
      getCachedSegmentSnapshotHandle: () =>
        inspected
          ? {
              handle: {
                getNode: (nodeId: bigint) =>
                  nodes.find((node) => node.nodeId === nodeId),
              },
            }
          : undefined,
    },
    selectAndMoveToSpatialSkeletonNode,
    rerootSpatialSkeletonNode,
  });
  return {
    layer,
    nodes,
    selectAndMoveToSpatialSkeletonNode,
    rerootSpatialSkeletonNode,
  };
}

function makeViewer(
  layers: object[],
  selectedLayer: object | undefined = undefined,
) {
  const layersChanged = new NullarySignal();
  const managedLayers = layers.map((layer) => ({ layer, visible: true }));
  const viewer = {
    commandRegistry: new CommandRegistry(),
    layerManager: {
      managedLayers,
      layersChanged,
      readyStateChanged: new NullarySignal(),
    },
    selectedLayer: {
      layer: selectedLayer === undefined ? undefined : { layer: selectedLayer },
    },
    selectionDetailsState: { value: undefined },
  };
  return { viewer, managedLayers, layersChanged };
}

describe("skeleton node commands", () => {
  it("offers skeleton commands only while a skeleton layer is visible", () => {
    const { viewer, managedLayers, layersChanged } = makeViewer([]);
    new SkeletonNodeCommands(viewer as any);
    const goToParent = viewer.commandRegistry.get("skeleton-go-parent")!;
    expect(goToParent.enabled).toBe(false);

    managedLayers.push({ layer: makeSkeletonLayer(3n).layer, visible: true });
    layersChanged.dispatch();
    expect(goToParent.enabled).toBe(true);
  });

  it("moves to the parent of the selected node", () => {
    const { layer, selectAndMoveToSpatialSkeletonNode } = makeSkeletonLayer(3n);
    const { viewer } = makeViewer([layer]);
    new SkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-go-parent")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(selectAndMoveToSpatialSkeletonNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 2n, segmentId: 42n }),
    );
  });

  it("acts on the selected layer when several skeleton layers are visible", () => {
    const first = makeSkeletonLayer(3n);
    const second = makeSkeletonLayer(3n);
    const { viewer } = makeViewer([first.layer, second.layer], second.layer);
    new SkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-go-root")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(first.selectAndMoveToSpatialSkeletonNode).not.toHaveBeenCalled();
    expect(second.selectAndMoveToSpatialSkeletonNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 1n }),
    );
  });

  it("sets the selected node as the skeleton root", () => {
    const { layer, nodes, rerootSpatialSkeletonNode } = makeSkeletonLayer(3n);
    const { viewer } = makeViewer([layer]);
    new SkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-reroot")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(rerootSpatialSkeletonNode).toHaveBeenCalledWith(nodes[2]);
  });

  it("asks to inspect the skeleton before setting a root", () => {
    const showMessage = vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockImplementation(() => ({ dispose() {} }) as any);
    const { layer, rerootSpatialSkeletonNode } = makeSkeletonLayer(3n, {
      inspected: false,
    });
    const { viewer } = makeViewer([layer]);
    new SkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-reroot")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(rerootSpatialSkeletonNode).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith(
      "Inspect skeleton 42 before editing it.",
    );
  });

  it("hides skeleton commands while the only skeleton layer is hidden", () => {
    const { viewer, managedLayers, layersChanged } = makeViewer([
      makeSkeletonLayer(3n).layer,
    ]);
    new SkeletonNodeCommands(viewer as any);
    const goToParent = viewer.commandRegistry.get("skeleton-go-parent")!;
    expect(goToParent.enabled).toBe(true);

    managedLayers[0].visible = false;
    layersChanged.dispatch();
    expect(goToParent.enabled).toBe(false);
  });

  it("marks an unflagged node as a true end", () => {
    const { layer, nodes } = makeSkeletonLayer(3n);
    const { viewer } = makeViewer([layer]);
    new SkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-toggle-true-end")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(executeSpatialSkeletonNodeTrueEndUpdate).toHaveBeenCalledWith(
      layer,
      { node: nodes[2], nextIsTrueEnd: true },
    );
  });

  it("reports an undo that is refused before it starts", async () => {
    const showMessage = vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockImplementation(() => ({ dispose() {} }) as any);
    const { layer } = makeSkeletonLayer(3n);
    layer.spatialSkeletonState.assertOptimisticEditingAllowed = () => {
      throw new Error("Editing is paused.");
    };
    const { viewer } = makeViewer([layer]);
    new SkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-undo")!
      .invoke({ dispatchTarget: new EventTarget() });

    await vi.waitFor(() =>
      expect(showMessage).toHaveBeenCalledWith(
        expect.stringContaining("Editing is paused."),
      ),
    );
  });
});
