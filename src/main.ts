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

/**
 * @file Main entry point for default neuroglancer viewer.
 */
import { setupDefaultViewer } from "#src/ui/default_viewer_setup.js";
import "#src/util/google_tag_manager.js";

(function maybeHandleOidcCallback() {
  try {
    // Only handle when running in a popup opened by our app and when code/state are present.
    if (window.opener === null) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (code === null || state === null) return;
    // Post message back to opener; opener will validate origin and state.
    window.opener.postMessage({ type: "oidc_code", code, state }, "*");
    // Close this popup window.
    window.close();
  } catch {
    // Swallow errors; fall through to normal app startup.
  }
})();

setupDefaultViewer();
