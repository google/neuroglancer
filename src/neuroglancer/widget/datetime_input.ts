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

function toDateTimeLocalString(date: Date) {
  return date.toISOString().slice(0, -8);
}

export class DateTimeInputWidget<T> extends RefCounted {
  element = document.createElement('input');
  constructor(public model: TrackableValueInterface<string>, min?: Date, max?: Date) {
    super();
    this.registerDisposer(model.changed.add(() => this.updateView()));
    const {element} = this;
    element.type = 'datetime-local';
    if (min) {
      this.setMin(min);
    }
    if (max) {
      this.setMax(max);
    }
    this.registerEventListener(element, 'change', () => this.updateModel());
    this.updateView();
  }

  setMin(date: Date) {
    const {element} = this;
    element.min = toDateTimeLocalString(date);
  }

  setMax(date: Date) {
    const {element} = this;
    element.max = toDateTimeLocalString(date);
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
