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
import { ActionCommand } from "#src/ui/command.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
import type { ViewerUIOptions } from "#src/viewer.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeViewer(options: Partial<ViewerUIOptions> = {}) {
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

function countControls(element: HTMLElement) {
  return {
    layoutButtons: element.querySelectorAll(
      ".neuroglancer-data-panel-layout-controls",
    ).length,
    displayDimensions: element.querySelectorAll(
      ".neuroglancer-display-dimensions-widget",
    ).length,
    sectionsCheckbox: element.querySelectorAll(
      "label.perspective-panel-show-slice-views",
    ).length,
  };
}

// The 4panel layout puts layout buttons on each of its four panels. The xy
// panel and the 3d panel show the display dimensions, and the 3d panel shows
// the "Sections" checkbox.
const FOUR_PANEL_CONTROLS = {
  layoutButtons: 4,
  displayDimensions: 2,
  sectionsCheckbox: 1,
};

const NO_CONTROLS = {
  layoutButtons: 0,
  displayDimensions: 0,
  sectionsCheckbox: 0,
};

describe("showPanelControls", () => {
  it("shows the controls in each data panel by default", async () => {
    const viewer = makeViewer();
    await vi.waitFor(() =>
      expect(countControls(viewer.element)).toEqual(FOUR_PANEL_CONTROLS),
    );
  });

  it("builds no panel controls when the option is false", async () => {
    const viewer = makeViewer({ showPanelControls: false });
    await vi.waitFor(() =>
      expect(
        viewer.element.querySelectorAll(".neuroglancer-panel").length,
      ).toBe(4),
    );
    expect(countControls(viewer.element)).toEqual(NO_CONTROLS);
  });

  it("removes and restores the controls when the value changes", async () => {
    const viewer = makeViewer();
    await vi.waitFor(() =>
      expect(countControls(viewer.element)).toEqual(FOUR_PANEL_CONTROLS),
    );

    viewer.uiConfiguration.showPanelControls.value = false;
    await vi.waitFor(() =>
      expect(countControls(viewer.element)).toEqual(NO_CONTROLS),
    );

    viewer.uiConfiguration.showPanelControls.value = true;
    await vi.waitFor(() =>
      expect(countControls(viewer.element)).toEqual(FOUR_PANEL_CONTROLS),
    );
  });

  it("hides the controls when showUIControls is false", async () => {
    const viewer = makeViewer();
    await vi.waitFor(() =>
      expect(countControls(viewer.element)).toEqual(FOUR_PANEL_CONTROLS),
    );

    viewer.uiConfiguration.showUIControls.value = false;
    await vi.waitFor(() =>
      expect(countControls(viewer.element)).toEqual(NO_CONTROLS),
    );
  });

  it("keeps the layout toggle action when the controls are hidden", async () => {
    const viewer = makeViewer({ showPanelControls: false });
    let panel: Element | null = null;
    await vi.waitFor(() => {
      panel = viewer.element.querySelector(".neuroglancer-panel");
      expect(panel).not.toBeNull();
    });

    // The first panel of the 4panel layout is the xy panel.
    new ActionCommand("toggle-layout", "Toggle Layout").invoke({
      dispatchTarget: panel!,
    });
    expect(viewer.state.toJSON().layout).toBe("xy");
  });
});
