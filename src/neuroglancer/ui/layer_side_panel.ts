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

import {changeLayerName, changeLayerType, deleteLayer, LayerManager, layerTypes, ManagedUserLayer, SelectedLayerState, UserLayer} from 'neuroglancer/layer';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {EventActionMap} from 'neuroglancer/util/mouse_bindings';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {makeDeleteButton} from 'neuroglancer/widget/delete_button';
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

const layerNameInputEventMap = EventActionMap.fromObject({
  'escape': {action: 'cancel'},
});

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
  private typeSelect = document.createElement('select');
  private typeSelectMeasure = document.createElement('div');
  private title = document.createElement('div');
  private layerName = document.createElement('input');
  // private userLayerElement = document.createElement('div');
  // private prevLayer: UserLayer|null|undefined;
  // private prevLayerPanel: UserLayerInfoPanel|EmptyUserLayerInfoPanel|undefined;

  private stack = this.registerDisposer(
      new StackView<UserLayer|null, UserLayerInfoPanel|EmptyUserLayerInfoPanel>(
          userLayer => {
            if (userLayer === null) {
              return new EmptyUserLayerInfoPanel();
            } else {
              return new UserLayerInfoPanel(userLayer);
            }
          },
          (() => {
            const {layer} = this;
            return {
              changed: layer.layerChanged,
              get value() {
                return layer.layer;
              },
            };
          })(),
          this.visibility, /*invalidateByDefault=*/ true));

  constructor(
      public layer: Borrowed<ManagedUserLayer>, public layerManager: Borrowed<LayerManager>,
      public collapse: () => void) {
    super();
    const {element, title, layerName, stack, typeSelect, typeSelectMeasure} = this;
    element.className = 'neuroglancer-managed-user-layer-info-panel';
    title.className = 'neuroglancer-layer-side-panel-title';
    stack.element.classList.add('neuroglancer-layer-side-panel-content-container');
    title.appendChild(typeSelect);
    element.appendChild(title);
    element.appendChild(stack.element);
    document.body.appendChild(typeSelectMeasure);
    typeSelect.classList.add('neuroglancer-layer-side-panel-type');
    typeSelectMeasure.classList.add('neuroglancer-layer-side-panel-type-measure');
    typeSelect.title = 'Change layer type';

    for (const [layerType, layerConstructor] of layerTypes) {
      if (layerConstructor.type !== layerType) continue;
      const option = document.createElement('option');
      option.textContent = layerType;
      option.value = layerType;
      typeSelect.appendChild(option);
    }
    typeSelect.addEventListener('change', () => {
      const userLayer = this.layer.layer;
      if (userLayer === null) {
        this.handleLayerNameModelChanged();
        return;
      }
      const newType = typeSelect.value;
      const layerConstructor = layerTypes.get(newType)!;
      changeLayerType(this.layer, layerConstructor);
    });

    title.appendChild(layerName);
    layerName.spellcheck = false;
    layerName.autocomplete = 'off';
    layerName.addEventListener('focus', () => {
      layerName.select();
    });
    const keyboardHandler =
        this.registerDisposer(new KeyboardEventBinder(layerName, layerNameInputEventMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    registerActionListener(layerName, 'cancel', event => {
      this.handleLayerNameModelChanged();
      layerName.blur();
      event.stopPropagation();
      event.preventDefault();
    });
    layerName.title = 'Rename layer';
    title.appendChild(makeDeleteButton({
      title: 'Delete layer',
      onClick: () => {
        deleteLayer(this.layer);
      }
    }));
    title.appendChild(makeCloseButton({
      title: 'Close side panel',
      onClick: () => {
        this.collapse();
      }
    }));
    layerName.addEventListener('change', () => this.handleLayerNameViewChanged());
    layerName.addEventListener('blur', () => this.handleLayerNameViewChanged());
    this.registerDisposer(layer.layerChanged.add(() => this.handleLayerNameModelChanged()));
    this.handleLayerNameModelChanged();
  }

  private handleLayerNameModelChanged() {
    const userLayer = this.layer.layer;
    const selectedName = userLayer !== null ? userLayer.type : 'auto';
    const {typeSelect, typeSelectMeasure} = this;
    typeSelectMeasure.textContent = selectedName;
    typeSelect.value = selectedName;
    typeSelect.style.width = `${typeSelectMeasure.offsetWidth}px`;
    this.layerName.value = this.layer.name;
  }

  private handleLayerNameViewChanged() {
    changeLayerName(this.layer, this.layerName.value);
  }
}

export class LayerInfoPanelContainer extends RefCounted {
  element = document.createElement('div');
  private stack = this.registerDisposer(new StackView<ManagedUserLayer, ManagedUserLayerInfoPanel>(
      (layer: ManagedUserLayer) =>
          new ManagedUserLayerInfoPanel(layer, this.state.layerManager, this.collapse.bind(this)),
      (() => {
        const {state} = this;
        return {
          changed: state.changed,
          get value() {
            return state.layer;
          },
        };
      })()));
  private debouncedUpdateView =
      this.registerCancellable(animationFrameDebounce(() => this.handleStateChanged()));
  private debouncedUpdateLayers =
      this.registerCancellable(animationFrameDebounce(() => this.handleLayersChanged()));
  constructor(public state: SelectedLayerState) {
    super();
    const {element, stack} = this;
    element.className = 'neuroglancer-layer-side-panel';
    stack.element.classList.add('neuroglancer-layer-info-panel-container');
    element.appendChild(stack.element);
    this.registerDisposer(state.changed.add(() => this.handleStateChanged()));
    this.registerDisposer(state.layerManager.layersChanged.add(this.debouncedUpdateLayers));
    this.debouncedUpdateView();
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
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
