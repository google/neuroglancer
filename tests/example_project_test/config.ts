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
import type { Project } from "@playwright/test";
import { defineConfig } from "@playwright/test";
import type { ClientTestOptions } from "#tests/example_project_test/client_test_options.js";
import { maybeStartScreenshotComparisonServer } from "#tests/example_project_test/screenshot_comparison_server.js";

const ROOT_DIR = path.join(import.meta.dirname, "..", "..");

const EXAMPLES_DIR = path.join(ROOT_DIR, "examples");

const EXAMPLE_BUNDLERS = ["rsbuild", "rspack", "vite", "webpack"];

await maybeStartScreenshotComparisonServer();

interface ClientOptions {
  name: string;
  clientDir: string;
  clientBuildOptions?: string[];
  distDir: string;
  installNodeModulesDependencies?: string[];
  buildPackageDependencies?: string[];
}

const [EXAMPLE_PROJECTS_BUILT, EXAMPLE_PROJECTS_SOURCE] = [
  "built",
  "source",
].map((kind) =>
  EXAMPLE_BUNDLERS.map((bundler): ClientOptions => {
    const name = `${bundler}-project-${kind}`;
    return {
      name,
      clientDir: path.join(EXAMPLES_DIR, bundler, name),
      distDir: "dist",
      installNodeModulesDependencies: [`${name}:install_node_modules`],
      buildPackageDependencies:
        kind === "built" ? ["build_package"] : undefined,
    };
  }),
);

const EXAMPLE_PROJECTS = [
  ...EXAMPLE_PROJECTS_SOURCE,
  ...EXAMPLE_PROJECTS_BUILT,
];

const ROOT_CLIENT: ClientOptions = {
  name: "root",
  clientDir: ROOT_DIR,
  distDir: "dist/client",
};

const CLIENTS = [ROOT_CLIENT, ...EXAMPLE_PROJECTS];

type ClientTestProject = Project<ClientTestOptions>;

export default defineConfig<ClientTestOptions>({
  projects: [
    {
      name: "build_package",
      testDir: "tests/example_project_test",
      testMatch: /build_package\.ts/,
    },
    ...EXAMPLE_PROJECTS.map(
      ({ name, clientDir, buildPackageDependencies }): ClientTestProject => ({
        name: `${name}:install_node_modules`,
        testDir: "tests/example_project_test",
        testMatch: /install_node_modules\.ts/,
        dependencies: buildPackageDependencies,
        use: { clientDir },
      }),
    ),
    ...CLIENTS.map(
      ({
        name,
        clientDir,
        clientBuildOptions,
        installNodeModulesDependencies,
      }): ClientTestProject => ({
        name: `${name}:build_client`,
        testDir: "tests/example_project_test",
        testMatch: /build_client\.ts/,
        use: { clientDir, clientBuildOptions },
        dependencies: installNodeModulesDependencies,
      }),
    ),
    ...CLIENTS.map(
      ({ name, clientDir, distDir }): ClientTestProject => ({
        name: `${name}:capture_build_screenshot`,
        testDir: "tests/example_project_test",
        testMatch: /capture_build_screenshot\.ts/,
        use: { clientDir: path.join(clientDir, distDir) },
        dependencies: [`${name}:build_client`, "reset_screenshots"],
        teardown: "compare_screenshots",
      }),
    ),
    ...CLIENTS.map(
      ({
        name,
        clientDir,
        clientBuildOptions,
        installNodeModulesDependencies,
      }): ClientTestProject => ({
        name: `${name}:capture_dev_server_screenshot`,
        testDir: "tests/example_project_test",
        testMatch: /capture_dev_server_screenshot\.ts/,
        use: { clientDir, clientBuildOptions },
        dependencies: [
          ...(installNodeModulesDependencies ?? []),
          "reset_screenshots",
        ],
        teardown: "compare_screenshots",
      }),
    ),
    {
      name: "reset_screenshots",
      testDir: "tests/example_project_test",
      testMatch: /reset_screenshot_server\.ts/,
    },
    {
      name: "compare_screenshots",
      testDir: "tests/example_project_test",
      testMatch: /compare_screenshots\.ts/,
    },
  ],
});
