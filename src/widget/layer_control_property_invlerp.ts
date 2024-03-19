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

import type { UserLayer } from "#src/layer/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { makeCachedDerivedWatchableValue } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import {
  convertDataTypeInterval,
  defaultDataTypeRange,
  normalizeDataTypeInterval,
} from "#src/util/lerp.js";
import type { HistogramSpecifications } from "#src/webgl/empirical_cdf.js";
import type {
  InvlerpParameters,
  PropertiesSpecification,
  PropertyInvlerpParameters,
} from "#src/webgl/shader_ui_controls.js";
import {
  activateInvlerpTool,
  VariableDataTypeInvlerpWidget,
} from "#src/widget/invlerp.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";
import type { LegendShaderOptions } from "#src/widget/shader_controls.js";

export function propertyInvlerpLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    watchableValue: WatchableValueInterface<PropertyInvlerpParameters>;
    properties: PropertiesSpecification;
    histogramSpecifications: HistogramSpecifications;
    histogramIndex: number;
    legendShaderOptions: LegendShaderOptions | undefined;
  },
): LayerControlFactory<LayerType, VariableDataTypeInvlerpWidget> {
  return {
    makeControl: (layer, context, options) => {
      const {
        watchableValue,
        properties,
        histogramSpecifications,
        legendShaderOptions,
        histogramIndex,
      } = getter(layer);
      {
        const propertySelectElement = document.createElement("select");
        for (const [property, dataType] of properties) {
          const optionElement = document.createElement("option");
          optionElement.textContent = `${property} (${DataType[
            dataType
          ].toLowerCase()})`;
          optionElement.value = property;
          propertySelectElement.appendChild(optionElement);
        }
        const updateModel = () => {
          const property = propertySelectElement.value;
          const dataType = properties.get(property)!;
          const { window, range } = watchableValue.value;
          watchableValue.value = {
            window:
              window !== undefined
                ? convertDataTypeInterval(window, dataType)
                : undefined,
            range:
              range !== undefined
                ? convertDataTypeInterval(range, dataType)
                : undefined,
            property,
            dataType,
          };
        };
        const updateView = () => {
          propertySelectElement.value = watchableValue.value.property;
        };
        context.registerEventListener(
          propertySelectElement,
          "change",
          updateModel,
        );
        context.registerDisposer(watchableValue.changed.add(updateView));
        updateView();
        options.labelContainer.appendChild(propertySelectElement);
      }
      const derivedWatchableValue = {
        changed: watchableValue.changed,
        get value(): InvlerpParameters {
          let { dataType, window, range } = watchableValue.value;
          if (range === undefined) {
            range = defaultDataTypeRange[dataType];
          }
          return {
            window: normalizeDataTypeInterval(window ?? range),
            range,
          };
        },
        set value(newValue: InvlerpParameters) {
          const { window, range } = newValue;
          watchableValue.value = { ...watchableValue.value, window, range };
        },
      };
      const derivedDataTypeWatchable = makeCachedDerivedWatchableValue(
        (p) => p.dataType,
        [watchableValue],
      );
      const control = context.registerDisposer(
        new VariableDataTypeInvlerpWidget(
          options.visibility,
          options.display,
          derivedDataTypeWatchable,
          derivedWatchableValue,
          histogramSpecifications,
          histogramIndex,
          legendShaderOptions,
        ),
      );
      return { control, controlElement: control.element };
    },
    activateTool: (activation, control) => {
      activateInvlerpTool(activation, control);
    },
  };
}
