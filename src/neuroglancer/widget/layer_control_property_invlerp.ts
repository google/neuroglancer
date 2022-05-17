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

import {UserLayer} from 'neuroglancer/layer';
import {makeCachedDerivedWatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {DataType} from 'neuroglancer/util/data_type';
import {convertDataTypeInterval, defaultDataTypeRange, normalizeDataTypeInterval} from 'neuroglancer/util/lerp';
import {HistogramSpecifications} from 'neuroglancer/webgl/empirical_cdf';
import {InvlerpParameters, PropertiesSpecification, PropertyInvlerpParameters} from 'neuroglancer/webgl/shader_ui_controls';
import {activateInvlerpTool, VariableDataTypeInvlerpWidget} from 'neuroglancer/widget/invlerp';
import {LayerControlFactory} from 'neuroglancer/widget/layer_control';
import {LegendShaderOptions} from 'neuroglancer/widget/shader_controls';

export function propertyInvlerpLayerControl<LayerType extends UserLayer>(
    getter: (layer: LayerType) => {
      watchableValue: WatchableValueInterface<PropertyInvlerpParameters>,
      properties: PropertiesSpecification,
      histogramSpecifications: HistogramSpecifications,
      histogramIndex: number,
      legendShaderOptions: LegendShaderOptions | undefined,
    }): LayerControlFactory<LayerType, VariableDataTypeInvlerpWidget> {
  return {
    makeControl: (layer, context, options) => {
      const {
        watchableValue,
        properties,
        histogramSpecifications,
        legendShaderOptions,
        histogramIndex
      } = getter(layer);
      {
        const propertySelectElement = document.createElement('select');
        for (const [property, dataType] of properties) {
          const optionElement = document.createElement('option');
          optionElement.textContent = `${property} (${DataType[dataType].toLowerCase()})`;
          optionElement.value = property;
          propertySelectElement.appendChild(optionElement);
        }
        const updateModel = () => {
          const property = propertySelectElement.value;
          const dataType = properties.get(property)!;
          const {window, range} = watchableValue.value;
          watchableValue.value = {
            window: window !== undefined ? convertDataTypeInterval(window, dataType) : undefined,
            range: range !== undefined ? convertDataTypeInterval(range, dataType) : undefined,
            property,
            dataType
          };
        };
        const updateView = () => {
          propertySelectElement.value = watchableValue.value.property;
        };
        context.registerEventListener(propertySelectElement, 'change', updateModel);
        context.registerDisposer(watchableValue.changed.add(updateView));
        updateView();
        options.labelContainer.appendChild(propertySelectElement);
      }
      const derivedWatchableValue = {
        changed: watchableValue.changed,
        get value(): InvlerpParameters {
          let {dataType, window, range} = watchableValue.value;
          if (range === undefined) {
            range = defaultDataTypeRange[dataType];
          }
          return {
            window: normalizeDataTypeInterval(window ?? range),
            range,
          };
        },
        set value(newValue: InvlerpParameters) {
          const {window, range} = newValue;
          watchableValue.value = {...watchableValue.value, window, range};
        }
      };
      const derivedDataTypeWatchable = makeCachedDerivedWatchableValue(p => p.dataType, [watchableValue]);
      const control = context.registerDisposer(new VariableDataTypeInvlerpWidget(
          options.visibility, options.display, derivedDataTypeWatchable, derivedWatchableValue,
          histogramSpecifications, histogramIndex, legendShaderOptions));
      return {control, controlElement: control.element};
    },
    activateTool: (activation, control) => {
      activateInvlerpTool(activation, control);
    },
  };
}
