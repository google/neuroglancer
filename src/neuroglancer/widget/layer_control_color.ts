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
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {ActionEvent, EventActionMap} from 'neuroglancer/util/event_action_map';
import {vec3} from 'neuroglancer/util/geom';
import {ColorWidget} from 'neuroglancer/widget/color';
import {LayerControlFactory} from 'neuroglancer/widget/layer_control';

const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift+wheel': {action: 'adjust-hue-via-wheel'},
});

export function colorLayerControl<LayerType extends UserLayer, Color extends vec3|undefined>(
    getter: (layer: LayerType) =>
        WatchableValueInterface<Color>): LayerControlFactory<LayerType, ColorWidget<Color>> {
  return {
    makeControl: (layer, context) => {
      const value = getter(layer);
      const control = context.registerDisposer(new ColorWidget(value));
      return {control, controlElement: control.element};
    },
    activateTool: (activation, control) => {
      activation.bindInputEventMap(TOOL_INPUT_EVENT_MAP);
      activation.bindAction('adjust-via-wheel', (event: ActionEvent<WheelEvent>) => {
        event.stopPropagation();
        event.preventDefault();
        control.adjustHueViaWheel(event.detail);
      });
    },
  };
}
