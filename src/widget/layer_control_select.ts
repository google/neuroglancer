/**
 * @license
 * Copyright 2026 Google Inc.
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
import type { ActionEvent } from "#src/util/event_action_map.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";
import { EnumSelectWidget } from "#src/widget/enum_widget.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";

const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift+wheel": { action: "adjust-via-wheel" },
});

export function selectLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    value: WatchableValueInterface<string>;
    options: string[];
  },
): LayerControlFactory<LayerType, EnumSelectWidget<number>> {
  return {
    makeControl: (layer, context) => {
      const { value, options } = getter(layer);
      const initialIndex = Math.max(0, options.indexOf(value.value));
      const trackableEnum = new TrackableEnum(
        Object.fromEntries(
          options.map((option, index) => [option.toUpperCase(), index]),
        ),
        initialIndex,
      );
      const control = context.registerDisposer(
        new EnumSelectWidget(trackableEnum),
      );
      for (const [index, option] of options.entries()) {
        const element = control.element.options.item(index);
        if (element !== null) {
          element.value = option;
          element.textContent = option;
        }
      }
      context.registerDisposer(
        value.changed.add(() => {
          const index = options.indexOf(value.value);
          if (index !== -1) {
            trackableEnum.value = index;
          }
        }),
      );
      context.registerDisposer(
        trackableEnum.changed.add(() => {
          const option = options[trackableEnum.value];
          if (option !== undefined) {
            value.value = option;
          }
        }),
      );
      return { control, controlElement: control.element };
    },
    activateTool: (activation, control) => {
      activation.bindInputEventMap(TOOL_INPUT_EVENT_MAP);
      activation.bindAction(
        "adjust-via-wheel",
        (event: ActionEvent<WheelEvent>) => {
          event.stopPropagation();
          event.preventDefault();
          control.adjustViaWheel(event.detail);
        },
      );
    },
  };
}
