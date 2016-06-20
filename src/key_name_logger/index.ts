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

import {getEventStrokeIdentifier} from 'neuroglancer/util/keyboard_shortcut_handler';

addEventListener('DOMContentLoaded', function() {
  window.addEventListener('keydown', event => {
    let s = getEventStrokeIdentifier(event);
    console.log(`Stroke = ${s}`, event);
    let text = `<pre>Stroke: ${s}
KeyboardEvent {
`;
    for (let prop of ['key', 'code', 'keyIdentifier', 'ctrlKey', 'altKey', 'metaKey', 'shiftKey']) {
      text += `  ${prop}: ${JSON.stringify((<any>event)[prop])}\n`;
    }
    text += `}</pre>`;
    document.body.innerHTML = text;
    event.preventDefault();
  });
});
