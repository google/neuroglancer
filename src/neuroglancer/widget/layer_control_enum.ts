/**
 * @license
 * Copyright 2021 Google Inc.
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

import {UserLayer} from 'neuroglancer/layer';
import {ActionEvent, EventActionMap} from 'neuroglancer/util/event_action_map';
import {TrackableEnum} from 'neuroglancer/util/trackable_enum';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {LayerControlFactory} from 'neuroglancer/widget/layer_control';

const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift+wheel': {action: 'adjust-via-wheel'},
});

export function enumLayerControl<LayerType extends UserLayer, T extends number>(
    getter: (layer: LayerType) =>
        TrackableEnum<T>): LayerControlFactory<LayerType, EnumSelectWidget<T>> {
  return {
    makeControl: (layer, context) => {
      const value = getter(layer);
      const control = context.registerDisposer(new EnumSelectWidget(value));
      return {control, controlElement: control.element};
    },
    activateTool: (activation, control) => {
      activation.bindInputEventMap(TOOL_INPUT_EVENT_MAP);
      activation.bindAction('adjust-via-wheel', (event: ActionEvent<WheelEvent>) => {
        event.stopPropagation();
        event.preventDefault();
        control.adjustViaWheel(event.detail);
      });
    },
  };
}
