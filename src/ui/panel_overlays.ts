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

/**
 * @file Places DOM overlays over a rendered panel and updates them only while
 * the last drawn frame of the panel is current.
 */

import "#src/ui/panel_overlays.css";

import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { Disposable } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { NullaryReadonlySignal } from "#src/util/signal.js";
import type { TrackableScreenshotMode } from "#src/util/trackable_screenshot_mode.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";

export interface PanelOverlay extends Disposable {
  /** Receives no pointer events, so that input reaches the panel. */
  readonly element: HTMLElement;
  /** Dispatched when the overlay must update between frames of the panel. */
  readonly updateNeeded: NullaryReadonlySignal;
  /** A mouse move updates the overlay only if this is true and `element` is shown. */
  readonly followsMouse: boolean;
  /** Must be cheap and idempotent, and never runs while the projection of the panel is stale. */
  update(): void;
}

/** DOM elements, not WebGL, so that a pick or a mouse move updates an overlay without a redraw of the panel. */
export class PanelOverlays extends RefCounted {
  private readonly container = document.createElement("div");
  private readonly overlays: PanelOverlay[] = [];
  private positionsValid = false;
  private readonly scheduleUpdate = this.registerCancellable(
    animationFrameDebounce(() => this.update()),
  );
  private readonly scheduleMouseUpdate = this.registerCancellable(
    animationFrameDebounce(() => {
      if (!this.positionsValid) return;
      for (const overlay of this.mouseFollowingOverlays()) overlay.update();
    }),
  );

  constructor(
    panelElement: HTMLElement,
    private readonly screenshotMode: TrackableScreenshotMode,
  ) {
    super();
    this.container.className = "neuroglancer-panel-overlays";
    this.container.hidden = true;
    panelElement.appendChild(this.container);
    this.registerDisposer(() => this.container.remove());
    this.registerDisposer(
      screenshotMode.changed.add(() => this.setPositionsValid(false)),
    );
  }

  /** Overlays added later draw on top. Returns a function that removes the overlay. */
  add(overlay: PanelOverlay): () => void {
    this.overlays.push(overlay);
    this.container.appendChild(overlay.element);
    const removeUpdateListener = overlay.updateNeeded.add(() => {
      if (this.positionsValid) this.scheduleUpdate();
    });
    const remove = () => {
      const index = this.overlays.indexOf(overlay);
      if (index === -1) return;
      this.overlays.splice(index, 1);
      this.unregisterDisposer(remove);
      removeUpdateListener();
      overlay.element.remove();
      overlay.dispose();
    };
    return this.registerDisposer(remove);
  }

  frameDrawn() {
    // A screenshot scales the panel to canvas pixels, which would misplace the overlays.
    this.setPositionsValid(this.screenshotMode.value === ScreenshotMode.OFF);
    this.update();
  }

  frameSkipped() {
    this.setPositionsValid(false);
  }

  mouseMoved() {
    if (this.positionsValid && this.mouseFollowingOverlays().length > 0) {
      this.scheduleMouseUpdate();
    }
  }

  private mouseFollowingOverlays() {
    return this.overlays.filter(
      (overlay) => overlay.followsMouse && !overlay.element.hidden,
    );
  }

  private setPositionsValid(positionsValid: boolean) {
    this.positionsValid = positionsValid;
    this.container.hidden = !positionsValid;
    if (!positionsValid) {
      this.scheduleUpdate.cancel();
      this.scheduleMouseUpdate.cancel();
    }
  }

  private update() {
    this.scheduleUpdate.cancel();
    this.scheduleMouseUpdate.cancel();
    if (!this.positionsValid) return;
    for (const overlay of this.overlays) overlay.update();
  }
}
