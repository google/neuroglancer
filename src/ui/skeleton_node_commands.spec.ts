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

import { SkeletonSourceConnection } from "#src/layer/segmentation/skeleton_source_connection.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import { SpatialSkeletonEditSession } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  executeSpatialSkeletonNodeTrueEndUpdate,
  executeSpatialSkeletonReroot,
} from "#src/skeleton/edit/submit_edits.js";
import { SkeletonNavigation } from "#src/skeleton/skeleton_navigator.js";
import { SkeletonOverlaySegments } from "#src/skeleton/spatial/overlay_segments.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { CommandRegistry } from "#src/ui/command_registry.js";
import { bindSkeletonNodeCommands } from "#src/ui/skeleton_node_commands.js";
import { NullarySignal } from "#src/util/signal.js";

vi.mock("#src/skeleton/edit/submit_edits.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeSpatialSkeletonNodeTrueEndUpdate: vi.fn(async () => true),
  executeSpatialSkeletonReroot: vi.fn(async () => true),
}));

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

function makeNodeAccess(nodes: readonly SkeletonNode[]) {
  return new WatchableValue({
    getSegmentNodes: () => nodes,
    nodesChanged: new NullarySignal(),
    hasPickableNodes: false,
    parentsInferred: false,
    displayState: { transform: new WatchableValue(undefined as any) },
  });
}

function makeSkeletonLayer(selectedNodeId: bigint, { inspected = true } = {}) {
  const nodes = [makeNode(1n, undefined), makeNode(2n, 1n), makeNode(3n, 2n)];
  const skeletonNodeSelection = {
    selected: { value: { nodeId: selectedNodeId, segmentId: 42n } },
    navigate: vi.fn(),
  };
  const spatialSkeletonEditSession = {
    getReloadRequired: () => undefined,
    assertEditingAllowed: () => {},
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
  };
  const skeletonSourceConnection = {
    spatialSkeletonEditSession,
    getActionsDisabledReason: () => undefined,
  };
  const layer = {
    skeletonNodeSelection,
    skeletonSourceConnection,
    spatialSkeletonEditSession,
  };
  return { layer, nodes, skeletonNodeSelection, skeletonSourceConnection };
}

function makeReadOnlySkeletonLayer() {
  const spatialSkeletonEditSession = new SpatialSkeletonEditSession();
  return {
    spatialSkeletonEditSession,
    skeletonSourceConnection: new SkeletonSourceConnection({
      spatialSkeletonEditSession,
      selection: {} as any,
      overlaySegments: new SkeletonOverlaySegments({
        segmentationGroupState: new WatchableValue({} as any),
        editSession: spatialSkeletonEditSession,
      }),
      segmentationGroupState: new WatchableValue({} as any),
      skeletonNodeAccess: makeNodeAccess([makeNode(1n, undefined)]),
      spatiallyIndexedSkeletonLayer: new WatchableValue(undefined),
    }),
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
    registerDisposer: <T>(disposable: T) => disposable,
  };
  return { viewer, managedLayers, layersChanged };
}

describe("skeleton node commands", () => {
  it("offers skeleton commands only while a skeleton layer is visible", () => {
    const { viewer, managedLayers, layersChanged } = makeViewer([]);
    bindSkeletonNodeCommands(viewer as any);
    const goToParent = viewer.commandRegistry.get("skeleton-go-parent")!;
    expect(goToParent.enabled).toBe(false);

    managedLayers.push({ layer: makeSkeletonLayer(3n).layer, visible: true });
    layersChanged.dispatch();
    expect(goToParent.enabled).toBe(true);
  });

  it("moves to the parent of the selected node", () => {
    const { layer, skeletonNodeSelection } = makeSkeletonLayer(3n);
    const { viewer } = makeViewer([layer]);
    bindSkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-go-parent")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(skeletonNodeSelection.navigate).toHaveBeenCalledWith(
      SkeletonNavigation.PARENT,
    );
  });

  it("acts on the selected layer when several skeleton layers are visible", () => {
    const first = makeSkeletonLayer(3n);
    const second = makeSkeletonLayer(3n);
    const { viewer } = makeViewer([first.layer, second.layer], second.layer);
    bindSkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-go-root")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(first.skeletonNodeSelection.navigate).not.toHaveBeenCalled();
    expect(second.skeletonNodeSelection.navigate).toHaveBeenCalledWith(
      SkeletonNavigation.ROOT,
    );
  });

  it("sets the selected node as the skeleton root", () => {
    const { layer, nodes, skeletonSourceConnection } = makeSkeletonLayer(3n);
    const { viewer } = makeViewer([layer]);
    bindSkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-reroot")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(executeSpatialSkeletonReroot).toHaveBeenCalledWith(
      skeletonSourceConnection,
      nodes[2],
    );
  });

  it("asks to inspect the skeleton before setting a root", () => {
    const showMessage = vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockImplementation(() => ({ dispose() {} }) as any);
    vi.mocked(executeSpatialSkeletonReroot).mockClear();
    const { layer } = makeSkeletonLayer(3n, { inspected: false });
    const { viewer } = makeViewer([layer]);
    bindSkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-reroot")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(executeSpatialSkeletonReroot).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith(
      "Inspect skeleton 42 before editing it.",
    );
  });

  it("hides skeleton commands while the only skeleton layer is hidden", () => {
    const { viewer, managedLayers, layersChanged } = makeViewer([
      makeSkeletonLayer(3n).layer,
    ]);
    bindSkeletonNodeCommands(viewer as any);
    const goToParent = viewer.commandRegistry.get("skeleton-go-parent")!;
    expect(goToParent.enabled).toBe(true);

    managedLayers[0].visible = false;
    layersChanged.dispatch();
    expect(goToParent.enabled).toBe(false);
  });

  it("marks an unflagged node as a true end", () => {
    const { layer, nodes, skeletonSourceConnection } = makeSkeletonLayer(3n);
    const { viewer } = makeViewer([layer]);
    bindSkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-toggle-true-end")!
      .invoke({ dispatchTarget: new EventTarget() });

    expect(executeSpatialSkeletonNodeTrueEndUpdate).toHaveBeenCalledWith(
      skeletonSourceConnection,
      { node: nodes[2], nextIsTrueEnd: true },
    );
  });

  it("reports an undo that is refused before it starts", async () => {
    const showMessage = vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockImplementation(() => ({ dispose() {} }) as any);
    const { layer } = makeSkeletonLayer(3n);
    layer.spatialSkeletonEditSession.assertEditingAllowed = () => {
      throw new Error("Editing is paused.");
    };
    const { viewer } = makeViewer([layer]);
    bindSkeletonNodeCommands(viewer as any);

    viewer.commandRegistry
      .get("skeleton-undo")!
      .invoke({ dispatchTarget: new EventTarget() });

    await vi.waitFor(() =>
      expect(showMessage).toHaveBeenCalledWith(
        expect.stringContaining("Editing is paused."),
      ),
    );
  });

  it("offers navigation commands but not edit commands for a read-only skeleton layer", () => {
    const { viewer } = makeViewer([makeReadOnlySkeletonLayer()]);
    bindSkeletonNodeCommands(viewer as any);

    expect(viewer.commandRegistry.get("skeleton-go-parent")!.enabled).toBe(
      true,
    );
    expect(viewer.commandRegistry.get("skeleton-reroot")!.enabled).toBe(false);
    expect(
      viewer.commandRegistry.get("skeleton-toggle-true-end")!.enabled,
    ).toBe(false);
    expect(viewer.commandRegistry.get("skeleton-undo")!.enabled).toBe(false);
  });

  it("undoes on the editable layer while a read-only skeleton layer is also visible", async () => {
    const showMessage = vi
      .spyOn(StatusMessage, "showTemporaryMessage")
      .mockImplementation(() => ({ dispose() {} }) as any);
    showMessage.mockClear();
    const { layer: editableLayer } = makeSkeletonLayer(3n);
    editableLayer.spatialSkeletonEditSession.assertEditingAllowed = () => {
      throw new Error("Editing is paused.");
    };
    const { viewer } = makeViewer([makeReadOnlySkeletonLayer(), editableLayer]);
    bindSkeletonNodeCommands(viewer as any);

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
