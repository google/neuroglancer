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

import 'neuroglancer/image_user_layer';
import 'neuroglancer/segmentation_user_layer';
import 'neuroglancer/single_mesh_user_layer';
import 'neuroglancer/annotation/user_layer';

import {makeDefaultKeyBindings} from 'neuroglancer/default_key_bindings';
import {makeDefaultViewer} from 'neuroglancer/default_viewer';
import {UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';
import {getCachedJson} from 'neuroglancer/util/trackable';

window.addEventListener('DOMContentLoaded', () => {
  let viewer = (<any>window)['viewer'] = makeDefaultViewer();
  makeDefaultKeyBindings(viewer.keyMap);

  const hashBinding = new UrlHashBinding(viewer.state);
  hashBinding.updateFromUrlHash();

  document.addEventListener('copy', (event: ClipboardEvent) => {
    const selection = window.getSelection();
    if (!selection.isCollapsed) {
      return;
    }
    const {tagName} = (<HTMLElement>event.target);
    if (tagName === 'TEXTAREA' || tagName === 'INPUT') {
      return;
    }
    const stateJson = getCachedJson(viewer.state).value;
    event.clipboardData.setData('text/plain', JSON.stringify(stateJson, undefined, '  '));
    event.preventDefault();
  });
});
