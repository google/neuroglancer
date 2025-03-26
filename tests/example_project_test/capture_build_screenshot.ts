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

import path from "node:path";
import { captureNeuroglancerScreenshot } from "#tests/example_project_test/capture_screenshot.js";
import { test } from "#tests/example_project_test/client_test_options.js";

test.use({ baseURL: "http://localhost:1/" });

test("capture screenshot from built client", async ({
  page,
  clientDir,
}, testInfo) => {
  await page.route("/**", (route, request) => {
    let { pathname } = new URL(request.url());
    if (pathname === "/") {
      pathname = "/index.html";
    }
    return route.fulfill({
      path: path.join(clientDir, pathname),
    });
  });
  await captureNeuroglancerScreenshot(page, "/", testInfo);
});
