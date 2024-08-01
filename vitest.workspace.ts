import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "node",
      environment: "node",
      setupFiles: ["./build_tools/vitest/setup-crypto.ts"],
      include: ["src/**/*.spec.ts"],
      benchmark: {
        include: ["src/**/*.benchmark.ts"],
      },
    },
  },
  {
    test: {
      name: "browser",
      include: ["src/**/*.browser_test.ts"],
      benchmark: {
        include: [],
      },
      browser: {
        provider: "playwright",
        enabled: true,
        headless: true,
        name: "chromium",
      },
    },
  },
]);
