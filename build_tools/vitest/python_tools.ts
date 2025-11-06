/**
 * @license
 * Copyright 2025 Google Inc.
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

import { spawnSync } from "node:child_process";

export async function syncPythonTools() {
  // Note: For unknown reasons, using `await promisify(spawn)` in place of
  // `spawnSync` causes the vitest process to exit as soon as the child
  // process completes.
  spawnSync("uv", ["sync", "--only-group", "vitest"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}
