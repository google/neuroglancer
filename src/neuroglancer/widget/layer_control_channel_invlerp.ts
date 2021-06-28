/**
 * @license
 * Copyright 2019 Google Inc.
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

import {CoordinateSpaceCombiner} from 'neuroglancer/coordinate_transform';
import {UserLayer} from 'neuroglancer/layer';
import {Position} from 'neuroglancer/navigation_state';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual} from 'neuroglancer/util/array';
import {DataType} from 'neuroglancer/util/data_type';
import {EventActionMap} from 'neuroglancer/util/event_action_map';
import {dataTypeIntervalEqual} from 'neuroglancer/util/lerp';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {getWheelZoomAmount} from 'neuroglancer/util/wheel_zoom';
import {HistogramSpecifications} from 'neuroglancer/webgl/empirical_cdf';
import {InvlerpParameters} from 'neuroglancer/webgl/shader_ui_controls';
import {adjustInvlerpBrightnessContrast, adjustInvlerpContrast, invertInvlerpRange, InvlerpWidget} from 'neuroglancer/widget/invlerp';
import {LayerControlFactory} from 'neuroglancer/widget/layer_control';
import {PositionWidget} from 'neuroglancer/widget/position_widget';
import {LegendShaderOptions} from 'neuroglancer/widget/shader_controls';

const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift+wheel': {action: 'adjust-contrast-via-wheel'},
  'at:shift+mousedown0': {action: 'adjust-via-drag'},
  'at:shift+mousedown2': {action: 'invert-range'},
});

export function channelInvlerpLayerControl<LayerType extends UserLayer>(
    getter: (layer: LayerType) => {
      watchableValue: WatchableValueInterface<InvlerpParameters>,
      dataType: DataType,
      defaultChannel: number[],
      channelCoordinateSpaceCombiner: CoordinateSpaceCombiner | undefined,
      histogramSpecifications: HistogramSpecifications,
      histogramIndex: number,
      legendShaderOptions: LegendShaderOptions | undefined,
    }): LayerControlFactory<LayerType, InvlerpWidget> {
  return {
    makeControl: (layer, context, options) => {
      const {
        watchableValue,
        channelCoordinateSpaceCombiner,
        dataType,
        defaultChannel,
        histogramSpecifications,
        legendShaderOptions,
        histogramIndex
      } = getter(layer);
      if (channelCoordinateSpaceCombiner !== undefined && defaultChannel.length !== 0) {
        const position =
            context.registerDisposer(new Position(channelCoordinateSpaceCombiner.combined));
        const positionWidget = context.registerDisposer(
            new PositionWidget(position, channelCoordinateSpaceCombiner, {copyButton: false}));
        context.registerDisposer(position.changed.add(() => {
          const value = position.value;
          const newChannel = Array.from(value, x => Math.floor(x));
          const oldParams = watchableValue.value;
          if (!arraysEqual(oldParams.channel, newChannel)) {
            watchableValue.value = {...watchableValue.value, channel: newChannel};
          }
        }));
        const updatePosition = () => {
          const value = position.value;
          const params = watchableValue.value;
          if (!arraysEqual(value, params.channel)) {
            value.set(params.channel);
            position.changed.dispatch();
          }
        };
        updatePosition();
        context.registerDisposer(watchableValue.changed.add(updatePosition));
        options.labelContainer.appendChild(positionWidget.element);
      }
      const control = context.registerDisposer(new InvlerpWidget(
          options.visibility, options.display, dataType, watchableValue, histogramSpecifications,
          histogramIndex, defaultChannel.length === 0 ? legendShaderOptions : undefined));
      return {control, controlElement: control.element};
    },
    activateTool: (activation, control) => {
      activation.bindInputEventMap(TOOL_INPUT_EVENT_MAP);
      activation.bindAction<WheelEvent>('adjust-contrast-via-wheel', event => {
        event.stopPropagation();
        const zoomAmount = getWheelZoomAmount(event.detail);
        adjustInvlerpContrast(control.dataType, control.trackable, zoomAmount);
      });
      activation.bindAction<MouseEvent>('adjust-via-drag', event => {
        event.stopPropagation();
        let baseScreenX = event.detail.screenX, baseScreenY = event.detail.screenY;
        let baseRange = control.trackable.value.range;
        let prevRange = baseRange;
        let prevScreenX = baseScreenX, prevScreenY = baseScreenY;
        startRelativeMouseDrag(event.detail, newEvent => {
          const curRange = control.trackable.value.range;
          const curScreenX = newEvent.screenX, curScreenY = newEvent.screenY;
          if (!dataTypeIntervalEqual(control.dataType, curRange, prevRange)) {
            baseRange = curRange;
            baseScreenX = prevScreenX;
            baseScreenY = prevScreenY;
          }
          adjustInvlerpBrightnessContrast(
              control.dataType, control.trackable, baseRange,
              (curScreenY - baseScreenY) * 2 / screen.height,
              (curScreenX - baseScreenX) * 4 / screen.width);
          prevRange = control.trackable.value.range;
          prevScreenX = curScreenX;
          prevScreenY = curScreenY;
        });
      });
      activation.bindAction('invert-range', event => {
        event.stopPropagation();
        invertInvlerpRange(control.trackable);
      });
    },
  };
}
