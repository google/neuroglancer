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

import type * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "http-server";

export interface TestDataServer extends AsyncDisposable {
  url: string;
}

export async function startTestDataServer(
  rootDirectory: string,
): Promise<TestDataServer> {
  const server: http.Server = (
    createServer({
      root: rootDirectory,
      cache: -1,
      cors: true,
    }) as any
  ).server;
  // Don't block node from exiting.
  server.unref();
  const serverUrl = await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "localhost", () => {
      const port = (server.address() as AddressInfo).port;
      resolve(`http://localhost:${port}/`);
    });
  });
  console.log(`Serving ${rootDirectory} at ${serverUrl}`);
  return {
    url: serverUrl,
    [Symbol.asyncDispose]: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
