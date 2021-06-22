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

import './single_mesh_user_layer.css';

import {ManagedUserLayer, registerLayerType, registerLayerTypeDetector, UserLayer} from 'neuroglancer/layer';
import {LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {Overlay} from 'neuroglancer/overlay';
import {VertexAttributeInfo} from 'neuroglancer/single_mesh/base';
import {getShaderAttributeType, pickAttributeNames, SingleMeshDisplayState, SingleMeshLayer} from 'neuroglancer/single_mesh/frontend';
import {WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {makeHelpButton} from 'neuroglancer/widget/help_button';
import {makeMaximizeButton} from 'neuroglancer/widget/maximize_button';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {registerLayerShaderControlsTool, ShaderControls} from 'neuroglancer/widget/shader_controls';
import {Tab} from 'neuroglancer/widget/tab_view';

const SHADER_JSON_KEY = 'shader';
const SHADER_CONTROLS_JSON_KEY = 'shaderControls';

export class SingleMeshUserLayer extends UserLayer {
  displayState = new SingleMeshDisplayState();
  vertexAttributes = new WatchableValue<VertexAttributeInfo[]|undefined>(undefined);
  constructor(public managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    this.registerDisposer(
        this.displayState.shaderControlState.changed.add(this.specificationChanged.dispatch));
    this.registerDisposer(
        this.displayState.fragmentMain.changed.add(this.specificationChanged.dispatch));
    this.tabs.add(
        'rendering', {label: 'Rendering', order: -100, getter: () => new DisplayOptionsTab(this)});
    this.tabs.default = 'rendering';
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.displayState.fragmentMain.restoreState(specification[SHADER_JSON_KEY]);
    this.displayState.shaderControlState.restoreState(specification[SHADER_CONTROLS_JSON_KEY]);
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    let hasSource = false;
    for (const loadedSubsource of subsources) {
      const {subsourceEntry} = loadedSubsource;
      const {subsource} = subsourceEntry;
      const {singleMesh} = subsource;
      if (singleMesh !== undefined) {
        if (hasSource) {
          loadedSubsource.deactivate('Only one single-mesh source supported');
          continue;
        }
        hasSource = true;
        loadedSubsource.activate(refCounted => {
          loadedSubsource.addRenderLayer(new SingleMeshLayer(
              singleMesh, this.displayState, loadedSubsource.getRenderLayerTransform()));
          this.vertexAttributes.value = singleMesh.info.vertexAttributes;
          refCounted.registerDisposer(() => {
            this.vertexAttributes.value = undefined;
          });
        });
        continue;
      }
      loadedSubsource.deactivate('Not compatible with image layer');
    }
  }

  toJSON() {
    let x = super.toJSON();
    x[SHADER_JSON_KEY] = this.displayState.fragmentMain.toJSON();
    x[SHADER_CONTROLS_JSON_KEY] = this.displayState.shaderControlState.toJSON();
    return x;
  }

  static type = 'mesh';
  static typeAbbreviation = 'mesh';
}

function makeShaderCodeWidget(layer: SingleMeshUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.fragmentMain,
    shaderError: layer.displayState.shaderError,
    shaderControlState: layer.displayState.shaderControlState,
  });
}

class VertexAttributeWidget extends RefCounted {
  element = document.createElement('div');
  constructor(public attributes: WatchableValueInterface<VertexAttributeInfo[]|undefined>) {
    super();
    this.element.className = 'neuroglancer-single-mesh-attribute-widget';
    this.updateView();
    this.registerDisposer(attributes.changed.add(() => {
      this.updateView();
    }));
  }

  private updateView() {
    const {element} = this;
    const attributeInfo = this.attributes.value;
    if (attributeInfo === undefined) {
      removeChildren(element);
      return;
    }
    const attributeNames = pickAttributeNames(attributeInfo.map(a => a.name));
    const numAttributes = attributeInfo.length;
    for (let i = 0; i < numAttributes; ++i) {
      const info = attributeInfo[i];
      const div = document.createElement('div');
      div.className = 'neuroglancer-single-mesh-attribute';
      const typeElement = document.createElement('div');
      typeElement.className = 'neuroglancer-single-mesh-attribute-type';
      typeElement.textContent = getShaderAttributeType(info);
      const nameElement = document.createElement('div');
      nameElement.className = 'neuroglancer-single-mesh-attribute-name';
      nameElement.textContent = attributeNames[i];
      div.appendChild(typeElement);
      div.appendChild(nameElement);
      if (info.min !== undefined && info.max !== undefined) {
        const minMaxElement = document.createElement('neuroglancer-single-mesh-attribute-minmax');
        minMaxElement.className = 'neuroglancer-single-mesh-attribute-range';
        minMaxElement.textContent = `[${info.min.toPrecision(6)}, ${info.max.toPrecision(6)}]`;
        div.appendChild(minMaxElement);
      }
      element.appendChild(div);
    }
  }

  disposed() {
    removeFromParent(this.element);
  }
}

function makeVertexAttributeWidget(layer: SingleMeshUserLayer) {
  return new VertexAttributeWidget(layer.vertexAttributes);
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

    topRow.appendChild(spacer);
    topRow.appendChild(makeMaximizeButton({
      title: 'Show larger editor view',
      onClick: () => {
        new ShaderCodeOverlay(this.layer);
      }
    }));
    topRow.appendChild(makeHelpButton({
      title: 'Documentation on single mesh layer rendering',
      href:
          'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md',
    }));

    element.appendChild(topRow);
    element.appendChild(this.attributeWidget.element);
    element.appendChild(this.codeWidget.element);
    element.appendChild(this.registerDisposer(new ShaderControls(
                                                  layer.displayState.shaderControlState,
                                                  this.layer.manager.root.display, this.layer,
                                                  {visibility: this.visibility}))
                            .element);
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

registerLayerType(SingleMeshUserLayer);
registerLayerTypeDetector(subsource => {
  if (subsource.singleMesh !== undefined) {
    return {layerConstructor: SingleMeshUserLayer, priority: 2};
  }
  return undefined;
});

registerLayerShaderControlsTool(
    SingleMeshUserLayer, layer => ({
                           shaderControlState: layer.displayState.shaderControlState,
                         }));
