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
 * @file Draws node rings, pending-edit markers and their connectors as HTML
 * elements over a panel, at the projected position of each node.
 */

import "#src/skeleton/spatial/skeleton_panel_overlay.css";

import type { ProjectionParameters } from "#src/projection_parameters.js";
import type { RenderedDataPanel } from "#src/rendered_data_panel.js";
import type { SkeletonOverlayPrimitives } from "#src/skeleton/spatial/skeleton_overlay_primitives.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { PanelOverlay } from "#src/ui/panel_overlays.js";
import { RefCounted } from "#src/util/disposable.js";
import type { mat4 } from "#src/util/geom.js";
import { vec4 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";

export type SkeletonPanelView = "2d" | "3d";

/** Sizes in render-viewport pixels. */
export interface SkeletonNodeRing {
  readonly diameter: number;
  readonly borderWidth: number;
}

export interface SkeletonNodeHighlightMarker {
  readonly kind: "marker";
  /** Global spatial coordinates. */
  readonly position: Float32Array;
  readonly color: string;
  readonly outlineColor: string;
  readonly ring: SkeletonNodeRing;
}

export interface SkeletonPendingEditMarker {
  readonly kind: "preparationMarker";
  readonly position: Float32Array;
  readonly label: string;
  readonly ring: SkeletonNodeRing;
}

export interface SkeletonPendingEditConnector {
  readonly kind: "preparationConnector";
  readonly from: Float32Array;
  readonly to: Float32Array;
  readonly width: number;
}

export type SkeletonPanelOverlayPrimitive =
  | SkeletonNodeHighlightMarker
  | SkeletonPendingEditMarker
  | SkeletonPendingEditConnector;

// Distance in front of the camera, from the depth row of `mat4.perspective` or `mat4.ortho`.
function getEyeDepth(projectionMat: mat4, normalizedDeviceZ: number) {
  const orthographic = projectionMat[15] === 1;
  return orthographic
    ? (projectionMat[14] - normalizedDeviceZ) / projectionMat[10]
    : projectionMat[14] / (normalizedDeviceZ + projectionMat[10]);
}

export interface ViewportPoint {
  readonly viewportX: number;
  readonly viewportY: number;
  readonly focalPlaneDepthFraction: number;
  /** Apparent size relative to a point on the focal plane. */
  readonly focalPlaneScale: number;
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
    viewportX:
      (visibleLeftFraction +
        (normalizedDeviceX * 0.5 + 0.5) * visibleWidthFraction) *
      logicalWidth,
    viewportY:
      (visibleTopFraction +
        (0.5 - normalizedDeviceY * 0.5) * visibleHeightFraction) *
      logicalHeight,
    focalPlaneDepthFraction:
      (eyeDepth - focalEyeDepth) / Math.abs(boundEyeDepth - focalEyeDepth),
    focalPlaneScale: focalClip[3] / w,
  };
}

const RING_BORDER_WIDTH_LIMITS = {
  "2d": { min: 3.5, max: 8.0 },
  "3d": { min: 3.0, max: 7.0 },
} as const;

/** The ring sits just outside the node, so it never covers the node point. */
export function getSkeletonNodeRing(
  nodeDiameter: number,
  view: SkeletonPanelView,
): SkeletonNodeRing {
  const { min, max } = RING_BORDER_WIDTH_LIMITS[view];
  const borderWidth = Math.min(max, Math.max(min, 0.5 * nodeDiameter));
  return { diameter: nodeDiameter + 2 * borderWidth, borderWidth };
}

interface PanelPoint {
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
}

export class SkeletonPanelOverlay extends RefCounted implements PanelOverlay {
  readonly element = document.createElement("div");
  readonly updateNeeded = new NullarySignal();
  readonly followsMouse = false;
  private readonly primitiveElements: HTMLDivElement[] = [];

  constructor(
    private readonly panel: RenderedDataPanel,
    private readonly overlayPrimitives: SkeletonOverlayPrimitives,
    private readonly nodeDiameter: WatchableValueInterface<number>,
    private readonly view: SkeletonPanelView,
  ) {
    super();
    this.registerDisposer(
      overlayPrimitives.changed.add(this.updateNeeded.dispatch),
    );
  }

  update(): void {
    const primitives = this.overlayPrimitives.computePrimitives(
      getSkeletonNodeRing(this.nodeDiameter.value, this.view),
    );
    const projectionParameters = this.panel.projectionParameters.value;
    const project = (position: Float32Array): PanelPoint | undefined => {
      const point = projectToViewport(projectionParameters, position);
      if (point === undefined) return undefined;
      return {
        x: point.viewportX,
        y: point.viewportY,
        opacity:
          this.view === "2d" ? 1 - Math.abs(point.focalPlaneDepthFraction) : 1,
      };
    };
    let count = 0;
    for (const primitive of primitives) {
      const element = this.getPrimitiveElement(count);
      if (!this.drawPrimitive(element, primitive, project)) continue;
      ++count;
    }
    this.element.replaceChildren(...this.primitiveElements.slice(0, count));
    this.element.hidden = count === 0;
  }

  private getPrimitiveElement(index: number) {
    let element = this.primitiveElements[index];
    if (element === undefined) {
      element = document.createElement("div");
      element.className = "neuroglancer-skeleton-panel-overlay-primitive";
      this.primitiveElements.push(element);
    }
    return element;
  }

  private drawPrimitive(
    element: HTMLDivElement,
    primitive: SkeletonPanelOverlayPrimitive,
    project: (position: Float32Array) => PanelPoint | undefined,
  ): boolean {
    const { style } = element;
    element.dataset.kind = primitive.kind;
    if (primitive.kind === "preparationConnector") {
      const from = project(primitive.from);
      const to = project(primitive.to);
      if (from === undefined || to === undefined) return false;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      style.setProperty("--connector-length", `${Math.hypot(dx, dy)}px`);
      style.setProperty("--connector-width", `${primitive.width}px`);
      style.opacity = `${Math.min(from.opacity, to.opacity)}`;
      style.transform = `translate(${from.x}px, ${from.y}px) rotate(${Math.atan2(dy, dx)}rad)`;
      element.textContent = "";
      return true;
    }
    const point = project(primitive.position);
    if (point === undefined) return false;
    const { diameter, borderWidth } = primitive.ring;
    style.setProperty("--ring-diameter", `${diameter}px`);
    style.setProperty("--ring-border-width", `${borderWidth}px`);
    if (primitive.kind === "marker") {
      style.setProperty("--ring-color", primitive.color);
      style.setProperty("--ring-outline-color", primitive.outlineColor);
      element.textContent = "";
    } else {
      // The colours of a cue come from the style sheet.
      style.removeProperty("--ring-color");
      style.removeProperty("--ring-outline-color");
      element.textContent = primitive.label;
    }
    style.opacity = `${point.opacity}`;
    style.transform = `translate(${point.x - diameter / 2}px, ${point.y - diameter / 2}px)`;
    return true;
  }
}
