/**
 * @license
 * Copyright 2026 Google Inc.
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

import { defineConfig, type Project } from "@playwright/test";

export default defineConfig({
  projects: ["browser-integration", "e2e"].map(
    (kind): Project => ({
      name: `skeleton-${kind}`,
      testDir: "tests/skeleton_edit",
      testMatch: kind === "e2e" ? "*.e2e.ts" : "*.browser_integration.ts",
      fullyParallel: false,
      retries: 0,
      timeout: 45_000,
      expect: { timeout: 10_000 },
      outputDir: `test-results/skeleton-${kind}`,
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 1000 },
        headless: true,
        // Real-backend traces can contain authentication headers.
        trace: kind === "e2e" ? "off" : "retain-on-failure",
        screenshot: "only-on-failure",
        serviceWorkers: "block",
        launchOptions: {
          args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        },
      },
    }),
  ),
});
