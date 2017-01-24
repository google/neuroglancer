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

import {ManagedUserLayer, UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerDialog} from 'neuroglancer/layer_dialog';
import {LayerListSpecification, ManagedUserLayerWithSpecification} from 'neuroglancer/layer_specification';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {positionDropdown} from 'neuroglancer/util/dropdown';
import Sortable from 'sortablejs';

require('neuroglancer/noselect.css');
require('./layer_panel.css');

class LayerWidget extends RefCounted {
  element: HTMLSpanElement;
  widgetElement: HTMLSpanElement;
  layerNumberElement: HTMLSpanElement;
  labelElement: HTMLSpanElement;
  valueElement: HTMLSpanElement;
  dropdownElement: HTMLDivElement;
  dropdown: UserLayerDropdown|undefined;
  userLayer: UserLayer|null;
  hovering: boolean;

  constructor(public layer: ManagedUserLayer, public panel: LayerPanel) {
    super();
    let element = this.element = document.createElement('span');
    element.className = 'layer-item-parent noselect';
    let widgetElement = this.widgetElement = document.createElement('span');
    widgetElement.className = 'layer-item noselect';
    element.appendChild(widgetElement);
    let labelElement = this.labelElement = document.createElement('span');
    labelElement.className = 'layer-item-label';
    let layerNumberElement = this.layerNumberElement = document.createElement('span');
    layerNumberElement.className = 'layer-item-number';
    let valueElement = this.valueElement = document.createElement('span');
    valueElement.className = 'layer-item-value';
    let closeElement = document.createElement('span');
    closeElement.title = 'Delete layer';
    closeElement.className = 'layer-item-close';
    this.registerEventListener(closeElement, 'click', (_event: MouseEvent) => {
      this.panel.layerManager.removeManagedLayer(this.layer);
    });
    widgetElement.appendChild(layerNumberElement);
    widgetElement.appendChild(labelElement);
    widgetElement.appendChild(valueElement);
    widgetElement.appendChild(closeElement);
    this.registerEventListener(
        widgetElement, 'click', (_event: MouseEvent) => { layer.setVisible(!layer.visible); });

    let dropdownElement = this.dropdownElement = document.createElement('div');

    // Hide the dropdown menu while dragging.  We can't wait until the onStart handler from
    // Sortablejs fires because it occurs too late to affect what is shown while dragging.
    const registerMousedownHandlers = (eventType: string) => {
      this.registerEventListener(element, eventType, (event: MouseEvent) => {
        if (event.button === 0) {
          this.panel.setDragging(true);
        }
      });
      this.registerEventListener(dropdownElement, eventType, (event: MouseEvent) => {
        // Prevent clicks on the dropdown from triggering dragging.
        event.stopPropagation();
      });
    };
    registerMousedownHandlers('mousedown');
    registerMousedownHandlers('pointerdown');
    this.registerEventListener(element, 'mouseup', (event: MouseEvent) => {
      if (event.button === 0) {
        this.panel.setDragging(false);
      }
    });

    this.registerEventListener(widgetElement, 'dblclick', (_event: MouseEvent) => {
      if (layer instanceof ManagedUserLayerWithSpecification) {
        new LayerDialog(this.panel.manager, layer);
      }
    });
    this.setupDropdownElement();
    this.handleLayerChanged();
    this.registerDisposer(layer.layerChanged.add(() => {
      this.handleLayerChanged();
    }));
    element.appendChild(dropdownElement);

    this.registerEventListener(element, 'mouseenter', () => {
      this.hovering = true;
      this.updateDropdownState();
    });
    this.registerEventListener(element, 'mouseleave', (_event: MouseEvent) => {
      this.hovering = false;
      this.updateDropdownState();
    });
  }

  updateDropdownState() {
    let style = this.dropdownElement.style;
    if (this.hovering && !this.panel.dragging && this.dropdownElement.childElementCount > 0) {
      if (style.display !== 'flex') {
        style.display = 'flex';
        if (this.dropdown) {
          this.dropdown.onShow();
        }
      }
      positionDropdown(this.dropdownElement, this.widgetElement);
    } else {
      if (style.display !== 'none') {
        this.dropdownElement.style.display = 'none';
        if (this.dropdown) {
          this.dropdown.onHide();
        }
      }
    }
  }

  setupDropdownElement() { this.dropdownElement.className = 'layer-dropdown'; }

  update() {
    let {layer} = this;
    this.labelElement.textContent = layer.name;
    this.widgetElement.setAttribute('layer-visible', layer.visible.toString());
  }

  private handleLayerChanged() {
    let {layer} = this;
    let userLayer = layer.layer;
    if (userLayer !== this.userLayer) {
      if (this.dropdown) {
        this.dropdown.dispose();
        removeChildren(this.dropdownElement);
        this.setupDropdownElement();
      }
      this.userLayer = userLayer;
      if (userLayer) {
        this.dropdown = userLayer.makeDropdown(this.dropdownElement);
      } else {
        this.dropdown = undefined;
      }
    }
  }

  disposed() {
    if (this.dropdown) {
      this.dropdown.dispose();
    }
    this.element.parentElement!.removeChild(this.element);
    super.disposed();
  }
}

export class LayerPanel extends RefCounted {
  private layerWidgets = new Map<ManagedUserLayer, LayerWidget>();
  private layerUpdateNeeded = true;
  private valueUpdateNeeded = false;
  private addButton: HTMLButtonElement;
  dragging = false;

  get layerManager() { return this.manager.layerManager; }

  constructor(public element: HTMLElement, public manager: LayerListSpecification) {
    super();
    element.className = 'layer-panel';
    this.registerDisposer(manager.layerSelectedValues.changed.add(() => {
      this.handleLayerValuesChanged();
    }));
    this.registerDisposer(manager.layerManager.layersChanged.add(() => {
      this.handleLayersChanged();
    }));
    let addButton = this.addButton = document.createElement('button');
    addButton.className = 'layer-add-button';
    addButton.title = 'Add layer';
    this.registerEventListener(addButton, 'click', () => { this.addLayerMenu(); });
    element.appendChild(addButton);
    this.update();
    let sortable = new Sortable(this.element, {
      draggable: '.layer-item-parent',
      onStart: (_evt) => {
        this.setDragging(true);
        this.element.classList.add('sorting-in-progress');
      },
      onEnd: (evt) => {
        this.setDragging(false);
        this.element.classList.remove('sorting-in-progress');
        this.layerManager.reorderManagedLayer(evt.oldIndex, evt.newIndex);
      },
      onMove: evt => { return (evt.related !== this.addButton); },
    });
    this.registerDisposer(() => { sortable.destroy(); });
  }

  setDragging(value: boolean) {
    this.dragging = value;
    for (let widget of this.layerWidgets.values()) {
      widget.updateDropdownState();
    }
  }

  disposed() {
    this.layerWidgets.forEach(x => x.dispose());
    this.layerWidgets = <any>undefined;
    super.disposed();
  }

  handleLayersChanged() {
    this.layerUpdateNeeded = true;
    this.handleLayerValuesChanged();
  }

  handleLayerValuesChanged() {
    if (!this.valueUpdateNeeded) {
      this.valueUpdateNeeded = true;
      requestAnimationFrame(this.update.bind(this));
    }
  }

  update() {
    this.valueUpdateNeeded = false;
    this.updateLayers();
    let values = this.manager.layerSelectedValues;
    for (let [layer, widget] of this.layerWidgets) {
      let userLayer = layer.layer;
      let text = '';
      if (userLayer !== null) {
        let value = values.get(userLayer);
        if (value !== undefined) {
          text = '' + value;
        }
      }
      widget.valueElement.textContent = text;
    }
  }

  updateLayers() {
    if (!this.layerUpdateNeeded) {
      return;
    }
    this.layerUpdateNeeded = false;
    let container = this.element;
    let layers = new Set();
    let nextChild = container.firstElementChild;
    this.manager.layerManager.managedLayers.forEach((layer, layerIndex) => {
      layers.add(layer);
      let widget = this.layerWidgets.get(layer);
      if (widget === undefined) {
        widget = new LayerWidget(layer, this);
        this.layerWidgets.set(layer, widget);
      }
      widget.layerNumberElement.textContent = '' + (1 + layerIndex);
      widget.update();
      let {element} = widget;
      if (element !== nextChild) {
        container.insertBefore(widget.element, this.addButton);
      }
    });
    for (let [layer, widget] of this.layerWidgets) {
      if (!layers.has(layer)) {
        this.layerWidgets.delete(layer);
        widget.dispose();
      }
    }
  }

  addLayerMenu() {
    // Automatically destroys itself when it exits.
    new LayerDialog(this.manager);
  }
};
