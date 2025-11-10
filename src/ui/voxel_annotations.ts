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

export class VoxelPixelLegacyTool extends LegacyTool<VoxUserLayer> {
  description = "pixel";
  private isDrawing = false;
  private lastVoxel: Int32Array | undefined;
  private mouseDisposer: (() => void) | undefined;
  private onMouseUp = () => this.stopDrawing();

  toJSON() {
    return PIXEL_TOOL_ID;
  }

  private getVoxel(mouseState: MouseSelectionState): Int32Array | undefined {
    const vox = (this.layer as any).getVoxelPositionFromMouse?.(mouseState) as Float32Array | undefined;
    if (!mouseState?.active || !vox) return undefined;
    return new Int32Array([Math.floor(vox[0]), Math.floor(vox[1]), Math.floor(vox[2])]);
  }

  private lineVoxels(a: Int32Array, b: Int32Array): Float32Array[] {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    const out: Float32Array[] = [];
    if (steps <= 0) return out;
    let lastX = a[0], lastY = a[1], lastZ = a[2];
    for (let s = 1; s <= steps; ++s) {
      const x = Math.round(a[0] + (dx * s) / steps);
      const y = Math.round(a[1] + (dy * s) / steps);
      const z = Math.round(a[2] + (dz * s) / steps);
      if (x !== lastX || y !== lastY || z !== lastZ) {
        out.push(new Float32Array([x, y, z]));
        lastX = x; lastY = y; lastZ = z;
      }
    }
    return out;
  }

  private startDrawing(mouseState: MouseSelectionState) {
    if (this.isDrawing) return;
    this.isDrawing = true;
    const start = this.getVoxel(mouseState);
    const value = (this.layer as any).voxEraseMode ? 0 : 42;
    if (start) {
      (this.layer as any).voxEditController?.paintVoxel(new Float32Array([start[0], start[1], start[2]]), value);
      this.lastVoxel = start;
    }
    // Subscribe to mouse moves to continue drawing.
    this.mouseDisposer = mouseState.changed.add(() => {
      if (!this.isDrawing) return;
      const cur = this.getVoxel(mouseState);
      if (!cur) return;
      const last = this.lastVoxel;
      if (!last) {
        (this.layer as any).voxEditController?.paintVoxel(new Float32Array([cur[0], cur[1], cur[2]]), value);
        this.lastVoxel = cur;
        return;
      }
      if (cur[0] === last[0] && cur[1] === last[1] && cur[2] === last[2]) return;
      const voxels = this.lineVoxels(last, cur);
      if (voxels.length > 0) {
        (this.layer as any).voxEditController?.paintVoxelsBatch(voxels, value);
      }
      this.lastVoxel = cur;
    });
    window.addEventListener('mouseup', this.onMouseUp, { once: true });
  }

  private stopDrawing() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.lastVoxel = undefined;
    if (this.mouseDisposer) {
      this.mouseDisposer();
      this.mouseDisposer = undefined;
    }
  }

  trigger(mouseState: MouseSelectionState) {
    if ((this.layer as any)?.constructor?.type !== 'vox') return;
    try {
      this.startDrawing(mouseState);
    } catch (e) {
      console.log('[VoxelPixelLegacyTool] Error computing voxel position:', e);
    }
  }

  deactivate() {
    this.stopDrawing();
  }
}

export class VoxelBrushLegacyTool extends LegacyTool<VoxUserLayer> {
  description = "brush";
  private isDrawing = false;
  private lastCenter: Int32Array | undefined;
  private mouseDisposer: (() => void) | undefined;
  private onMouseUp = () => this.stopDrawing();

  toJSON() {
    return BRUSH_TOOL_ID;
  }

  private getCenter(mouseState: MouseSelectionState): Int32Array | undefined {
    const vox = (this.layer as any).getVoxelPositionFromMouse?.(mouseState) as Float32Array | undefined;
    if (!mouseState?.active || !vox) return undefined;
    return new Int32Array([Math.floor(vox[0]), Math.floor(vox[1]), Math.floor(vox[2])]);
  }

  private lineCenters(a: Int32Array, b: Int32Array): Float32Array[] {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    const out: Float32Array[] = [];
    if (steps <= 0) return out;
    let lastX = a[0], lastY = a[1], lastZ = a[2];
    for (let s = 1; s <= steps; ++s) {
      const x = Math.round(a[0] + (dx * s) / steps);
      const y = Math.round(a[1] + (dy * s) / steps);
      const z = Math.round(a[2] + (dz * s) / steps);
      if (x !== lastX || y !== lastY || z !== lastZ) {
        out.push(new Float32Array([x, y, z]));
        lastX = x; lastY = y; lastZ = z;
      }
    }
    return out;
  }

  private startDrawing(mouseState: MouseSelectionState) {
    if (this.isDrawing) return;
    this.isDrawing = true;
    const radius = Math.max(1, Math.floor((this.layer as any).voxBrushRadius ?? 3));
    const value = (this.layer as any).voxEraseMode ? 0 : 42;
    const shape = ((this.layer as any).voxBrushShape === 'sphere') ? 'sphere' : 'disk';

    const start = this.getCenter(mouseState);
    if (start) {
      (this.layer as any).voxEditController?.paintBrushWithShape(new Float32Array([start[0], start[1], start[2]]), radius, value, shape);
      this.lastCenter = start;
    }

    this.mouseDisposer = mouseState.changed.add(() => {
      if (!this.isDrawing) return;
      const cur = this.getCenter(mouseState);
      if (!cur) return;
      const last = this.lastCenter;
      if (!last) {
        (this.layer as any).voxEditController?.paintBrushWithShape(new Float32Array([cur[0], cur[1], cur[2]]), radius, value, shape);
        this.lastCenter = cur;
        return;
      }
      if (cur[0] === last[0] && cur[1] === last[1] && cur[2] === last[2]) return;
      const centers = this.lineCenters(last, cur);
      if (centers.length > 0) {
        // Stamp the brush along the path. To minimize uploads, we can aggregate all voxels, but keep it simple by calling per center.
        const ctrl = (this.layer as any).voxEditController;
        for (const c of centers) {
          ctrl?.paintBrushWithShape(c, radius, value, shape);
        }
      }
      this.lastCenter = cur;
    });
    window.addEventListener('mouseup', this.onMouseUp, { once: true });
  }

  private stopDrawing() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.lastCenter = undefined;
    if (this.mouseDisposer) {
      this.mouseDisposer();
      this.mouseDisposer = undefined;
    }
  }

  trigger(mouseState: MouseSelectionState) {
    if ((this.layer as any)?.constructor?.type !== 'vox') return;
    try {
      this.startDrawing(mouseState);
    } catch (e) {
      console.log('[VoxelBrushLegacyTool] Error:', e);
    }
  }

  deactivate() {
    this.stopDrawing();
  }
}

export function registerVoxelAnnotationTools() {
  registerLegacyTool(PIXEL_TOOL_ID, (layer) => new VoxelPixelLegacyTool(layer as unknown as VoxUserLayer));
  registerLegacyTool(BRUSH_TOOL_ID, (layer) => new VoxelBrushLegacyTool(layer as unknown as VoxUserLayer));
}
