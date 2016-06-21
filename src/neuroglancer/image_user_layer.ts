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

import 'codemirror/addon/lint/lint.js';

import * as CodeMirror from 'codemirror';
import * as debounce from 'lodash/debounce';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {Overlay} from 'neuroglancer/overlay';
import {FRAGMENT_MAIN_START, ImageRenderLayer, getTrackableFragmentMain} from 'neuroglancer/sliceview/image_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/sliceview/renderlayer';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {ShaderCompilationError, ShaderLinkError} from 'neuroglancer/webgl/shader';
import {RangeWidget} from 'neuroglancer/widget/range';

require('codemirror/lib/codemirror.css');
require('codemirror/addon/lint/lint.css');
require('./image_user_layer.css');
require('neuroglancer/help_button.css');
require('neuroglancer/maximize_button.css');
require<(codeMirror: typeof CodeMirror) => void>('glsl-editor/glsl')(CodeMirror);

/**
 * Time in milliseconds during which the input field must not be modified before the shader is
 * recompiled.
 */
const SHADER_UPDATE_DELAY = 500;

export class ImageUserLayer extends UserLayer {
  volumePath: string;
  opacity = trackableAlphaValue(0.5);
  fragmentMain = getTrackableFragmentMain();
  renderLayer: ImageRenderLayer;
  constructor(manager: LayerListSpecification, x: any) {
    super();
    let volumePath = x['source'];
    if (typeof volumePath !== 'string') {
      throw new Error('Invalid image layer specification');
    }
    this.opacity.restoreState(x['opacity']);
    this.fragmentMain.restoreState(x['shader']);
    this.registerSignalBinding(
        this.fragmentMain.changed.add(() => { this.specificationChanged.dispatch(); }));
    this.volumePath = volumePath;
    let renderLayer = new ImageRenderLayer(
        manager.chunkManager, getVolumeWithStatusMessage(volumePath), this.opacity,
        this.fragmentMain);
    this.renderLayer = renderLayer;
    this.addRenderLayer(renderLayer);
  }
  toJSON() {
    let x: any = {'type': 'image'};
    x['source'] = this.volumePath;
    x['opacity'] = this.opacity.toJSON();
    x['shader'] = this.fragmentMain.toJSON();
    return x;
  }
  makeDropdown(element: HTMLDivElement) { return new ImageDropdown(element, this); }
};

class ShaderCodeWidget extends RefCounted {
  textEditor: CodeMirror.Editor;
  get element() { return this.textEditor.getWrapperElement(); }
  private changingValue = false;
  private debouncedValueUpdater = debounce(() => {
    this.changingValue = true;
    try {
      this.layer.fragmentMain.value = this.textEditor.getValue();
    } finally {
      this.changingValue = false;
    }
  }, SHADER_UPDATE_DELAY);

  constructor(public layer: ImageUserLayer) {
    super();
    this.textEditor = CodeMirror(element => {}, {
      value: this.layer.fragmentMain.value,
      mode: 'glsl',
      gutters: ['CodeMirror-lint-markers'],
    });
    this.textEditor.on('change', () => {
      this.setValidState(undefined);
      this.debouncedValueUpdater();
    });
    this.registerSignalBinding(this.layer.fragmentMain.changed.add(() => {
      if (!this.changingValue) {
        this.textEditor.setValue(this.layer.fragmentMain.value);
      }
    }));
    this.registerSignalBinding(
        this.layer.renderLayer.shaderError.changed.add(() => { this.updateErrorState(); }));
    this.updateErrorState();
  }

  updateErrorState() {
    if (this.layer.renderLayer.shaderUpdated) {
      this.setValidState(undefined);
    }
    let error = this.layer.renderLayer.shaderError.value;
    if (error !== undefined) {
      this.textEditor.setOption('lint', {
        getAnnotations: () => {
          if (error!.name === 'ShaderCompilationError') {
            let fragmentMainStartLine =
                (<ShaderCompilationError>error).source.split('\n').indexOf(FRAGMENT_MAIN_START) + 2;
            return (<ShaderCompilationError>error).errorMessages.map(e => {
              return {
                message: e.message,
                severity: 'error',
                from: CodeMirror.Pos(e.line === undefined ? 0 : e.line - fragmentMainStartLine),
              };
            });
          } else if (error!.name === 'ShaderLinkError') {
            return [{
              message: (<ShaderLinkError>error).log,
              severity: 'error',
              from: CodeMirror.Pos(0),
            }];
          } else {
            return [{
              message: error!.message,
              severity: 'error',
              from: CodeMirror.Pos(0),
            }];
          }
        },
      });
      this.setValidState(false);
    } else {
      this.textEditor.setOption('lint', undefined);
      this.setValidState(true);
    }
  }

  setValidState(valid?: boolean) {
    let {element} = this;
    element.classList.remove('invalid-input');
    element.classList.remove('valid-input');
    if (valid === true) {
      element.classList.add('valid-input');
    } else if (valid === false) {
      element.classList.add('invalid-input');
    }
  }

  disposed() {
    (<{flush?: () => void}>this.debouncedValueUpdater).flush!();
    this.debouncedValueUpdater = <any>undefined;
    removeFromParent(this.element);
    this.textEditor = <any>undefined;
  }
};

class ImageDropdown extends UserLayerDropdown {
  opacityWidget = this.registerDisposer(new RangeWidget(this.layer.opacity));
  codeWidget = this.registerDisposer(new ShaderCodeWidget(this.layer));
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
    this.registerEventListener(
        maximizeButton, 'click', () => { new ShaderCodeOverlay(this.layer); });

    topRow.appendChild(this.opacityWidget.element);
    topRow.appendChild(spacer);
    topRow.appendChild(maximizeButton);
    topRow.appendChild(helpLink);

    element.appendChild(topRow);
    element.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }

  onShow() { this.codeWidget.textEditor.refresh(); }
};

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(new ShaderCodeWidget(this.layer));
  constructor(public layer: ImageUserLayer) {
    super();
    this.content.classList.add('image-layer-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
};
