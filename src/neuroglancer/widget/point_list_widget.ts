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

/**
 * @file
 * Defines a widget for displaying a list of point locations.
 */

import {AnnotationPointColorList} from 'neuroglancer/annotation/point_color_list';
import {AnnotationPointList} from 'neuroglancer/annotation/point_list';
import {AnnotationPointSizeList} from 'neuroglancer/annotation/point_size_list';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {TrackableValue, WatchableValue} from 'neuroglancer/trackable_value';
import {TrackableVec3} from 'neuroglancer/trackable_vec3';
import {hexToRgb, rgbToHex} from 'neuroglancer/util/colorspace';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {Signal} from 'neuroglancer/util/signal';

require('neuroglancer/noselect.css');
require('./point_list_widget.css');

export class PointListWidget extends RefCounted {
  element = document.createElement('div');
  private clearButton = document.createElement('button');
  private defaultSizeInput = document.createElement('input');
  private defaultColorInput = document.createElement('input');
  private itemContainer = document.createElement('div');
  generation = -1;
  pointSelected = new Signal<(index: number) => void>();
  private visible_ = false;

  constructor(
      public pointList: AnnotationPointList, public colorList: AnnotationPointColorList,
      public sizeList: AnnotationPointSizeList, public selectionIndex: WatchableValue<number|null>,
      public usePerspective2D: TrackableBoolean, public usePerspective3D: TrackableBoolean,
      public defaultSize: TrackableValue<number>, public defaultColor: TrackableVec3) {
    super();
    let {element, clearButton, itemContainer, defaultSizeInput, defaultColorInput} = this;
    element.className = 'neuroglancer-point-list-widget';
    clearButton.className = 'neuroglancer-clear-button';
    clearButton.textContent = 'Delete all points';
    this.registerEventListener(clearButton, 'click', () => {
      this.pointList.reset();
      this.colorList.reset();
      this.sizeList.reset();
    });
    element.appendChild(clearButton);
    {
      const checkbox = this.registerDisposer(new TrackableBooleanCheckbox(usePerspective2D));
      checkbox.element.className = 'neuroglancer-perspective-checkbox';
      const label = document.createElement('label');
      label.className = 'neuroglancer-perspective-checkbox';
      label.appendChild(document.createTextNode('Perspective Scaling (2D)'));
      label.appendChild(checkbox.element);
      element.appendChild(label);
    }
    {
      const checkbox = this.registerDisposer(new TrackableBooleanCheckbox(usePerspective3D));
      checkbox.element.className = 'neuroglancer-perspective-checkbox';
      const label = document.createElement('label');
      label.className = 'neuroglancer-perspective-checkbox';
      label.appendChild(document.createTextNode('Perspective Scaling (3D)'));
      label.appendChild(checkbox.element);
      element.appendChild(label);
    }
    {
      defaultSizeInput.type = 'number';
      defaultSizeInput.min = '1';
      this.registerDisposer(defaultSize.changed.add(() => {
        this.updateSizeInput();
      }));
      this.updateSizeInput();
      this.registerEventListener(defaultSizeInput, 'input', () => {
        defaultSize.value = parseFloat(defaultSizeInput.value);
        defaultSize.changed.dispatch();
      });
      const div = document.createElement('div');
      div.className = 'neuroglancer-defaultsize-input-container';
      const label = document.createElement('label');
      label.appendChild(document.createTextNode('Default Size'));
      label.htmlFor = 'neuroglancer-defaultsize-input';
      defaultSizeInput.id = 'neuroglancer-defaultsize-input';
      div.appendChild(label);
      div.appendChild(defaultSizeInput);
      element.appendChild(div);
    }
    {
      defaultColorInput.type = 'color';
      this.registerDisposer(defaultColor.changed.add(() => {
        this.updateColorInput();
      }));
      this.updateColorInput();
      this.registerEventListener(defaultColorInput, 'input', () => {
        hexToRgb(defaultColor.value, defaultColorInput.value);
        defaultColor.changed.dispatch();
      });
      const div = document.createElement('div');
      div.className = 'neuroglancer-defaultcolor-input-container';
      const label = document.createElement('label');
      label.appendChild(document.createTextNode('Default Color'));
      label.htmlFor = 'neuroglancer-defaultcolor-input';
      defaultColorInput.id = 'neuroglancer-defaultcolor-input';
      div.appendChild(label);
      div.appendChild(defaultColorInput);
      element.appendChild(div);
    }
    itemContainer.className = 'neuroglancer-item-container neuroglancer-select-text';
    element.appendChild(itemContainer);
    this.registerDisposer(pointList.changed.add(() => {
      this.maybeUpdate();
    }));
  }

  get visible() {
    return this.visible_;
  }
  set visible(value: boolean) {
    if (this.visible_ !== value) {
      this.visible_ = value;
      if (value === true) {
        this.maybeUpdate();
      }
    }
  }

  updateSizeInput() {
    this.defaultSizeInput.value = this.defaultSize.value.toString();
  }

  updateColorInput() {
    let col = rgbToHex(this.defaultColor.value);
    this.defaultColorInput.value = col ? col : '#000000';
  }

  maybeUpdate() {
    if (!this.visible_) {
      return;
    }
    let {pointList} = this;
    if (this.generation === pointList.generation) {
      return;
    }
    this.generation = pointList.generation;
    let {itemContainer} = this;
    removeChildren(itemContainer);

    const {length} = pointList;
    const data = pointList.points.data;
    for (let i = 0; i < length; ++i) {
      let item = document.createElement('div');
      item.className = 'neuroglancer-point-list-item';
      let j = i * 3;
      item.textContent =
          `${Math.round(data[j])} ${Math.round(data[j + 1])} ${Math.round(data[j + 2])}`;
      item.addEventListener('click', () => {
        this.pointSelected.dispatch(i);
      });
      item.addEventListener('mouseenter', () => {
        this.selectionIndex.value = i;
      });
      item.addEventListener('mouseleave', () => {
        this.selectionIndex.value = null;
      });
      itemContainer.appendChild(item);
    }
  }

  disposed() {
    removeFromParent(this.element);
    this.element = <any>undefined;
    this.itemContainer = <any>undefined;
    this.clearButton = <any>undefined;
    this.defaultSizeInput = <any>undefined;
    this.defaultColorInput = <any>undefined;
    super.disposed();
  }
}
