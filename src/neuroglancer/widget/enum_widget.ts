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

import {TrackableEnum} from 'neuroglancer/util/trackable_enum';
import {RefCounted} from 'neuroglancer/util/disposable';

export class EnumSelectWidget<T extends number> extends RefCounted {
  element = document.createElement('select');
  private valueIndexMap = new Map<T, number>();
  constructor (public model: TrackableEnum<T>) {
    super();
    const {element, valueIndexMap} = this;
    let index = 0;
    for (const key of Object.keys(model.enumType)) {
      if (isNaN(Number(key))) {
        const option = document.createElement('option');
        option.textContent = option.value = key.toLowerCase();
        element.appendChild(option);
        valueIndexMap.set(model.enumType[key], index);
        ++index;
      }
    }
    this.registerDisposer(model.changed.add(() => this.updateView()));
    this.registerEventListener(element, 'change', () => this.updateModel());
    this.registerEventListener(element, 'wheel', (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.adjustViaWheel(event);
    });
    this.updateView();
  }

  adjustViaWheel(event: WheelEvent) {
    const {element} = this;
    let {deltaY} = event;
    if (deltaY > 0) {
      element.selectedIndex =
          (element.options.length + element.selectedIndex - 1) % element.options.length;
      this.updateModel();
    } else if (deltaY < 0) {
      element.selectedIndex =
          (element.options.length + element.selectedIndex + 1) % element.options.length;
      this.updateModel();
    }
  }

  private updateView() {
    const {element} = this;
    element.selectedIndex = this.valueIndexMap.get(this.model.value)!;
  }

  private updateModel() {
    this.model.restoreState(this.element.value);
  }
}
