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

import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

require('./range.css');

export class RangeWidget extends RefCounted {
  element = document.createElement('label');
  promptElement = document.createElement('span');
  inputElement = document.createElement('input');

  constructor(public value: TrackableValue<number>, {min = 0, max = 1, step = 0.01} = {}) {
    super();
    let {element, promptElement, inputElement} = this;
    element.className = 'range-slider';
    promptElement.className = 'range-prompt';
    inputElement.type = 'range';
    inputElement.min = '' + min;
    inputElement.max = '' + max;
    inputElement.step = '' + step;
    inputElement.valueAsNumber = this.value.value;
    element.appendChild(promptElement);
    element.appendChild(inputElement);
    const inputValueChanged = () => {
      this.value.value = this.inputElement.valueAsNumber;
    };
    this.registerEventListener(inputElement, 'change', inputValueChanged);
    this.registerEventListener(inputElement, 'input', inputValueChanged);
    this.registerEventListener(inputElement, 'wheel', (event: WheelEvent) => {
      let {deltaY} = event;
      if (deltaY > 0) {
        this.inputElement.stepUp();
        inputValueChanged();
      } else if (deltaY < 0) {
        this.inputElement.stepDown();
        inputValueChanged();
      }
    });
    value.changed.add(() => {
      this.inputElement.valueAsNumber = this.value.value;
    });
  }
  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
