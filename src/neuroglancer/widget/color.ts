/**
 * @license
 * Copyright 2018 Google Inc.
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

import {TrackableRGB} from 'neuroglancer/util/color';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

export class ColorWidget extends RefCounted {
  element = document.createElement('input');

  constructor(public model: TrackableRGB) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-color-widget');
    element.type = 'color';
    element.addEventListener('change', () => this.updateModel());
    this.registerDisposer(model.changed.add(() => this.updateView()));
    this.updateView();
  }
  private updateView() {
    this.element.value = this.model.toString();
  }
  private updateModel() {
    this.model.restoreState(this.element.value);
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
