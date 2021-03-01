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

import {makeExtraKeyBindings} from 'my-neuroglancer-project/extra_key_bindings';
import {navigateToOrigin} from 'my-neuroglancer-project/navigate_to_origin';
import {setupDefaultViewer} from 'neuroglancer/ui/default_viewer_setup';
import {registerActionListener} from 'neuroglancer/util/event_action_map';

window.addEventListener('DOMContentLoaded', () => {
  const viewer = setupDefaultViewer();
  makeExtraKeyBindings(viewer.inputEventMap);
  registerActionListener(viewer.element, 'navigate-to-origin', () => navigateToOrigin(viewer));
});
