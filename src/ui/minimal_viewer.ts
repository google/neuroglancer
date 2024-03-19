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

import "#src/sliceview/chunk_format_handlers.js";

import { DisplayContext } from "#src/display_context.js";
import { StatusMessage } from "#src/status.js";
import type { ViewerOptions } from "#src/viewer.js";
import { Viewer } from "#src/viewer.js";

export interface MinimalViewerOptions extends ViewerOptions {
  target: HTMLElement;
}

export function makeMinimalViewer(options: Partial<MinimalViewerOptions> = {}) {
  try {
    let { target = document.getElementById("neuroglancer-container") } =
      options;
    if (target === null) {
      target = document.createElement("div");
      target.id = "neuroglancer-container";
      document.body.appendChild(target);
    }
    const display = new DisplayContext(target);
    return new Viewer(display, options);
  } catch (error) {
    StatusMessage.showMessage(`Error: ${error.message}`);
    throw error;
  }
}
