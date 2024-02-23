import { defineWorkspace } from "vitest/config";
import binaryPlugin from "./build_tools/vite/vite-plugin-binary.ts";

const baseConfig = {
  extends: "./vite.config.ts",
  plugins: [binaryPlugin({ include: ["**/*.npy", "**/*.dat"] })],
};

export default defineWorkspace([
  {
    ...baseConfig,
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
    ...baseConfig,
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
