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

import { afterEach, describe, expect, it } from "vitest";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { getStatusMessageContainers } from "#src/status.js";
import type { MinimalViewerOptions } from "#src/ui/minimal_viewer.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
import {
  SelectSegmentsMode,
  SelectSegmentsTool,
} from "#src/ui/segment_select_tools.js";
import {
  MergeSegmentsTool,
  SplitSegmentsTool,
} from "#src/ui/segment_split_merge_tools.js";
import type { LocalToolBinder, ToolActivation } from "#src/ui/tool.js";
import { makeToolStatusContent, Tool } from "#src/ui/tool.js";
import type { RefCounted } from "#src/util/disposable.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { vec3 } from "#src/util/geom.js";
import type { Viewer } from "#src/viewer.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeViewer(options: Partial<MinimalViewerOptions> = {}) {
  const target = document.createElement("div");
  target.style.width = "400px";
  target.style.height = "400px";
  document.body.appendChild(target);
  const viewer = makeMinimalViewer({ target, ...options });
  cleanups.push(() => {
    viewer.dispose();
    viewer.display.dispose();
    target.remove();
  });
  return viewer;
}

function toolStatusElements() {
  return getStatusMessageContainers().flatMap((container) =>
    Array.from(container.querySelectorAll(".neuroglancer-tool-status")),
  );
}

const TEST_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:mousedown0": "test-tool-action",
});

class UnmigratedTestTool extends Tool<Viewer> {
  constructor(
    localBinder: LocalToolBinder<Viewer>,
    toggle = false,
    public json = "testTool",
  ) {
    super(localBinder, toggle);
  }

  activateCount = 0;
  cancelOnActivate = false;
  activeActivationDuringActivate: ToolActivation | undefined;

  activate(activation: ToolActivation<this>) {
    ++this.activateCount;
    this.activeActivationDuringActivate =
      this.globalBinder.activeActivation.value;
    activation.bindInputEventMap(TEST_INPUT_EVENT_MAP);
    if (this.cancelOnActivate) activation.cancel();
  }

  toJSON() {
    return this.json;
  }

  get description() {
    return "test";
  }
}

class TestTool extends UnmigratedTestTool {
  panelContext: RefCounted | undefined;

  renderActivation(_activation: ToolActivation<this>, context: RefCounted) {
    this.panelContext = context;
    const content = makeToolStatusContent();
    content.textContent = "test tool panel";
    return content;
  }
}

describe("GlobalToolBinder.activeActivation", () => {
  it("holds the activation after activate() returns", () => {
    const viewer = makeViewer({ chrome: false });
    const binder = viewer.globalToolBinder;
    const tool = new TestTool(viewer.toolBinder);
    const values: Array<ToolActivation | undefined> = [];
    binder.activeActivation.changed.add(() => {
      values.push(binder.activeActivation.value);
    });

    binder.activateDirect(tool);

    expect(tool.activeActivationDuringActivate).toBeUndefined();
    expect(values).toHaveLength(1);
    expect(values[0]?.tool).toBe(tool);
    expect(values[0]?.inputEventMaps).toEqual([TEST_INPUT_EVENT_MAP]);

    binder.deactivate_();

    expect(values).toHaveLength(2);
    expect(values[1]).toBeUndefined();
  });

  it("stays undefined when the tool cancels from activate()", () => {
    const viewer = makeViewer({ chrome: false });
    const binder = viewer.globalToolBinder;
    const tool = new TestTool(viewer.toolBinder);
    tool.cancelOnActivate = true;
    let changeCount = 0;
    binder.activeActivation.changed.add(() => ++changeCount);

    binder.activateDirect(tool);

    expect(tool.activateCount).toBe(1);
    expect(binder.activeActivation.value).toBeUndefined();
    expect(changeCount).toBe(0);
  });

  it("holds the activation of a tool that a key activates", () => {
    const viewer = makeViewer({ chrome: false });
    const binder = viewer.globalToolBinder;
    const tool = new TestTool(viewer.toolBinder);
    binder.set("A", tool);

    binder.activate("A");

    expect(tool.activeActivationDuringActivate).toBeUndefined();
    expect(binder.activeActivation.value?.tool).toBe(tool);

    binder.deactivate_();

    expect(binder.activeActivation.value).toBeUndefined();
  });

  it("holds the activation of a queued toggle tool when it comes back", () => {
    const viewer = makeViewer({ chrome: false });
    const binder = viewer.globalToolBinder;
    const toggleTool = new TestTool(
      viewer.toolBinder,
      /*toggle=*/ true,
      "toggleTool",
    );
    const momentaryTool = new TestTool(
      viewer.toolBinder,
      /*toggle=*/ false,
      "momentaryTool",
    );
    binder.set("A", toggleTool);
    binder.set("B", momentaryTool);
    binder.activate("A");
    binder.activate("B");
    expect(binder.activeActivation.value?.tool).toBe(momentaryTool);

    binder.activeActivation.value!.cancel();

    expect(toggleTool.activateCount).toBe(2);
    expect(toggleTool.activeActivationDuringActivate).toBeUndefined();
    expect(binder.activeActivation.value?.tool).toBe(toggleTool);
  });
});

describe("ToolActivationStatus", () => {
  it("shows the panel and the bindings of the active tool", () => {
    const viewer = makeViewer();
    const binder = viewer.globalToolBinder;
    const tool = new TestTool(viewer.toolBinder);

    binder.activateDirect(tool);

    const elements = toolStatusElements();
    expect(elements).toHaveLength(1);
    const [content, bindings] = Array.from(elements[0].children);
    expect(content.textContent).toBe("test tool panel");
    expect(bindings.classList).toContain("neuroglancer-tool-status-bindings");
    expect(bindings.textContent).toBe(TEST_INPUT_EVENT_MAP.describe());

    binder.deactivate_();

    expect(toolStatusElements()).toHaveLength(0);
    expect(tool.panelContext!.wasDisposed).toBe(true);
  });

  it("shows no panel for a tool with no renderActivation()", () => {
    const viewer = makeViewer();
    const tool = new UnmigratedTestTool(viewer.toolBinder);

    viewer.globalToolBinder.activateDirect(tool);

    expect(tool.activateCount).toBe(1);
    expect(toolStatusElements()).toHaveLength(0);
  });

  it("is not present in a viewer with no chrome", () => {
    const viewer = makeViewer({ chrome: false });
    const tool = new TestTool(viewer.toolBinder);

    viewer.globalToolBinder.activateDirect(tool);

    expect(tool.panelContext).toBeUndefined();
    expect(toolStatusElements()).toHaveLength(0);
  });
});

function makeSegmentationLayer(viewer: Viewer) {
  viewer.state.restoreState({
    layers: [{ type: "segmentation", name: "segmentation", source: [] }],
  });
  const { layer } = viewer.layerManager.getLayerByName("segmentation")!;
  expect(layer).toBeInstanceOf(SegmentationUserLayer);
  return layer as SegmentationUserLayer;
}

function startSelectDrag(button: number) {
  const detail = new MouseEvent("mousedown", { view: window, button });
  window.dispatchEvent(
    new CustomEvent("action:drag-select-segments", { detail }),
  );
}

function endDrag(button: number) {
  document.dispatchEvent(new PointerEvent("pointerup", { button }));
}

describe("SelectSegmentsTool", () => {
  it("shows the mode of a drag in the status panel", () => {
    const viewer = makeViewer();
    const layer = makeSegmentationLayer(viewer);
    const tool = new SelectSegmentsTool(layer);
    viewer.globalToolBinder.activateDirect(tool);
    const [element] = toolStatusElements();
    const header = element.querySelector(".neuroglancer-tool-status-header")!;
    expect(header.textContent).toBe("Select/Deselect segments");

    startSelectDrag(0);

    expect(tool.mode.value).toBe(SelectSegmentsMode.SELECT);
    expect(header.textContent).toBe("Select segments");

    endDrag(0);

    expect(tool.mode.value).toBe(SelectSegmentsMode.IDLE);
    expect(header.textContent).toBe("Select/Deselect segments");
  });

  it("resets its mode when the activation ends", () => {
    const viewer = makeViewer({ chrome: false });
    const layer = makeSegmentationLayer(viewer);
    const tool = new SelectSegmentsTool(layer);
    viewer.globalToolBinder.activateDirect(tool);
    startSelectDrag(0);
    expect(tool.mode.value).toBe(SelectSegmentsMode.SELECT);

    viewer.globalToolBinder.deactivate_();

    expect(tool.mode.value).toBe(SelectSegmentsMode.IDLE);
    endDrag(0);
  });

  it("keeps the mode of a new activation when an earlier drag ends", () => {
    const viewer = makeViewer({ chrome: false });
    const layer = makeSegmentationLayer(viewer);
    const tool = new SelectSegmentsTool(layer);
    const binder = viewer.globalToolBinder;
    binder.set("A", tool);
    binder.activate("A");
    startSelectDrag(0);
    binder.deactivate_();
    binder.activate("A");
    startSelectDrag(1);
    expect(tool.mode.value).toBe(SelectSegmentsMode.SELECT);

    endDrag(0);

    expect(tool.mode.value).toBe(SelectSegmentsMode.SELECT);

    endDrag(1);

    expect(tool.mode.value).toBe(SelectSegmentsMode.IDLE);
  });
});

describe("MergeSegmentsTool", () => {
  it("keeps its status while active, and the panel shows it", () => {
    const viewer = makeViewer();
    const layer = makeSegmentationLayer(viewer);
    const tool = new MergeSegmentsTool(layer);

    viewer.globalToolBinder.activateDirect(tool);

    expect(tool.status.value).toEqual({
      anchorSegment: undefined,
      otherSegment: undefined,
      error: "Select anchor segment for merge",
    });
    const [element] = toolStatusElements();
    expect(
      element.querySelector(".neuroglancer-tool-status-header")!.textContent,
    ).toBe("Merge segments");
    expect(
      element.querySelector(".neuroglancer-tool-status-body")!.textContent,
    ).toBe("Select anchor segment for merge");

    viewer.globalToolBinder.deactivate_();

    expect(tool.status.value).toBeUndefined();
  });
});

describe("SplitSegmentsTool", () => {
  it("keeps its status while active, and the panel shows it", () => {
    const viewer = makeViewer();
    const layer = makeSegmentationLayer(viewer);
    const tool = new SplitSegmentsTool(layer);

    viewer.globalToolBinder.activateDirect(tool);

    expect(tool.status.value).toEqual({
      anchorSegment: undefined,
      otherSegment: undefined,
      error: "Select anchor segment for split",
    });
    const [element] = toolStatusElements();
    expect(
      element.querySelector(".neuroglancer-tool-status-header")!.textContent,
    ).toBe("Split segments");
    expect(
      element.querySelector(".neuroglancer-tool-status-body")!.textContent,
    ).toBe("Select anchor segment for split");

    viewer.globalToolBinder.deactivate_();

    expect(tool.status.value).toBeUndefined();
  });
});

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

describe("segment pair tool status", () => {
  it("does not change when an update gives the same status", async () => {
    const viewer = makeViewer({ chrome: false });
    const layer = makeSegmentationLayer(viewer);
    const tool = new MergeSegmentsTool(layer);
    viewer.globalToolBinder.activateDirect(tool);
    const status = tool.status.value;
    let changeCount = 0;
    tool.status.changed.add(() => ++changeCount);

    layer.displayState.segmentationGroupState.value.visibleSegments.add(5n);
    await nextAnimationFrame();

    expect(changeCount).toBe(0);
    expect(tool.status.value).toBe(status);
  });

  it("shows a new anchor segment in the panel", async () => {
    const viewer = makeViewer();
    const layer = makeSegmentationLayer(viewer);
    const tool = new MergeSegmentsTool(layer);
    viewer.globalToolBinder.activateDirect(tool);
    layer.displayState.segmentationGroupState.value.visibleSegments.add(5n);

    layer.anchorSegment.value = 5n;
    await nextAnimationFrame();

    const [element] = toolStatusElements();
    const body = element.querySelector(".neuroglancer-tool-status-body")!;
    expect(body.querySelector(".neuroglancer-segment-list-entry")).not.toBe(
      null,
    );
    expect(tool.status.value?.anchorSegment?.key).toBe(5n);
  });

  it("makes the segment widgets again when a segment color changes", async () => {
    const viewer = makeViewer();
    const layer = makeSegmentationLayer(viewer);
    const tool = new MergeSegmentsTool(layer);
    viewer.globalToolBinder.activateDirect(tool);
    layer.displayState.segmentationGroupState.value.visibleSegments.add(5n);
    layer.anchorSegment.value = 5n;
    await nextAnimationFrame();
    const [element] = toolStatusElements();
    const body = element.querySelector(".neuroglancer-tool-status-body")!;
    const widget = body.querySelector(".neuroglancer-segment-list-entry");
    expect(widget).not.toBe(null);

    layer.displayState.segmentationColorGroupState.value.segmentDefaultColor.value =
      vec3.fromValues(1, 0, 0);
    await nextAnimationFrame();

    const newWidget = body.querySelector(".neuroglancer-segment-list-entry");
    expect(newWidget).not.toBe(null);
    expect(newWidget).not.toBe(widget);
  });
});
