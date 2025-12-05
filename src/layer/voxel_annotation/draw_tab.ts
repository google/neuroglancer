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

import { VOXEL_TAB_LAYOUT } from "#src/layer/voxel_annotation/controls.js";
import type { UserLayerWithVoxelEditing } from "#src/layer/voxel_annotation/index.js";
import { observeWatchable } from "#src/trackable_value.js";
import { makeToolButton } from "#src/ui/tool.js";
import type { VoxelEditController } from "#src/voxel_annotation/frontend.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import { addLayerControlToOptionsTab } from "#src/widget/layer_control.js";
import { Tab } from "#src/widget/tab_view.js";

export class VoxToolTab extends Tab {
  constructor(public layer: UserLayerWithVoxelEditing) {
    super();
    const { element } = this;

    const toolbox = document.createElement("div");

    for (const elementDef of VOXEL_TAB_LAYOUT) {
      if ("type" in elementDef && elementDef.type === "header") {
        const title = document.createElement("div");
        title.textContent = elementDef.label;
        title.style.fontWeight = "600";
        toolbox.appendChild(title);
      } else if ("type" in elementDef && elementDef.type === "tool-row") {
        const toolButtonsContainer = document.createElement("div");
        toolButtonsContainer.style.display = "flex";
        toolButtonsContainer.style.gap = "8px";

        for (const tool of elementDef.tools) {
          const button = makeToolButton(this, layer.toolBinder, {
            toolJson: tool.toolId,
            label: tool.label,
          });
          toolButtonsContainer.appendChild(button);
        }
        toolbox.appendChild(toolButtonsContainer);
      } else {
        const controlDef = elementDef as any;
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
                      layer.editingContexts.values().next().value
                        ?._controller ?? undefined
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

        toolbox.appendChild(controlElement);
      }
    }

    element.appendChild(toolbox);
  }
}
