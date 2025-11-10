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
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { LegacyTool, registerLegacyTool } from "#src/ui/tool.js";
import { formatScaleWithUnitAsString } from "#src/util/si_units.js";

export const PIXEL_TOOL_ID = "voxPixel";

export class VoxelPixelLegacyTool extends LegacyTool<VoxUserLayer> {
  description = "pixel";
  toJSON() {
    return PIXEL_TOOL_ID;
  }
  trigger(mouseState: MouseSelectionState) {
    // Defensive runtime check: this tool is intended for VoxUserLayer only.
    if ((this.layer as any)?.constructor?.type !== 'vox') return;
    try {
      const layer = this.layer;
      const display = layer.manager.root.display;
      const panels = display.panels;
      // Compute mouse position relative to canvas
      const pageX = mouseState?.pageX ?? 0;
      const pageY = mouseState?.pageY ?? 0;
      const rect = display.canvasRect ?? display.canvas.getBoundingClientRect();
      const canvasX = pageX - rect.left;
      const canvasY = pageY - rect.top;

      // Find the RenderedDataPanel under the mouse
      let chosenPanel: RenderedDataPanel | undefined;
      for (const panel of panels) {
        if (!(panel instanceof RenderedDataPanel)) continue;
        const left = panel.canvasRelativeClippedLeft;
        const top = panel.canvasRelativeClippedTop;
        const right = left + panel.renderViewport.width;
        const bottom = top + panel.renderViewport.height;
        if (canvasX >= left && canvasX < right && canvasY >= top && canvasY < bottom) {
          chosenPanel = panel;
          break;
        }
      }
      if (!chosenPanel) {
        // Fallback: pick the first RenderedDataPanel if any
        for (const p of panels) {
          if (p instanceof RenderedDataPanel) {
            chosenPanel = p;
            break;
          }
        }
      }

      // Mouse voxel position string
      let mousePosStr = "unknown";
      const cs = mouseState?.coordinateSpace;
      const pos = mouseState?.position;
      if (mouseState?.active && cs && pos) {
        const { rank, names } = cs;
        const parts: string[] = [];
        for (let i = 0; i < rank; ++i) {
          parts.push(`${names[i]} ${Math.floor(pos[i])}`);
        }
        mousePosStr = parts.join("  ");
      }

      // Zoom and viewport scale
      let zoomStr = "n/a";
      const imageScaleParts: string[] = [];
      if (chosenPanel) {
        const nav = (chosenPanel as any).navigationState;
        const zoom = nav?.zoomFactor?.value;
        if (typeof zoom === "number" && !Number.isNaN(zoom)) {
          zoomStr = String(zoom);
        }
        const info = nav?.displayDimensionRenderInfo?.value;
        if (info) {
          const {
            displayDimensionIndices,
            displayDimensionUnits,
            globalDimensionNames,
          } = info;

          // Try to compute per-image-pixel sizes (current LOD texel size) from the SliceView.
          const panelAny = chosenPanel as any;
          const sliceView = panelAny?.sliceView;
          const minImagePixelSize = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
          if (sliceView?.visibleLayers instanceof Map) {
            for (const layerInfo of sliceView.visibleLayers.values()) {
              const visibleSources = layerInfo?.visibleSources as any[] | undefined;
              if (!Array.isArray(visibleSources)) continue;
              for (const tsource of visibleSources) {
                const evs: Float32Array | number[] | undefined = (tsource as any)?.effectiveVoxelSize;
                if (!evs) continue;
                for (let i = 0; i < 3; ++i) {
                  const v = evs[i];
                  if (typeof v === "number" && v > 0) {
                    if (v < minImagePixelSize[i]) minImagePixelSize[i] = v;
                  }
                }
              }
            }
          }

          for (let i = 0; i < 3; ++i) {
            const dim = displayDimensionIndices[i];
            if (dim === -1) continue;
            const pxSize = minImagePixelSize[i];
            if (Number.isFinite(pxSize)) {
              const formatted = formatScaleWithUnitAsString(
                pxSize,
                displayDimensionUnits[i],
                { precision: 2, elide1: false },
              );
              imageScaleParts.push(`${globalDimensionNames[dim]} ${formatted}/imgPx`);
            }
          }

          // Fallback: if we couldn't determine image pixel sizes, skip logging them.
        }
      }

      console.log(
        `Mouse: ${mousePosStr} | Zoom: ${zoomStr} | Viewport scale: ${imageScaleParts.join(", ")}`,
      );
    } catch (e) {
      console.log("[VoxelPixelLegacyTool] Error computing info:", e);
    }
  }
}

export function registerVoxelAnnotationTools() {
  registerLegacyTool(PIXEL_TOOL_ID, (layer) => new VoxelPixelLegacyTool(layer as unknown as VoxUserLayer));
}
