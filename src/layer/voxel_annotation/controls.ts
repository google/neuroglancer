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
import type {
  UserLayerWithVoxelEditing,
  VoxelEditingContext,
} from "#src/layer/voxel_annotation/index.js";
import type { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { observeWatchable } from "#src/trackable_value.js";
import { mat3, vec3 } from "#src/util/geom.js";
import {
  BRUSH_TOOL_ID,
  FLOODFILL_TOOL_ID,
  getBasisFromNormal,
  SEG_PICKER_TOOL_ID,
} from "#src/voxel_annotation/base.js";
import type { LayerControlDefinition } from "#src/widget/layer_control.js";
import { registerLayerControl } from "#src/widget/layer_control.js";
import { buttonLayerControl } from "#src/widget/layer_control_button.js";
import { checkboxLayerControl } from "#src/widget/layer_control_checkbox.js";
import { enumLayerControl } from "#src/widget/layer_control_enum.js";
import { rangeLayerControl } from "#src/widget/layer_control_range.js";

export function getEditingContext(
  layer: UserLayerWithVoxelEditing,
): VoxelEditingContext | undefined {
  const it = layer.editingContexts.values();
  let ctx: VoxelEditingContext;
  while ((ctx = it.next().value) !== undefined) {
    if (ctx.writingEnabled) return ctx;
  }
  return undefined;
}

export function drawBrushCursor(
  layer: UserLayerWithVoxelEditing,
  panel: RenderedDataPanel,
  ctx: CanvasRenderingContext2D,
) {
  const context = getEditingContext(layer);
  if (context === undefined || !(panel instanceof SliceViewPanel)) {
    return;
  }

  const { projectionParameters } = panel.sliceView;
  const { displayDimensionRenderInfo, viewMatrix } = projectionParameters.value;
  const { displayRank } = displayDimensionRenderInfo;

  if (displayRank < 2) {
    return;
  }

  const chunkTransform = context.getChunkTransform();
  if (!chunkTransform) {
    return;
  }
  const { chunkToLayerTransform, layerRank } = chunkTransform;
  const { globalToRenderLayerDimensions } = chunkTransform.modelTransform;
  const stride = layerRank + 1;

  const n_world =
    projectionParameters.value.viewportNormalInCanonicalCoordinates;
  const n_chunk = context.transformGlobalToVoxelNormal(n_world);

  const { u: u_chunk, v: v_chunk } = getBasisFromNormal(n_chunk);

  const radius = layer.brushRadius.value - 0.5;
  vec3.scale(u_chunk, u_chunk, radius);
  vec3.scale(v_chunk, v_chunk, radius);

  const chunkToCam3 = mat3.create();

  // manually creating chunkToCam3 matrix to avoid any unwanted scaling
  for (let row = 0; row < 3; ++row) {
    for (let col = 0; col < 3; ++col) {
      let sum = 0;
      for (let globalDim = 0; globalDim < 3; ++globalDim) {
        const layerDim = globalToRenderLayerDimensions[globalDim];
        if (layerDim !== -1) {
          const viewVal = viewMatrix[globalDim * 4 + row];
          const layerVal = chunkToLayerTransform[col * stride + layerDim];
          sum += viewVal * layerVal;
        }
      }
      chunkToCam3[col * 3 + row] = sum;
    }
  }

  const u_cam = vec3.create();
  const v_cam = vec3.create();
  vec3.transformMat3(u_cam, u_chunk, chunkToCam3);
  vec3.transformMat3(v_cam, v_chunk, chunkToCam3);

  const u_scr_x = u_cam[0];
  const u_scr_y = u_cam[1];
  const v_scr_x = v_cam[0];
  const v_scr_y = v_cam[1];

  const Q11 = u_scr_x * u_scr_x + v_scr_x * v_scr_x;
  const Q12 = u_scr_x * u_scr_y + v_scr_x * v_scr_y;
  const Q22 = u_scr_y * u_scr_y + v_scr_y * v_scr_y;

  const trace = Q11 + Q22;
  const det = Q11 * Q22 - Q12 * Q12;

  const D_sq = trace * trace - 4 * det;
  const D = D_sq < 0 ? 0 : Math.sqrt(D_sq);

  const lambda1 = (trace + D) / 2;
  const lambda2 = (trace - D) / 2;

  const radiusX = Math.sqrt(lambda1);
  const radiusY = Math.sqrt(lambda2);

  const rotation = Math.atan2(lambda1 - Q11, Q12);

  if (radiusX > 0 && radiusY > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(
      panel.mouseX,
      panel.mouseY,
      radiusX,
      radiusY,
      rotation,
      0,
      2 * Math.PI,
    );
    ctx.restore();

    const isEraser = layer.shouldErase();
    const color = "white";
    ctx.fillStyle = isEraser ? "red" : color;
    ctx.globalAlpha = 0.2;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = isEraser ? "rgb(255,136,136)" : "rgba(255, 255, 255, 1)";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = isEraser ? "rgb(97,0,0)" : "rgba(0, 0, 0, 1)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

export type VoxelTabElement =
  | { type: "header"; label: string }
  | { type: "tool-row"; tools: { toolId: string; label: string }[] }
  | LayerControlDefinition<UserLayerWithVoxelEditing>;

const TOOL_SPECIFIC_CONTROLS: LayerControlDefinition<UserLayerWithVoxelEditing>[] =
  [
    {
      label: "Brush size",
      toolJson: { type: "vox-brush-size" },
      ...(() => {
        const control = rangeLayerControl(
          (layer: UserLayerWithVoxelEditing) => ({
            value: layer.brushRadius,
            options: { min: 1, max: 64, step: 1 },
          }),
        );
        return {
          ...control,
          activateTool: (activation, _controlContext) => {
            const layer = activation.tool.layer as UserLayerWithVoxelEditing;
            const trigger = () => {
              for (const panel of layer.manager.root.display.panels) {
                if (panel instanceof SliceViewPanel) {
                  panel.scheduleOverlayRedraw();
                }
              }
            };

            trigger();
            activation.registerDisposer(
              layer.manager.root.layerSelectedValues.mouseState.changed.add(
                trigger,
              ),
            );
            activation.registerDisposer(layer.brushRadius.changed.add(trigger));
            activation.registerDisposer(() => {
              trigger();
            });
          },
        };
      })(),
    },
    {
      label: "Brush shape",
      toolJson: { type: "vox-brush-shape" },
      ...enumLayerControl(
        (layer: UserLayerWithVoxelEditing) => layer.brushShape,
      ),
    },
    {
      label: "Max fill voxels",
      toolJson: { type: "vox-flood-max-voxels" },
      ...rangeLayerControl((layer) => ({
        value: layer.floodMaxVoxels,
        options: { min: 1, max: 1000000, step: 1000 },
      })),
    },
  ];

const COMMON_CONTROLS: VoxelTabElement[] = [
  { type: "header", label: "Settings" },
  {
    label: "Erase only selected value",
    toolJson: { type: "vox-erase-mode" },
    ...checkboxLayerControl((layer) => layer.lockToSelectedValue),
  },
  { type: "header", label: "Actions" },
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

export const VOXEL_LAYER_CONTROLS: LayerControlDefinition<UserLayerWithVoxelEditing>[] =
  [...TOOL_SPECIFIC_CONTROLS, ...COMMON_CONTROLS].filter(
    (x): x is LayerControlDefinition<UserLayerWithVoxelEditing> =>
      !("type" in x) || (x.type !== "header" && x.type !== "tool-row"),
  );

export const VOXEL_TAB_LAYOUT: VoxelTabElement[] = [
  { type: "header", label: "Tools" },
  {
    type: "tool-row",
    tools: [
      { toolId: BRUSH_TOOL_ID, label: "Brush" },
      { toolId: FLOODFILL_TOOL_ID, label: "Flood Fill" },
      { toolId: SEG_PICKER_TOOL_ID, label: "Seg Picker" },
    ],
  },
  ...COMMON_CONTROLS,
];

export function registerVoxelLayerControls(
  layerType: UserLayerConstructor<UserLayerWithVoxelEditing>,
) {
  for (const control of VOXEL_LAYER_CONTROLS) {
    registerLayerControl(layerType, control);
  }
}
