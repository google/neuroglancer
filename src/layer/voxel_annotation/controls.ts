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
import type { UserLayerWithVoxelEditing } from "#src/layer/voxel_annotation/index.js";
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { observeWatchable } from "#src/trackable_value.js";
import { mat3, vec3 } from "#src/util/geom.js";
import {
  BRUSH_TOOL_ID,
  FLOODFILL_TOOL_ID,
  SEG_PICKER_TOOL_ID,
} from "#src/voxel_annotation/base.js";
import type { LayerControlDefinition } from "#src/widget/layer_control.js";
import { registerLayerControl } from "#src/widget/layer_control.js";
import { buttonLayerControl } from "#src/widget/layer_control_button.js";
import { checkboxLayerControl } from "#src/widget/layer_control_checkbox.js";
import { enumLayerControl } from "#src/widget/layer_control_enum.js";
import { rangeLayerControl } from "#src/widget/layer_control_range.js";

export function getActivePanel(
  layer: UserLayerWithVoxelEditing,
): RenderedDataPanel | undefined {
  let activePanel: RenderedDataPanel | undefined;
  for (const panel of layer.manager.root.display.panels) {
    if (panel instanceof RenderedDataPanel) {
      if (panel.mouseX !== -1 && panel instanceof SliceViewPanel) {
        activePanel = panel;
      } else {
        panel.clearOverlay();
      }
    }
  }
  return activePanel;
}

export function updateBrushOutline(layer: UserLayerWithVoxelEditing) {
  const panel = getActivePanel(layer);
  if (!panel || !(panel instanceof SliceViewPanel)) {
    if (panel) panel.clearOverlay();
    return;
  }

  const { projectionParameters } = panel.sliceView;
  const { displayDimensionRenderInfo, viewMatrix } = projectionParameters.value;
  const { canonicalVoxelFactors, displayRank } = displayDimensionRenderInfo;

  if (displayRank < 2) {
    panel.clearOverlay();
    return;
  }

  const radiusInVoxels = layer.voxBrushRadius.value;

  const n_canonical =
    projectionParameters.value.viewportNormalInCanonicalCoordinates;

  const canonicalVoxelFactorsVec3 = vec3.fromValues(
    canonicalVoxelFactors[0],
    canonicalVoxelFactors[1],
    canonicalVoxelFactors[2],
  );

  // Convert to voxel coordinates by dividing by canonical voxel factors.
  const n_vox = vec3.create();
  vec3.divide(n_vox, n_canonical as vec3, canonicalVoxelFactorsVec3);
  vec3.normalize(n_vox, n_vox);

  // Create an orthonormal basis for the plane in voxel coordinates
  const u_vox = vec3.create();
  const tempVec = vec3.fromValues(1, 0, 0);
  if (Math.abs(vec3.dot(n_vox, tempVec)) > 0.999) {
    vec3.set(tempVec, 0, 1, 0);
  }
  vec3.cross(u_vox, n_vox, tempVec);
  vec3.normalize(u_vox, u_vox);

  const v_vox = vec3.cross(vec3.create(), n_vox, u_vox);

  // Scale basis vectors by radius to get two orthogonal radius vectors of the brush circle
  // in voxel coordinates.
  vec3.scale(u_vox, u_vox, radiusInVoxels);
  vec3.scale(v_vox, v_vox, radiusInVoxels);

  const u_cam = vec3.create();
  const v_cam = vec3.create();
  // The viewMatrix transforms from world/voxel space to camera space.
  // We use a mat3 to only apply rotation and scaling, not translation.
  const viewMatrix3 = mat3.fromMat4(mat3.create(), viewMatrix);

  // Transform voxel-space vectors directly to camera-space vectors.
  // This avoids the double-scaling error.
  vec3.transformMat3(u_cam, u_vox, viewMatrix3);
  vec3.transformMat3(v_cam, v_vox, viewMatrix3);

  // The x, y components of these vectors are conjugate semi-diameters of the ellipse on screen.
  const u_scr_x = u_cam[0];
  const u_scr_y = u_cam[1];
  const v_scr_x = v_cam[0];
  const v_scr_y = v_cam[1];

  // From the conjugate semi-diameters, compute the ellipse parameters (radii and rotation).
  // We analyze the quadratic form matrix Q = A * A^T where A = [[u_scr_x, v_scr_x], [u_scr_y, v_scr_y]].
  const Q11 = u_scr_x * u_scr_x + v_scr_x * v_scr_x;
  const Q12 = u_scr_x * u_scr_y + v_scr_x * v_scr_y;
  const Q22 = u_scr_y * u_scr_y + v_scr_y * v_scr_y;

  const trace = Q11 + Q22;
  const det = Q11 * Q22 - Q12 * Q12;

  // Eigenvalues are roots of lambda^2 - trace*lambda + det = 0
  const D_sq = trace * trace - 4 * det;
  const D = D_sq < 0 ? 0 : Math.sqrt(D_sq);

  const lambda1 = (trace + D) / 2;
  const lambda2 = (trace - D) / 2;

  const radiusX = Math.sqrt(lambda1);
  const radiusY = Math.sqrt(lambda2);

  // Eigenvector for lambda1 is proportional to [Q12, lambda1 - Q11]
  const rotation = Math.atan2(lambda1 - Q11, Q12);

  panel.drawBrushCursor(
    panel.mouseX,
    panel.mouseY,
    radiusX,
    radiusY,
    rotation,
    "white",
    layer.shouldErase(),
  );
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
            value: layer.voxBrushRadius,
            options: { min: 1, max: 64, step: 1 },
          }),
        );
        const originalActivateTool = control.activateTool;
        return {
          ...control,
          activateTool: (activation, controlContext) => {
            originalActivateTool(activation, controlContext as any);

            const layer = activation.tool.layer as UserLayerWithVoxelEditing;
            const updateCursor = () => {
              updateBrushOutline(layer);
            };

            updateCursor();
            activation.registerDisposer(
              layer.manager.root.layerSelectedValues.mouseState.changed.add(
                updateCursor,
              ),
            );
            activation.registerDisposer(
              layer.voxBrushRadius.changed.add(updateCursor),
            );
            activation.registerDisposer(() => {
              getActivePanel(layer)?.clearOverlay();
            });
          },
        };
      })(),
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
  ];

const COMMON_CONTROLS: VoxelTabElement[] = [
  { type: "header", label: "Settings" },
  {
    label: "Eraser (selected value)",
    toolJson: { type: "vox-erase-selected-mode" },
    ...checkboxLayerControl((layer) => layer.voxEraseSelectedMode),
  },
  {
    label: "Eraser (everything)",
    toolJson: { type: "vox-erase-mode" },
    ...checkboxLayerControl((layer) => layer.voxEraseMode),
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
