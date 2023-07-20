/**
 * @license
 * Copyright 2019 Google Inc.
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

import './channel_dimensions_widget.css';

import {CoordinateSpace, CoordinateSpaceCombiner, DimensionId, getDisplayLowerUpperBounds, insertDimensionAt} from 'neuroglancer/coordinate_transform';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {arraysEqual} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {updateChildren, updateInputFieldWidth} from 'neuroglancer/util/dom';
import {KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {EventActionMap} from 'neuroglancer/util/mouse_bindings';

const inputEventMap = EventActionMap.fromObject({
  'arrowup': {action: 'tab-backward'},
  'arrowdown': {action: 'tab-forward'},
  'tab': {action: 'tab-forward'},
  'shift+tab': {action: 'tab-backward'},
  'enter': {action: 'commit'},
  'escape': {action: 'cancel'},
});

class DimensionWidget {
  element = document.createElement('div');
  nameContainer = document.createElement('div');
  nameElement = document.createElement('input');
  lowerElement = document.createElement('div');
  upperElement = document.createElement('div');
  constructor(public id: DimensionId) {
    const {element, nameContainer, nameElement, lowerElement, upperElement} = this;
    element.classList.add('neuroglancer-channel-dimensions-widget-dim');
    nameContainer.classList.add('neuroglancer-channel-dimensions-widget-name-container');
    nameElement.classList.add('neuroglancer-channel-dimensions-widget-name');
    nameContainer.appendChild(nameElement);
    lowerElement.classList.add('neuroglancer-channel-dimensions-widget-lower');
    upperElement.classList.add('neuroglancer-channel-dimensions-widget-upper');
    element.appendChild(nameContainer);
    element.appendChild(lowerElement);
    element.appendChild(upperElement);
    nameContainer.draggable = true;
    nameElement.disabled = true;
    nameElement.spellcheck = false;
    nameElement.autocomplete = 'off';
    nameElement.required = true;
    nameElement.placeholder = ' ';
    nameContainer.title = `Drag to reorder, double click to rename.  Names ending in ' or ^ indicate dimensions local to the layer; names ending in ^ indicate channel dimensions (image layers only).`;
    nameContainer.addEventListener('dblclick', () => {
      nameElement.disabled = false;
      nameElement.focus();
      nameElement.select();
    });
    nameElement.addEventListener('focus', () => {
      nameElement.select();
    });
  }
}

export class ChannelDimensionsWidget extends RefCounted {
  element = document.createElement('div');
  private dimensionWidgets: DimensionWidget[] = [];
  private curCoordinateSpace: CoordinateSpace|undefined = undefined;
  private dragSource: DimensionWidget|undefined = undefined;
  private reorderDimensionTo(targetIndex: number, sourceIndex: number) {
    if (targetIndex === sourceIndex) return;
    const {coordinateSpace} = this;
    coordinateSpace.value = insertDimensionAt(coordinateSpace.value, targetIndex, sourceIndex);
  }

  coordinateSpace = this.combiner.combined;

  constructor(public combiner: CoordinateSpaceCombiner) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-channel-dimensions-widget');
    const debouncedUpdateView =
        this.registerCancellable(animationFrameDebounce(() => this.updateView()));
    this.registerDisposer(combiner.combined.changed.add(debouncedUpdateView));
    const keyboardHandler = this.registerDisposer(new KeyboardEventBinder(element, inputEventMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    this.registerDisposer(registerActionListener(element, 'cancel', event => {
      this.forceUpdateView();
      const {target} = event;
      if (target instanceof HTMLElement) {
        target.blur();
      }
    }));
    this.updateView();
  }

  private makeNewDimensionWidget(id: DimensionId) {
    const widget = new DimensionWidget(id);
    widget.nameContainer.addEventListener('dragstart', (event: DragEvent) => {
      this.dragSource = widget;
      event.stopPropagation();
      event.dataTransfer!.setData('neuroglancer-dimension', '');
    });
    widget.nameContainer.addEventListener('dragenter', (event: DragEvent) => {
      const {dragSource} = this;
      if (dragSource === undefined || dragSource === widget) return;
      const {dimensionWidgets} = this;
      const sourceIndex = dimensionWidgets.indexOf(dragSource);
      const targetIndex = dimensionWidgets.indexOf(widget);
      if (sourceIndex === -1 || targetIndex === -1) return;
      event.preventDefault();
      this.reorderDimensionTo(targetIndex, sourceIndex);
    });
    widget.nameContainer.addEventListener('dragend', (event: DragEvent) => {
      event;
      if (this.dragSource === widget) {
        this.dragSource = undefined;
      }
    });
    widget.nameElement.addEventListener('blur', event => {
      widget.nameElement.disabled = true;
      const {relatedTarget} = event;
      if (this.dimensionWidgets.some(widget => widget.nameElement === relatedTarget)) {
        return;
      }
      if (!this.updateNames()) {
        this.forceUpdateView();
      }
    });
    widget.nameElement.addEventListener('input', () => {
      const {nameElement} = widget;
      updateInputFieldWidth(nameElement);
      this.updateNameValidity();
    });
    registerActionListener(widget.nameElement, 'commit', () => {
      this.updateNames();
    });
    registerActionListener<Event>(
        widget.nameElement, 'tab-forward', event => this.selectAdjacentField(event, widget, +1));
    registerActionListener<Event>(
        widget.nameElement, 'tab-backward', event => this.selectAdjacentField(event, widget, -1));
    return widget;
  }

  private selectAdjacentField(event: Event, widget: DimensionWidget, dir: number) {
    event.stopPropagation();
    const {dimensionWidgets} = this;
    const dimIndex = dimensionWidgets.indexOf(widget);
    if (dimIndex === -1) return;
    const nextIndex = dimIndex + dir;
    if (nextIndex < 0 || nextIndex >= dimensionWidgets.length) return;
    const nextWidget = dimensionWidgets[nextIndex];
    nextWidget.nameElement.disabled = false;
    nextWidget.nameElement.focus();
    event.preventDefault();
  }

  private updateNames() {
    const {dimensionWidgets, coordinateSpace} = this;
    const existing = coordinateSpace.value;
    const names = dimensionWidgets.map(x => x.nameElement.value);
    if (this.combiner.getRenameValidity(names).includes(false)) return false;
    const existingNames = existing.names;
    if (arraysEqual(existingNames, names)) return false;
    const timestamps =
        existing.timestamps.map((t, i) => (existingNames[i] === names[i]) ? t : Date.now());
    const newSpace = {...existing, names, timestamps};
    coordinateSpace.value = newSpace;
    return true;
  }

  private updateNameValidity() {
    const {dimensionWidgets} = this;
    const names = dimensionWidgets.map(w => w.nameElement.value);
    const rank = names.length;
    const isValid = this.combiner.getRenameValidity(names);
    for (let i = 0; i < rank; ++i) {
      dimensionWidgets[i].nameElement.dataset.isValid = (isValid[i] === false) ? 'false' : 'true';
    }
  }

  private forceUpdateView() {
    this.curCoordinateSpace = undefined;
    this.updateView();
  }

  private updateView() {
    const {coordinateSpace: {value: coordinateSpace}} = this;
    if (this.curCoordinateSpace === coordinateSpace) return;
    this.curCoordinateSpace = coordinateSpace;
    const {element} = this;
    const oldDimensionWidgets = this.dimensionWidgets;
    const dimensionWidgets = this.dimensionWidgets = coordinateSpace.ids.map(
        id => oldDimensionWidgets.find(x => x.id === id) || this.makeNewDimensionWidget(id));
    function* getChildren(this: ChannelDimensionsWidget) {
      const {names, rank, bounds} = coordinateSpace;
      for (let i = 0; i < rank; ++i) {
        const widget = dimensionWidgets[i];
        widget.nameElement.value = names[i];
        delete widget.nameElement.dataset.isValid;
        updateInputFieldWidth(widget.nameElement);
        const [lower, upper] = getDisplayLowerUpperBounds(bounds, i);
        widget.lowerElement.textContent = lower.toString();
        widget.upperElement.textContent = upper.toString();
        yield widget.element;
      }
    }
    updateChildren(element, getChildren.call(this));
  }
}
