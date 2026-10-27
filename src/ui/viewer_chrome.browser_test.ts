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
import { PrefetchManager } from "#src/python_integration/prefetch.js";
import { setupEngine } from "#src/ui/default_viewer_setup.js";
import type { MinimalViewerOptions } from "#src/ui/minimal_viewer.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
import type { Viewer } from "#src/viewer.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeTarget() {
  const target = document.createElement("div");
  target.style.width = "400px";
  target.style.height = "400px";
  document.body.appendChild(target);
  return target;
}

function track(viewer: Viewer, target: HTMLElement) {
  cleanups.push(() => {
    viewer.dispose();
    viewer.display.dispose();
    target.remove();
  });
  return viewer;
}

function makeViewer(options: Partial<MinimalViewerOptions> = {}) {
  const target = makeTarget();
  return track(makeMinimalViewer({ target, ...options }), target);
}

describe("ViewerChrome", () => {
  it("builds the top row and the side panels by default", () => {
    const viewer = makeViewer();
    const { chrome } = viewer;

    expect(chrome).toBeDefined();
    expect(viewer.sidePanelManager).toBe(chrome!.sidePanelManager);
    const children = Array.from(viewer.element.children);
    expect(children).toHaveLength(2);
    expect(children[0].classList).toContain("neuroglancer-viewer-top-row");
    expect(children[1]).toBe(chrome!.sidePanelManager.element);
    expect(
      chrome!.sidePanelManager.element.contains(viewer.layout.element),
    ).toBe(true);
  });

  it("resets the side panels when the state resets", () => {
    const viewer = makeViewer();
    const reset = vi.spyOn(viewer.chrome!.sidePanelManager, "reset");

    viewer.state.reset();

    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("Viewer with chrome: false", () => {
  it("mounts the layout directly in the viewer element", () => {
    const viewer = makeViewer({ chrome: false });

    expect(viewer.chrome).toBeUndefined();
    expect(viewer.sidePanelManager).toBeUndefined();
    expect(Array.from(viewer.element.children)).toEqual([
      viewer.layout.element,
    ]);
    expect(
      viewer.element.querySelector(".neuroglancer-viewer-top-row"),
    ).toBeNull();
  });

  it("keeps the side panel state but builds no side panel", () => {
    const viewer = makeViewer({ chrome: false });

    viewer.state.restoreState({
      layout: "xy",
      layerListPanel: { visible: true },
      helpPanel: { visible: true },
    });

    const json = viewer.state.toJSON();
    expect(json.layout).toBe("xy");
    expect(json.layerListPanel.visible).toBe(true);
    expect(json.helpPanel.visible).toBe(true);
    expect(viewer.element.querySelector(".neuroglancer-side-panel")).toBeNull();
    expect(() => viewer.state.reset()).not.toThrow();
  });
});

describe("PrefetchManager", () => {
  it("makes a viewer with no chrome for each prefetch state", async () => {
    const viewer = makeViewer();
    const prefetchManager = new PrefetchManager(
      viewer.display,
      viewer.dataSourceProvider,
      viewer.dataContext.addRef(),
      viewer.uiConfiguration,
    );
    cleanups.push(() => prefetchManager.dispose());

    prefetchManager.restoreState([{ state: { layout: "xy" } }]);

    await vi.waitFor(() => expect(prefetchManager.prefetchStates.size).toBe(1));
    for (const prefetchViewer of prefetchManager.prefetchStates.values()) {
      expect(prefetchViewer.chrome).toBeUndefined();
    }
    expect(
      viewer.display.container.querySelectorAll(".neuroglancer-viewer-top-row"),
    ).toHaveLength(1);
  });
});

describe("setupEngine", () => {
  it("makes a viewer with no chrome, no layer bar and no panel controls", () => {
    const target = makeTarget();
    const viewer = track(setupEngine({ target }), target);

    expect(viewer.chrome).toBeUndefined();
    expect(viewer.uiConfiguration.showLayerPanel.value).toBe(false);
    expect(viewer.uiConfiguration.showPanelControls.value).toBe(false);
    expect(viewer.showLayerDialog).toBe(false);
    expect(viewer.commandRegistry.get("screenshot")).toBeDefined();
  });

  it("lets the options turn on the layer bar and the panel controls", () => {
    const target = makeTarget();
    const viewer = track(
      setupEngine({ target, showLayerPanel: true, showPanelControls: true }),
      target,
    );

    expect(viewer.chrome).toBeUndefined();
    expect(viewer.uiConfiguration.showLayerPanel.value).toBe(true);
    expect(viewer.uiConfiguration.showPanelControls.value).toBe(true);
  });
});
