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

/**
 * @file Side panel for displaying/editing layer details.
 */

import 'neuroglancer/ui/layer_side_panel.css';

import {LayerManager, ManagedUserLayer, SelectedLayerState, UserLayer} from 'neuroglancer/layer';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {StackView, Tab, TabView} from 'neuroglancer/widget/tab_view';

class UserLayerInfoPanel extends Tab {
  tabView = new TabView(this.layer.tabs.addRef(), this.visibility);
  constructor(public layer: UserLayer) {
    super();
    this.element.appendChild(this.tabView.element);
    this.element.classList.add('neuroglancer-layer-side-panel-info-panel');
    this.tabView.element.style.flex = '1';
  }
}

class EmptyUserLayerInfoPanel extends Tab {
  get layer(): null {
    return null;
  }

  constructor() {
    super();
    this.element.classList.add('neuroglancer-layer-side-panel-info-panel-empty');
    this.element.textContent =
        'Information about this layer will be available once it finishes loading.';
  }
}

class ManagedUserLayerInfoPanel extends Tab {
  element = document.createElement('div');
  private title = document.createElement('div');
  private layerName = document.createElement('input');
  private stack = this.registerDisposer(
      new StackView<UserLayer|null, UserLayerInfoPanel|EmptyUserLayerInfoPanel>(userLayer => {
        if (userLayer === null) {
          return new EmptyUserLayerInfoPanel();
        } else {
          return new UserLayerInfoPanel(userLayer);
        }
      }, this.visibility));

  constructor(
      public layer: Borrowed<ManagedUserLayer>, public layerManager: Borrowed<LayerManager>,
      public collapse: () => void) {
    super();
    const {element, title, layerName, stack} = this;
    element.className = 'neuroglancer-managed-user-layer-info-panel';
    title.className = 'neuroglancer-layer-side-panel-title';
    stack.element.classList.add('neuroglancer-layer-side-panel-content-container');
    element.appendChild(title);
    element.appendChild(stack.element);

    const collapseButton = makeCloseButton();
    collapseButton.title = 'Close side panel';
    collapseButton.addEventListener('click', () => {
      this.collapse();
    });
    title.appendChild(layerName);
    layerName.spellcheck = false;
    layerName.title = 'Rename layer';
    title.appendChild(collapseButton);
    layerName.addEventListener('change', () => this.handleLayerNameViewChanged());
    layerName.addEventListener('blur', () => this.handleLayerNameViewChanged());
    this.registerDisposer(layer.layerChanged.add(() => this.handleLayerNameModelChanged()));
    this.handleUserLayerChanged();
    this.handleLayerNameModelChanged();
  }

  private handleUserLayerChanged() {
    if (this.stack.selected !== this.layer.layer) {
      this.stack.invalidateAll();
      this.stack.selected = this.layer.layer;
    }
  }

  private handleLayerNameModelChanged() {
    this.layerName.value = this.layer.name;
  }

  private handleLayerNameViewChanged() {
    const {layer} = this;
    if (layer !== undefined) {
      let newName = this.layerName.value;
      if (newName !== layer.name) {
        newName = this.layerManager.getUniqueLayerName(newName);
        this.layerName.value = newName;
        layer.name = newName;
        layer.layerChanged.dispatch();
      }
    }
  }
}

export class LayerInfoPanelContainer extends RefCounted {
  element = document.createElement('div');
  private stack = this.registerDisposer(new StackView<ManagedUserLayer, ManagedUserLayerInfoPanel>(
      layer =>
          new ManagedUserLayerInfoPanel(layer, this.state.layerManager, this.collapse.bind(this))));
  constructor(public state: SelectedLayerState) {
    super();
    const {element, stack} = this;
    element.className = 'neuroglancer-layer-side-panel';
    stack.element.classList.add('neuroglancer-layer-info-panel-container');
    element.appendChild(stack.element);
    this.registerDisposer(state.changed.add(() => this.handleStateChanged()));
    this.registerDisposer(state.layerManager.layersChanged.add(() => this.handleLayersChanged()));
    this.handleStateChanged();
  }

  private handleLayersChanged() {
    const {layerManager} = this.state;
    const {stack} = this;
    for (const layer of stack.tabs.keys()) {
      if (!layerManager.has(layer)) {
        stack.invalidate(layer);
      }
    }
  }

  collapse() {
    const {state} = this;
    if (state.visible === true) {
      this.state.visible = false;
      this.state.changed.dispatch();
    }
  }

  private handleStateChanged() {
    const {state} = this;
    const {visible} = state;
    this.element.style.display = visible ? null : 'none';
    this.stack.visibility.value =
        visible ? WatchableVisibilityPriority.VISIBLE : WatchableVisibilityPriority.IGNORED;
    this.stack.selected = state.layer;
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
