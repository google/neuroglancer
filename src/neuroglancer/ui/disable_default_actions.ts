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

import {registerEventListener} from 'neuroglancer/util/disposable';

/**
 * Prevent context menu on right click, as this interferes with other event handlers for right mouse
 * clicks.
 */
export function disableContextMenu() {
  return registerEventListener(document, 'contextmenu', (e: Event) => {
    e.preventDefault();
  });
}

export function disableWheel() {
  return registerEventListener(document, 'wheel', (e: WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
    }
  }, {passive: false});
}
