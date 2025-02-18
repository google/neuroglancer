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

import type { AutoDetectRegistry } from "#src/kvstore/auto_detect.js";

const INITIAL_MAIN_REF = "refs/branch.main/ZZZZZZZZ.json";

const EXPECTED_SUB_DIRECTORIES = new Set(["refs", "snapshots"]);

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerDirectoryFormat({
    fileNames: new Set([INITIAL_MAIN_REF]),
    subDirectories: EXPECTED_SUB_DIRECTORIES,
    match: async ({ fileNames, subDirectories }) => {
      if (!fileNames.has(INITIAL_MAIN_REF)) {
        // Check based on sub-directories
        for (const subDirectory of EXPECTED_SUB_DIRECTORIES) {
          if (!subDirectories.has(subDirectory)) return [];
        }
      }
      return [{ suffix: "icechunk:", description: "Icechunk repository" }];
    },
  });
}
