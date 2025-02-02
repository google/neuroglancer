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

import "#src/kvstore/http/register.js";
import { constantFixture } from "#tests/fixtures/fixture.js";
import { httpServerFixture } from "#tests/fixtures/http_server.js";
import { TEST_FILES_DIR } from "#tests/kvstore/test_data.js";
import { testKvStore } from "#tests/kvstore/test_util.js";
import { mswFixture } from "#tests/fixtures/msw";
import { beforeEach, describe } from "vitest";
import { http, passthrough } from "msw";

const serverFixture = httpServerFixture(constantFixture(TEST_FILES_DIR));
const msw = mswFixture();

describe("with HEAD support", () => {
  testKvStore(serverFixture.serverUrl);
});

describe.for([405, 501])("HEAD returns %s", (statusCode) => {
  beforeEach(async () => {
    const serverUrl = await serverFixture.serverUrl();
    (await msw()).use(
      http.all(`${serverUrl}*`, ({ request }) => {
        if (request.method === "HEAD") {
          return new Response(null, { status: statusCode });
        }
        return passthrough();
      }),
    );
  });

  testKvStore(serverFixture.serverUrl);
});
