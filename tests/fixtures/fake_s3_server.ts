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

import nodeHttp from "node:http";
import nodeStream from "node:stream";
import { bypass, http } from "msw";
import S3rver from "s3rver";
import { beforeEach } from "vitest";
import { fetchOk } from "#src/util/http_request.js";
import { fixture, type Fixture } from "#tests/fixtures/fixture.js";
import type { mswFixture } from "#tests/fixtures/msw";
import { tempDirectoryFixture } from "#tests/fixtures/temp_directory.js";

export function fakeS3ServerFixture(
  options: {
    directory?: Fixture<string>;
    msw?: ReturnType<typeof mswFixture>;
  } = {},
): Fixture<string> {
  const { directory = tempDirectoryFixture(), msw } = options;
  const s3Server = fixture(async (stack) => {
    const server = new S3rver({
      address: "localhost",
      port: 0,
      directory: await directory(),
    });
    stack.defer(async () => server.close());
    const address = await server.run();
    return `http://localhost:${address.port}`;
  });
  if (msw !== undefined) {
    beforeEach(async () => {
      const serverUrl = await s3Server();
      (await msw()).use(
        http.all(
          /^https:\/\/([^/]+\.)?s3\.amazonaws\.com\/.*/,
          ({ request }) => {
            const parsedServerUrl = new URL(serverUrl);
            const requestUrl = new URL(request.url);
            const requestHost = requestUrl.host;
            requestUrl.protocol = parsedServerUrl.protocol;
            requestUrl.host = parsedServerUrl.host;
            const headers = request.headers;
            headers.set("host", requestHost);
            const modifiedRequest = bypass(requestUrl.toString(), request);
            const { promise, resolve, reject } =
              Promise.withResolvers<Response>();
            const req = nodeHttp.request(modifiedRequest.url, {
              setHost: false,
              signal: modifiedRequest.signal,
              headers: {
                ...Object.fromEntries(modifiedRequest.headers),
                host: requestHost,
              },
              method: modifiedRequest.method,
            });
            const requestBody = modifiedRequest.body;
            req.on("error", (reason) => reject(reason));
            req.on("response", (res) => {
              // Convert nodeHttp.IncomingHttpHeaders to Fetch Headers object.
              const headers = new Headers();
              for (let [key, value] of Object.entries(res.headers)) {
                if (!Array.isArray(value)) value = [value!];
                for (const v of value) {
                  headers.append(key, v);
                }
              }
              // Convert node stream.Readable to ReadableStream.
              const responseBody = new ReadableStream({
                start(controller) {
                  res.on("data", (chunk) => {
                    controller.enqueue(chunk);
                  });
                  res.on("end", () => {
                    controller.close();
                  });
                  res.on("error", (err) => {
                    controller.error(err);
                  });
                },
              });
              resolve(
                new Response(responseBody, {
                  status: res.statusCode,
                  statusText: res.statusMessage,
                  headers,
                }),
              );
            });
            if (requestBody === null) {
              req.end();
            } else {
              nodeStream.Readable.fromWeb(requestBody as any).pipe(req);
            }
            return promise;
          },
        ),
      );
    });
  }
  return s3Server;
}

export async function createBucket(s3: Fixture<string>, bucket: string) {
  await fetchOk(
    bypass(`${await s3()}/${bucket}/`, {
      method: "PUT",
    }),
  );
}

export async function writeObject(
  s3: Fixture<string>,
  bucket: string,
  path: string,
  body: RequestInit["body"],
) {
  await fetchOk(
    bypass(`${await s3()}/${bucket}/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: body,
    }),
  );
}
