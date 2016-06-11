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

import {KeySequenceMap} from 'neuroglancer/util/keyboard_shortcut_handler';

/**
 * This binds the default set of viewer key bindings.
 */
export function makeDefaultKeyBindings(keyMap: KeySequenceMap) {
  keyMap.bind('arrowleft', 'x-');
  keyMap.bind('arrowright', 'x+');
  keyMap.bind('arrowup', 'y-');
  keyMap.bind('arrowdown', 'y+');
  keyMap.bind('comma', 'z-');
  keyMap.bind('period', 'z+');
  keyMap.bind('keyz', 'snap');
  keyMap.bind('control+equal', 'zoom-in');
  keyMap.bind('control+shift+equal', 'zoom-in');
  keyMap.bind('control+minus', 'zoom-out');
  keyMap.bind('keyr', 'rotate-relative-z-');
  keyMap.bind('keye', 'rotate-relative-z+');
  keyMap.bind('shift+arrowdown', 'rotate-relative-x-');
  keyMap.bind('shift+arrowup', 'rotate-relative-x+');
  keyMap.bind('shift+arrowleft', 'rotate-relative-y-');
  keyMap.bind('shift+arrowright', 'rotate-relative-y+');
  keyMap.bind('keyl', 'recolor');
  keyMap.bind('keyx', 'clear-segments');
  keyMap.bind('keys', 'toggle-show-slices');
  keyMap.bind('keyb', 'toggle-scale-bar');
  keyMap.bind('keya', 'toggle-axis-lines');

  for (let i = 1; i <= 9; ++i) {
    keyMap.bind('digit' + i, 'toggle-layer-' + i);
  }

  keyMap.bind('keyn', 'add-layer');
  keyMap.bind('keyh', 'help');

  keyMap.bind('space', 'toggle-layout');
}
