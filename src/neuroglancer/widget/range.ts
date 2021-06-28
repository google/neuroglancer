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

import './range.css';

import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

export interface RangeWidgetOptions {
  min?: number;
  max?: number;
  step?: number;
}

export class RangeWidget extends RefCounted {
  element = document.createElement('label');
  inputElement = document.createElement('input');
  numericInputElement = document.createElement('input');

  constructor(
      public value: WatchableValueInterface<number>,
      {min = 0, max = 1, step = 0.01}: RangeWidgetOptions = {}) {
    super();
    let {element, inputElement, numericInputElement} = this;
    element.className = 'range-slider';
    const initInputElement = (el: HTMLInputElement) => {
      el.min = '' + min;
      el.max = '' + max;
      el.step = '' + step;
      el.valueAsNumber = this.value.value;
      this.registerEventListener(el, 'change', () => this.inputValueChanged(el));
      this.registerEventListener(el, 'input', () => this.inputValueChanged(el));
      this.registerEventListener(el, 'wheel', (event: WheelEvent) => {
        this.adjustViaWheel(el, event);
      });
    };
    inputElement.type = 'range';
    initInputElement(inputElement);
    numericInputElement.type = 'number';
    const maxNumberWidth = Math.max(
        min.toString().length, max.toString().length, Math.min(max, min + step).toString().length,
        Math.max(min, max - step).toString().length);
    numericInputElement.style.width = (maxNumberWidth + 2) + 'ch';
    initInputElement(numericInputElement);
    element.appendChild(inputElement);
    element.appendChild(numericInputElement);
    value.changed.add(() => {
      this.inputElement.valueAsNumber = this.value.value;
      this.numericInputElement.valueAsNumber = this.value.value;
    });
  }

  private inputValueChanged(element: HTMLInputElement) {
    this.value.value = element.valueAsNumber;
  }

  adjustViaWheel(element: HTMLInputElement, event: WheelEvent) {
    const el = this.inputElement;
    let {deltaY} = event;
    if (deltaY > 0) {
      el.stepUp();
      this.inputValueChanged(element);
    } else if (deltaY < 0) {
      el.stepDown();
      this.inputValueChanged(element);
    }
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
