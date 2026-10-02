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

import "#src/ui/picking_indicator.css";

import { coordinateSpacesEqual } from "#src/coordinate_transform.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import { projectToViewport } from "#src/projection_parameters.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { OverlaidPanel, PanelOverlay } from "#src/ui/panel_overlays.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

const PICKING_INDICATOR_DIAMETER = 14;
const PICKING_INDICATOR_MIN_SCALE = 0.6;
const PICKING_INDICATOR_MAX_SCALE = 1.7;

export class PickingIndicator extends RefCounted implements PanelOverlay {
  readonly element = document.createElement("div");
  readonly updateNeeded = new NullarySignal();

  constructor(
    private readonly panel: OverlaidPanel,
    private readonly mouseState: MouseSelectionState,
    private readonly showPickingIndicator: WatchableValueInterface<boolean>,
  ) {
    super();
    this.element.className = "neuroglancer-picking-indicator";
    this.registerDisposer(
      mouseState.changed.add(() => {
        if (showPickingIndicator.value) this.updateNeeded.dispatch();
      }),
    );
    this.registerDisposer(
      showPickingIndicator.changed.add(this.updateNeeded.dispatch),
    );
  }

  update() {
    const { element, mouseState, panel } = this;
    const point =
      this.showPickingIndicator.value &&
      mouseState.active &&
      coordinateSpacesEqual(
        mouseState.coordinateSpace,
        panel.navigationState.coordinateSpace.value,
      )
        ? projectToViewport(
            panel.projectionParameters.value,
            mouseState.position,
          )
        : undefined;
    element.hidden = point === undefined;
    if (point === undefined) return;
    const scale = Math.min(
      PICKING_INDICATOR_MAX_SCALE,
      Math.max(PICKING_INDICATOR_MIN_SCALE, point.focalPlaneScale),
    );
    const size = PICKING_INDICATOR_DIAMETER * scale;
    // The pick completes after the cursor moves, so the cursor gives the position in its own panel.
    const mouseInPanel = panel.mouseX >= 0;
    const viewportX = mouseInPanel ? panel.mouseX : point.viewportX;
    const viewportY = mouseInPanel ? panel.mouseY : point.viewportY;
    const opacity = mouseInPanel
      ? 1
      : 1 - Math.abs(point.focalPlaneDepthFraction);
    const { style } = element;
    style.width = `${size}px`;
    style.height = `${size}px`;
    style.opacity = `${opacity}`;
    style.transform = `translate(${viewportX - size / 2}px, ${viewportY - size / 2}px)`;
  }
}
