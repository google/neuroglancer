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

import { CoordinateSpaceCombiner } from "#/coordinate_transform";
import { UserLayer } from "#/layer";
import { Position } from "#/navigation_state";
import { WatchableValueInterface } from "#/trackable_value";
import { arraysEqual } from "#/util/array";
import { DataType } from "#/util/data_type";
import { HistogramSpecifications } from "#/webgl/empirical_cdf";
import { ImageInvlerpParameters } from "#/webgl/shader_ui_controls";
import { activateInvlerpTool, InvlerpWidget } from "#/widget/invlerp";
import { LayerControlFactory } from "#/widget/layer_control";
import { PositionWidget } from "#/widget/position_widget";
import { LegendShaderOptions } from "#/widget/shader_controls";

export function channelInvlerpLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    watchableValue: WatchableValueInterface<ImageInvlerpParameters>;
    dataType: DataType;
    defaultChannel: number[];
    channelCoordinateSpaceCombiner: CoordinateSpaceCombiner | undefined;
    histogramSpecifications: HistogramSpecifications;
    histogramIndex: number;
    legendShaderOptions: LegendShaderOptions | undefined;
  },
): LayerControlFactory<LayerType, InvlerpWidget> {
  return {
    makeControl: (layer, context, options) => {
      const {
        watchableValue,
        channelCoordinateSpaceCombiner,
        dataType,
        defaultChannel,
        histogramSpecifications,
        legendShaderOptions,
        histogramIndex,
      } = getter(layer);
      if (
        channelCoordinateSpaceCombiner !== undefined &&
        defaultChannel.length !== 0
      ) {
        const position = context.registerDisposer(
          new Position(channelCoordinateSpaceCombiner.combined),
        );
        const positionWidget = context.registerDisposer(
          new PositionWidget(position, channelCoordinateSpaceCombiner, {
            copyButton: false,
          }),
        );
        context.registerDisposer(
          position.changed.add(() => {
            const value = position.value;
            const newChannel = Array.from(value, (x) => Math.floor(x));
            const oldParams = watchableValue.value;
            if (!arraysEqual(oldParams.channel, newChannel)) {
              watchableValue.value = {
                ...watchableValue.value,
                channel: newChannel,
              };
            }
          }),
        );
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
      const control = context.registerDisposer(
        new InvlerpWidget(
          options.visibility,
          options.display,
          dataType,
          watchableValue,
          histogramSpecifications,
          histogramIndex,
          defaultChannel.length === 0 ? legendShaderOptions : undefined,
        ),
      );
      return { control, controlElement: control.element };
    },
    activateTool: (activation, control) => {
      activateInvlerpTool(activation, control);
    },
  };
}
