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

import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

export interface ScreenshotComparisonServer extends AsyncDisposable {
  url: string;
}

export function startScreenshotComparisonServer(): Promise<ScreenshotComparisonServer> {
  const app = express();
  const token = crypto.randomBytes(32).toString("base64url");

  const seenScreenshots: { name: string; value: string }[] = [];

  app.put(`/${token}/:name/:value`, (req, res) => {
    seenScreenshots.push(req.params);
    res.send("");
  });
  app.delete(`/${token}`, (_req, res) => {
    seenScreenshots.length = 0;
    res.send("");
  });
  app.get(`/${token}`, (_req, res) => {
    res.json(seenScreenshots);
  });

  const server = app.listen(0, "localhost");
  // Don't block node from exiting while this server is running.
  server.unref();
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.on("listening", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://localhost:${port}/${token}`,
        [Symbol.asyncDispose]: () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      });
    });
  });
}

const SCREENSHOT_SERVER_ENVVAR =
  "NEUROGLANCER_PLAYWRIGHT_SCREENSHOT_COMPARISON_SERVER";

export async function maybeStartScreenshotComparisonServer() {
  if (process.env[SCREENSHOT_SERVER_ENVVAR] === undefined) {
    process.env[SCREENSHOT_SERVER_ENVVAR] = (
      await startScreenshotComparisonServer()
    ).url;
  }
}

export async function sendScreenshotServerCommand(
  suffix: string,
  init: RequestInit,
): Promise<Response> {
  const server = process.env[SCREENSHOT_SERVER_ENVVAR];
  if (server === undefined) {
    throw new Error(
      `Expected environment variable ${SCREENSHOT_SERVER_ENVVAR} to be set`,
    );
  }
  const response = await fetch(server + suffix, init);
  if (response.status !== 200) {
    throw new Error(`Unexpected response: ${response.status}`);
  }
  return response;
}
