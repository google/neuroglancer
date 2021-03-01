/**
 * @license
 * Copyright 2017 Google Inc.
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

import {TrackableVec3} from 'neuroglancer/trackable_vec3';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {verifyFiniteFloat} from 'neuroglancer/util/json';
import {Signal} from 'neuroglancer/util/signal';

import './vec3.css';

export class Vec3Widget extends RefCounted {
  promptElement = document.createElement('span');
  element = document.createElement('label');
  inputx = document.createElement('input');
  inputy = document.createElement('input');
  inputz = document.createElement('input');
  valueEntered = new Signal<(value: number) => void>();

  constructor(public model: TrackableVec3) {
    super();
    let {inputx, inputy, inputz, element, promptElement} = this;

    element.className = 'vec3-input-row';
    promptElement.className = 'vec3-input-label';

    element.appendChild(promptElement);

    element.appendChild(inputx);
    element.appendChild(inputy);
    element.appendChild(inputz);

    inputx.type = inputy.type = inputz.type = 'number';
    this.updateInput();

    const inputValueChanged = () => {
      this.model.value = this.getVec3Values();
    };
    this.registerEventListener(inputx, 'change', inputValueChanged);
    this.registerEventListener(inputy, 'change', inputValueChanged);
    this.registerEventListener(inputz, 'change', inputValueChanged);

    this.model.changed.add(() => {
      this.updateInput();
    });
  }

  getVec3Values(): vec3 {
    let ret = vec3.create();
    ret[0] = this.verifyValue(this.inputx.valueAsNumber);
    ret[1] = this.verifyValue(this.inputy.valueAsNumber);
    ret[2] = this.verifyValue(this.inputz.valueAsNumber);

    return ret;
  }

  verifyValue(value: any) {
    return verifyFiniteFloat(value);
  }

  updateInput() {
    this.inputx.valueAsNumber = this.model.value[0];
    this.inputy.valueAsNumber = this.model.value[1];
    this.inputz.valueAsNumber = this.model.value[2];
  }

  disposed() {
    let {inputx, inputy, inputz, element} = this;
    if (inputx.parentElement) {
      inputx.parentElement.removeChild(inputx);
    }
    if (inputy.parentElement) {
      inputy.parentElement.removeChild(inputy);
    }
    if (inputz.parentElement) {
      inputz.parentElement.removeChild(inputz);
    }
    if (element.parentElement) {
      element.parentElement.removeChild(element);
    }
    super.disposed();
  }
}
