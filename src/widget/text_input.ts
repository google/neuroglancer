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

import type { TrackableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeFromParent } from "#src/util/dom.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import {
  KeyboardEventBinder,
  registerActionListener,
} from "#src/util/keyboard_bindings.js";

const inputEventMap = EventActionMap.fromObject({
  escape: { action: "cancel" },
});

export class TextInputWidget<T> extends RefCounted {
  element = document.createElement("input");
  constructor(public model: TrackableValueInterface<T>) {
    super();
    this.registerDisposer(model.changed.add(() => this.updateView()));
    const { element } = this;
    element.type = "text";
    element.spellcheck = false;
    element.autocomplete = "off";
    const keyboardHandler = this.registerDisposer(
      new KeyboardEventBinder(element, inputEventMap),
    );
    keyboardHandler.allShortcutsAreGlobal = true;
    registerActionListener(element, "cancel", (event) => {
      this.updateView();
      element.blur();
      event.stopPropagation();
      event.preventDefault();
    });
    this.registerEventListener(element, "change", () => this.updateModel());
    this.registerEventListener(element, "blur", () => this.updateModel());
    this.updateView();
  }

  disposed() {
    removeFromParent(this.element);
  }

  private updateView() {
    this.element.value = (this.model.value ?? "") + "";
  }

  private updateModel() {
    try {
      this.model.restoreState(this.element.value);
    } catch {
      // Ignore invalid input.
    }
    this.updateView();
  }
}
