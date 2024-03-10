import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
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
      include: ["src/**/*.browser_test.ts"],
      benchmark: {
        include: [],
      },
      browser: {
        enabled: true,
        headless: true,
        name: "chrome",
      },
    },
  },
]);
