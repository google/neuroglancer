/**
 * @license
 * Copyright 2024 Google Inc.
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
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { ColormapParameters } from "#src/webgl/shader_ui_controls.js";
import { ColormapWidget } from "#src/widget/colormap_legend.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";

export function colormapLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    watchableValue: WatchableValueInterface<ColormapParameters>;
  },
): LayerControlFactory<LayerType, ColormapWidget> {
  return {
    makeControl: (layer, context) => {
      const { watchableValue } = getter(layer);
      const control = context.registerDisposer(
        new ColormapWidget(watchableValue),
      );
      return { control, controlElement: control.element };
    },
    activateTool: () => {
      // No interactive tool: the colormap selection is changed via the dropdown.
    },
  };
}
