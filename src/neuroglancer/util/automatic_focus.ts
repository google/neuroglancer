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

import debounce from 'lodash/debounce';
import {RefCounted} from 'neuroglancer/util/disposable';
import LinkedListOperations from 'neuroglancer/util/linked_list.0.ts';

class AutomaticFocusList {
  next0: AutomaticallyFocusedElement|null;
  prev0: AutomaticallyFocusedElement|null;

  constructor() {
    LinkedListOperations.initializeHead(<any>this);
  }
}

const automaticFocusList = new AutomaticFocusList();

const maybeUpdateFocus = debounce(() => {
  const {activeElement} = document;
  if (activeElement === null || activeElement === document.body) {
    const node = LinkedListOperations.front<AutomaticallyFocusedElement>(<any>automaticFocusList);
    if (node !== null) {
      node.element.focus();
    }
  }
});

window.addEventListener('focus', () => {
  maybeUpdateFocus();
}, true);

window.addEventListener('blur', () => {
  maybeUpdateFocus();
}, true);

export class AutomaticallyFocusedElement extends RefCounted {
  prev0: AutomaticallyFocusedElement|null = null;
  next0: AutomaticallyFocusedElement|null = null;

  focusTimer: number|undefined;

  constructor(public element: HTMLElement) {
    super();
    element.tabIndex = -1;
    this.registerEventListener(element, 'mouseenter', () => {
      if (this.focusTimer === undefined) {
        this.focusTimer = setTimeout(() => element.focus(), 0);
      }
      console.log('focusing element due to mouseenter', element);
      // element.focus();
    });
    this.registerEventListener(element, 'mouseleave', () => {
      const {focusTimer} = this;
      if (focusTimer !== undefined) {
        clearTimeout(focusTimer);
        this.focusTimer = undefined;
      }
      console.log('focusing element due to mouseenter', element);
      // element.focus();
    });
    // Insert at the end of the list.
    LinkedListOperations.insertBefore(<any>automaticFocusList, this);
    this.registerEventListener(element, 'focus', () => {
      // Move to the beginning of the list.
      LinkedListOperations.pop<AutomaticallyFocusedElement>(this);
      LinkedListOperations.insertAfter(<any>automaticFocusList, this);
    });
    maybeUpdateFocus();
  }

  disposed() {
    LinkedListOperations.pop<AutomaticallyFocusedElement>(this);
    if (this.focusTimer !== undefined) {
      clearTimeout(this.focusTimer);
    }
    super.disposed();
  }
}
