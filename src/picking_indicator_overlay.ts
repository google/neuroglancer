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

import "#src/picking_indicator_overlay.css";

import type { MouseSelectionState } from "#src/layer/index.js";
import type {
  PanelOverlayContext,
  PanelOverlaySource,
} from "#src/panel_overlay.js";
import type { NullarySignal } from "#src/util/signal.js";

// Base ring diameter in CSS pixels; scaled by the projection's depth `scale`.
const PICKING_INDICATOR_DIAMETER = 14;

function createRing(): HTMLElement {
  const element = document.createElement("div");
  element.className = "neuroglancer-picking-indicator";
  return element;
}

/** A ring drawn at the cursor's picked position, driven by the mouse state. */
export class PickingIndicatorOverlay implements PanelOverlaySource {
  readonly overlayPriority = 100;

  constructor(private readonly mouseState: MouseSelectionState) {}

  get overlayUpdateNeeded(): NullarySignal {
    return this.mouseState.changed;
  }

  updatePanelOverlays(ctx: PanelOverlayContext): void {
    const { container } = ctx;
    const { mouseState } = this;
    const pos =
      mouseState.active && !mouseState.pickingIndicatorSuppressed
        ? ctx.project(mouseState.position)
        : undefined;
    let element = container.firstElementChild as HTMLElement | null;
    if (pos === undefined) {
      if (element !== null) element.style.display = "none";
      return;
    }
    if (element === null) {
      element = createRing();
      container.appendChild(element);
    }
    const size = PICKING_INDICATOR_DIAMETER * (pos.scale ?? 1);
    const { style } = element;
    style.display = "";
    style.width = `${size}px`;
    style.height = `${size}px`;
    style.opacity = `${pos.opacity ?? 1}`;
    style.transform = `translate(${pos.x - size / 2}px, ${pos.y - size / 2}px)`;
  }
}
