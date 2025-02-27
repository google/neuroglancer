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

import type {
  AutoDetectFileOptions,
  AutoDetectMatch,
  AutoDetectRegistry,
} from "#src/kvstore/auto_detect.js";
import {
  EOCDR_WITHOUT_COMMENT_SIZE,
  parseEndOfCentralDirectoryRecord,
} from "#src/kvstore/zip/metadata.js";

async function detectZip(
  options: AutoDetectFileOptions,
): Promise<AutoDetectMatch[]> {
  const { suffix } = options;
  if (suffix === undefined) return [];
  if (parseEndOfCentralDirectoryRecord(suffix) === undefined) return [];
  return [{ suffix: "zip:", description: "ZIP archive" }];
}

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerFileFormat({
    prefixLength: 0,
    // To ensure all valid zip file are detected, this should be set to
    // `EOCDR_WITHOUT_COMMENT_SIZE + MAX_COMMENT_SIZE`. In practice, though, zip
    // files with comments are rare and 4096 should be sufficient for most
    // cases while avoiding reading an excessive amount for auto-detection.
    suffixLength: EOCDR_WITHOUT_COMMENT_SIZE + 4096,
    match: detectZip,
  });
}
