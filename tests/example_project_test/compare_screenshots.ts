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

import { test, expect } from "@playwright/test";
import { sendScreenshotServerCommand } from "#tests/example_project_test/screenshot_comparison_server.js";

test("compare screenshots", async () => {
  const results: { name: string; value: string }[] = await (
    await sendScreenshotServerCommand("", {})
  ).json();
  const map = new Map<string, string[]>();
  for (const { name, value } of results) {
    const names = map.get(value) ?? [];
    map.set(value, names);
    names.push(name);
  }
  const groups = Array.from(map.values());
  expect(groups).toHaveLength(1);
});
