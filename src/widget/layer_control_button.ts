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

import type { UserLayer } from "#src/layer/index.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";

export function buttonLayerControl<LayerType extends UserLayer>(options: {
  text: string;
  onClick: (layer: LayerType) => void;
}): LayerControlFactory<LayerType, HTMLButtonElement> {
  return {
    makeControl: (layer, context) => {
      const control = document.createElement("button");
      control.textContent = options.text;
      context.registerEventListener(control, "click", () =>
        options.onClick(layer),
      );
      return { control, controlElement: control };
    },
    activateTool: (activation) => {
      options.onClick(activation.tool.layer as LayerType);
    },
  };
}
