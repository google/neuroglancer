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

import './layer_control.css';

import {DisplayContext} from 'neuroglancer/display_context';
import {UserLayer, UserLayerConstructor} from 'neuroglancer/layer';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {makeToolActivationStatusMessageWithHeader, registerLayerTool, Tool, ToolActivation, ToolBindingWidget} from 'neuroglancer/ui/tool';
import {RefCounted} from 'neuroglancer/util/disposable';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {DependentViewWidget} from 'neuroglancer/widget/dependent_view_widget';

export interface LayerControlLabelOptions<LayerType extends UserLayer = UserLayer> {
  label: string;
  title?: string;
  toolDescription?: string;
  toolJson: any;
  isValid?: (layer: LayerType) => WatchableValueInterface<boolean>;
}

export interface LayerControlFactory<LayerType extends UserLayer, ControlType = unknown> {
  makeControl: (layer: LayerType, context: RefCounted, options: {
    labelContainer: HTMLElement,
    labelTextContainer: HTMLElement,
    display: DisplayContext,
    visibility: WatchableVisibilityPriority
  }) => {
    control: ControlType, controlElement: HTMLElement,
  };
  activateTool:
      (activation: ToolActivation<LayerControlTool<LayerType>>, control: ControlType) => void;
}

export interface LayerControlDefinition<LayerType extends UserLayer, ControlType = unknown> extends
    LayerControlLabelOptions<LayerType>, LayerControlFactory<LayerType, ControlType> {}

function makeControl<LayerType extends UserLayer>(
    context: RefCounted, layer: LayerType, options: LayerControlDefinition<LayerType>,
    visibility: WatchableVisibilityPriority) {
  const controlContainer = document.createElement('label');
  controlContainer.classList.add('neuroglancer-layer-control-container');
  const labelContainer = document.createElement('div');
  labelContainer.classList.add('neuroglancer-layer-control-label-container');
  const label = document.createElement('div');
  label.classList.add('neuroglancer-layer-control-label');
  labelContainer.appendChild(label);
  const labelTextContainer = document.createElement('div');
  labelTextContainer.classList.add('neuroglancer-layer-control-label-text-container');
  labelTextContainer.appendChild(document.createTextNode(options.label));
  label.appendChild(labelTextContainer);
  if (options.title) {
    label.title = options.title;
  }
  controlContainer.appendChild(labelContainer);

  const {control, controlElement} = options.makeControl(
      layer, context,
      {labelContainer, labelTextContainer, display: layer.manager.root.display, visibility});
  controlElement.classList.add('neuroglancer-layer-control-control');
  controlContainer.appendChild(controlElement);
  return {controlContainer, label, labelContainer, labelTextContainer, control};
}

export class LayerControlTool<LayerType extends UserLayer = UserLayer> extends Tool<LayerType> {
  constructor(layer: LayerType, public options: LayerControlDefinition<LayerType>) {
    super(layer);
  }
  activate(activation: ToolActivation<this>) {
    const {options} = this;
    const {layer} = this;
    const {isValid} = options;
    if (isValid !== undefined && !isValid(layer).value) return;
    const {header, body} = makeToolActivationStatusMessageWithHeader(activation);
    const {controlContainer, control, labelContainer} = makeControl(
        activation, layer, options,
        new WatchableVisibilityPriority(WatchableVisibilityPriority.VISIBLE));
    header.appendChild(labelContainer);
    body.appendChild(controlContainer);
    options.activateTool(activation, control);
  }
  get description() {
    const {options} = this;
    return options.toolDescription ?? options.label;
  }
  toJSON() {
    return this.options.toolJson;
  }
}

function makeLayerControlToOptionsTab<LayerType extends UserLayer>(
    context: RefCounted, layer: LayerType, options: LayerControlDefinition<LayerType>,
    visibility: WatchableVisibilityPriority): HTMLElement {
  const {controlContainer, label} = makeControl(context, layer, options, visibility);
  controlContainer.classList.add('neuroglancer-layer-options-control-container');
  label.prepend(context.registerDisposer(new ToolBindingWidget(layer, options.toolJson)).element);
  return controlContainer;
}

export function addLayerControlToOptionsTab<LayerType extends UserLayer>(
    context: RefCounted, layer: LayerType, visibility: WatchableVisibilityPriority,
    options: LayerControlDefinition<LayerType>): HTMLElement {
  const {isValid} = options;
  if (isValid === undefined) {
    return makeLayerControlToOptionsTab(context, layer, options, visibility);
  }
  return context
      .registerDisposer(new DependentViewWidget(
          isValid(layer),
          (valid, parent, context) => {
            if (!valid) return;
            parent.appendChild(makeLayerControlToOptionsTab(context, layer, options, visibility));
          },
          visibility))
      .element;
}

export function registerLayerControl<LayerType extends UserLayer>(
    layerType: UserLayerConstructor<LayerType>, options: LayerControlDefinition<LayerType>) {
  const {toolJson} = options;
  const toolId = (typeof toolJson === 'string') ? toolJson : toolJson.type;
  registerLayerTool(layerType, toolId, layer => new LayerControlTool<LayerType>(layer, options));
}
