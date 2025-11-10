import type { UserLayerConstructor } from "#src/layer/index.js";
import { LayerActionContext } from "#src/layer/index.js";
import type { UserLayerWithVoxelEditing } from "#src/layer/vox/index.js";
import type { LayerControlDefinition } from "#src/widget/layer_control.js";
import { registerLayerControl } from "#src/widget/layer_control.js";
import { buttonLayerControl } from "#src/widget/layer_control_button.js";
import { checkboxLayerControl } from "#src/widget/layer_control_checkbox.js";
import { enumLayerControl } from "#src/widget/layer_control_enum.js";
import { rangeLayerControl } from "#src/widget/layer_control_range.js";

export const VOXEL_LAYER_CONTROLS: LayerControlDefinition<UserLayerWithVoxelEditing>[] =
  [
    {
      label: "Brush size",
      toolJson: { type: "vox-brush-size" },
      ...rangeLayerControl((layer) => ({
        value: layer.voxBrushRadius,
        options: { min: 1, max: 64, step: 1 },
      })),
    },
    {
      label: "Eraser",
      toolJson: { type: "vox-erase-mode" },
      ...checkboxLayerControl((layer) => layer.voxEraseMode),
    },
    {
      label: "Brush shape",
      toolJson: { type: "vox-brush-shape" },
      ...enumLayerControl(
        (layer: UserLayerWithVoxelEditing) => layer.voxBrushShape,
      ),
    },
    {
      label: "Max fill voxels",
      toolJson: { type: "vox-flood-max-voxels" },
      ...rangeLayerControl((layer) => ({
        value: layer.voxFloodMaxVoxels,
        options: { min: 1, max: 1000000, step: 1000 },
      })),
    },
    {
      label: "Undo",
      toolJson: { type: "vox-undo" },
      ...buttonLayerControl({
        text: "Undo",
        onClick: (layer) =>
          layer.handleVoxAction("undo", new LayerActionContext()),
      }),
    },
    {
      label: "Redo",
      toolJson: { type: "vox-redo" },
      ...buttonLayerControl({
        text: "Redo",
        onClick: (layer) =>
          layer.handleVoxAction("redo", new LayerActionContext()),
      }),
    },
    {
      label: "New label",
      toolJson: { type: "vox-new-label" },
      ...buttonLayerControl({
        text: "New Label",
        onClick: (layer) =>
          layer.handleVoxAction("new-label", new LayerActionContext()),
      }),
    },
  ];

export function registerVoxelLayerControls(
  layerType: UserLayerConstructor<UserLayerWithVoxelEditing>,
) {
  for (const control of VOXEL_LAYER_CONTROLS) {
    registerLayerControl(layerType, control);
  }
}
