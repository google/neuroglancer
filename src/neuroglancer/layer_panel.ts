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

import 'neuroglancer/noselect.css';
import './layer_panel.css';

import svg_plus from 'ikonate/icons/plus.svg';
import {DisplayContext} from 'neuroglancer/display_context';
import {addNewLayer, LayerListSpecification, ManagedUserLayer, SelectedLayerState,} from 'neuroglancer/layer';
import {LinkedViewerNavigationState} from 'neuroglancer/layer_group_viewer';
import {NavigationLinkType} from 'neuroglancer/navigation_state';
import {DropLayers, endLayerDrag, getDropLayers, getLayerDropEffect, startLayerDrag} from 'neuroglancer/ui/layer_drag_and_drop';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {RefCounted, registerEventListener} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {getDropEffect, preventDrag, setDropEffect} from 'neuroglancer/util/drag_and_drop';
import {float32ToString} from 'neuroglancer/util/float32_to_string';
import {makeCloseButton} from 'neuroglancer/widget/close_button';
import {makeIcon} from 'neuroglancer/widget/icon';
import {PositionWidget} from 'neuroglancer/widget/position_widget';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';

function destroyDropLayers(dropLayers: DropLayers, targetLayer?: ManagedUserLayer) {
  if (dropLayers.method === 'move') {
    // Nothing to do.
    return false;
  }
  dropLayers.manager.layerManager.filter(layer => !dropLayers.layers.has(layer));
  return targetLayer !== undefined && dropLayers.layers.has(targetLayer);
}

function registerDropHandlers(
    panel: LayerPanel, target: EventTarget, targetLayer: ManagedUserLayer|undefined) {
  function update(event: DragEvent, updateDropEffect: boolean): DropLayers|undefined {
    let dropLayers = panel.dropLayers;
    const dropEffect =
        updateDropEffect ? getLayerDropEffect(event, panel.manager) : getDropEffect();
    let existingDropLayers = true;
    if (dropLayers !== undefined) {
      if (updateDropEffect) {
        setDropEffect(event, dropEffect);
      }
      if (!dropLayers.compatibleWithMethod(dropEffect)) {
        panel.dropLayers = undefined;
        if (destroyDropLayers(dropLayers, targetLayer)) {
          // We destroyed the layer for which we received the dragenter event.  Wait until we get
          // another dragenter or drop event to do something.
          return undefined;
        }
      }
    }
    if (dropLayers === undefined) {
      dropLayers = panel.dropLayers = getDropLayers(
          event, panel.manager, /*forceCopy=*/ dropEffect === 'copy', /*allowMove=*/ true,
          /*newTarget=*/ false);
      if (dropLayers === undefined) {
        return undefined;
      }
      existingDropLayers = dropLayers.method === 'move';
    }

    // Dragged onto itself, nothing to do.
    if (targetLayer !== undefined && dropLayers.layers.has(targetLayer)) {
      return dropLayers;
    }
    if (!existingDropLayers) {
      let newIndex: number|undefined;
      if (targetLayer !== undefined) {
        newIndex = panel.manager.layerManager.managedLayers.indexOf(targetLayer);
      }
      for (const newLayer of dropLayers.layers.keys()) {
        panel.manager.add(newLayer, newIndex);
      }
    } else {
      // Rearrange layers.
      const {layerManager} = panel.manager;
      const existingLayers = new Set<ManagedUserLayer>();
      let firstRemovalIndex = Number.POSITIVE_INFINITY;
      const managedLayers = layerManager.managedLayers =
          layerManager.managedLayers.filter((x: ManagedUserLayer, index) => {
            if (dropLayers!.layers.has(x)) {
              if (firstRemovalIndex === Number.POSITIVE_INFINITY) {
                firstRemovalIndex = index;
              }
              existingLayers.add(x);
              return false;
            } else {
              return true;
            }
          });
      let newIndex: number;
      if (targetLayer !== undefined) {
        newIndex = managedLayers.indexOf(targetLayer);
        if (firstRemovalIndex <= newIndex) {
          ++newIndex;
        }
      } else {
        newIndex = managedLayers.length;
      }
      // Filter out layers that have been concurrently removed.
      for (const layer of dropLayers.layers.keys()) {
        if (!existingLayers.has(layer)) {
          dropLayers.layers.delete(layer);
        }
      }
      managedLayers.splice(newIndex, 0, ...dropLayers.layers.keys());
      layerManager.layersChanged.dispatch();
    }
    return dropLayers;
  }
  const enterDisposer = registerEventListener(target, 'dragenter', (event: DragEvent) => {
    if (update(event, /*updateDropEffect=*/ true) !== undefined) {
      event.preventDefault();
    }
  });
  const dropDisposer = registerEventListener(target, 'drop', (event: DragEvent) => {
    event.preventDefault();
    const dropLayers = update(event, /*updateDropEffect=*/ false);
    if (dropLayers !== undefined) {
      if (!dropLayers.finalize(event)) {
        destroyDropLayers(dropLayers);
      } else {
        event.dataTransfer!.dropEffect = getDropEffect();
        endLayerDrag(dropLayers.method === 'move' ? undefined : event);
      }
    }
    panel.dropLayers = undefined;
  });
  const overDisposer = registerEventListener(target, 'dragover', (event: DragEvent) => {
    const dropLayers = update(event, /*updateDropEffect=*/ true);
    if (dropLayers === undefined) {
      return;
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
  element: HTMLElement;
  layerNumberElement: HTMLSpanElement;
  labelElement: HTMLSpanElement;
  valueElement: HTMLSpanElement;

  constructor(public layer: ManagedUserLayer, public panel: LayerPanel) {
    super();
    let element = this.element = document.createElement('div');
    element.title = 'Control+click for layer options, drag to move/copy.';
    element.className = 'neuroglancer-layer-item neuroglancer-noselect';
    let labelElement = this.labelElement = document.createElement('span');
    labelElement.className = 'neuroglancer-layer-item-label';
    let layerNumberElement = this.layerNumberElement = document.createElement('span');
    layerNumberElement.className = 'neuroglancer-layer-item-number';
    let valueElement = this.valueElement = document.createElement('span');
    valueElement.className = 'neuroglancer-layer-item-value';
    const closeElement = makeCloseButton();
    closeElement.title = 'Remove layer from this layer group';
    this.registerEventListener(closeElement, 'click', (event: MouseEvent) => {
      this.panel.layerManager.removeManagedLayer(this.layer);
      event.stopPropagation();
    });
    element.appendChild(layerNumberElement);
    element.appendChild(labelElement);
    element.appendChild(valueElement);
    const positionWidget = this.registerDisposer(new PositionWidget(
        layer.localPosition, layer.localCoordinateSpaceCombiner, {copyButton: false}));
    element.appendChild(positionWidget.element);
    positionWidget.element.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation();
    });
    positionWidget.element.addEventListener('dblclick', (event: MouseEvent) => {
      event.stopPropagation();
    });
    element.appendChild(closeElement);
    this.registerEventListener(element, 'click', (event: MouseEvent) => {
      if (event.ctrlKey) {
        panel.selectedLayer.layer = layer;
        panel.selectedLayer.visible = true;
      } else {
        layer.setVisible(!layer.visible);
      }
    });

    this.registerEventListener(element, 'contextmenu', (event: MouseEvent) => {
      panel.selectedLayer.layer = layer;
      panel.selectedLayer.visible = true;
      event.stopPropagation();
      event.preventDefault();
    });

    element.draggable = true;
    this.registerEventListener(element, 'dragstart', (event: DragEvent) => {
      startLayerDrag(
          event,
          {manager: panel.manager, layers: [this.layer], layoutSpec: panel.getLayoutSpecForDrag()});
      event.stopPropagation();
    });

    this.registerEventListener(element, 'dragend', (event: DragEvent) => {
      endLayerDrag(event);
    });

    this.registerDisposer(registerDropHandlers(this.panel, element, this.layer));
  }

  update() {
    let {layer} = this;
    this.labelElement.textContent = layer.name;
    this.element.setAttribute('layer-visible', layer.visible.toString());
    this.element.setAttribute(
        'layer-selected', (layer === this.panel.selectedLayer.layer).toString());
  }

  disposed() {
    this.element.parentElement!.removeChild(this.element);
    super.disposed();
  }
}

export class LayerPanel extends RefCounted {
  layerWidgets = new Map<ManagedUserLayer, LayerWidget>();
  element = document.createElement('div');
  private layerUpdateNeeded = true;
  private valueUpdateNeeded = false;
  dropZone: HTMLDivElement;
  private layerWidgetInsertionPoint = document.createElement('div');
  private positionWidget = this.registerDisposer(new PositionWidget(
      this.viewerNavigationState.position.value, this.manager.root.coordinateSpaceCombiner));
  /**
   * For use within this module only.
   */
  dropLayers: DropLayers|undefined;

  get layerManager() {
    return this.manager.layerManager;
  }

  constructor(
      public display: DisplayContext, public manager: LayerListSpecification,
      public viewerNavigationState: LinkedViewerNavigationState,
      public selectedLayer: SelectedLayerState, public getLayoutSpecForDrag: () => any,
      public showLayerHoverValues: WatchableValueInterface<boolean>) {
    super(); 
    this.registerDisposer(selectedLayer);
    const {element} = this;
    element.className = 'neuroglancer-layer-panel';
    this.registerDisposer(manager.layerSelectedValues.changed.add(() => {
      this.handleLayerValuesChanged();
    }));
    this.registerDisposer(manager.layerManager.layersChanged.add(() => {
      this.handleLayersChanged();
    }));
    this.registerDisposer(selectedLayer.changed.add(() => {
      this.handleLayersChanged();
    }));
    this.registerDisposer(showLayerHoverValues.changed.add(() => {
      this.handleLayerItemValueChanged();
    }));
    this.element.dataset.showHoverValues = this.showLayerHoverValues.value.toString()
    this.layerWidgetInsertionPoint.style.display = 'none';
    this.element.appendChild(this.layerWidgetInsertionPoint);

    let addButton = makeIcon({
      svg: svg_plus,
      title: 'Click to add layer, control+click/right click/⌘+click to add local annotation layer.',
    });
    addButton.classList.add('neuroglancer-layer-add-button');

    let dropZone = this.dropZone = document.createElement('div');
    dropZone.className = 'neuroglancer-layer-panel-drop-zone';

    const addLayer = (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey || event.type === 'contextmenu') {
        const layer = new ManagedUserLayer('annotation', {}, this.manager);
        this.manager.initializeLayerFromSpec(
            layer, {type: 'annotation', 'source': 'local://annotations'});
        this.manager.add(layer);
        this.selectedLayer.layer = layer;
        this.selectedLayer.visible = true;
      } else {
        this.addLayerMenu();
      }
    };
    this.registerEventListener(addButton, 'click', addLayer);
    this.registerEventListener(addButton, 'contextmenu', addLayer);
    element.appendChild(addButton);
    element.appendChild(dropZone);
    this.registerDisposer(preventDrag(addButton));

    element.appendChild(this.positionWidget.element);
    const updatePositionWidgetVisibility = () => {
      const linkValue = this.viewerNavigationState.position.link.value;
      this.positionWidget.element.style.display =
          linkValue === NavigationLinkType.LINKED ? 'none' : null;
    };
    this.registerDisposer(
        this.viewerNavigationState.position.link.changed.add(updatePositionWidgetVisibility));
    updatePositionWidgetVisibility();

    this.update();

    this.registerEventListener(element, 'dragleave', (event: DragEvent) => {
      if (event.relatedTarget && element.contains(<Node>event.relatedTarget)) {
        return;
      }
      const {dropLayers} = this;
      if (dropLayers !== undefined) {
        destroyDropLayers(dropLayers);
        this.dropLayers = undefined;
      }
    });
    this.registerDisposer(registerDropHandlers(this, addButton, undefined));
    this.registerDisposer(registerDropHandlers(this, dropZone, undefined));

    // Ensure layer widgets are updated before WebGL drawing starts; we don't want the layout to
    // change after WebGL drawing or we will get flicker.
    this.registerDisposer(display.updateStarted.add(() => this.updateLayers()));
  }

  disposed() {
    this.layerWidgets.forEach(x => x.dispose());
    this.layerWidgets = <any>undefined;
    removeFromParent(this.element);
    super.disposed();
  }

  handleLayersChanged() {
    this.layerUpdateNeeded = true;
    this.handleLayerValuesChanged();
  }

  handleLayerValuesChanged() {
    if (!this.valueUpdateNeeded) {
      this.valueUpdateNeeded = true;
      this.scheduleUpdate();
    }
  }

  handleLayerItemValueChanged(){
    this.element.dataset.showHoverValues = this.showLayerHoverValues.value.toString()
  }

  private scheduleUpdate = this.registerCancellable(animationFrameDebounce(() => this.update()));

  private update() {
    this.valueUpdateNeeded = false;
    this.updateLayers();
    if (this.showLayerHoverValues.value === false){
      return}
    let values = this.manager.layerSelectedValues;
    for (let [layer, widget] of this.layerWidgets) {
      let userLayer = layer.layer;
      let text = '';
      if (userLayer !== null) {
        let value = values.get(userLayer);
        if (value !== undefined) {
          value = Array().concat(value);
          value = value.map((x: any) => {
            if (x === null) {
              return 'null';
            } else if (Math.fround(x) === x) {
              // FIXME: Verify actual layer data type
              return float32ToString(x);
            } else {
              return x;
            }
          });
          text += value.join(', ');
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
    let nextChild = this.layerWidgetInsertionPoint.nextElementSibling;
    this.manager.layerManager.managedLayers.forEach((layer: ManagedUserLayer) => {
      layers.add(layer);
      let widget = this.layerWidgets.get(layer);
      const layerIndex = this.manager.rootLayers.managedLayers.indexOf(layer);
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
    addNewLayer(this.manager, this.selectedLayer);
  }
}

