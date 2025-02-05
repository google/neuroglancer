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

import path from "node:path";
import mswPlugin from "@iodigital/vite-plugin-msw";
import { defineWorkspace } from "vitest/config";
import { getFakeGcsServerBin } from "build_tools/vitest/build_fake_gcs_server.ts";
import {
  PYTHON_TEST_TOOLS_PATH,
  syncPythonTools,
} from "build_tools/vitest/python_tools.ts";
import { startFakeNgauthServer } from "./build_tools/vitest/fake_ngauth_server.ts";
import { startTestDataServer } from "./build_tools/vitest/test_data_server.ts";

const fakeNgauthServer = await startFakeNgauthServer();
const testDataServer = await startTestDataServer(
  path.join(import.meta.dirname, "testdata"),
);
const fakeGcsServerBin = await getFakeGcsServerBin();
await syncPythonTools();

export default defineWorkspace([
  {
    test: {
      name: "node",
      environment: "jsdom",
      setupFiles: [
        "./build_tools/vitest/polyfill-browser-globals-in-node.ts",
        "@vitest/web-worker",
      ],
      include: ["src/**/*.spec.ts", "tests/**/*.spec.ts"],
      benchmark: {
        include: ["src/**/*.benchmark.ts"],
      },
      testTimeout: 10000,
    },
    define: {
      FAKE_GCS_SERVER_BIN: JSON.stringify(fakeGcsServerBin),
      PYTHON_TEST_TOOLS_PATH: JSON.stringify(PYTHON_TEST_TOOLS_PATH),
    },
  },
  {
    define: {
      FAKE_NGAUTH_SERVER: JSON.stringify(fakeNgauthServer.url),
      TEST_DATA_SERVER: JSON.stringify(testDataServer.url),
    },
    esbuild: {
      target: "es2022",
    },
    plugins: [mswPlugin({ mode: "browser", handlers: [] })],
    optimizeDeps: {
      include: ["nifti-reader-js"],
      entries: ["src/util/polyfills.ts"],
    },
    test: {
      name: "browser",
      include: ["src/**/*.browser_test.ts", "tests/**/*.browser_test.ts"],
      benchmark: {
        include: [],
      },
      browser: {
        provider: "playwright",
        enabled: true,
        headless: true,
        instances: [{ browser: "chromium" }],
        screenshotFailures: false,
      },
    },
  },
]);
