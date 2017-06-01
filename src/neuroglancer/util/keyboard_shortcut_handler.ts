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

// This is based on goog/ui/keyboardshortcuthandler.js in the Google Closure library.

import {RefCounted} from 'neuroglancer/util/disposable';

type Handler = (action: string) => boolean;

const MAX_KEY_SEQUENCE_DELAY = 1500;  // 1.5 sec

const globalKeys = new Set(
    ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', 'escape', 'pause']);
const DEFAULT_TEXT_INPUTS = new Set([
  'color', 'date', 'datetime', 'datetime-local', 'email', 'month', 'number', 'password', 'search',
  'tel', 'text', 'time', 'url', 'week'
]);

export class KeyboardShortcutHandler extends RefCounted {
  private currentNode: KeyStrokeMap;
  private lastStrokeTime: number;
  modifierShortcutsAreGlobal = true;
  allShortcutsAreGlobal = false;
  allowSpaceKeyOnButtons = false;
  constructor(
      public target: EventTarget, public keySequenceMap: KeySequenceMap, public handler: Handler) {
    super();
    this.reset();
    this.registerEventListener(
        target, 'keydown', this.handleKeyDown.bind(this), /*useCapture=*/true);
  }

  private reset() {
    this.currentNode = this.keySequenceMap.root;
    this.lastStrokeTime = Number.NEGATIVE_INFINITY;
  }

  setKeySequenceMap(keySequenceMap: KeySequenceMap) {
    this.keySequenceMap = keySequenceMap;
    this.reset();
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
    let key = getEventKeyName(event);
    if (this.shouldIgnoreEvent(key, event)) {
      return;
    }
    let stroke = getStrokeIdentifier(key, getEventModifierMask(event));
    let root = this.keySequenceMap.root;
    let {currentNode} = this;
    let value = currentNode.get(stroke);
    let now = Date.now();
    if (currentNode !== root &&
        (value === undefined || now > this.lastStrokeTime + MAX_KEY_SEQUENCE_DELAY)) {
      this.currentNode = root;
      value = currentNode.get(stroke);
    }
    if (value === undefined) {
      return;
    }
    if (typeof value === 'string') {
      // Terminal node.
      this.reset();
      if (this.handler(value)) {
        event.preventDefault();
      }
    } else {
      this.currentNode = value;
      this.lastStrokeTime = now;
      event.preventDefault();
    }
  }
}

export function getEventStrokeIdentifier(event: KeyboardEvent) {
  return getStrokeIdentifier(getEventKeyName(event), getEventModifierMask(event));
}

type KeyStrokeMap = Map<string, any>;

type KeySequence = string|string[];

export type KeyStrokeIdentifier = string;

const enum Modifiers {
  CONTROL = 1,
  ALT = 2,
  META = 4,
  SHIFT = 8,
}

type ModifierMask = number;

export function getEventModifierMask(event: KeyboardEvent) {
  return (event.ctrlKey ? Modifiers.CONTROL : 0) | (event.altKey ? Modifiers.ALT : 0) |
      (event.metaKey ? Modifiers.META : 0) | (event.shiftKey ? Modifiers.SHIFT : 0);
}

export function getStrokeIdentifier(keyName: string, modifiers: ModifierMask) {
  let identifier = '';
  if (modifiers & Modifiers.CONTROL) {
    identifier += 'control+';
  }
  if (modifiers & Modifiers.ALT) {
    identifier += 'alt+';
  }
  if (modifiers & Modifiers.META) {
    identifier += 'meta+';
  }
  if (modifiers & Modifiers.SHIFT) {
    identifier += 'shift+';
  }
  identifier += keyName;
  return identifier;
}

export function getEventKeyName(event: KeyboardEvent): string {
  return event.code.toLowerCase();
}

export function parseKeyStroke(strokeIdentifier: string) {
  strokeIdentifier = strokeIdentifier.toLowerCase().replace(' ', '');
  let parts = strokeIdentifier.split('+');
  let keyName: string|null|undefined;
  let modifiers = 0;
  for (let part of parts) {
    switch (part) {
      case 'control':
        modifiers |= Modifiers.CONTROL;
        break;
      case 'alt':
        modifiers |= Modifiers.ALT;
        break;
      case 'meta':
        modifiers |= Modifiers.META;
        break;
      case 'shift':
        modifiers |= Modifiers.SHIFT;
        break;
      default:
        if (keyName === undefined) {
          keyName = part;
        } else {
          keyName = null;
        }
    }
  }
  if (keyName == null) {
    throw new Error(`Invalid stroke ${JSON.stringify(strokeIdentifier)}`);
  }
  return getStrokeIdentifier(keyName, modifiers);
}

export function parseKeySequence(sequence: KeySequence) {
  if (typeof sequence === 'string') {
    let s = <string>sequence;
    s = s.replace(/[ +]*\+[ +]*/g, '+').replace(/[ ]+/g, ' ').toLowerCase();
    sequence = s.split(' ');
  }
  let parts = (<string[]>sequence).map(parseKeyStroke);
  if (parts.length === 0) {
    throw new Error('Key sequence must not be empty');
  }
  return parts;
}

export function formatKeySequence(sequence: string[]) {
  return JSON.stringify(sequence.join(' '));
}

interface Bindings {
  [keySequenceSpec: string]: string;
}

function* keySequenceMapEntries(map: Map<string, any>, prefix: string[] = [
]): IterableIterator<[string[], string]> {
  for (let [key, value] of map) {
    let newPrefix = [...prefix, key];
    if (typeof value === 'string') {
      yield [newPrefix, value];
    } else {
      yield* keySequenceMapEntries(value, newPrefix);
    }
  }
}

export class KeySequenceMap {
  root = new Map<string, any>();
  constructor(bindings?: Bindings) {
    if (bindings !== undefined) {
      this.bindMultiple(bindings);
    }
  }

  bind(keySequenceSpec: KeySequence, action: string) {
    let keySequence = parseKeySequence(keySequenceSpec);
    let currentNode = this.root;
    let prefixEnd = keySequence.length - 1;
    for (let i = 0; i < prefixEnd; ++i) {
      let stroke = keySequence[i];
      let value = currentNode.get(stroke);
      if (value === undefined) {
        value = new Map<string, any>();
        currentNode.set(stroke, value);
      }
      if (typeof value === 'string') {
        throw new Error(
            `Error binding key sequence ${formatKeySequence(keySequence)}: ` +
            `prefix ${formatKeySequence(keySequence.slice(0, i + 1))} ` +
            `is already bound to action ${JSON.stringify(value)}`);
      }
      currentNode = value;
    }
    let stroke = keySequence[prefixEnd];
    let existingValue = currentNode.get(stroke);
    if (existingValue !== undefined) {
      throw new Error(
          `Key sequence ${formatKeySequence(keySequence)} ` +
          `is already bound to action ${JSON.stringify(existingValue)}`);
    }
    currentNode.set(stroke, action);
  }

  bindMultiple(bindings: {[keySequenceSpec: string]: string}) {
    for (let key of Object.keys(bindings)) {
      this.bind(key, bindings[key]);
    }
  }

  entries() {
    return keySequenceMapEntries(this.root);
  }
}

interface HandlerStackEntry {
  keySequenceMap: KeySequenceMap;
  handler: Handler;
  identifier: any;
  priority: number;
}

export class KeyboardHandlerStack extends RefCounted {
  keyboardHandler: KeyboardShortcutHandler|undefined;
  stack = new Array<HandlerStackEntry>();
  constructor(public target: EventTarget) {
    super();
  }

  push(keySequenceMap: KeySequenceMap, handler: Handler, priority: number = 0) {
    const identifier = {};
    const entry = {keySequenceMap, handler, identifier, priority};
    const {stack} = this;
    let insertionIndex = stack.length;
    while (insertionIndex > 0 && stack[insertionIndex - 1].priority > priority) {
      --insertionIndex;
    }
    this.stack.splice(insertionIndex, 0, entry);
    if (insertionIndex === stack.length - 1) {
      this.updateHandler();
    }

    const disposer = () => {
      this.delete(identifier);
    };
    return disposer;
  }

  private delete(identifier: any) {
    const {stack} = this;
    const index = stack.findIndex(entry => entry.identifier === identifier);
    if (index === -1) {
      throw new Error('Attempt to delete keyboard handler that does not exist.');
    }
    stack.splice(index, 1);
    if (index === stack.length) {
      this.updateHandler();
    }
  }

  /**
   * Update this.keyboardHandler to reflect top of stack.
   */
  private updateHandler() {
    const {stack} = this;
    let {keyboardHandler} = this;
    if (stack.length === 0) {
      if (keyboardHandler !== undefined) {
        keyboardHandler.dispose();
        this.keyboardHandler = undefined;
        return;
      }
    }

    const {keySequenceMap, handler} = stack[stack.length - 1];

    if (keyboardHandler === undefined) {
      this.keyboardHandler = new KeyboardShortcutHandler(window, keySequenceMap, handler);
      return;
    }

    keyboardHandler.setKeySequenceMap(keySequenceMap);
    keyboardHandler.handler = handler;
  }

  disposed() {
    const {keyboardHandler} = this;
    if (keyboardHandler !== undefined) {
      keyboardHandler.dispose();
    }
    this.keyboardHandler = undefined;
    this.stack.length = 0;
    super.disposed();
  }
}

export const globalKeyboardHandlerStack = new KeyboardHandlerStack(window);
