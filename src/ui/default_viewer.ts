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

import "#src/ui/default_viewer.css";
import {
  disableContextMenu,
  disableWheel,
} from "#src/ui/disable_default_actions.js";
import type { MinimalViewerOptions } from "#src/ui/minimal_viewer.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";

export function makeDefaultViewer(options?: Partial<MinimalViewerOptions>) {
  disableContextMenu();
  disableWheel();
  return makeMinimalViewer(options);
}
