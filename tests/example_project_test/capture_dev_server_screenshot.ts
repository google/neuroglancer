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

import { spawn, exec } from "node:child_process";
import readline from "node:readline";
import { stripVTControlCharacters, promisify } from "node:util";
import { expect } from "@playwright/test";
import { captureNeuroglancerScreenshot } from "#tests/example_project_test/capture_screenshot.js";
import { test as base } from "#tests/example_project_test/client_test_options.js";

const execAsync = promisify(exec);

const test = base.extend<{ devServer: string }>({
  devServer: async ({ clientDir, clientBuildOptions }, use) => {
    const proc = spawn(
      "npm",
      ["run", "dev-server", "--", ...clientBuildOptions],
      { cwd: clientDir, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    try {
      const { resolve, reject, promise } = Promise.withResolvers<string>();
      for (const channel of ["stdout", "stderr"] as const) {
        (async () => {
          for await (const line of readline.createInterface({
            input: proc[channel],
          })) {
            console.log(`[dev-server ${channel}]: ${line}`);
            const m = line.match(/http:\/\/[^,\s]+/);
            if (m !== null) {
              const url = stripVTControlCharacters(m[0]);
              console.log(`Dev server is listening at ${url}`);
              resolve(url);
            }
          }
          reject(new Error("Failed to start server"));
        })();
      }
      await use(await promise);
    } finally {
      const pid = proc.pid;
      if (pid !== undefined) {
        if (process.platform !== "win32") {
          process.kill(-pid);
        } else {
          await execAsync(`taskkill /PID ${pid} /T /F`);
        }
      }
    }
  },
});

test("capture screenshot from built client", async ({
  page,
  devServer,
}, testInfo) => {
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(devServer);
          return response.status;
        } catch {
          return 0;
        }
      },
      { timeout: 30000, message: "Waiting for dev server to be ready" },
    )
    .toBe(200);
  await captureNeuroglancerScreenshot(page, devServer, testInfo);
});
