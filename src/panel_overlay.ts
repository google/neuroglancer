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

import "#src/panel_overlay.css";

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { Disposable } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { getViewFrustumDepthRange, vec4 } from "#src/util/geom.js";

export interface ViewportPoint {
  readonly viewportLeft: number;
  readonly viewportTop: number;
  readonly focalPlaneDepthFraction: number;
}

const tempClip = vec4.create();

export function projectToViewport(
  parameters: ProjectionParameters,
  position: ArrayLike<number>,
): ViewportPoint | undefined {
  const {
    projectionMat,
    viewProjectionMat,
    logicalWidth,
    logicalHeight,
    visibleLeftFraction,
    visibleTopFraction,
    visibleWidthFraction,
    visibleHeightFraction,
    displayDimensionRenderInfo: { displayDimensionIndices },
  } = parameters;
  const clip = tempClip;
  for (let i = 0; i < 3; ++i) {
    const index = displayDimensionIndices[i];
    clip[i] = index >= 0 ? position[index] : 0;
  }
  clip[3] = 1;
  vec4.transformMat4(clip, clip, viewProjectionMat);
  const w = clip[3];
  if (w <= 0) return undefined;
  const normalizedDeviceZ = clip[2] / w;
  if (normalizedDeviceZ < -1 || normalizedDeviceZ > 1) return undefined;
  const orthographic = projectionMat[15] === 1;
  return {
    viewportLeft:
      (visibleLeftFraction +
        ((clip[0] / w) * 0.5 + 0.5) * visibleWidthFraction) *
      logicalWidth,
    viewportTop:
      (visibleTopFraction +
        (0.5 - (clip[1] / w) * 0.5) * visibleHeightFraction) *
      logicalHeight,
    focalPlaneDepthFraction: orthographic
      ? normalizedDeviceZ
      : (w - 1) / (getViewFrustumDepthRange(projectionMat) / 2),
  };
}

export type ProjectOverlayPosition = (
  position: Float32Array,
  coordinateSpace: CoordinateSpace,
) => ViewportPoint | undefined;

export interface PanelOverlayHost {
  readonly container: HTMLElement;
  readonly project: ProjectOverlayPosition;
  /** Updates the overlays at the next animation frame without a redraw. */
  scheduleUpdate(): void;
}

export interface PanelOverlay extends Disposable {
  update(): void;
}

export class PanelOverlayManager
  extends RefCounted
  implements PanelOverlayHost
{
  readonly container = document.createElement("div");
  private readonly overlays: PanelOverlay[] = [];
  readonly scheduleUpdate = this.registerCancellable(
    animationFrameDebounce(() => {
      if (this.isDrawable()) this.update();
      else this.hide();
    }),
  );

  constructor(
    panelElement: HTMLElement,
    readonly project: ProjectOverlayPosition,
    private readonly isDrawable: () => boolean,
  ) {
    super();
    this.container.className = "neuroglancer-panel-overlay-container";
    panelElement.appendChild(this.container);
    this.registerDisposer(() => this.container.remove());
  }

  /** Overlays added later draw on top. Returns a function that removes the overlay. */
  add(createOverlay: (host: PanelOverlayHost) => PanelOverlay) {
    const overlay = this.registerDisposer(createOverlay(this));
    this.overlays.push(overlay);
    return () => {
      this.unregisterDisposer(overlay);
      this.overlays.splice(this.overlays.indexOf(overlay), 1);
      overlay.dispose();
    };
  }

  update() {
    this.scheduleUpdate.cancel();
    this.container.hidden = false;
    for (const overlay of this.overlays) overlay.update();
  }

  hide() {
    this.scheduleUpdate.cancel();
    this.container.hidden = true;
  }
}
