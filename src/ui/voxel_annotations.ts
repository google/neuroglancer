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
  toJSON() {
    return PIXEL_TOOL_ID;
  }

  trigger(mouseState: MouseSelectionState) {
    if ((this.layer as any)?.constructor?.type !== 'vox') return;
    try {
      const vox = (this.layer as any).getVoxelPositionFromMouse?.(mouseState) as Float32Array | undefined;
      if (!mouseState?.active || !vox) return;
      const vx = Math.floor(vox[0]);
      const vy = Math.floor(vox[1]);
      const vz = Math.floor(vox[2]);
      (this.layer as any).voxEditController?.paintVoxel(new Float32Array([vx, vy, vz]), 42);
    } catch (e) {
      console.log('[VoxelPixelLegacyTool] Error computing voxel position:', e);
    }
  }
}

export class VoxelBrushLegacyTool extends LegacyTool<VoxUserLayer> {
  description = "brush";
  radius = 3;
  toJSON() {
    return BRUSH_TOOL_ID;
  }

  trigger(mouseState: MouseSelectionState) {
    if ((this.layer as any)?.constructor?.type !== 'vox') return;
    try {
      const vox = (this.layer as any).getVoxelPositionFromMouse?.(mouseState) as Float32Array | undefined;
      if (!mouseState?.active || !vox) return;
      const cx = Math.floor(vox[0]);
      const cy = Math.floor(vox[1]);
      const cz = Math.floor(vox[2]);
      (this.layer as any).voxEditController?.paintBrush(new Float32Array([cx, cy, cz]), this.radius, 42);
    } catch (e) {
      console.log('[VoxelBrushLegacyTool] Error:', e);
    }
  }
}

export function registerVoxelAnnotationTools() {
  registerLegacyTool(PIXEL_TOOL_ID, (layer) => new VoxelPixelLegacyTool(layer as unknown as VoxUserLayer));
  registerLegacyTool(BRUSH_TOOL_ID, (layer) => new VoxelBrushLegacyTool(layer as unknown as VoxUserLayer));
}
