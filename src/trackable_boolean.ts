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

import { debounce } from "lodash-es";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

export class TrackableBoolean implements Trackable {
  get value() {
    return this.value_;
  }
  set value(newValue: boolean) {
    if (newValue !== this.value_) {
      this.value_ = newValue;
      this.changed.dispatch();
    }
  }
  toggle() {
    this.value = !this.value;
  }
  changed = new NullarySignal();
  constructor(
    private value_: boolean,
    public defaultValue: boolean = value_,
  ) {}
  toJSON() {
    const { value_ } = this;
    if (value_ === this.defaultValue) {
      return undefined;
    }
    return this.value_;
  }
  restoreState(x: any) {
    if (x === true || x === false) {
      this.value = x;
      return;
    }
    this.value = this.defaultValue;
  }
  reset() {
    this.value = this.defaultValue;
  }
}

/**
 * @param model: A watchable value that is used to track the checkbox state.
 * @param options.enabledTitle: Optional title to show when the checkbox is checked.
 * @param options.disabledTitle: Optional title to show when the checkbox is unchecked.
 */
export class TrackableBooleanCheckbox extends RefCounted {
  element = document.createElement("input");
  constructor(
    public model: WatchableValueInterface<boolean>,
    options: {
      enabledTitle?: string;
      disabledTitle?: string;
    } = {},
  ) {
    super();
    const { element } = this;
    element.type = "checkbox";

    const updateCheckbox = () => {
      const value = this.model.value;
      this.element.checked = value;
      if (
        options.enabledTitle !== undefined ||
        options.disabledTitle !== undefined
      ) {
        this.element.title =
          (value ? options.enabledTitle : options.disabledTitle) ?? "";
      }
    };

    this.registerDisposer(model.changed.add(updateCheckbox));
    updateCheckbox();
    this.registerEventListener(
      element,
      "change",
      function (this: typeof element, _e: Event) {
        model.value = this.checked;
      },
    );

    // Prevent the checkbox from becoming focused.
    element.addEventListener("mousedown", (event: MouseEvent) => {
      event.preventDefault();
    });
  }

  disposed() {
    const { element } = this;
    const { parentElement } = element;
    if (parentElement) {
      parentElement.removeChild(element);
    }
    super.disposed();
  }
}

export class ElementVisibilityFromTrackableBoolean extends RefCounted {
  private initialDisplay: string;
  constructor(
    public model: WatchableValueInterface<boolean>,
    public element: HTMLElement,
  ) {
    super();
    this.initialDisplay = this.element.style.display;
    this.updateVisibility();
    this.registerDisposer(
      model.changed.add(
        this.registerCancellable(debounce(() => this.updateVisibility(), 0)),
      ),
    );
  }

  updateVisibility() {
    this.element.style.display = this.model.value
      ? this.initialDisplay
      : "none";
  }
}
