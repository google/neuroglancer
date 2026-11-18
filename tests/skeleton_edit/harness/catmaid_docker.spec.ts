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

import { afterEach, describe, expect, it, vi } from "vitest";
import { startCatmaidDocker } from "./catmaid_docker.js";

const { execFileAsync } = vi.hoisted(() => ({ execFileAsync: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const mock = {
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: execFileAsync,
    }),
  };
  return { ...mock, default: mock };
});

afterEach(() => {
  execFileAsync.mockReset();
  vi.restoreAllMocks();
});

describe("CATMAID Docker startup failure", () => {
  it.each([
    { logsFail: false, cleanupFails: false },
    { logsFail: true, cleanupFails: false },
    { logsFail: false, cleanupFails: true },
    { logsFail: true, cleanupFails: true },
  ])(
    "preserves the original error and attempts cleanup: %j",
    async ({ logsFail, cleanupFails }) => {
      const startupError = new Error("Docker startup failed");
      const logError = new Error("Logs unavailable");
      const cleanupError = new Error("Cleanup failed");
      const report = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      execFileAsync.mockImplementation(
        async (_file: string, args: string[]) => {
          switch (args[5]) {
            case "up":
              throw startupError;
            case "logs":
              if (logsFail) throw logError;
              return { stdout: "Startup log", stderr: "" };
            case "down":
              if (cleanupFails) throw cleanupError;
              return { stdout: "", stderr: "" };
            default:
              throw new Error(`Unexpected Compose action: ${args[5]}`);
          }
        },
      );
      await expect(startCatmaidDocker()).rejects.toBe(startupError);
      expect(execFileAsync.mock.calls.map(([, args]) => args[5])).toEqual([
        "up",
        "logs",
        "down",
      ]);
      if (logsFail)
        expect(report).toHaveBeenCalledWith(
          "Failed to collect CATMAID startup logs:",
          logError,
        );
      else expect(report).toHaveBeenCalledWith("Startup log");
      if (cleanupFails)
        expect(report).toHaveBeenCalledWith(
          "Failed to remove CATMAID test containers:",
          cleanupError,
        );
      expect(execFileAsync.mock.calls[2][1].slice(5)).toEqual([
        "down",
        "--volumes",
        "--remove-orphans",
      ]);
    },
  );
});
