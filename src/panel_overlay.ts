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
import type { MouseSelectionState } from "#src/layer/index.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { Disposable } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { mat4 } from "#src/util/geom.js";
import { vec4 } from "#src/util/geom.js";

export interface ViewportPosition {
  readonly viewportLeft: number;
  readonly viewportTop: number;
}

export interface ViewportPoint extends ViewportPosition {
  readonly focalPlaneDepthFraction: number;
  readonly perspectiveDivideFactor: number;
}

const tempClip = vec4.create();
const tempFocalClip = vec4.create();

function getClipCoordinates(
  out: vec4,
  parameters: ProjectionParameters,
  position: ArrayLike<number>,
): vec4 {
  const {
    viewProjectionMat,
    displayDimensionRenderInfo: { displayDimensionIndices },
  } = parameters;
  for (let i = 0; i < 3; ++i) {
    const index = displayDimensionIndices[i];
    out[i] = index >= 0 ? position[index] : 0;
  }
  out[3] = 1;
  return vec4.transformMat4(out, out, viewProjectionMat);
}

// Distance in front of the camera, from the depth row of `mat4.perspective` or `mat4.ortho`.
function getEyeDepth(projectionMat: mat4, normalizedDeviceZ: number): number {
  const orthographic = projectionMat[15] === 1;
  return orthographic
    ? (projectionMat[14] - normalizedDeviceZ) / projectionMat[10]
    : projectionMat[14] / (normalizedDeviceZ + projectionMat[10]);
}

export function projectToViewport(
  parameters: ProjectionParameters,
  position: ArrayLike<number>,
): ViewportPoint | undefined {
  const {
    projectionMat,
    logicalWidth,
    logicalHeight,
    visibleLeftFraction,
    visibleTopFraction,
    visibleWidthFraction,
    visibleHeightFraction,
  } = parameters;
  const clip = getClipCoordinates(tempClip, parameters, position);
  const w = clip[3];
  if (w <= 0) return undefined;
  const normalizedDeviceX = clip[0] / w;
  const normalizedDeviceY = clip[1] / w;
  const normalizedDeviceZ = clip[2] / w;
  if (normalizedDeviceZ < -1 || normalizedDeviceZ > 1) return undefined;
  const eyeDepth = getEyeDepth(projectionMat, normalizedDeviceZ);
  const focalClip = getClipCoordinates(
    tempFocalClip,
    parameters,
    parameters.globalPosition,
  );
  const focalEyeDepth = getEyeDepth(projectionMat, focalClip[2] / focalClip[3]);
  // The near and far planes can be unequally far from the focal plane.
  const boundEyeDepth = getEyeDepth(
    projectionMat,
    eyeDepth < focalEyeDepth ? -1 : 1,
  );
  return {
    viewportLeft:
      (visibleLeftFraction +
        (normalizedDeviceX * 0.5 + 0.5) * visibleWidthFraction) *
      logicalWidth,
    viewportTop:
      (visibleTopFraction +
        (0.5 - normalizedDeviceY * 0.5) * visibleHeightFraction) *
      logicalHeight,
    focalPlaneDepthFraction:
      (eyeDepth - focalEyeDepth) / Math.abs(boundEyeDepth - focalEyeDepth),
    perspectiveDivideFactor: 1 / w,
  };
}

export type ProjectOverlayPosition = (
  position: Float32Array,
  coordinateSpace: CoordinateSpace,
) => ViewportPoint | undefined;

export interface PanelOverlayHost {
  readonly container: HTMLElement;
  readonly project: ProjectOverlayPosition;
  /** Undefined while the cursor is outside the panel. */
  readonly cursor: ViewportPosition | undefined;
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
  cursor: ViewportPosition | undefined = undefined;
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

  /** Overlays added later draw on top. */
  add(createOverlay: (host: PanelOverlayHost) => PanelOverlay) {
    this.overlays.push(this.registerDisposer(createOverlay(this)));
  }

  moveCursor(cursor: ViewportPosition | undefined) {
    this.cursor = cursor;
    this.scheduleUpdate();
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

const PICKING_INDICATOR_DIAMETER = 14;
const PICKING_INDICATOR_MIN_SCALE = 0.6;
const PICKING_INDICATOR_MAX_SCALE = 1.7;

export class PickingIndicator extends RefCounted implements PanelOverlay {
  private readonly ring = document.createElement("div");

  constructor(
    private readonly host: PanelOverlayHost,
    private readonly mouseState: MouseSelectionState,
    private readonly showPickingIndicator: WatchableValueInterface<boolean>,
  ) {
    super();
    this.ring.className = "neuroglancer-picking-indicator";
    host.container.appendChild(this.ring);
    this.registerDisposer(() => this.ring.remove());
    this.registerDisposer(mouseState.changed.add(host.scheduleUpdate));
    this.registerDisposer(
      showPickingIndicator.changed.add(host.scheduleUpdate),
    );
  }

  update() {
    const { mouseState, ring } = this;
    const point =
      this.showPickingIndicator.value && mouseState.active
        ? this.host.project(mouseState.position, mouseState.coordinateSpace)
        : undefined;
    ring.hidden = point === undefined;
    if (point === undefined) return;
    const scale = Math.min(
      PICKING_INDICATOR_MAX_SCALE,
      Math.max(PICKING_INDICATOR_MIN_SCALE, point.perspectiveDivideFactor),
    );
    const size = PICKING_INDICATOR_DIAMETER * scale;
    // The pick completes after the cursor moves, so the cursor gives the position in its own panel.
    const { viewportLeft, viewportTop } = this.host.cursor ?? point;
    const { style } = ring;
    style.width = `${size}px`;
    style.height = `${size}px`;
    style.opacity = `${1 - Math.abs(point.focalPlaneDepthFraction)}`;
    style.transform = `translate(${viewportLeft - size / 2}px, ${viewportTop - size / 2}px)`;
  }
}
