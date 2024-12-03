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

import type { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeFromParent } from "#src/util/dom.js";

function toDateTimeLocalString(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, -8);
}

export class DateTimeInputWidget extends RefCounted {
  element = document.createElement("input");
  constructor(
    public model: WatchableValue<number | undefined>,
    minDate?: Date,
    maxDate?: Date,
  ) {
    super();
    this.registerDisposer(model.changed.add(() => this.updateView()));
    const { element } = this;
    element.type = "datetime-local";
    if (minDate) {
      this.setMin(minDate);
    }
    if (maxDate) {
      this.setMax(maxDate);
    }
    this.registerEventListener(element, "change", () => this.updateModel());
    this.updateView();
  }

  setMin(date: Date) {
    const { element } = this;
    element.min = toDateTimeLocalString(date);
  }

  setMax(date: Date) {
    const { element } = this;
    element.max = toDateTimeLocalString(date);
  }

  disposed() {
    removeFromParent(this.element);
  }

  private updateView() {
    if (this.model.value !== undefined) {
      this.element.value = toDateTimeLocalString(new Date(this.model.value));
    } else {
      this.element.value = "";
    }
  }

  private updateModel() {
    try {
      if (this.element.value) {
        this.model.value = new Date(this.element.value).valueOf();
      } else {
        this.model.value = undefined;
      }
    } catch {
      // Ignore invalid input.
    }
    this.updateView();
  }
}
