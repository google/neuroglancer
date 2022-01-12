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

/**
 * @file Facility for triggering named actions in response to keyboard events.
 */

// This is based on goog/ui/keyboardshortcuthandler.js in the Google Closure library.

import {WatchableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {ActionEvent, dispatchEventWithModifiers, EventActionMap, EventActionMapInterface, registerActionListener, getEventModifierMask} from 'neuroglancer/util/event_action_map';

export const globalModifiers = new WatchableValue<number>(0);
window.addEventListener('keydown', event => {  globalModifiers.value = getEventModifierMask(event); });
window.addEventListener('keyup', event => {  globalModifiers.value = getEventModifierMask(event); });

const globalKeys = new Set(
    ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'escape', 'pause']);
const DEFAULT_TEXT_INPUTS = new Set([
  'color', 'date', 'datetime', 'datetime-local', 'email', 'month', 'number', 'password', 'search',
  'tel', 'text', 'time', 'url', 'week'
]);

export class KeyboardEventBinder<EventMap extends EventActionMapInterface> extends RefCounted {
  modifierShortcutsAreGlobal = true;
  allShortcutsAreGlobal = false;
  allowSpaceKeyOnButtons = false;
  constructor(public target: EventTarget, public eventMap: EventMap) {
    super();
    this.registerEventListener(
        target, 'keydown', this.handleKeyDown.bind(this), /*useCapture=*/false);
  }

  private shouldIgnoreEvent(key: string, event: KeyboardEvent) {
    var el = <HTMLElement>event.target;
    let {tagName} = el;
    if (el === this.target) {
      // If the event is directly on the target element, we never ignore it.
      return false;
    }
    var isFormElement = tagName === 'TEXTAREA' || tagName === 'INPUT' || tagName === 'BUTTON' ||
        tagName === 'SELECT';

    var isContentEditable = !isFormElement &&
        (el.isContentEditable || (el.ownerDocument && el.ownerDocument.designMode === 'on'));

    if (!isFormElement && !isContentEditable) {
      return false;
    }
    // Always allow keys registered as global to be used (typically Esc, the
    // F-keys and other keys that are not typically used to manipulate text).
    if (this.allShortcutsAreGlobal || globalKeys.has(key)) {
      return false;
    }
    if (isContentEditable) {
      // For events originating from an element in editing mode we only let
      // global key codes through.
      return true;
    }
    // Event target is one of (TEXTAREA, INPUT, BUTTON, SELECT).
    // Allow modifier shortcuts, unless we shouldn't.
    if (this.modifierShortcutsAreGlobal && (event.altKey || event.ctrlKey || event.metaKey)) {
      return true;
    }
    // Allow ENTER to be used as shortcut for text inputs.
    if (tagName === 'INPUT' && DEFAULT_TEXT_INPUTS.has((<HTMLInputElement>el).type)) {
      return key !== 'enter';
    }
    // Checkboxes, radiobuttons and buttons. Allow all but SPACE as shortcut.
    if (tagName === 'INPUT' || tagName === 'BUTTON') {
      // TODO(gboyer): If more flexibility is needed, create protected helper
      // methods for each case (e.g. button, input, etc).
      if (this.allowSpaceKeyOnButtons) {
        return false;
      } else {
        return key === 'space';
      }
    }
    // Don't allow any additional shortcut keys for textareas or selects.
    return true;
  }

  private handleKeyDown(event: KeyboardEvent) {
    const key = getEventKeyName(event);
    if (this.shouldIgnoreEvent(key, event)) {
      return;
    }
    dispatchEventWithModifiers(key, event, event, this.eventMap);
  }
}

export function getEventKeyName(event: KeyboardEvent): string {
  return event.code.toLowerCase();
}

export {EventActionMap, registerActionListener};
export type {EventActionMapInterface, ActionEvent}
