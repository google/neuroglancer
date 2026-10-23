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

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { CatmaidIntegrationConfig } from "./catmaid_integration_fixture.js";

const execFileAsync = promisify(execFile);

/** Owns only this run's Compose project; no shared containers or database. */
export async function startCatmaidDocker(): Promise<{
  createProject(
    name: string,
  ): Promise<{ config: CatmaidIntegrationConfig; close(): Promise<void> }>;
  remainingProjects(): Promise<number[]>;
  close(): Promise<void>;
}> {
  const project = `neuroglancer-catmaid-${randomUUID()}`;
  const composeFile = path.join(import.meta.dirname, "docker", "compose.yaml");
  const compose = (...args: string[]) =>
    execFileAsync(
      "docker",
      ["compose", "--project-name", project, "--file", composeFile, ...args],
      { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
  const close = async () => {
    await compose("down", "--volumes", "--remove-orphans");
  };
  try {
    console.log("Starting disposable CATMAID and PostGIS containers...");
    await compose(
      "up",
      "--build",
      "--detach",
      "--wait",
      "--wait-timeout",
      "300",
    );
    const { stdout: address } = await compose("port", "catmaid", "8000");
    if (!/^127\.0\.0\.1:\d+$/.test(address.trim())) {
      throw new Error(
        `Expected a loopback CATMAID port, got ${address.trim()}`,
      );
    }
    const { stdout: bootstrap } = await compose(
      "exec",
      "-T",
      "catmaid",
      "cat",
      "/tmp/neuroglancer-fixture.json",
    );
    const { apiToken } = JSON.parse(bootstrap);
    if (typeof apiToken !== "string" || !apiToken)
      throw new Error("CATMAID bootstrap did not provide credentials");
    const baseUrl = `http://${address.trim()}`;
    const manage = async (...args: string[]) => {
      const { stdout } = await compose(
        "exec",
        "-T",
        "catmaid",
        "/home/env/bin/python",
        "/test-support/project_manager.py",
        ...args,
      );
      return JSON.parse(stdout);
    };
    console.log(`Disposable CATMAID is ready at ${baseUrl}`);
    return {
      close,
      remainingProjects: () => manage("list"),
      createProject: async (name: string) => {
        const { projectId } = await manage("create", name);
        if (!Number.isSafeInteger(projectId) || projectId <= 0)
          throw new Error("Invalid test project ID");
        let removed = false;
        return {
          config: { baseUrl, projectId, apiToken },
          close: async () => {
            if (removed) return;
            await manage("delete", String(projectId));
            removed = true;
          },
        };
      },
    };
  } catch (error) {
    try {
      const { stdout, stderr } = await compose(
        "logs",
        "--no-color",
        "--tail",
        "80",
      );
      console.error(stdout + stderr);
    } catch (logError) {
      console.error("Failed to collect CATMAID startup logs:", logError);
    }
    try {
      await close();
    } catch (cleanupError) {
      console.error("Failed to remove CATMAID test containers:", cleanupError);
    }
    throw error;
  }
}
