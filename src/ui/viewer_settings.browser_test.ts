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
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const SSAO_SLIDER_LABELS = ["SSAO intensity", "SSAO radius", "SSAO depth cue"];

function makeViewerWithSettingsPanel() {
  const target = document.createElement("div");
  target.style.width = "400px";
  target.style.height = "400px";
  document.body.appendChild(target);
  const viewer = makeMinimalViewer({ target });
  cleanups.push(() => {
    viewer.dispose();
    viewer.display.dispose();
    target.remove();
  });
  viewer.settingsPanelState.location.visible = true;
  return viewer;
}

function findSlider(root: HTMLElement, label: string) {
  return Array.from(root.querySelectorAll<HTMLElement>(".range-slider")).find(
    (element) => element.textContent?.startsWith(label),
  );
}

function sliderDisplays(root: HTMLElement) {
  return SSAO_SLIDER_LABELS.map(
    (label) => findSlider(root, label)?.style.display,
  );
}

describe("ViewerSettingsPanel", () => {
  it("shows the SSAO sliders only while SSAO is enabled", async () => {
    const viewer = makeViewerWithSettingsPanel();
    const root = viewer.element;

    await vi.waitFor(() => {
      for (const label of SSAO_SLIDER_LABELS) {
        expect(findSlider(root, label), label).toBeDefined();
      }
    });
    expect(sliderDisplays(root)).toEqual(["none", "none", "none"]);

    viewer.ssao.enabled.value = true;
    await vi.waitFor(() => {
      expect(sliderDisplays(root)).toEqual(["", "", ""]);
    });

    viewer.ssao.enabled.value = false;
    await vi.waitFor(() => {
      expect(sliderDisplays(root)).toEqual(["none", "none", "none"]);
    });
  });
});
