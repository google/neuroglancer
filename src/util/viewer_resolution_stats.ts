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
 *
 * @file Helper functions to get the resolution of the viewer layers and panels.
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

export interface PanelViewport {
  left: number;
  right: number;
  top: number;
  bottom: number;
  panelType: string;
}

interface CanvasSizeStatistics {
  totalRenderPanelViewport: PanelViewport;
  individualRenderPanelViewports: PanelViewport[];
}

/**
 * For each visible data layer, returns the resolution of the voxels
 * in physical units for the most detailed resolution of the data for
 * which any data is actually loaded.
 *
 * The resolution is for loaded data, so may be lower than the resolution requested
 * for the layer, such as when there are memory constraints.
 *
 * The key for the returned map is the layer name and type.
 * A single layer name can have multiple types, such as ImageRenderLayer and
 * VolumeRenderingRenderLayer from the same named layer.
 *
 * As the dimensions of the voxels can be the same in each dimension, the
 * function will return a single resolution if all dimensions in the layer are the
 * same, with the name "All_". Otherwise, it will return the resolution for
 * each dimension, with the name of the dimension as per the global viewer dim names.
 */
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

/**
 * For each viewer panel, returns the scale in each dimension for that panel.
 *
 * It is quite common for all dimensions to have the same scale, so the function
 * will return a single resolution for a panel if all dimensions in the panel are
 * the same, with the name "All_". Otherwise, it will return the resolution for
 * each dimension, with the name of the dimension as per the global dimension names.
 *
 * For orthographic projections or slice views, the scale is in pixels, otherwise it is in vh.
 *
 * @param panels The set of panels to get the resolutions for. E.g. viewer.display.panels
 * @param onlyUniqueResolutions If true, only return panels with unique resolutions.
 * It is quite common for all slice view panels to have the same resolution.
 *
 * @returns An array of resolutions for each panel.
 */
export function getViewerPanelResolutions(
  panels: ReadonlySet<RenderedPanel>,
  onlyUniqueResolutions = true,
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
    const {
      panelType,
      panelDimensionUnit,
    }: { panelType: string; panelDimensionUnit: string } =
      determinePanelTypeAndUnit(panel);
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

  if (!onlyUniqueResolutions) {
    return resolutions;
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

function determinePanelTypeAndUnit(panel: RenderedDataPanel) {
  const isOrtographicProjection =
    panel instanceof PerspectivePanel &&
    panel.viewer.orthographicProjection.value;

  const panelDimensionUnit =
    panel instanceof SliceViewPanel || isOrtographicProjection ? "px" : "vh";
  let panelType: string;
  if (panel instanceof SliceViewPanel) {
    panelType = "Slice view (2D)";
  } else if (isOrtographicProjection) {
    panelType = "Orthographic projection (3D)";
  } else if (panel instanceof PerspectivePanel) {
    panelType = "Perspective projection (3D)";
  } else {
    panelType = "Unknown";
  }
  return { panelType, panelDimensionUnit };
}

/**
 * Calculates the viewport bounds of the viewer render data panels individually.
 * And also calculates the total viewport bounds of all the render data panels combined.
 *
 * The total bounds can contain some non-panel areas, such as the layer bar if
 * the panels have been duplicated so that the layer bar sits in the middle
 * of the visible rendered panels.
 */
export function calculatePanelViewportBounds(
  panels: ReadonlySet<RenderedPanel>,
): CanvasSizeStatistics {
  const viewportBounds = {
    left: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
    panelType: "All",
  };
  const allPanelViewports: PanelViewport[] = [];
  for (const panel of panels) {
    if (!(panel instanceof RenderedDataPanel)) continue;
    const viewport = panel.renderViewport;
    const { width, height } = viewport;
    const panelLeft = panel.canvasRelativeClippedLeft;
    const panelTop = panel.canvasRelativeClippedTop;
    const panelRight = panelLeft + width;
    const panelBottom = panelTop + height;
    viewportBounds.left = Math.min(viewportBounds.left, panelLeft);
    viewportBounds.right = Math.max(viewportBounds.right, panelRight);
    viewportBounds.top = Math.min(viewportBounds.top, panelTop);
    viewportBounds.bottom = Math.max(viewportBounds.bottom, panelBottom);

    allPanelViewports.push({
      left: panelLeft,
      right: panelRight,
      top: panelTop,
      bottom: panelBottom,
      panelType: determinePanelTypeAndUnit(panel).panelType,
    });
  }
  return {
    totalRenderPanelViewport: viewportBounds,
    individualRenderPanelViewports: allPanelViewports,
  };
}
