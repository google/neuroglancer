/**
 * @license
 * Copyright 2020 Google Inc.
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

import './linked_layer.css';

import debounce from 'lodash/debounce';
import {LinkedLayerGroup} from 'neuroglancer/layer';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {makeCloseButton} from 'neuroglancer/widget/close_button';

export class LinkedLayerGroupWidget extends RefCounted {
  element = document.createElement('div');
  topRow = document.createElement('div');
  label = document.createElement('label');
  private selectElement = document.createElement('select');
  private linkedLayers = document.createElement('div');
  private unlinkButton = document.createElement('button');
  constructor(public group: Borrowed<LinkedLayerGroup>) {
    super();
    const {element, label, topRow, selectElement, linkedLayers, unlinkButton} = this;
    topRow.appendChild(label);
    topRow.appendChild(selectElement);
    topRow.appendChild(unlinkButton);
    unlinkButton.textContent = 'Unlink';
    unlinkButton.addEventListener('click', () => {
      this.group.isolate();
    });
    element.appendChild(topRow);
    element.appendChild(linkedLayers);

    this.updateView();
    const debouncedUpdateView = debounce(() => this.updateView(), 0);
    this.registerEventListener(selectElement, 'change', () => {
      this.updateModel();
      debouncedUpdateView();
    });
    this.registerDisposer(this.group.changed.add(debouncedUpdateView));
    this.registerDisposer(this.group.linkedLayersChanged.add(debouncedUpdateView));
    this.registerDisposer(this.group.layerManager.layersChanged.add(debouncedUpdateView));
  }

  private updateModel() {
    const name = this.selectElement.value;
    if (name === '' && this.group.root.value !== this.group.layer) {
      this.group.isolate();
    } else {
      this.group.linkByName(name);
    }
  }

  private updateView() {
    const {selectElement, group} = this;
    const {predicate} = group;
    removeChildren(selectElement);

    const inGroup = this.group.rootGroup.linkedLayers.size !== 0;
    this.unlinkButton.style.display = inGroup ? '' : 'none';
    const {linkedLayers} = this;

    const isNonEmptyRoot = group.linkedLayers.size !== 0;
    linkedLayers.style.display = isNonEmptyRoot ? '' : 'none';
    this.unlinkButton.textContent = isNonEmptyRoot ? 'Unlink all' : 'Unlink';


    if (isNonEmptyRoot) {
      this.element.style.display = '';
      selectElement.style.display = 'none';
      removeChildren(linkedLayers);
      for (const layer of group.linkedLayers) {
        const element = document.createElement('div');
        element.classList.add('neuroglancer-linked-layer-widget-layer');
        const unlinkIcon = makeCloseButton({
          title: 'Unlink layer',
          onClick: () => {
            this.group.getGroup(layer).isolate();
          }
        });
        element.appendChild(unlinkIcon);
        element.appendChild(document.createTextNode(layer.managedLayer.name));
        linkedLayers.appendChild(element);
      }
    } else {
      selectElement.style.display = '';
      const emptyOption = document.createElement('option');
      selectElement.appendChild(emptyOption);
      let numOptions = 0;
      for (const layer of this.group.layerManager.managedLayers) {
        const userLayer = layer.layer;
        if (userLayer === null) continue;
        if (userLayer === group.layer) continue;
        if (predicate(userLayer)) {
          ++numOptions;
          const option = document.createElement('option');
          const {name} = layer;
          option.textContent = name;
          option.value = name;
          selectElement.appendChild(option);
        }
      }
      selectElement.value = group.toJSON() ?? '';
      this.element.style.display = numOptions === 0 ? 'none' : '';
    }
  }
}
