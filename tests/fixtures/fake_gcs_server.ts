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

import { spawn } from "node:child_process";
import readline from "node:readline";
import { bypass, http } from "msw";
import { beforeEach } from "vitest";
import { fetchOk } from "#src/util/http_request.js";
import { fixture, type Fixture } from "#tests/fixtures/fixture.js";
import type { mswFixture } from "#tests/fixtures/msw";

function pickRandomPort() {
  const minPort = 1024;
  const maxPort = 65535;
  return Math.round(Math.random() * (maxPort - minPort) + minPort);
}

declare const FAKE_GCS_SERVER_BIN: string;

export function fakeGcsServerFixture(
  msw?: ReturnType<typeof mswFixture>,
): Fixture<string> {
  const gcsServer = fixture(async (stack) => {
    const port = pickRandomPort();
    const proc = stack.use(
      spawn(
        FAKE_GCS_SERVER_BIN,
        [
          "-backend",
          "memory",
          "-scheme",
          "http",
          "-host",
          "localhost",
          "-port",
          `${port}`,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      ),
    );

    const { resolve, reject, promise } = Promise.withResolvers<void>();

    (async () => {
      for await (const line of readline.createInterface({
        input: proc.stderr,
      })) {
        console.log(`fake_gcs_server: ${line}`);
        if (line.match(/server started at/)) {
          resolve();
        }
      }
      reject(new Error("Failed to start server"));
    })();
    await promise;
    return `http://localhost:${port}`;
  });
  if (msw !== undefined) {
    beforeEach(async () => {
      const serverUrl = await gcsServer();
      const PUBLIC_SERVER = "https://storage.googleapis.com";
      (await msw()).use(
        http.all(`${PUBLIC_SERVER}/storage/*`, ({ request }) => {
          const adjustedUrl =
            serverUrl + request.url.substring(PUBLIC_SERVER.length);
          return fetch(bypass(adjustedUrl, request));
        }),
      );
    });
  }
  return gcsServer;
}

const DEFAULT_PROJECT = "myproject";

export async function createBucket(
  gcs: Fixture<string>,
  bucket: string,
  project: string = DEFAULT_PROJECT,
) {
  await fetchOk(
    bypass(
      `${await gcs()}/storage/v1/b?project=${encodeURIComponent(project)}`,
      {
        method: "POST",
        body: JSON.stringify({ name: bucket }),
      },
    ),
  );
}

export async function writeObject(
  gcs: Fixture<string>,
  bucket: string,
  path: string,
  body: RequestInit["body"],
) {
  await fetchOk(
    bypass(
      `${await gcs()}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?name=${encodeURIComponent(path)}&uploadType=media`,
      {
        method: "POST",
        body: body,
      },
    ),
  );
}
