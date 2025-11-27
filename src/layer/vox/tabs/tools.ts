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
  SEG_PICKER_TOOL_ID,
  BRUSH_TOOL_ID,
  FLOODFILL_TOOL_ID,
} from "#src/ui/voxel_annotations.js";
import type { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import { addLayerControlToOptionsTab } from "#src/widget/layer_control.js";
import { Tab } from "#src/widget/tab_view.js";

export class VoxToolTab extends Tab {
  constructor(public layer: UserLayerWithVoxelEditing) {
    super();
    const { element } = this;

    const toolbox = document.createElement("div");

    const toolsRow = document.createElement("div");
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
      toolJson: { type: SEG_PICKER_TOOL_ID },
      label: "Seg Picker",
    });

    toolButtonsContainer.appendChild(brushButton);
    toolButtonsContainer.appendChild(floodFillButton);
    toolButtonsContainer.appendChild(pickButton);
    toolsRow.appendChild(toolButtonsContainer);
    toolbox.appendChild(toolsRow);

    const settingsTitle = document.createElement("div");
    settingsTitle.textContent = "Settings";
    settingsTitle.style.fontWeight = "600";
    toolbox.appendChild(settingsTitle);

    for (const controlDef of VOXEL_LAYER_CONTROLS) {
      const controlElement = addLayerControlToOptionsTab(
        this,
        this.layer,
        this.visibility,
        controlDef,
      );

      if (
        controlDef.toolJson.type === "vox-undo" ||
        controlDef.toolJson.type === "vox-redo"
      ) {
        const button = controlElement.querySelector("button");
        if (button) {
          this.registerDisposer(
            new DependentViewWidget(
              {
                changed: this.layer.layersChanged,
                get value() {
                  return (
                    layer.editingContexts.values().next().value?._controller ??
                    undefined
                  );
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
                  controlDef.toolJson.type === "vox-undo"
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

      if (controlDef.toolJson.type === "vox-undo") {
        const actionsTitle = document.createElement("div");
        actionsTitle.textContent = "Actions";
        actionsTitle.style.fontWeight = "600";
        toolbox.appendChild(actionsTitle);
      }

      toolbox.appendChild(controlElement);
    }

    element.appendChild(toolbox);
  }
}
