import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import * as json_keys from "#src/layer/segmentation/json_keys.js";
import type { LayerControlDefinition } from "#src/widget/layer_control.js";
import { registerLayerControl } from "#src/widget/layer_control.js";
import { checkboxLayerControl } from "#src/widget/layer_control_checkbox.js";
import { enumLayerControl } from "#src/widget/layer_control_enum.js";
import { rangeLayerControl } from "#src/widget/layer_control_range.js";
import { renderScaleLayerControl } from "#src/widget/render_scale_widget.js";
import {
  colorSeedLayerControl,
  fixedColorLayerControl,
} from "#src/widget/segmentation_color_mode.js";

export const LAYER_CONTROLS: LayerControlDefinition<SegmentationUserLayer>[] = [
  {
    label: "Color seed",
    title: "Color segments based on a hash of their id",
    toolJson: json_keys.COLOR_SEED_JSON_KEY,
    ...colorSeedLayerControl(),
  },
  {
    label: "Fixed color",
    title:
      "Use a fixed color for all segments without an explicitly-specified color",
    toolJson: json_keys.SEGMENT_DEFAULT_COLOR_JSON_KEY,
    ...fixedColorLayerControl(),
  },
  {
    label: "Saturation",
    toolJson: json_keys.SATURATION_JSON_KEY,
    title: "Saturation of segment colors",
    ...rangeLayerControl((layer) => ({ value: layer.displayState.saturation })),
  },
  {
    label: "Opacity (on)",
    toolJson: json_keys.SELECTED_ALPHA_JSON_KEY,
    isValid: (layer) => layer.has2dLayer,
    title: "Opacity in cross-section views of segments that are selected",
    ...rangeLayerControl((layer) => ({
      value: layer.displayState.selectedAlpha,
    })),
  },
  {
    label: "Opacity (off)",
    toolJson: json_keys.NOT_SELECTED_ALPHA_JSON_KEY,
    isValid: (layer) => layer.has2dLayer,
    title: "Opacity in cross-section views of segments that are not selected",
    ...rangeLayerControl((layer) => ({
      value: layer.displayState.notSelectedAlpha,
    })),
  },
  {
    label: "Resolution (slice)",
    toolJson: json_keys.CROSS_SECTION_RENDER_SCALE_JSON_KEY,
    isValid: (layer) => layer.has2dLayer,
    ...renderScaleLayerControl((layer) => ({
      histogram: layer.sliceViewRenderScaleHistogram,
      target: layer.sliceViewRenderScaleTarget,
    })),
  },
  {
    label: "Resolution (mesh)",
    toolJson: json_keys.MESH_RENDER_SCALE_JSON_KEY,
    isValid: (layer) => layer.has3dLayer,
    ...renderScaleLayerControl((layer) => ({
      histogram: layer.displayState.renderScaleHistogram,
      target: layer.displayState.renderScaleTarget,
    })),
  },
  {
    label: "Opacity (3d)",
    toolJson: json_keys.OBJECT_ALPHA_JSON_KEY,
    isValid: (layer) => layer.has3dLayer,
    title: "Opacity of meshes and skeletons",
    ...rangeLayerControl((layer) => ({
      value: layer.displayState.objectAlpha,
    })),
  },
  {
    label: "Silhouette (3d)",
    toolJson: json_keys.MESH_SILHOUETTE_RENDERING_JSON_KEY,
    isValid: (layer) => layer.has3dLayer,
    title:
      "Set to a non-zero value to increase transparency of object faces perpendicular to view direction",
    ...rangeLayerControl((layer) => ({
      value: layer.displayState.silhouetteRendering,
      options: { min: 0, max: maxSilhouettePower, step: 0.1 },
    })),
  },
  {
    label: "Hide segment ID 0",
    toolJson: json_keys.HIDE_SEGMENT_ZERO_JSON_KEY,
    title: "Disallow selection and display of segment id 0",
    ...checkboxLayerControl((layer) => layer.displayState.hideSegmentZero),
  },
  {
    label: "Base segment coloring",
    toolJson: json_keys.BASE_SEGMENT_COLORING_JSON_KEY,
    title: "Color base segments individually",
    ...checkboxLayerControl((layer) => layer.displayState.baseSegmentColoring),
  },
  {
    label: "Show all by default",
    title: "Show all segments if none are selected",
    toolJson: json_keys.IGNORE_NULL_VISIBLE_SET_JSON_KEY,
    ...checkboxLayerControl((layer) => layer.displayState.ignoreNullVisibleSet),
  },
  {
    label: "Highlight on hover",
    toolJson: json_keys.HOVER_HIGHLIGHT_JSON_KEY,
    title: "Highlight the segment under the mouse pointer",
    ...checkboxLayerControl((layer) => layer.displayState.hoverHighlight),
  },
  ...getViewSpecificSkeletonRenderingControl("2d"),
  ...getViewSpecificSkeletonRenderingControl("3d"),
];

const maxSilhouettePower = 10;

function getViewSpecificSkeletonRenderingControl(
  viewName: "2d" | "3d",
): LayerControlDefinition<SegmentationUserLayer>[] {
  return [
    {
      label: `Skeleton mode (${viewName})`,
      toolJson: `${json_keys.SKELETON_RENDERING_JSON_KEY}.mode${viewName}`,
      isValid: (layer) => layer.hasSkeletonsLayer,
      ...enumLayerControl(
        (layer) =>
          layer.displayState.skeletonRenderingOptions[
            `params${viewName}` as const
          ].mode,
      ),
    },
    {
      label: `Line width (${viewName})`,
      toolJson: `${json_keys.SKELETON_RENDERING_JSON_KEY}.lineWidth${viewName}`,
      isValid: (layer) => layer.hasSkeletonsLayer,
      toolDescription: `Skeleton line width (${viewName})`,
      title: `Skeleton line width (${viewName})`,
      ...rangeLayerControl((layer) => ({
        value:
          layer.displayState.skeletonRenderingOptions[
            `params${viewName}` as const
          ].lineWidth,
        options: { min: 1, max: 40, step: 1 },
      })),
    },
  ];
}

export function registerLayerControls(layerType: typeof SegmentationUserLayer) {
  for (const control of LAYER_CONTROLS) {
    registerLayerControl(layerType, control);
  }
}
