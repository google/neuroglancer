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
import {RefCounted, registerEventListener} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {decodeParametersFromDragTypeList, encodeParametersAsDragType} from 'neuroglancer/util/drag_and_drop';
import {positionDropdown} from 'neuroglancer/util/dropdown';
import {verifyBoolean, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';

const layerDragTypePrefix = 'neuroglancer-layer\0';

require('neuroglancer/noselect.css');
require('./layer_panel.css');

/**
 * If a layer originating in this browser is being dragged.
 */
let dragSourceWidget: LayerWidget|undefined;

/**
 * If there is a layer representation in this browser of the layer being dropped.
 */
let dropTargetWidget: LayerWidget|undefined;


function registerDropHandlers(
    panel: LayerPanel, target: EventTarget, targetWidget: LayerWidget|undefined) {
  const enterDisposer = registerEventListener(target, 'dragenter', (event: DragEvent) => {
    const result = decodeParametersFromDragTypeList(event.dataTransfer.types, layerDragTypePrefix);
    if (result === undefined) {
      return;
    }
    const layerInfo = result.parameters;
    if (targetWidget !== undefined &&
        (dropTargetWidget === targetWidget || dragSourceWidget === targetWidget)) {
      // Dragged onto itself, nothing to do.
      return;
    }
    const originalName = verifyObjectProperty(layerInfo, 'name', verifyString);
    const visible = verifyObjectProperty(layerInfo, 'visible', verifyBoolean);
    let newIndex: number;
    if (targetWidget !== undefined) {
      newIndex = panel.manager.layerManager.managedLayers.indexOf(targetWidget.layer);
    } else {
      newIndex = panel.manager.layerManager.managedLayers.length;
    }
    if (dropTargetWidget === undefined && dragSourceWidget !== undefined &&
        dragSourceWidget.panel.layerManager === panel.layerManager) {
      // A move within the same layer manager.
      dropTargetWidget = dragSourceWidget;
    }
    if (dropTargetWidget === undefined) {
      const uniqueName = panel.manager.layerManager.getUniqueLayerName(originalName);
      const newLayer = new ManagedUserLayerWithSpecification(uniqueName, null, panel.manager);
      newLayer.visible = visible;
      panel.manager.layerManager.addManagedLayer(newLayer, newIndex);
      panel.updateLayers();
      dropTargetWidget = panel.layerWidgets.get(newLayer);
    } else {
      const oldIndex = panel.manager.layerManager.managedLayers.indexOf(dropTargetWidget.layer);
      if (newIndex === panel.layerManager.managedLayers.length) {
        --newIndex;
      }
      panel.layerManager.reorderManagedLayer(oldIndex, newIndex);
    }
  });
  const dropDisposer = registerEventListener(target, 'drop', (event: DragEvent) => {
    event.preventDefault();
    const result = decodeParametersFromDragTypeList(event.dataTransfer.types, layerDragTypePrefix);
    if (result === undefined) {
      return;
    }
    if (dropTargetWidget !== undefined) {
      try {
        if (dragSourceWidget === undefined ||
            dragSourceWidget.panel.layerManager !== dropTargetWidget.panel.layerManager) {
          try {
            const spec = JSON.parse(event.dataTransfer.getData(result.dragType));
            panel.manager.initializeLayerFromSpec(
                <ManagedUserLayerWithSpecification>dropTargetWidget.layer, spec);
          } catch {
            dropTargetWidget.panel.layerManager.removeManagedLayer(dropTargetWidget.layer);
          }
        }
      } finally {
        dropTargetWidget = undefined;
      }
    }
  });
  const overDisposer = registerEventListener(target, 'dragover', (event: DragEvent) => {
    const result = decodeParametersFromDragTypeList(event.dataTransfer.types, layerDragTypePrefix);
    if (result === undefined) {
      return;
    }
    if (dragSourceWidget !== undefined &&
        dragSourceWidget.panel.layerManager === panel.layerManager) {
      event.dataTransfer.dropEffect = 'move';
    } else {
      event.dataTransfer.dropEffect = 'copy';
    }
    event.preventDefault();
    event.stopPropagation();
  });

  return () => {
    overDisposer();
    dropDisposer();
    enterDisposer();
  };
}


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
    element.className = 'layer-item-parent neuroglancer-noselect';
    let widgetElement = this.widgetElement = document.createElement('span');
    widgetElement.className = 'layer-item neuroglancer-noselect';
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
    this.registerEventListener(widgetElement, 'click', (_event: MouseEvent) => {
      layer.setVisible(!layer.visible);
    });

    let dropdownElement = this.dropdownElement = document.createElement('div');

    widgetElement.draggable = true;
    this.registerEventListener(widgetElement, 'dragstart', (event: DragEvent) => {
      dragSourceWidget = this;
      event.dataTransfer.setData(
          encodeParametersAsDragType(
              layerDragTypePrefix, {name: this.layer.name, visible: this.layer.visible}),
          JSON.stringify((<ManagedUserLayerWithSpecification>this.layer).toJSON()));
    });

    this.registerEventListener(widgetElement, 'dragend', (_event: DragEvent) => {
      dragSourceWidget = undefined;
    });

    this.registerDisposer(registerDropHandlers(this.panel, widgetElement, this));

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

    this.registerEventListener(element, 'mouseenter', (event: MouseEvent) => {
      this.hovering = event.buttons === 0 ? true : false;
      this.updateDropdownState();
    });
    this.registerEventListener(element, 'mouseup', (event: MouseEvent) => {
      this.hovering = this.hovering || (event.buttons === 0 ? true : false);
      this.updateDropdownState();
    });
    this.registerEventListener(widgetElement, 'mousedown', (_event: MouseEvent) => {
      this.hovering = false;
      this.updateDropdownState();
    });
    this.registerEventListener(element, 'mouseleave', (_event: MouseEvent) => {
      this.hovering = false;
      this.updateDropdownState();
    });
  }

  updateDropdownState() {
    let style = this.dropdownElement.style;
    if (this.hovering && this.dropdownElement.childElementCount > 0) {
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

  setupDropdownElement() {
    this.dropdownElement.className = 'layer-dropdown';
  }

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
  layerWidgets = new Map<ManagedUserLayer, LayerWidget>();
  private layerUpdateNeeded = true;
  private valueUpdateNeeded = false;
  private addButton: HTMLButtonElement;
  private dropZone: HTMLDivElement;

  get layerManager() {
    return this.manager.layerManager;
  }

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
    let dropZone = this.dropZone = document.createElement('div');
    dropZone.className = 'neuroglancer-layer-panel-drop-zone';

    this.registerEventListener(addButton, 'click', () => {
      this.addLayerMenu();
    });
    element.appendChild(addButton);
    element.appendChild(dropZone);
    this.update();

    this.registerEventListener(element, 'dragleave', (event: DragEvent) => {
      if (event.relatedTarget && element.contains(<Node>event.relatedTarget)) {
        return;
      }
      if (dropTargetWidget !== undefined) {
        if (dragSourceWidget === undefined) {
          dropTargetWidget.panel.layerManager.removeManagedLayer(dropTargetWidget.layer);
        }
        dropTargetWidget = undefined;
      }
    });
    this.registerDisposer(registerDropHandlers(this, addButton, undefined));
    this.registerDisposer(registerDropHandlers(this, dropZone, undefined));
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
        container.insertBefore(widget.element, nextChild);
      }
      nextChild = element.nextElementSibling;
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
}
