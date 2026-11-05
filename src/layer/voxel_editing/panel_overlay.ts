/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { SliceViewPanel } from "#src/sliceview/panel.js";
import { RefCounted } from "#src/util/disposable.js";

/**
 * A 2D canvas laid over a slice view panel, used to draw the brush cursor:
 * CSS cursors are capped in size (128 px in Chrome), too small for large
 * brushes.
 */
export class PanelOverlay extends RefCounted {
  private canvas = document.createElement("canvas");
  private context = this.canvas.getContext("2d")!;
  private redrawScheduled = false;

  constructor(
    public panel: SliceViewPanel,
    private draw: (
      context: CanvasRenderingContext2D,
      panel: SliceViewPanel,
    ) => void,
  ) {
    super();
    const { style } = this.canvas;
    style.position = "absolute";
    style.top = "0";
    style.left = "0";
    style.width = "100%";
    style.height = "100%";
    style.pointerEvents = "none";
    style.zIndex = "10";
    panel.element.appendChild(this.canvas);
    this.registerDisposer(() => this.canvas.remove());
    const resize = () => {
      this.canvas.width = panel.renderViewport.logicalWidth;
      this.canvas.height = panel.renderViewport.logicalHeight;
    };
    resize();
    this.registerDisposer(panel.boundsUpdated.add(resize));
  }

  scheduleRedraw() {
    if (this.redrawScheduled || !this.panel.visible) return;
    this.redrawScheduled = true;
    requestAnimationFrame(() => {
      this.redrawScheduled = false;
      if (this.wasDisposed) return;
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.draw(this.context, this.panel);
    });
  }
}
