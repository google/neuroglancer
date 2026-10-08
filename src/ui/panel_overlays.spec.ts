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

import { describe, expect, it } from "vitest";
import { PanelOverlays } from "#src/ui/panel_overlays.js";
import { NullarySignal } from "#src/util/signal.js";
import {
  ScreenshotMode,
  TrackableScreenshotMode,
} from "#src/util/trackable_screenshot_mode.js";

function makeOverlay() {
  const overlay = {
    element: document.createElement("div"),
    updateNeeded: new NullarySignal(),
    updateCount: 0,
    update() {
      ++overlay.updateCount;
    },
    dispose() {},
  };
  return overlay;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function isShown(element: HTMLElement) {
  for (
    let ancestor: HTMLElement | null = element;
    ancestor !== null;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor.hidden) return false;
  }
  return true;
}

describe("PanelOverlays", () => {
  it("keeps overlays hidden after the panel skips a frame, until the panel draws again", async () => {
    const overlays = new PanelOverlays(
      document.createElement("div"),
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const overlay = makeOverlay();
    overlays.add(overlay);
    overlays.frameDrawn();
    overlays.frameSkipped();

    overlay.updateNeeded.dispatch();
    await nextAnimationFrame();
    expect(isShown(overlay.element)).toBe(false);
    expect(overlay.updateCount).toBe(1);

    overlays.frameDrawn();
    expect(isShown(overlay.element)).toBe(true);
    expect(overlay.updateCount).toBe(2);
  });

  it("hides overlays while a screenshot is taken", () => {
    const screenshotMode = new TrackableScreenshotMode(ScreenshotMode.OFF);
    const overlays = new PanelOverlays(
      document.createElement("div"),
      screenshotMode,
    );
    const overlay = makeOverlay();
    overlays.add(overlay);
    overlays.frameDrawn();

    screenshotMode.value = ScreenshotMode.ON;
    expect(isShown(overlay.element)).toBe(false);
    overlays.frameDrawn();
    expect(isShown(overlay.element)).toBe(false);

    screenshotMode.value = ScreenshotMode.OFF;
    overlays.frameDrawn();
    expect(isShown(overlay.element)).toBe(true);
  });

  it("updates on mouse moves only while an overlay is shown", async () => {
    const overlays = new PanelOverlays(
      document.createElement("div"),
      new TrackableScreenshotMode(ScreenshotMode.OFF),
    );
    const overlay = makeOverlay();
    overlays.add(overlay);
    overlays.frameDrawn();
    expect(overlay.updateCount).toBe(1);

    overlay.element.hidden = true;
    overlays.mouseMoved();
    await nextAnimationFrame();
    expect(overlay.updateCount).toBe(1);

    overlay.element.hidden = false;
    overlays.mouseMoved();
    await nextAnimationFrame();
    expect(overlay.updateCount).toBe(2);
  });
});
