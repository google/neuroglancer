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
import type { ViteUserConfig } from "vitest/config";
import { defineWorkspace, mergeConfig } from "vitest/config";
import { getFakeGcsServerBin } from "./build_tools/vitest/build_fake_gcs_server.js";
import { startFakeNgauthServer } from "./build_tools/vitest/fake_ngauth_server.js";
import { syncPythonTools } from "./build_tools/vitest/python_tools.js";
import { startTestDataServer } from "./build_tools/vitest/test_data_server.js";

const fakeNgauthServer = await startFakeNgauthServer();
const testDataServer = await startTestDataServer(
  path.join(import.meta.dirname, "testdata"),
);
const fakeGcsServerBin = await getFakeGcsServerBin();
await syncPythonTools();

const commonDefines: Record<string, string> = {
  FAKE_NGAUTH_SERVER: JSON.stringify(fakeNgauthServer.url),
  TEST_DATA_SERVER: JSON.stringify(testDataServer.url),
};

const browserDefines = { ...commonDefines };
const nodeDefines = {
  FAKE_GCS_SERVER_BIN: JSON.stringify(fakeGcsServerBin),
  ...commonDefines,
};

function defaultNodeProject(): ViteUserConfig {
  return {
    define: { ...nodeDefines },
    test: {
      environment: "jsdom-patched",
      setupFiles: [
        "./build_tools/vitest/polyfill-browser-globals-in-node.ts",
        "@vitest/web-worker",
      ],
      testTimeout: 10000,
    },
  };
}

const KVSTORE_TESTS_WITH_CUSTOM_CONDITIONS = [
  { name: "zip" },
  { name: "ocdbt" },
  { name: "icechunk", conditions: ["neuroglancer/kvstore/s3:enabled"] },
];

export default defineWorkspace([
  mergeConfig(defaultNodeProject(), {
    test: {
      name: "node",
      include: ["src/**/*.spec.ts", "tests/**/*.spec.ts"],
      exclude: KVSTORE_TESTS_WITH_CUSTOM_CONDITIONS.map(
        ({ name }) => `tests/kvstore/${name}.spec.ts`,
      ),
      benchmark: {
        include: ["src/**/*.benchmark.ts"],
      },
      // On Github actions macos runners, s3 fixture can take a long time for
      // some reason.
      hookTimeout: 120000,
    },
  }),
  ...KVSTORE_TESTS_WITH_CUSTOM_CONDITIONS.map(({ name, conditions = [] }) =>
    mergeConfig(defaultNodeProject(), {
      resolve: {
        conditions: [
          "neuroglancer/datasource:none_by_default",
          "neuroglancer/kvstore:none_by_default",
          "neuroglancer/layer:none_by_default",
          `neuroglancer/kvstore/${name}:enabled`,
          "neuroglancer/kvstore/http:enabled",
          ...conditions,
        ],
      },
      test: {
        name: `kvstore/${name}`,
        include: [`tests/kvstore/${name}.spec.ts`],
        setupFiles: ["#src/kvstore/enabled_frontend_modules.js"],
        benchmark: {
          include: [],
        },
      },
    }),
  ),
  {
    define: browserDefines,
    esbuild: {
      target: "es2022",
    },
    plugins: [mswPlugin({ mode: "browser", handlers: [] })],
    optimizeDeps: {
      entries: [
        "src/**/*.browser_test.ts",
        "tests/**/*.browser_test.ts",
        "src/*.bundle.js",
      ],
    },
    test: {
      name: "browser",
      include: ["src/**/*.browser_test.ts", "tests/**/*.browser_test.ts"],
      benchmark: {
        include: ["src/**/*.browser_benchmark.ts"],
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
