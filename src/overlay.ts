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

import { AutomaticallyFocusedElement } from "#src/util/automatic_focus.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  EventActionMap,
  KeyboardEventBinder,
} from "#src/util/keyboard_bindings.js";
import "#src/overlay.css";

export const overlayKeyboardHandlerPriority = 100;

export let overlaysOpen = 0;

export const defaultEventMap = EventActionMap.fromObject({
  escape: { action: "close" },
});

export class Overlay extends RefCounted {
  container: HTMLDivElement;
  content: HTMLDivElement;
  keyMap = new EventActionMap();
  constructor() {
    super();
    this.keyMap.addParent(defaultEventMap, Number.NEGATIVE_INFINITY);
    ++overlaysOpen;
    const container = (this.container = document.createElement("div"));
    container.className = "overlay";
    const content = (this.content = document.createElement("div"));
    this.registerDisposer(new AutomaticallyFocusedElement(content));
    content.className = "overlay-content";
    container.appendChild(content);
    document.body.appendChild(container);
    this.registerDisposer(new KeyboardEventBinder(this.container, this.keyMap));
    this.registerEventListener(container, "action:close", () => {
      this.close();
    });
    content.focus();
  }

  close() {
    this.dispose();
  }

  disposed() {
    --overlaysOpen;
    document.body.removeChild(this.container);
    super.disposed();
  }
}
