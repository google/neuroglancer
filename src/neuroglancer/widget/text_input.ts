/**
 * @license
 * Copyright 2020 Google Inc.
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

export class TextInputWidget<T> extends RefCounted {
  element = document.createElement('input');
  constructor(public model: TrackableValueInterface<T>) {
    super();
    this.registerDisposer(model.changed.add(() => this.updateView()));
    const {element} = this;
    element.type = 'text';
    this.registerEventListener(element, 'change', () => this.updateModel());
    this.updateView();
  }

  disposed() {
    removeFromParent(this.element);
  }

  private updateView() {
    this.element.value = (this.model.value ?? '') + '';
  }

  private updateModel() {
    try {
      this.model.restoreState(this.element.value);
    } catch {
    }
    this.updateView();
  }
}
