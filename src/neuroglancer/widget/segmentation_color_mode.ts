/**
 * @license
 * Copyright 2016 Google Inc.
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

import './segmentation_color_mode.css';

import svg_rotate from 'ikonate/icons/rotate.svg';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {observeWatchable} from 'neuroglancer/trackable_value';
import {vec3} from 'neuroglancer/util/geom';
import {ColorWidget} from 'neuroglancer/widget/color';
import {makeIcon} from 'neuroglancer/widget/icon';
import {LayerControlFactory} from 'neuroglancer/widget/layer_control';
import {colorLayerControl} from 'neuroglancer/widget/layer_control_color';
import {TextInputWidget} from 'neuroglancer/widget/text_input';

function chooseColorMode(layer: SegmentationUserLayer, useFixedColor: boolean) {
  if (!useFixedColor) {
    layer.displayState.segmentDefaultColor.value = undefined;
  } else {
    layer.displayState.segmentDefaultColor.value = vec3.fromValues(1, 0, 0);
  }
}

export function colorSeedLayerControl(): LayerControlFactory<SegmentationUserLayer> {
  const randomize = (layer: SegmentationUserLayer) => {
    layer.displayState.segmentationColorGroupState.value.segmentColorHash.randomize();
  };
  return {
    makeControl: (layer, context, {labelTextContainer}) => {
      const checkbox = document.createElement('input');
      checkbox.type = 'radio';
      checkbox.addEventListener('change', () => {
        chooseColorMode(layer, !checkbox.checked);
      });
      labelTextContainer.prepend(checkbox);
      const controlElement = document.createElement('div');
      controlElement.classList.add('neuroglancer-segmentation-color-seed-control');
      const widget =
          context.registerDisposer(new TextInputWidget(layer.displayState.segmentColorHash));
      controlElement.appendChild(widget.element);
      const randomizeButton = makeIcon({
        svg: svg_rotate,
        title: 'Randomize',
        onClick: () => randomize(layer),
      });
      controlElement.appendChild(randomizeButton);
      context.registerDisposer(observeWatchable(value => {
        const isVisible = value === undefined;
        controlElement.style.visibility = isVisible ? '' : 'hidden';
        checkbox.checked = isVisible;
      }, layer.displayState.segmentDefaultColor));
      return {controlElement, control: widget};
    },
    activateTool: activation => {
      const {layer} = activation.tool;
      chooseColorMode(layer, false);
      randomize(layer);
    },
  };
}

export function fixedColorLayerControl():
    LayerControlFactory<SegmentationUserLayer, ColorWidget<vec3|undefined>> {
  const options =
      colorLayerControl((layer: SegmentationUserLayer) => layer.displayState.segmentDefaultColor);
  return {
    ...options,
    makeControl: (layer, context, labelElements) => {
      const result = options.makeControl(layer, context, labelElements);
      const {controlElement} = result;
      const checkbox = document.createElement('input');
      checkbox.type = 'radio';
      checkbox.addEventListener('change', () => {
        chooseColorMode(layer, checkbox.checked);
        if (checkbox.checked) {
          controlElement.click();
        }
      });
      labelElements.labelTextContainer.prepend(checkbox);
      context.registerDisposer(observeWatchable(value => {
        const isVisible = value !== undefined;
        controlElement.style.visibility = isVisible ? '' : 'hidden';
        checkbox.checked = isVisible;
      }, layer.displayState.segmentDefaultColor));
      return result;
    },
    activateTool: (activation, control) => {
      chooseColorMode(activation.tool.layer, true);
      options.activateTool(activation, control);
    },
  };
}
