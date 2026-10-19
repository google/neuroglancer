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

import { spawn, execFile } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { promisify, stripVTControlCharacters } from "node:util";
import { expect, test as base } from "@playwright/test";
import { startCatmaidDocker } from "./catmaid_docker.js";

const execFileAsync = promisify(execFile);

export const test = base.extend<
  object,
  {
    appServer: string;
    catmaidServer: Awaited<ReturnType<typeof startCatmaidDocker>>;
  }
>({
  appServer: [
    // Playwright requires destructured fixture arguments even without dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      if (process.env.SKELETON_APP_URL) {
        await use(process.env.SKELETON_APP_URL);
        return;
      }
      const root = path.join(import.meta.dirname, "..", "..");
      const proc = spawn(
        process.execPath,
        [
          path.join(root, "build_tools/cli.ts"),
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          process.env.SKELETON_TEST_PORT ?? "0",
        ],
        {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          windowsHide: true,
        },
      );
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error(`Viewer startup timed out:\n${output}`)),
        150_000,
      );
      proc.on("error", reject);
      proc.on("exit", (code) =>
        reject(new Error(`Viewer exited (${code}):\n${output}`)),
      );
      const readers = [proc.stdout, proc.stderr].map((input) => {
        const lines = readline.createInterface({ input });
        lines.on("line", (line) => {
          output = (output + line + "\n").slice(-8000);
          const match = stripVTControlCharacters(line).match(
            /http:\/\/127\.0\.0\.1:\d+/,
          );
          if (match !== null) resolve(match[0]);
        });
        return lines;
      });
      try {
        const url = await promise;
        await expect
          .poll(
            async () => {
              try {
                return (await fetch(url)).status;
              } catch {
                return 0;
              }
            },
            { timeout: 30_000, message: "Waiting for the Neuroglancer viewer" },
          )
          .toBe(200);
        await use(url);
      } finally {
        clearTimeout(timeout);
        for (const reader of readers) reader.close();
        if (proc.pid !== undefined && proc.exitCode === null) {
          if (process.platform === "win32") {
            await execFileAsync(
              "taskkill",
              ["/PID", String(proc.pid), "/T", "/F"],
              { windowsHide: true },
            );
          } else {
            process.kill(-proc.pid, "SIGTERM");
          }
        }
      }
    },
    { scope: "worker", timeout: 180_000 },
  ],
  baseURL: async ({ appServer }, use) => {
    await use(appServer);
  },
  // Lazy worker fixture: importing or listing the suites never starts Docker.
  catmaidServer: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startCatmaidDocker();
      try {
        await use(server);
      } finally {
        try {
          expect(
            await server.remainingProjects(),
            "Every test project must be removed",
          ).toEqual([]);
        } finally {
          await server.close();
        }
      }
    },
    { scope: "worker", timeout: 660_000 },
  ],
});
