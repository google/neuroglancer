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

import debounce from 'lodash/debounce';
import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType} from 'neuroglancer/layer_specification';
import {Overlay} from 'neuroglancer/overlay';
import {SingleMeshSourceParameters} from 'neuroglancer/single_mesh/base';
import {VertexAttributeInfo} from 'neuroglancer/single_mesh/base';
import {FRAGMENT_MAIN_START, getShaderAttributeType, getSingleMeshSource, SingleMeshDisplayState, SingleMeshLayer, SingleMeshSource, TrackableAttributeNames} from 'neuroglancer/single_mesh/frontend';
import {UserLayerWithCoordinateTransformMixin} from 'neuroglancer/user_layer_with_coordinate_transform';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {parseArray, verifyObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {Tab} from 'neuroglancer/widget/tab_view';

import './single_mesh_user_layer.css';

function makeValidIdentifier(x: string) {
  return x.split(/[^a-zA-Z0-9]+/).filter(y => y).join('_');
}

function pickAttributeNames(existingNames: string[]) {
  const seenNames = new Set<string>();
  let result: string[] = [];
  for (let existingName of existingNames) {
    let name = makeValidIdentifier(existingName);
    let suffix = '';
    let suffixNumber = 0;
    while (seenNames.has(name + suffix)) {
      suffix = '' + (++suffixNumber);
    }
    result.push(name + suffix);
  }
  return result;
}

const BaseUserLayer = UserLayerWithCoordinateTransformMixin(UserLayer);

export class SingleMeshUserLayer extends BaseUserLayer {
  parameters: SingleMeshSourceParameters;
  meshSource: SingleMeshSource|undefined;
  displayState = new SingleMeshDisplayState();
  userSpecifiedAttributeNames: (string|undefined)[]|undefined;
  defaultAttributeNames: string[]|undefined;
  constructor(public manager: LayerListSpecification, x: any) {
    super(manager, x);
    this.displayState.objectToDataTransform = this.transform;
    this.parameters = {
      meshSourceUrl: verifyObjectProperty(x, 'source', verifyString),
      attributeSourceUrls: verifyObjectProperty(
          x, 'vertexAttributeSources',
          y => {
            if (y !== undefined) {
              return parseArray(y, verifyString);
            } else {
              return [];
            }
          }),
    };
    this.displayState.fragmentMain.restoreState(x['shader']);
    this.userSpecifiedAttributeNames = verifyObjectProperty(x, 'vertexAttributeNames', y => {
      if (y === undefined) {
        return undefined;
      }
      return parseArray(y, z => {
        let result = verifyOptionalString(z);
        if (result) {
          return result;
        }
        return undefined;
      });
    });
    getSingleMeshSource(manager.chunkManager, this.parameters).then(source => {
      if (this.wasDisposed) {
        return;
      }
      this.meshSource = source;
      const defaultAttributeNames = this.defaultAttributeNames =
          pickAttributeNames(source.info.vertexAttributes.map(a => a.name));
      const {userSpecifiedAttributeNames} = this;
      let initialAttributeNames: (string|undefined)[];
      if (userSpecifiedAttributeNames !== undefined &&
          userSpecifiedAttributeNames.length === defaultAttributeNames.length) {
        initialAttributeNames = userSpecifiedAttributeNames;
        this.userSpecifiedAttributeNames = undefined;
      } else {
        initialAttributeNames = Array.from(defaultAttributeNames);
      }
      this.displayState.attributeNames.value = initialAttributeNames;
      this.addRenderLayer(new SingleMeshLayer(source, this.displayState));
      this.isReady = true;
    });
    this.registerDisposer(this.displayState.fragmentMain.changed.add(() => {
      this.specificationChanged.dispatch();
    }));
    this.registerDisposer(this.displayState.attributeNames.changed.add(() => {
      this.specificationChanged.dispatch();
    }));
    this.tabs.add(
        'rendering', {label: 'Rendering', order: -100, getter: () => new DisplayOptionsTab(this)});
    this.tabs.default = 'rendering';
  }
  toJSON() {
    let x = super.toJSON();
    x['type'] = 'mesh';
    let {parameters} = this;
    let {attributeSourceUrls} = parameters;
    x['source'] = this.parameters.meshSourceUrl;
    if (attributeSourceUrls) {
      x['vertexAttributeSources'] = attributeSourceUrls;
    }
    x['shader'] = this.displayState.fragmentMain.toJSON();
    let persistentAttributeNames: (string|undefined)[]|undefined = undefined;
    if (this.meshSource === undefined) {
      persistentAttributeNames = this.userSpecifiedAttributeNames;
    } else {
      const defaultAttributeNames = this.defaultAttributeNames!;
      const attributeNames = this.displayState.attributeNames.value;
      // Check if equal.
      let equal = true;
      const numAttributes = attributeNames.length;
      for (let i = 0; i < numAttributes; ++i) {
        if (attributeNames[i] !== defaultAttributeNames[i]) {
          equal = false;
          break;
        }
      }
      if (equal) {
        persistentAttributeNames = undefined;
      } else {
        persistentAttributeNames = Array.from(attributeNames);
      }
    }
    x['vertexAttributeNames'] = persistentAttributeNames;
    return x;
  }
}

function makeShaderCodeWidget(layer: SingleMeshUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.fragmentMain,
    shaderError: layer.displayState.shaderError,
    fragmentMainStartLine: FRAGMENT_MAIN_START,
  });
}

/**
 * Time in milliseconds during which the input field must not be modified before the shader is
 * recompiled.
 */
const SHADER_UPDATE_DELAY = 500;

class VertexAttributeWidget extends RefCounted {
  element = document.createElement('div');

  attributeNameElements: HTMLInputElement[]|undefined;

  private debouncedValueUpdater = debounce(() => {
    this.updateAttributeNames();
  }, SHADER_UPDATE_DELAY);

  constructor(
      public attributeNames: TrackableAttributeNames,
      public getAttributeInfo: () => VertexAttributeInfo[] | undefined) {
    super();
    this.element.className = 'neuroglancer-single-mesh-attribute-widget';

    this.updateInputElements();
    this.registerDisposer(attributeNames.changed.add(() => {
      this.updateInputElements();
    }));
  }

  private updateInputElements() {
    const attributeNames = this.attributeNames;
    let {attributeNameElements} = this;
    if (attributeNameElements === undefined) {
      let attributeInfo = this.getAttributeInfo();
      if (attributeInfo === undefined) {
        return;
      }
      attributeNameElements = this.attributeNameElements = new Array<HTMLInputElement>();
      let previousSource: string|undefined = undefined;
      let numAttributes = attributeNames.value.length;
      let {element} = this;
      for (let i = 0; i < numAttributes; ++i) {
        let info = attributeInfo[i];
        let {source} = info;
        if (source !== previousSource && source !== undefined) {
          previousSource = source;
          let div = document.createElement('div');
          div.className = 'neuroglancer-single-mesh-source-header';
          div.textContent = source;
          element.appendChild(div);
        }
        let div = document.createElement('div');
        div.className = 'neuroglancer-single-mesh-attribute';
        let input = document.createElement('input');
        input.title = info.name;
        this.registerEventListener(input, 'input', this.debouncedValueUpdater);
        input.type = 'text';
        div.textContent = getShaderAttributeType(info);
        div.appendChild(input);
        if (info.min !== undefined && info.max !== undefined) {
          let minMaxText = document.createElement('span');
          minMaxText.className = 'neuroglancer-single-mesh-attribute-range';
          minMaxText.textContent = `[${info.min.toPrecision(6)}, ${info.max.toPrecision(6)}]`;
          div.appendChild(minMaxText);
        }
        attributeNameElements[i] = input;
        element.appendChild(div);
      }
    }
    const attributeNamesValue = attributeNames.value;
    attributeNamesValue.forEach((name, i) => {
      attributeNameElements![i].value = name || '';
    });
  }

  disposed() {
    removeFromParent(this.element);
  }

  private updateAttributeNames() {
    const attributeNames = this.attributeNames.value;
    const attributeNameElements = this.attributeNameElements!;
    let changed = false;
    attributeNames.forEach((name, i) => {
      let newName: string|undefined = attributeNameElements[i].value;
      if (!newName) {
        newName = undefined;
      }
      if (newName !== name) {
        changed = true;
        attributeNames[i] = newName;
      }
    });
    if (changed) {
      this.attributeNames.changed.dispatch();
    }
  }
}

function makeVertexAttributeWidget(layer: SingleMeshUserLayer) {
  return new VertexAttributeWidget(
      layer.displayState.attributeNames,
      () => layer.meshSource && layer.meshSource.info.vertexAttributes);
}

class DisplayOptionsTab extends Tab {
  attributeWidget = this.registerDisposer(makeVertexAttributeWidget(this.layer));
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: SingleMeshUserLayer) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-single-mesh-dropdown');
    let topRow = document.createElement('div');
    topRow.className = 'neuroglancer-single-mesh-dropdown-top-row';
    let spacer = document.createElement('div');
    spacer.style.flex = '1';
    let helpLink = document.createElement('a');
    let helpButton = document.createElement('button');
    helpButton.type = 'button';
    helpButton.textContent = '?';
    helpButton.className = 'help-link';
    helpLink.appendChild(helpButton);
    helpLink.title = 'Documentation on single mesh layer rendering';
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

    topRow.appendChild(spacer);
    topRow.appendChild(maximizeButton);
    topRow.appendChild(helpLink);

    element.appendChild(topRow);
    element.appendChild(this.attributeWidget.element);
    element.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();

    this.visibility.changed.add(() => {
      if (this.visible) {
        this.codeWidget.textEditor.refresh();
      }
    });
  }
}

class ShaderCodeOverlay extends Overlay {
  attributeWidget = this.registerDisposer(makeVertexAttributeWidget(this.layer));
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: SingleMeshUserLayer) {
    super();
    this.content.classList.add('neuroglancer-single-mesh-layer-shader-overlay');
    this.content.appendChild(this.attributeWidget.element);
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType('mesh', SingleMeshUserLayer);
