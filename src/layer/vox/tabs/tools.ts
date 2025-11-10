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

import { VOXEL_LAYER_CONTROLS } from "#src/layer/vox/controls.js";
import type { UserLayerWithVoxelEditing } from "#src/layer/vox/index.js";
import { observeWatchable } from "#src/trackable_value.js";
import { makeToolButton } from "#src/ui/tool.js";
import {
  ADOPT_VOXEL_LABEL_TOOL_ID,
  BRUSH_TOOL_ID,
  FLOODFILL_TOOL_ID,
} from "#src/ui/voxel_annotations.js";
import { DataType } from "#src/util/data_type.js";
import type { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";
import type { LabelsManager } from "#src/voxel_annotation/labels.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import { addLayerControlToOptionsTab } from "#src/widget/layer_control.js";
import { Tab } from "#src/widget/tab_view.js";

function formatUnsignedId(id: bigint, dataType: DataType): string {
  if (id >= 0n) {
    return id.toString();
  }
  // Handle two's complement representation for negative BigInts.
  if (dataType === DataType.UINT32) {
    return ((1n << 32n) + id).toString();
  }
  if (dataType === DataType.UINT64) {
    return ((1n << 64n) + id).toString();
  }
  return id.toString();
}

export class VoxToolTab extends Tab {
  constructor(public layer: UserLayerWithVoxelEditing) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-vox-tools-tab");

    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-vox-toolbox";

    const toolsRow = document.createElement("div");
    toolsRow.className = "neuroglancer-vox-row";
    const toolsTitle = document.createElement("div");
    toolsTitle.textContent = "Tools";
    toolsTitle.style.fontWeight = "600";
    toolsRow.appendChild(toolsTitle);

    const toolButtonsContainer = document.createElement("div");
    toolButtonsContainer.style.display = "flex";
    toolButtonsContainer.style.gap = "8px";

    const brushButton = makeToolButton(this, layer.toolBinder, {
      toolJson: { type: BRUSH_TOOL_ID },
      label: "Brush",
    });

    const floodFillButton = makeToolButton(this, layer.toolBinder, {
      toolJson: { type: FLOODFILL_TOOL_ID },
      label: "Flood Fill",
    });

    const pickButton = makeToolButton(this, layer.toolBinder, {
      toolJson: { type: ADOPT_VOXEL_LABEL_TOOL_ID },
      label: "Seg Picker",
    });

    toolButtonsContainer.appendChild(brushButton);
    toolButtonsContainer.appendChild(floodFillButton);
    toolButtonsContainer.appendChild(pickButton);
    toolsRow.appendChild(toolButtonsContainer);
    toolbox.appendChild(toolsRow);

    for (const controlDef of VOXEL_LAYER_CONTROLS) {
      const controlElement = addLayerControlToOptionsTab(
        this,
        this.layer,
        this.visibility,
        controlDef,
      );

      if (
        controlDef.toolJson.type === "vox:undo" ||
        controlDef.toolJson.type === "vox:redo"
      ) {
        const button = controlElement.querySelector("button");
        if (button) {
          this.registerDisposer(
            new DependentViewWidget(
              {
                changed: this.layer.layersChanged,
                get value() {
                  return layer.editingContexts.values().next().value.controller;
                },
              },
              (
                controller: VoxelEditController | undefined,
                _parent,
                context,
              ) => {
                if (!controller) {
                  button.disabled = true;
                  return;
                }
                const watchable =
                  controlDef.toolJson.type === "vox:undo"
                    ? controller.undoCount
                    : controller.redoCount;
                context.registerDisposer(
                  observeWatchable((count) => {
                    button.disabled = count === 0;
                  }, watchable),
                );
              },
              this.visibility,
            ),
          );
        }
      }

      toolbox.appendChild(controlElement);
    }

    const labelsSection = document.createElement("div");
    labelsSection.style.display = "flex";
    labelsSection.style.flexDirection = "column";
    labelsSection.style.gap = "6px";
    labelsSection.style.marginTop = "8px";

    const labelsTitle = document.createElement("div");
    labelsTitle.textContent = "Labels";
    labelsTitle.style.fontWeight = "600";

    const labelsWidget = this.registerDisposer(
      new DependentViewWidget(
        {
          changed: this.layer.labelsChanged,
          get value() {
            return layer.voxLabelsManager;
          },
        },
        (labelsManager: LabelsManager | undefined, parent) => {
          if (labelsManager === undefined) return;

          const list = document.createElement("div");
          list.className = "neuroglancer-vox-labels";
          list.style.display = "flex";
          list.style.flexDirection = "column";
          list.style.gap = "4px";
          list.style.maxHeight = "180px";
          list.style.overflowY = "auto";

          for (const label of labelsManager.labels) {
            const row = document.createElement("div");
            row.className = "neuroglancer-vox-label-row";
            row.style.display = "grid";
            row.style.gridTemplateColumns = "16px 1fr";
            row.style.alignItems = "center";
            row.style.gap = "8px";

            const swatch = document.createElement("div");
            swatch.style.width = "16px";
            swatch.style.height = "16px";
            swatch.style.borderRadius = "3px";
            swatch.style.border = "1px solid rgba(0,0,0,0.2)";
            swatch.style.background = labelsManager.colorForValue(label);

            const text = document.createElement("div");
            text.textContent = formatUnsignedId(label, labelsManager.dataType);
            text.style.fontFamily = "monospace";
            text.style.whiteSpace = "nowrap";
            text.style.overflow = "hidden";
            text.style.textOverflow = "ellipsis";

            row.appendChild(swatch);
            row.appendChild(text);

            if (label === labelsManager.selectedLabelId) {
              row.style.background = "rgba(100,150,255,0.15)";
              row.style.outline = "1px solid rgba(100,150,255,0.6)";
            }
            row.style.cursor = "pointer";
            row.style.padding = "2px 4px";
            row.style.borderRadius = "4px";
            row.addEventListener("click", () => {
              labelsManager.selectVoxLabel(label);
            });

            list.appendChild(row);
          }

          if (labelsManager.labelsError) {
            const errorDiv = document.createElement("div");
            errorDiv.className = "neuroglancer-vox-labels-error";
            errorDiv.style.color = "#b00020";
            errorDiv.style.fontSize = "12px";
            errorDiv.style.whiteSpace = "pre-wrap";
            errorDiv.textContent = labelsManager.labelsError;
            parent.appendChild(errorDiv);
          }

          parent.appendChild(list);
        },
        this.visibility,
      ),
    );

    labelsSection.appendChild(labelsTitle);
    labelsSection.appendChild(labelsWidget.element);
    toolbox.appendChild(labelsSection);

    const drawErrorContainer = document.createElement("div");
    drawErrorContainer.className = "neuroglancer-vox-draw-error";
    drawErrorContainer.style.color = "#b00020";
    drawErrorContainer.style.fontSize = "12px";
    drawErrorContainer.style.whiteSpace = "pre-wrap";
    drawErrorContainer.style.marginTop = "8px";
    drawErrorContainer.style.display = "none";
    toolbox.appendChild(drawErrorContainer);

    this.layer.onDrawMessageChanged = () => {
      const msg = this.layer.voxDrawErrorMessage;
      if (msg && msg.length > 0) {
        drawErrorContainer.textContent = msg;
        drawErrorContainer.style.display = "block";
      } else {
        drawErrorContainer.textContent = "";
        drawErrorContainer.style.display = "none";
      }
    };
    this.layer.onDrawMessageChanged();

    element.appendChild(toolbox);
  }
}
