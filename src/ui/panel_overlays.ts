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

import "#src/ui/panel_overlays.css";

import type { NavigationState } from "#src/navigation_state.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type { WatchableValueChangeInterface } from "#src/trackable_value.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { Disposable } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { NullaryReadonlySignal } from "#src/util/signal.js";
import type { TrackableScreenshotMode } from "#src/util/trackable_screenshot_mode.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";

export interface OverlaidPanel {
  /** In viewport pixels, or -1 while the mouse is outside the panel. */
  readonly mouseX: number;
  readonly mouseY: number;
  readonly navigationState: NavigationState;
  readonly projectionParameters: WatchableValueChangeInterface<ProjectionParameters>;
}

export interface PanelOverlay extends Disposable {
  /** Receives no pointer events, so that input reaches the panel. */
  readonly element: HTMLElement;
  /** Dispatched when the overlay must update without a redraw of the panel. */
  readonly updateNeeded: NullaryReadonlySignal;
  /**
   * Must be cheap and idempotent, and never runs while the projection of the panel is stale.
   * A mouse move does not update an overlay whose `element` is hidden.
   */
  update(): void;
}

export class PanelOverlays extends RefCounted {
  private readonly container = document.createElement("div");
  private readonly overlays: PanelOverlay[] = [];
  private positionsValid = false;
  private readonly scheduleUpdate = this.registerCancellable(
    animationFrameDebounce(() => this.update()),
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

  /** Overlays added later draw on top. */
  add(overlay: PanelOverlay) {
    this.overlays.push(this.registerDisposer(overlay));
    this.container.appendChild(overlay.element);
    this.registerDisposer(
      overlay.updateNeeded.add(() => {
        if (this.positionsValid) this.scheduleUpdate();
      }),
    );
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
    if (
      this.positionsValid &&
      this.overlays.some((overlay) => !overlay.element.hidden)
    ) {
      this.scheduleUpdate();
    }
  }

  private setPositionsValid(positionsValid: boolean) {
    this.positionsValid = positionsValid;
    this.container.hidden = !positionsValid;
    if (!positionsValid) this.scheduleUpdate.cancel();
  }

  private update() {
    this.scheduleUpdate.cancel();
    if (!this.positionsValid) return;
    for (const overlay of this.overlays) overlay.update();
  }
}
