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
import { PerspectivePanel } from "#src/perspective_view/panel.js";
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { ImageRenderLayer } from "#src/sliceview/volume/image_renderlayer.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { formatScaleWithUnitAsString } from "#src/util/si_units.js";
import type { Viewer } from "#src/viewer.js";
import { VolumeRenderingRenderLayer } from "#src/volume_rendering/volume_render_layer.js";

export interface DimensionResolutionStats {
  parentType: string;
  dimensionName: string;
  resolutionWithUnit: string;
}

interface LayerIdentifier {
  name: string;
  type: string;
}

export function getViewerLayerResolutions(
  viewer: Viewer,
): Map<LayerIdentifier, DimensionResolutionStats[]> {
  function formatResolution(
    resolution: Float32Array | undefined,
    parentType: string,
  ): DimensionResolutionStats[] {
    if (resolution === undefined) return [];

    const resolution_stats: DimensionResolutionStats[] = [];
    const {
      globalDimensionNames,
      displayDimensionUnits,
      displayDimensionIndices,
    } = viewer.navigationState.displayDimensionRenderInfo.value;

    // Check if all units and factors are the same.
    const firstDim = displayDimensionIndices[0];
    let singleScale = true;
    if (firstDim !== -1) {
      const unit = displayDimensionUnits[0];
      const factor = resolution[0];
      for (let i = 1; i < 3; ++i) {
        const dim = displayDimensionIndices[i];
        if (dim === -1) continue;
        if (displayDimensionUnits[i] !== unit || factor !== resolution[i]) {
          singleScale = false;
          break;
        }
      }
    }

    for (let i = 0; i < 3; ++i) {
      const dim = displayDimensionIndices[i];
      if (dim !== -1) {
        const dimensionName = globalDimensionNames[dim];
        if (i === 0 || !singleScale) {
          const formattedScale = formatScaleWithUnitAsString(
            resolution[i],
            displayDimensionUnits[i],
            { precision: 2, elide1: false },
          );
          resolution_stats.push({
            parentType: parentType,
            resolutionWithUnit: `${formattedScale}`,
            dimensionName: singleScale ? "All_" : dimensionName,
          });
        }
      }
    }
    return resolution_stats;
  }

  const layers = viewer.layerManager.visibleRenderLayers;
  const map = new Map<LayerIdentifier, DimensionResolutionStats[]>();

  for (const layer of layers) {
    if (layer.role === RenderLayerRole.DATA) {
      let isVisble = false;
      const name = layer.userLayer!.managedLayer.name;
      let type: string = "";
      let resolution: Float32Array | undefined;
      if (layer instanceof ImageRenderLayer) {
        type = "ImageRenderLayer";
        isVisble = layer.visibleSourcesList.length > 0;
        resolution = layer.highestResolutionLoadedVoxelSize;
      } else if (layer instanceof VolumeRenderingRenderLayer) {
        type = "VolumeRenderingRenderLayer";
        isVisble = layer.visibility.visible;
        resolution = layer.highestResolutionLoadedVoxelSize;
      } else if (layer instanceof SegmentationRenderLayer) {
        type = "SegmentationRenderLayer";
        isVisble = layer.visibleSourcesList.length > 0;
        resolution = layer.highestResolutionLoadedVoxelSize;
      }
      if (!isVisble) continue;
      map.set({ name, type }, formatResolution(resolution, type));
    }
  }
  return map;
}

export function getViewerPanelResolutions(
  panels: ReadonlySet<RenderedPanel>,
): DimensionResolutionStats[][] {
  function resolutionsEqual(
    resolution1: DimensionResolutionStats[],
    resolution2: DimensionResolutionStats[],
  ) {
    if (resolution1.length !== resolution2.length) {
      return false;
    }
    for (let i = 0; i < resolution1.length; ++i) {
      if (
        resolution1[i].resolutionWithUnit !== resolution2[i].resolutionWithUnit
      ) {
        return false;
      }
      if (resolution1[i].parentType !== resolution2[i].parentType) {
        return false;
      }
      if (resolution1[i].dimensionName !== resolution2[i].dimensionName) {
        return false;
      }
    }
    return true;
  }

  const resolutions: DimensionResolutionStats[][] = [];
  for (const panel of panels) {
    if (!(panel instanceof RenderedDataPanel)) continue;
    const panel_resolution = [];
    const isOrtographicProjection =
      panel instanceof PerspectivePanel &&
      panel.viewer.orthographicProjection.value;

    const panelDimensionUnit =
      panel instanceof SliceViewPanel || isOrtographicProjection ? "px" : "vh";
    let panelType: string;
    if (panel instanceof SliceViewPanel) {
      panelType = "Slice view";
    } else if (isOrtographicProjection) {
      panelType = "Orthographic view";
    } else if (panel instanceof PerspectivePanel) {
      panelType = "Perspective view";
    } else {
      panelType = "Unknown";
    }
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
        const dimensionName = globalDimensionNames[dim];
        if (i === 0 || !singleScale) {
          const formattedScale = formatScaleWithUnitAsString(
            totalScale,
            displayDimensionUnits[i],
            { precision: 2, elide1: false },
          );
          panel_resolution.push({
            parentType: panelType,
            resolutionWithUnit: `${formattedScale}/${panelDimensionUnit}`,
            dimensionName: singleScale ? "All_" : dimensionName,
          });
        }
      }
    }
    resolutions.push(panel_resolution);
  }

  const uniqueResolutions: DimensionResolutionStats[][] = [];
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
