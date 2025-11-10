/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { UserLayerConstructor } from "#src/layer/index.js";
import { LayerActionContext } from "#src/layer/index.js";
import type { UserLayerWithVoxelEditing } from "#src/layer/vox/index.js";
import { observeWatchable } from "#src/trackable_value.js";
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
      label: "Paint Value",
      toolJson: { type: "vox-paint-value" },
      makeControl: (layer, context) => {
        const control = document.createElement("input");
        control.type = "text";
        control.title = "Specify segment ID or intensity value to paint";
        control.addEventListener("change", () => {
          try {
            layer.setVoxelPaintValue(control.value);
          } catch {
            control.value = layer.paintValue.value.toString();
          }
        });
        context.registerDisposer(
          observeWatchable((value) => {
            control.value = value.toString();
          }, layer.paintValue),
        );
        control.value = layer.paintValue.value.toString();
        return { control, controlElement: control, parent: context };
      },
      activateTool: () => {},
    },
    {
      label: "New Random Value",
      toolJson: { type: "vox-random-value" },
      ...buttonLayerControl({
        text: "Random",
        onClick: (layer) =>
          layer.handleVoxAction(
            "randomize-paint-value",
            new LayerActionContext(),
          ),
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
