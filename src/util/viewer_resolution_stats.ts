/**
 * @license
 * Copyright 2024 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use viewer file except in compliance with the License.
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

import type { RenderedPanel } from "#src/display_context.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { MultiscaleMeshLayer } from "#src/mesh/frontend.js";
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { ImageRenderLayer } from "#src/sliceview/volume/image_renderlayer.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { formatScaleWithUnitAsString } from "#src/util/si_units.js";
import type { Viewer } from "#src/viewer.js";
import { VolumeRenderingRenderLayer } from "#src/volume_rendering/volume_render_layer.js";

export function getViewerLayerResolutions(
  viewer: Viewer,
): Map<[string, string], any> {
  const layers = viewer.layerManager.visibleRenderLayers;
  const panels = viewer.display.panels;
  const map = new Map();

  // Get all the layers in at least one panel.
  for (const panel of panels) {
    if (!(panel instanceof RenderedDataPanel)) continue;
  }

  for (const layer of layers) {
    //const isLayerInAnyPanel =
    if (layer.role === RenderLayerRole.DATA) {
      const layer_name = layer.userLayer!.managedLayer.name;
      if (layer instanceof ImageRenderLayer) {
        const isVisble = layer.visibleSourcesList.length > 0;
        if (!isVisble) {
          continue;
        }
        const type = "ImageRenderLayer";
        const resolution = layer.renderScaleTarget.value;
        map.set([layer_name, type], { resolution });
      } else if (layer instanceof VolumeRenderingRenderLayer) {
        const isVisble = layer.visibility.visible;
        if (!isVisble) {
          continue;
        }
        const type = "VolumeRenderingRenderLayer";
        const resolution = layer.depthSamplesTarget.value;
        map.set([layer_name, type], {
          resolution,
        });
      } else if (layer instanceof SegmentationRenderLayer) {
        const isVisble = layer.visibleSourcesList.length > 0;
        if (!isVisble) {
          continue;
        }
        const type = "SegmentationRenderLayer";
        const resolution = layer.renderScaleTarget.value;
        map.set([layer_name, type], {
          resolution,
        });
      } else if (layer instanceof MultiscaleMeshLayer) {
        const isVisble = layer.visibility.visible;
        if (!isVisble) {
          continue;
        }
        const type = "MultiscaleMeshLayer";
        const userLayer = layer.userLayer as SegmentationUserLayer;
        const resolution = userLayer.displayState.renderScaleTarget.value;
        map.set([layer_name, type], { resolution });
      }
    }
  }
  return map;
}

export function getViewerPanelResolutions(panels: ReadonlySet<RenderedPanel>) {
  function resolutionsEqual(resolution1: any[], resolution2: any[]) {
    if (resolution1.length !== resolution2.length) {
      return false;
    }
    for (let i = 0; i < resolution1.length; ++i) {
      if (resolution1[i].textContent !== resolution2[i].textContent) {
        return false;
      }
      if (resolution1[i].panelType !== resolution2[i].panelType) {
        return false;
      }
      if (resolution1[i].name !== resolution2[i].name) {
        return false;
      }
    }
    return true;
  }

  const resolutions: any[] = [];
  for (const panel of panels) {
    if (!(panel instanceof RenderedDataPanel)) continue;
    const panel_resolution = [];
    const displayDimensionUnit = panel instanceof SliceViewPanel ? "px" : "vh";
    const panelType = panel instanceof SliceViewPanel ? "Slice" : "3D";
    const { navigationState } = panel;
    const {
      displayDimensionIndices,
      canonicalVoxelFactors,
      displayDimensionUnits,
      displayDimensionScales,
      globalDimensionNames,
    } = navigationState.displayDimensionRenderInfo.value;
    const { factors } = navigationState.relativeDisplayScales.value;
    const zoom = navigationState.zoomFactor.value;
    // Check if all units and factors are the same.
    const firstDim = displayDimensionIndices[0];
    let singleScale = true;
    if (firstDim !== -1) {
      const unit = displayDimensionUnits[0];
      const factor = factors[firstDim];
      for (let i = 1; i < 3; ++i) {
        const dim = displayDimensionIndices[i];
        if (dim === -1) continue;
        if (displayDimensionUnits[i] !== unit || factors[dim] !== factor) {
          singleScale = false;
          break;
        }
      }
    }
    for (let i = 0; i < 3; ++i) {
      const dim = displayDimensionIndices[i];
      if (dim !== -1) {
        const totalScale =
          (displayDimensionScales[i] * zoom) / canonicalVoxelFactors[i];
        let textContent;
        const name = globalDimensionNames[dim];
        if (i === 0 || !singleScale) {
          const formattedScale = formatScaleWithUnitAsString(
            totalScale,
            displayDimensionUnits[i],
            { precision: 2, elide1: false },
          );
          textContent = `${formattedScale}/${displayDimensionUnit}`;
          if (singleScale) {
            panel_resolution.push({ panelType, textContent, name: "All_" });
          } else {
            panel_resolution.push({ panelType, textContent, name });
          }
        } else {
          textContent = "";
        }
      }
    }
    resolutions.push(panel_resolution);
  }

  const uniqueResolutions: any[] = [];
  for (const resolution of resolutions) {
    let found = false;
    for (const uniqueResolution of uniqueResolutions) {
      if (resolutionsEqual(resolution, uniqueResolution)) {
        found = true;
        break;
      }
    }
    if (!found) {
      uniqueResolutions.push(resolution);
    }
  }
  return uniqueResolutions;
}
