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

import svg_close from "ikonate/icons/close.svg?raw";
import { AutomaticallyFocusedElement } from "#src/util/automatic_focus.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  EventActionMap,
  KeyboardEventBinder,
} from "#src/util/keyboard_bindings.js";
import "#src/overlay.css";
import { makeIcon } from "#src/widget/icon.js";

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
    container.className = "neuroglancer-overlay";
    const content = (this.content = document.createElement("div"));
    this.registerDisposer(new AutomaticallyFocusedElement(content));
    content.className = "neuroglancer-overlay-content";
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

/**
 * A dialog that has a header, body, and footer.
 * The header contains a title and a close icon.
 * The footer contains a primary button.
 * The body is where the main content goes.
 * @param title - The title text to display in the header
 * @param primaryButtonText - The text to display on the primary button
 * @param extraClassPrefix - Optional CSS class prefix to add to all dialog elements
 * @param onPrimaryButtonClick - Optional callback function to execute when primary button is clicked. Provide null to give no action.
 */

export class FramedDialog extends Overlay {
  header: HTMLDivElement;
  headerTitle: HTMLSpanElement;
  closeMenuIcon: HTMLElement;
  primaryButton: HTMLButtonElement;
  body: HTMLDivElement;
  footer: HTMLDivElement;
  constructor(
    title: string = "Dialog",
    primaryButtonText: string = "Close",
    extraClassPrefix?: string,
    onPrimaryButtonClick?: () => void | null,
  ) {
    super();

    const header = (this.header = document.createElement("div"));
    const closeMenuIcon = (this.closeMenuIcon = makeIcon({ svg: svg_close }));
    this.registerEventListener(closeMenuIcon, "click", () => this.close());
    const headerTitle = (this.headerTitle = document.createElement("span"));
    headerTitle.textContent = title;
    header.appendChild(headerTitle);
    header.appendChild(closeMenuIcon);
    this.content.appendChild(header);

    const body = (this.body = document.createElement("div"));
    this.content.appendChild(body);

    const footer = (this.footer = document.createElement("div"));
    const primaryButton = (this.primaryButton =
      document.createElement("button"));
    primaryButton.textContent = primaryButtonText;
    if (onPrimaryButtonClick === undefined) {
      this.registerEventListener(primaryButton, "click", () => this.close());
    } else if (onPrimaryButtonClick !== null) {
      this.registerEventListener(primaryButton, "click", onPrimaryButtonClick);
    }
    footer.appendChild(primaryButton);
    this.content.appendChild(this.footer);

    const classPrefixes = ["neuroglancer-framed-dialog", extraClassPrefix];
    for (const classPrefix of classPrefixes) {
      if (classPrefix !== undefined) {
        this.content.classList.add(`${classPrefix}`);
        this.header.classList.add(`${classPrefix}-header`);
        this.headerTitle.classList.add(`${classPrefix}-title`);
        this.closeMenuIcon.classList.add(`${classPrefix}-close-icon`);
        this.body.classList.add(`${classPrefix}-body`);
        this.footer.classList.add(`${classPrefix}-footer`);
        this.primaryButton.classList.add(`${classPrefix}-primary-button`);
      }
    }
  }
}
