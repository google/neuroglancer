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

import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {Overlay} from 'neuroglancer/overlay';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {FRAGMENT_MAIN_START, getTrackableFragmentMain, ImageRenderLayer} from 'neuroglancer/sliceview/volume/image_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {mat4} from 'neuroglancer/util/geom';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {RangeWidget} from 'neuroglancer/widget/range';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';

require('./image_user_layer.css');
require('neuroglancer/help_button.css');
require('neuroglancer/maximize_button.css');

export class ImageUserLayer extends UserLayer {
  volumePath: string;
  opacity = trackableAlphaValue(0.5);
  fragmentMain = getTrackableFragmentMain();
  shaderError = makeWatchableShaderError();
  renderLayer: ImageRenderLayer;
  transform = new CoordinateTransform();
  constructor(manager: LayerListSpecification, x: any) {
    super();
    let volumePath = x['source'];
    if (typeof volumePath !== 'string') {
      throw new Error('Invalid image layer specification');
    }
    this.opacity.restoreState(x['opacity']);
    this.fragmentMain.restoreState(x['shader']);
    this.transform.restoreState(x['transform']);
    this.registerDisposer(this.fragmentMain.changed.add(() => {
      this.specificationChanged.dispatch();
    }));
    this.volumePath = volumePath;
    getVolumeWithStatusMessage(manager.chunkManager, volumePath).then(volume => {
      if (!this.wasDisposed) {
        let renderLayer = this.renderLayer = new ImageRenderLayer(volume, {
          opacity: this.opacity,
          fragmentMain: this.fragmentMain,
          shaderError: this.shaderError,
          sourceOptions: {transform: mat4.clone(this.transform.transform)},
        });
        this.addRenderLayer(renderLayer);
        this.shaderError.changed.dispatch();
      }
    });
  }
  toJSON() {
    let x: any = {'type': 'image'};
    x['source'] = this.volumePath;
    x['opacity'] = this.opacity.toJSON();
    x['shader'] = this.fragmentMain.toJSON();
    x['transform'] = this.transform.toJSON();
    return x;
  }
  makeDropdown(element: HTMLDivElement) {
    return new ImageDropdown(element, this);
  }
}

function makeShaderCodeWidget(layer: ImageUserLayer) {
  return new ShaderCodeWidget({
    shaderError: layer.shaderError,
    fragmentMain: layer.fragmentMain,
    fragmentMainStartLine: FRAGMENT_MAIN_START,
  });
}

class ImageDropdown extends UserLayerDropdown {
  opacityWidget = this.registerDisposer(new RangeWidget(this.layer.opacity));
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public element: HTMLDivElement, public layer: ImageUserLayer) {
    super();
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
  }

  onShow() {
    this.codeWidget.textEditor.refresh();
  }
};

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
