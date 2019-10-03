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

import debounce from 'lodash/debounce';
import {LayerReference} from 'neuroglancer/layer';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';

export class LayerReferenceWidget extends RefCounted {
  element = document.createElement('label');
  private selectElement = document.createElement('select');
  constructor(public ref: Owned<LayerReference>) {
    super();
    this.registerDisposer(ref);
    const {element, selectElement} = this;
    element.appendChild(selectElement);

    this.updateView();
    this.registerEventListener(selectElement, 'change', () => this.updateModel());
    this.registerDisposer(this.ref.changed.add(debounce(() => this.updateView(), 0)));
  }

  private updateModel() {
    this.ref.layerName = this.selectElement.value || undefined;
  }

  private updateView() {
    const {selectElement, ref} = this;
    const {filter} = ref;
    removeChildren(selectElement);
    const emptyOption = document.createElement('option');
    selectElement.appendChild(emptyOption);
    for (const layer of this.ref.layerManager.managedLayers) {
      if (filter(layer)) {
        const option = document.createElement('option');
        const {name} = layer;
        option.textContent = name;
        option.value = name;
        selectElement.appendChild(option);
      }
    }
    selectElement.value = ref.layerName || '';
  }
}
