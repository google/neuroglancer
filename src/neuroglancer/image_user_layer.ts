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

import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {Overlay} from 'neuroglancer/overlay';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {FRAGMENT_MAIN_START, getTrackableFragmentMain, ImageRenderLayer} from 'neuroglancer/sliceview/volume/image_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {trackableBlendModeValue} from 'neuroglancer/trackable_blend';
import {UserLayerWithVolumeSourceMixin} from 'neuroglancer/user_layer_with_volume_source';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {RangeWidget} from 'neuroglancer/widget/range';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {Tab} from 'neuroglancer/widget/tab_view';
import {TrackableRGB} from 'neuroglancer/util/color';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {ColorWidget} from 'neuroglancer/widget/color';
import {vec3} from 'neuroglancer/util/geom';

require('./image_user_layer.css');
require('neuroglancer/maximize_button.css');

const OPACITY_JSON_KEY = 'opacity';
const BLEND_JSON_KEY = 'blend';
const SHADER_JSON_KEY = 'shader';
const COLOR_JSON_KEY = 'color';
const USE_CUSTOM_SHADER_JSON_KEY = 'use_custom_shader';
const MIN_JSON_KEY = 'min';
const MAX_JSON_KEY = 'max';

const Base = UserLayerWithVolumeSourceMixin(UserLayer);
export class ImageUserLayer extends Base {
  opacity = trackableAlphaValue(0.5);
  blendMode = trackableBlendModeValue();
  fragmentMain = getTrackableFragmentMain();
  shaderError = makeWatchableShaderError();
  color = new TrackableRGB(vec3.fromValues(1, 1, 1));
  useCustomShader = new TrackableBoolean(false);
  renderLayer: ImageRenderLayer;
  min = trackableAlphaValue(0.0);
  max = trackableAlphaValue(1.0);
  shaderEditorUpdate: () => void;
  constructor(manager: LayerListSpecification, x: any) {
    super(manager, x);
    this.registerDisposer(this.fragmentMain.changed.add(this.specificationChanged.dispatch));
    this.tabs.add(
        'rendering',
        {label: 'Rendering', order: -100, getter: () => new RenderingOptionsTab(this)});
    this.tabs.default = 'rendering';
    this.shaderEditorUpdate = () => {
      if (!this.useCustomShader.value) {
        let shaderString = `float scale(float x) {
  float min = ${this.min.value.toPrecision(2)};
  float max = ${this.max.value.toPrecision(2)};
  return (x - min) / (max - min);
}
void main() {
  emitRGB(
    vec3(
      scale(toNormalized(getDataValue()))*${this.color.value[0].toPrecision(3)},
      scale(toNormalized(getDataValue()))*${this.color.value[1].toPrecision(3)},
      scale(toNormalized(getDataValue()))*${this.color.value[2].toPrecision(3)}
    )
  );
}`;
        this.fragmentMain.value = shaderString;
      }
    };

    // EAP: Kludge to update the shader & trigger a change event
    this.color.changed.add(this.shaderEditorUpdate);
    this.min.changed.add(this.shaderEditorUpdate);
    this.max.changed.add(this.shaderEditorUpdate);
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.opacity.restoreState(specification[OPACITY_JSON_KEY]);
    this.blendMode.restoreState(specification[BLEND_JSON_KEY]);
    this.fragmentMain.restoreState(specification[SHADER_JSON_KEY]);
    this.color.restoreState(specification[COLOR_JSON_KEY]);
    this.useCustomShader.restoreState(specification[USE_CUSTOM_SHADER_JSON_KEY]);
    this.min.restoreState(specification[MIN_JSON_KEY]);
    this.max.restoreState(specification[MAX_JSON_KEY]);
    const {multiscaleSource} = this;
    if (multiscaleSource === undefined) {
      throw new Error(`source property must be specified`);
    }
    multiscaleSource.then(volume => {
      if (!this.wasDisposed) {
        let renderLayer = this.renderLayer = new ImageRenderLayer(volume, {
          opacity: this.opacity,
          blendMode: this.blendMode,
          fragmentMain: this.fragmentMain,
          shaderError: this.shaderError,
          transform: this.transform,
        });
        this.addRenderLayer(renderLayer);
        this.shaderError.changed.dispatch();
        this.isReady = true;
      }
    });
  }
  toJSON() {
    const x = super.toJSON();
    x['type'] = 'image';
    x[OPACITY_JSON_KEY] = this.opacity.toJSON();
    x[BLEND_JSON_KEY] = this.blendMode.toJSON();
    x[USE_CUSTOM_SHADER_JSON_KEY] = this.useCustomShader.toJSON();
    if (this.useCustomShader.value) {
      x[SHADER_JSON_KEY] = this.fragmentMain.toJSON();
    } else {
      x[COLOR_JSON_KEY] = this.color.toJSON();
      x[MIN_JSON_KEY] = this.min.toJSON();
      x[MAX_JSON_KEY] = this.max.toJSON();
    }
    return x;
  }
}

function makeShaderCodeWidget(layer: ImageUserLayer) {
  return new ShaderCodeWidget({
    shaderError: layer.shaderError,
    fragmentMain: layer.fragmentMain,
    fragmentMainStartLine: FRAGMENT_MAIN_START,
  });
}

class RenderingOptionsTab extends Tab {
  opacityWidget = this.registerDisposer(new RangeWidget(this.layer.opacity));
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  colorPicker = this.registerDisposer(new ColorWidget(this.layer.color));
  minWidget = this.registerDisposer(new RangeWidget(this.layer.min));
  maxWidget = this.registerDisposer(new RangeWidget(this.layer.max));

  constructor(public layer: ImageUserLayer) {
    super();
    const {element} = this;
    element.classList.add('image-dropdown');
    let {opacityWidget} = this;
    let topRow = document.createElement('div');
    topRow.className = 'image-dropdown-top-row';
    opacityWidget.promptElement.textContent = 'Opacity';

    let spacer = document.createElement('div');
    spacer.style.flex = '1';
    let helpLink = document.createElement('a');
    let helpButton = document.createElement('button');
    helpButton.type = 'button';
    helpButton.textContent = '?';
    helpButton.className = 'help-link';
    helpLink.appendChild(helpButton);
    helpLink.title = 'Documentation on image layer rendering';
    helpLink.target = '_blank';
    helpLink.href =
        'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md';

    let maximizeButton = document.createElement('button');
    maximizeButton.innerHTML = '&square;';
    maximizeButton.className = 'maximize-button';
    maximizeButton.title = 'Show larger editor view';
    this.registerEventListener(maximizeButton, 'click', () => {
      new ShaderCodeOverlay(this.layer);
    });

    topRow.appendChild(this.opacityWidget.element);
    topRow.appendChild(spacer);
    topRow.appendChild(maximizeButton);
    topRow.appendChild(helpLink);

    element.appendChild(topRow);
    element.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
    this.visibility.changed.add(() => {
      if (this.visible) {
        this.codeWidget.textEditor.refresh();
      }
    });

    const checkbox = this.registerDisposer(new TrackableBooleanCheckbox(layer.useCustomShader));
    const label = document.createElement('label');
    label.appendChild(document.createTextNode('Use custom shader '));
    label.appendChild(checkbox.element);
    element.appendChild(label);

    element.appendChild(document.createElement('br'));
    element.appendChild(document.createTextNode('Color: '));
    this.colorPicker.element.title = 'Change layer display color';
    element.appendChild(this.colorPicker.element);
    element.appendChild(document.createElement('br'));
    this.minWidget.promptElement.textContent = 'Min: ';
    element.appendChild(this.minWidget.element);
    this.maxWidget.promptElement.textContent = 'Max: ';
    element.appendChild(this.maxWidget.element);
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: ImageUserLayer) {
    super();
    this.content.classList.add('image-layer-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType('image', ImageUserLayer);
registerVolumeLayerType(VolumeType.IMAGE, ImageUserLayer);
