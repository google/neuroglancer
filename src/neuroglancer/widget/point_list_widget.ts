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

import {AnnotationPointList} from 'neuroglancer/annotation/point_list';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {Signal} from 'neuroglancer/util/signal';

require('neuroglancer/noselect.css');
require('./point_list_widget.css');

export class PointListWidget extends RefCounted {
  element = document.createElement('div');
  private clearButton = document.createElement('button');
  private itemContainer = document.createElement('div');
  generation = -1;
  pointSelected = new Signal<(index: number) => void>();
  private visible_ = false;

  constructor(
      public pointList: AnnotationPointList, public selectionIndex: WatchableValue<number|null>) {
    super();
    let {element, clearButton, itemContainer} = this;
    element.className = 'neuroglancer-point-list-widget';
    clearButton.className = 'neuroglancer-clear-button';
    clearButton.textContent = 'Delete all points';
    this.registerEventListener(clearButton, 'click', () => { this.pointList.reset(); });
    itemContainer.className = 'neuroglancer-item-container neuroglancer-select-text';
    element.appendChild(clearButton);
    element.appendChild(itemContainer);
    this.registerDisposer(pointList.changed.add(() => { this.maybeUpdate(); }));
  }

  get visible() { return this.visible_; }
  set visible(value: boolean) {
    if (this.visible_ !== value) {
      this.visible_ = value;
      if (value === true) {
        this.maybeUpdate();
      }
    }
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
      item.addEventListener('click', () => { this.pointSelected.dispatch(i); });
      item.addEventListener('mouseenter', () => { this.selectionIndex.value = i; });
      item.addEventListener('mouseleave', () => { this.selectionIndex.value = null; });
      itemContainer.appendChild(item);
    }
  }

  disposed() {
    removeFromParent(this.element);
    this.element = <any>undefined;
    this.itemContainer = <any>undefined;
    this.clearButton = <any>undefined;
    super.disposed();
  }
}
