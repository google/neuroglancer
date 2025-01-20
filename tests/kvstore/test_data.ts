/**
 * @license
 * Copyright 2024 Google Inc.
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

import fs from "node:fs/promises";
import path from "node:path";

export const TEST_DATA_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "testdata",
  "kvstore",
);
export const TEST_FILES_DIR = path.join(TEST_DATA_DIR, "files");

export async function findFilesRecursively(rootDir: string): Promise<string[]> {
  const relativePaths: string[] = [];
  for (const entry of await fs.readdir(rootDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) {
      continue;
    }
    const fullPath = path.join(entry.parentPath, entry.name);
    const relativePath = path
      .relative(rootDir, fullPath)
      .replaceAll(path.sep, "/");
    relativePaths.push(relativePath);
  }
  return relativePaths;
}

export async function getTestFiles(
  rootDir: string = TEST_FILES_DIR,
): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  for (const relativePath of await findFilesRecursively(rootDir)) {
    const content = await fs.readFile(path.join(rootDir, relativePath));
    map.set(relativePath, content);
  }
  return map;
}
