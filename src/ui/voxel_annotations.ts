/**
 * @license
 * Copyright 2025.
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

import type { MouseSelectionState } from "#src/layer/index.js";
import type { VoxUserLayer } from "#src/layer/vox/index.js";
import { BrushShape } from "#src/layer/vox/index.js";
import type { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { StatusMessage } from "#src/status.js";
import { LayerTool, registerTool, type ToolActivation } from "#src/ui/tool.js";
import { vec3 } from "#src/util/geom.js";
import { EventActionMap } from "#src/util/mouse_bindings.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import { NullarySignal } from "#src/util/signal.js";

export const BRUSH_TOOL_ID = "vox-brush";
export const FLOODFILL_TOOL_ID = "vox-flood-fill";
export const ADOPT_VOXEL_LABEL_TOOL_ID = "vox-pick-label";

const VOX_TOOL_INPUT_MAP = EventActionMap.fromObject({
  ["at:control+mousedown0"]: "paint-voxels",
});

abstract class BaseVoxelTool extends LayerTool<VoxUserLayer> {
  protected latestMouseState: MouseSelectionState | null = null;

  protected getPoint(mouseState: MouseSelectionState): Int32Array | undefined {
    const vox = this.layer.getVoxelPositionFromMouse?.(mouseState) as
      | Float32Array
      | undefined;
    if (!mouseState?.active || !vox) return undefined;
    const planeNormal = mouseState?.planeNormal;
    if (!mouseState?.active || !vox || !planeNormal) return undefined;
    const CHUNK_POSITION_EPSILON = 1e-3;
    const shiftedVox = new Float32Array(3);
    for (let i = 0; i < 3; ++i) {
      shiftedVox[i] =
        vox[i] + CHUNK_POSITION_EPSILON * Math.abs(planeNormal[i]);
    }
    return new Int32Array([
      Math.floor(shiftedVox[0]),
      Math.floor(shiftedVox[1]),
      Math.floor(shiftedVox[2]),
    ]);
  }

  protected linePoints(a: Int32Array, b: Int32Array): Float32Array[] {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    const out: Float32Array[] = [];
    if (steps <= 0) return out;
    let lastX = a[0],
      lastY = a[1],
      lastZ = a[2];
    for (let s = 1; s <= steps; ++s) {
      const x = Math.round(a[0] + (dx * s) / steps);
      const y = Math.round(a[1] + (dy * s) / steps);
      const z = Math.round(a[2] + (dz * s) / steps);
      if (x !== lastX || y !== lastY || z !== lastZ) {
        out.push(new Float32Array([x, y, z]));
        lastX = x;
        lastY = y;
        lastZ = z;
      }
    }
    return out;
  }

  activate(activation: ToolActivation<this>): void {
    activation.bindInputEventMap(VOX_TOOL_INPUT_MAP);

    activation.bindAction("paint-voxels", (event) => {
      event.stopPropagation();
      this.activationCallback(activation);
        startRelativeMouseDrag(
          event.detail as MouseEvent,
          () => {
            this.latestMouseState = this.mouseState;
          },
          () => {
            this.deactivationCallback(activation);
          },
        );

        return true;
    });

  }

  abstract activationCallback(activation: ToolActivation<this>): void;
  abstract deactivationCallback(activation: ToolActivation<this>): void;

  protected setCursor(cursor: string) {
    for (const panel of this.layer.manager.root.display.panels) {
      panel.element.style.setProperty("cursor", cursor, "important");
    }
  }

  protected resetCursor() {
    for (const panel of this.layer.manager.root.display.panels) {
      panel.element.style.removeProperty("cursor");
    }
  }
}

export class VoxelBrushTool extends BaseVoxelTool {
  private isDrawing = false;
  private lastPoint: Int32Array | undefined;
  private mouseDisposer: (() => void) | undefined;
  private currentMouseState: MouseSelectionState | undefined;
  private animationFrameHandle: number | null = null;

  activate(activation: ToolActivation<this>) {
    super.activate(activation);
    const getZoom = () => {
      const panels = Array.from(this.layer.manager.root.display.panels) as RenderedDataPanel[];
      if (panels.length > 0) {
        return panels[0].navigationState.zoomFactor.value;
      }
      return 1.0;
    };

    const getZoomChangedSignal = () => {
      const panels = Array.from(this.layer.manager.root.display.panels) as RenderedDataPanel[];
      return panels.length > 0 ? panels[0].navigationState.zoomFactor.changed : new NullarySignal();
    };

    const updateCursor = () => {
      const radiusInVoxels = this.layer.voxBrushRadius.value;
      const zoom = getZoom();
      const radiusInPixels = Math.max(1, radiusInVoxels / zoom);
      const svgSize = 2 * radiusInPixels + 4;
      const svgCenter = svgSize / 2;

      const svgString = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${svgSize}" height="${svgSize}">
          <circle cx="${svgCenter}" cy="${svgCenter}" r="${radiusInPixels}" 
                  stroke="white" stroke-width="3" fill="rgba(255, 255, 255, 0.2)" />
          <circle cx="${svgCenter}" cy="${svgCenter}" r="${radiusInPixels}" 
                  stroke="black" stroke-width="1.5" fill="rgba(255, 255, 255, 0)" />
        </svg>
      `.replace(/\s\s+/g, " ");

      const cursorURL = `url('data:image/svg+xml;utf8,${encodeURIComponent(svgString)}')`;
      this.setCursor(`${cursorURL} ${svgCenter} ${svgCenter}, crosshair`)
    };

    updateCursor();
    activation.registerDisposer(this.layer.voxBrushRadius.changed.add(updateCursor));
    activation.registerDisposer(getZoomChangedSignal().add(updateCursor));
    activation.registerDisposer(() => {
      this.resetCursor();
    });
  }

  activationCallback(_activation: ToolActivation<this>): void {
    this.startDrawing(this.mouseState);
  }

  deactivationCallback(_activation: ToolActivation<this>): void {
    this.stopDrawing();
  }

  constructor(layer: VoxUserLayer) {
    super(layer, /*toggle=*/ true);
  }

  toJSON() {
    return BRUSH_TOOL_ID;
  }

  get description() {
    return "Brush tool";
  }

  private drawLoop = (): void => {
    if (!this.isDrawing) {
      this.animationFrameHandle = null;
      return;
    }
    if (this.latestMouseState === null) {
      this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
      return;
    }
    const cur = this.getPoint(this.latestMouseState);
    this.latestMouseState = null;
    if (cur) {
      const last = this.lastPoint;
      if (
        last &&
        (cur[0] !== last[0] || cur[1] !== last[1] || cur[2] !== last[2])
      ) {
        const points = this.linePoints(last, cur);
        if (points.length > 0) {
          const value = this.layer.voxLabelsManager.getCurrentLabelValue(
            this.layer.voxEraseMode.value,
          );
          this.paintPoints(points, value);
        }
      }
      this.lastPoint = cur;
    }
    this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
  };

  private startDrawing(mouseState: MouseSelectionState) {
    if (this.isDrawing) return;
    this.isDrawing = true;
    this.currentMouseState = mouseState;

    const start = this.getPoint(mouseState);
    if (!start) {
      throw new Error(
        "startDrawing: could not compute a starting voxel position from mouse",
      );
    }

    // Lock render LOD to base level during edits
    this.layer.beginRenderLodLock(0);

    const value = this.layer.voxLabelsManager.getCurrentLabelValue(
      this.layer.voxEraseMode.value,
    );

    this.paintPoints([new Float32Array([start[0], start[1], start[2]])], value);
    this.lastPoint = start;
    this.latestMouseState = mouseState;

    this.mouseDisposer = mouseState.changed.add(() => {
      this.latestMouseState = mouseState;
      this.currentMouseState = mouseState;
    });

    if (this.animationFrameHandle === null) {
      this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
    }
  }

  private stopDrawing() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.lastPoint = undefined;
    if (this.animationFrameHandle !== null) {
      cancelAnimationFrame(this.animationFrameHandle);
      this.animationFrameHandle = null;
    }
    if (this.mouseDisposer) {
      this.mouseDisposer();
      this.mouseDisposer = undefined;
    }
    try {
      this.layer.endRenderLodLock();
    } catch {
      /* ignore */
    }
  }

  private paintPoints(points: Float32Array[], value: bigint) {
    const radius = Math.max(
      1,
      Math.floor(this.layer.voxBrushRadius.value ?? 3),
    );
    const shapeEnum = this.layer.voxBrushShape.value;
    const ctrl = this.layer.voxEditController;
    let basis = undefined as undefined | { u: Float32Array; v: Float32Array };
    if (shapeEnum === BrushShape.DISK && this.currentMouseState?.planeNormal) {
      const n = this.currentMouseState.planeNormal;
      const u = vec3.create();
      const tempVec =
        Math.abs(vec3.dot(n, vec3.fromValues(1, 0, 0))) < 0.9
          ? vec3.fromValues(1, 0, 0)
          : vec3.fromValues(0, 1, 0);
      vec3.cross(u, tempVec, n);
      vec3.normalize(u, u);
      const v = vec3.cross(vec3.create(), n, u);
      vec3.normalize(v, v);
      basis = { u, v };
    }
    for (const p of points)
      ctrl?.paintBrushWithShape(p, radius, value, shapeEnum, basis);
  }
}

const floodFillSVG = `<svg width="24px" height="24px" viewBox="0 0 24 24" fill="none"
     xmlns="http://www.w3.org/2000/svg" color="#000000">
  <path d="M2.63596 10.2927L9.70703 3.22168L18.1923 11.707L11.1212 18.778C10.3402 19.5591 9.07387 19.5591 8.29282 18.778L2.63596 13.1212C1.85492 12.3401 1.85492 11.0738 2.63596 10.2927Z"
        stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8.29297 1.80762L9.70718 3.22183"
        stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path fill-rule="evenodd" clip-rule="evenodd"
        d="M19.9991 15C19.9991 15 22.9991 17.9934 22.9994 19.8865C22.9997 21.5422 21.6552 22.8865 19.9997 22.8865C18.3442 22.8865 17.012 21.5422 17 19.8865C17.0098 17.9924 19.9991 15 19.9991 15Z"
        stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

  <path d="M2.63596 10.2927L9.70703 3.22168L18.1923 11.707L11.1212 18.778C10.3402 19.5591 9.07387 19.5591 8.29282 18.778L2.63596 13.1212C1.85492 12.3401 1.85492 11.0738 2.63596 10.2927Z"
        stroke="#000000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8.29297 1.80762L9.70718 3.22183"
        stroke="#000000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path fill-rule="evenodd" clip-rule="evenodd"
        d="M19.9991 15C19.9991 15 22.9991 17.9934 22.9994 19.8865C22.9997 21.5422 21.6552 22.8865 19.9997 22.8865C18.3442 22.8865 17.012 21.5422 17 19.8865C17.0098 17.9924 19.9991 15 19.9991 15Z"
        stroke="#000000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`.replace(/\s\s+/g, " ");

const floodFillCursor = `url('data:image/svg+xml;utf8,${encodeURIComponent(floodFillSVG)}') 4 19, crosshair`;


export class VoxelFloodFillTool extends BaseVoxelTool {
  activate(activation: ToolActivation<this>) {
    super.activate(activation);
    this.setCursor(floodFillCursor);
    activation.registerDisposer(() => {this.resetCursor()})
  }

  activationCallback(_activation: ToolActivation<this>): void {
    const seed = this.getPoint(this.mouseState);
    const planeNormal = this.mouseState.planeNormal;
    if (!seed || !planeNormal) return;
    const layer = this.layer;
    try {
      layer.setDrawErrorMessage(undefined);
      const value = layer.voxLabelsManager.getCurrentLabelValue(
        layer.voxEraseMode.value,
      );
      const max = Number(layer.voxFloodMaxVoxels.value);
      if (!Number.isFinite(max) || max <= 0) {
        throw new Error("Invalid max fill voxels setting");
      }
      const ctrl = layer.voxEditController;
      if (!ctrl) throw new Error("Drawing backend not ready yet");
      ctrl
        .floodFillPlane2D(
          new Float32Array(seed),
          value,
          Math.floor(max),
          planeNormal,
        )
        .catch((e: any) =>
          layer.setDrawErrorMessage?.(String(e?.message ?? e)),
        );
    } catch (e: any) {
      layer.setDrawErrorMessage?.(String(e?.message ?? e));
    }
  }

  deactivationCallback(_activation: ToolActivation<this>): void {
    return;
  }

  constructor(layer: VoxUserLayer) {
    super(layer, /*toggle=*/ true);
  }

  toJSON() {
    return FLOODFILL_TOOL_ID;
  }

  get description() {
    return "Flood fill tool";
  }
}

export class AdoptVoxelLabelTool extends LayerTool<VoxUserLayer> {
  constructor(layer: VoxUserLayer) {
    super(layer, /*toggle=*/ false);
  }

  toJSON() {
    return ADOPT_VOXEL_LABEL_TOOL_ID;
  }

  get description() {
    return "Picking tool";
  }

  activate(_activation: ToolActivation<this>): void {
    if (!this.mouseState?.active) return;
    const layer = this.layer as VoxUserLayer;
    const pos = layer.getVoxelPositionFromMouse?.(this.mouseState);

    if (!pos || pos.length < 3) {
      StatusMessage.showTemporaryMessage(
        "Cannot pick label: position is not valid.",
        3000,
      );
      return;
    }

    const editController = layer.voxEditController;
    if (!editController) {
      StatusMessage.showTemporaryMessage(
        "Cannot pick label: layer is not ready.",
        3000,
      );
      return;
    }

    const renderLayer = layer.voxRenderLayerInstance;
    if (!renderLayer) {
      StatusMessage.showTemporaryMessage("Render layer not available.", 3000);
      return;
    }

    const visibleSources = renderLayer.visibleSourcesList;
    if (visibleSources.length === 0) {
      StatusMessage.showTemporaryMessage(
        "No data is visible at the current zoom level.",
        3000,
      );
      return;
    }

    const source = visibleSources[0].source;
    const channelAccess = editController.singleChannelAccess;

    StatusMessage.forPromise(
      source
        .getEnsuredValueAt(pos, channelAccess)
        .then((value: bigint | number | null) => {
          if (value === null) {
            throw new Error(
              "Voxel data not available at the selected position.",
            );
          }
          const label = BigInt(value);
          if (label === 0n) {
            StatusMessage.showTemporaryMessage(
              "Cannot adopt background label (0).",
              3000,
            );
            return;
          }
          layer.voxLabelsManager.addLabel(label);
          StatusMessage.showTemporaryMessage(`Adopted label: ${label}`, 3000);
        }),
      {
        initialMessage: "Picking voxel label...",
        delay: true,
        errorPrefix: "Error picking label: ",
      },
    );
  }
}

export function registerVoxelTools(LayerCtor: any) {
  registerTool(LayerCtor, BRUSH_TOOL_ID, (layer: VoxUserLayer) => new VoxelBrushTool(layer));
  registerTool(LayerCtor, FLOODFILL_TOOL_ID, (layer: VoxUserLayer) => new VoxelFloodFillTool(layer));
  registerTool(LayerCtor, ADOPT_VOXEL_LABEL_TOOL_ID, (layer: VoxUserLayer) => new AdoptVoxelLabelTool(layer));
}
