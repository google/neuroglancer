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

import {RefCounted} from 'neuroglancer/util/disposable';
import {globalKeyboardHandlerStack, KeySequenceMap} from 'neuroglancer/util/keyboard_shortcut_handler';

export const overlayKeyboardHandlerPriority = 100;

require('./overlay.css');

export let overlaysOpen = 0;

let KEY_MAP = new KeySequenceMap();
KEY_MAP.bind('escape', 'close');

export class Overlay extends RefCounted {
  container: HTMLDivElement;
  content: HTMLDivElement;
  constructor(public keySequenceMap: KeySequenceMap = KEY_MAP) {
    super();
    ++overlaysOpen;
    let container = this.container = document.createElement('div');
    container.className = 'overlay';
    let content = this.content = document.createElement('div');
    content.className = 'overlay-content';
    container.appendChild(content);
    document.body.appendChild(container);
    this.registerDisposer(globalKeyboardHandlerStack.push(
        keySequenceMap, this.commandReceived.bind(this), overlayKeyboardHandlerPriority));
  }

  commandReceived(action: string) {
    if (action === 'close') {
      this.dispose();
    }
    return false;
  }

  disposed() {
    --overlaysOpen;
    document.body.removeChild(this.container);
    super.disposed();
  }
}
