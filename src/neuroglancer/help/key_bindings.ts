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

import {Overlay} from 'neuroglancer/overlay';
import {KeySequenceMap} from 'neuroglancer/util/keyboard_shortcut_handler';

require('./key_bindings.css');

export function formatKeyName(name: string) {
  if (name.startsWith('key')) {
    return name.substring(3);
  }
  if (name.startsWith('digit')) {
    return name.substring(5);
  }
  if (name.startsWith('arrow')) {
    return name.substring(5);
  }
  return name;
}

export function formatKeyStroke(stroke: string) {
  let parts = stroke.split('+');
  return parts.map(formatKeyName).join('+');
}

export class KeyBindingHelpDialog extends Overlay {
  /**
   * @param keyMap Key map to list.
   */
  constructor(keyMap: KeySequenceMap) {
    super();

    let {content} = this;
    content.classList.add('describe-key-bindings');

    let scroll = document.createElement('div');

    let dl = document.createElement('div');
    dl.className = 'dl';

    for (let [sequence, command] of keyMap.entries()) {
      let container = document.createElement('div');
      let container2 = document.createElement('div');
      container2.className = 'definition-outer-container';
      container.className = 'definition-container';
      let dt = document.createElement('div');
      dt.className = 'dt';
      dt.textContent = sequence.map(formatKeyStroke).join(' ');
      let dd = document.createElement('div');
      dd.className = 'dd';
      dd.textContent = command;
      container.appendChild(dt);
      container.appendChild(dd);
      dl.appendChild(container2);
      container2.appendChild(container);
    }
    scroll.appendChild(dl);
    content.appendChild(scroll);
  }
}
