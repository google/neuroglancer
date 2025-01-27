import path from "node:path";
import mswPlugin from "@iodigital/vite-plugin-msw";
import { defineWorkspace } from "vitest/config";
import { getFakeGcsServerBin } from "build_tools/vitest/build_fake_gcs_server.ts";
import { startFakeNgauthServer } from "./build_tools/vitest/fake_ngauth_server.ts";
import { startTestDataServer } from "./build_tools/vitest/test_data_server.ts";

const fakeNgauthServer = await startFakeNgauthServer();
const testDataServer = await startTestDataServer(
  path.join(import.meta.dirname, "testdata"),
);
const fakeGcsServerBin = await getFakeGcsServerBin();

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
