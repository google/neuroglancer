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

import {TrackableValueInterface} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

import './range.css';

export class RangeWidget extends RefCounted {
  element = document.createElement('label');
  promptElement = document.createElement('span');
  inputElement = document.createElement('input');
  numericInputElement = document.createElement('input');

  constructor(public value: TrackableValueInterface<number>, {min = 0, max = 1, step = 0.01} = {}) {
    super();
    let {element, promptElement, inputElement, numericInputElement} = this;
    element.className = 'range-slider';
    promptElement.className = 'range-prompt';
    const initInputElement = (el: HTMLInputElement) => {
      el.min = '' + min;
      el.max = '' + max;
      el.step = '' + step;
      el.valueAsNumber = this.value.value;
      const inputValueChanged = () => {
        this.value.value = el.valueAsNumber;
      };
      this.registerEventListener(el, 'change', inputValueChanged);
      this.registerEventListener(el, 'input', inputValueChanged);
      this.registerEventListener(el, 'wheel', (event: WheelEvent) => {
        let {deltaY} = event;
        if (deltaY > 0) {
          el.stepUp();
          inputValueChanged();
        } else if (deltaY < 0) {
          el.stepDown();
          inputValueChanged();
        }
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
    element.appendChild(promptElement);
    element.appendChild(inputElement);
    element.appendChild(numericInputElement);
    value.changed.add(() => {
      this.inputElement.valueAsNumber = this.value.value;
      this.numericInputElement.valueAsNumber = this.value.value;
    });
  }
  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
