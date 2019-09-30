/**
 * @license
 * Copyright 2018 Google Inc.
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

import './annotation_tool_status.css';

import {SelectedLayerState} from 'neuroglancer/layer';
import {RefCounted} from 'neuroglancer/util/disposable';

export class AnnotationToolStatusWidget extends RefCounted {
  element = document.createElement('div');
  private unbindPreviousLayer: (() => void)|undefined;

  constructor(public selectedLayer: SelectedLayerState) {
    super();
    const {element} = this;
    element.className = 'neuroglancer-annotation-tool-status-widget';
    this.registerDisposer(selectedLayer.changed.add(() => this.selectedLayerChanged()));
    this.selectedLayerChanged();
  }

  private selectedLayerChanged() {
    let {unbindPreviousLayer} = this;
    if (unbindPreviousLayer !== undefined) {
      unbindPreviousLayer();
    }
    const layer = this.selectedLayer.layer;
    if (layer !== undefined) {
      this.unbindPreviousLayer = layer.specificationChanged.add(() => {
        this.updateView();
      });
    }
    this.updateView();
  }

  disposed() {
    const {unbindPreviousLayer} = this;
    if (unbindPreviousLayer !== undefined) {
      unbindPreviousLayer();
    }
    this.unbindPreviousLayer = undefined;
  }

  private getDescriptionText(): string|undefined {
    const layer = this.selectedLayer.layer;
    if (layer === undefined) {
      return undefined;
    }
    const userLayer = layer.layer;
    if (userLayer === null) {
      return undefined;
    }
    const tool = userLayer.tool.value;
    if (tool === undefined) {
      return undefined;
    }
    return tool.description;
  }

  private updateView() {
    this.element.textContent = this.getDescriptionText() || '';
  }
}
