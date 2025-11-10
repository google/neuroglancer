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
import { LegacyTool, registerLegacyTool } from "#src/ui/tool.js";

export const PIXEL_TOOL_ID = "voxPixel";
export const BRUSH_TOOL_ID = "voxBrush";

abstract class BaseVoxelLegacyTool extends LegacyTool<VoxUserLayer> {
  protected isDrawing = false;
  protected lastPoint: Int32Array | undefined;
  protected mouseDisposer: (() => void) | undefined;
  protected onMouseUp = () => this.stopDrawing();
  protected currentMouseState: MouseSelectionState | undefined;

  protected getPoint(mouseState: MouseSelectionState): Int32Array | undefined {
    const vox = (this.layer as any).getVoxelPositionFromMouse?.(mouseState) as
      | Float32Array
      | undefined;
    if (!mouseState?.active || !vox) return undefined;
    return new Int32Array([
      Math.floor(vox[0]),
      Math.floor(vox[1]),
      Math.floor(vox[2]),
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

  protected abstract paintPoint(point: Float32Array, value: number): void;
  protected abstract paintPoints(points: Float32Array[], value: number): void;

  protected startDrawing(mouseState: MouseSelectionState) {
    if (this.isDrawing) return;
    this.isDrawing = true;
    this.currentMouseState = mouseState;
    const value = (this.layer as any).getCurrentLabelValue?.() ?? ((this.layer as any).voxEraseMode ? 0 : 42);
    const start = this.getPoint(mouseState);
    if (start) {
      this.paintPoint(new Float32Array([start[0], start[1], start[2]]), value);
      this.lastPoint = start;
    }

    this.mouseDisposer = mouseState.changed.add(() => {
      if (!this.isDrawing) return;
      this.currentMouseState = mouseState;
      const cur = this.getPoint(mouseState);
      if (!cur) return;
      const last = this.lastPoint;
      if (!last) {
        this.paintPoint(new Float32Array([cur[0], cur[1], cur[2]]), value);
        this.lastPoint = cur;
        return;
      }
      if (cur[0] === last[0] && cur[1] === last[1] && cur[2] === last[2])
        return;
      const points = this.linePoints(last, cur);
      if (points.length > 0) {
        this.paintPoints(points, value);
      }
      this.lastPoint = cur;
    });
    window.addEventListener("mouseup", this.onMouseUp, { once: true });
  }

  protected stopDrawing() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.lastPoint = undefined;
    if (this.mouseDisposer) {
      this.mouseDisposer();
      this.mouseDisposer = undefined;
    }
  }

  trigger(mouseState: MouseSelectionState) {
    if ((this.layer as any)?.constructor?.type !== "vox") return;
    try {
      this.startDrawing(mouseState);
    } catch (e) {
      console.log(`[${this.constructor.name}] Error:`, e);
    }
  }

  deactivate() {
    this.stopDrawing();
  }
}

export class VoxelPixelLegacyTool extends BaseVoxelLegacyTool {
  description = "pixel";

  toJSON() {
    return PIXEL_TOOL_ID;
  }

  protected paintPoint(point: Float32Array, value: number) {
    (this.layer as any).voxEditController?.paintVoxelsBatch([point], value);
  }

  protected paintPoints(points: Float32Array[], value: number) {
    (this.layer as any).voxEditController?.paintVoxelsBatch(points, value);
  }
}

export class VoxelBrushLegacyTool extends BaseVoxelLegacyTool {
  description = "brush";

  toJSON() {
    return BRUSH_TOOL_ID;
  }

  protected paintPoint(point: Float32Array, value: number) {
    const radius = Math.max(
      1,
      Math.floor((this.layer as any).voxBrushRadius ?? 3),
    );
    const shape =
      (this.layer as any).voxBrushShape === "sphere" ? "sphere" : "disk";
    const basis = shape === "disk" ? (this.layer as any).getBrushPlaneBasis?.(this.currentMouseState) : undefined;
    (this.layer as any).voxEditController?.paintBrushWithShape(
      point,
      radius,
      value,
      shape,
      basis,
    );
  }

  protected paintPoints(points: Float32Array[], value: number) {
    const radius = Math.max(
      1,
      Math.floor((this.layer as any).voxBrushRadius ?? 3),
    );
    const shape =
      (this.layer as any).voxBrushShape === "sphere" ? "sphere" : "disk";
    const ctrl = (this.layer as any).voxEditController;
    const basis = shape === "disk" ? (this.layer as any).getBrushPlaneBasis?.(this.currentMouseState) : undefined;
    for (const point of points) {
      ctrl?.paintBrushWithShape(point, radius, value, shape, basis);
    }
  }
}

export function registerVoxelAnnotationTools() {
  registerLegacyTool(
    PIXEL_TOOL_ID,
    (layer) => new VoxelPixelLegacyTool(layer as unknown as VoxUserLayer),
  );
  registerLegacyTool(
    BRUSH_TOOL_ID,
    (layer) => new VoxelBrushLegacyTool(layer as unknown as VoxUserLayer),
  );
}
