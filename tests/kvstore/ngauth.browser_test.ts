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

import "#src/kvstore/ngauth/register.js";
import "#src/kvstore/ngauth/register_credentials_provider.js";
import { http, passthrough } from "msw";
import { expect, test, afterEach } from "vitest";
import { mswFixture } from "#tests/fixtures/msw";
import { sharedKvStoreContextFixture } from "#tests/fixtures/shared_kvstore_context.js";
import { statusMessageObserverFixture } from "#tests/fixtures/status_message_observer.js";
import { clearCookies } from "#tests/util/clear_cookies.js";
import { mswRequestLog } from "#tests/util/msw_request_log.js";

const msw = mswFixture();

const statusMessageObserver = statusMessageObserverFixture();

declare const FAKE_NGAUTH_SERVER: string;

const BUCKET = "mybucket";

const sharedKvStoreContext = sharedKvStoreContextFixture();
const sharedKvStoreContext2 = sharedKvStoreContextFixture();
afterEach(() => {
  clearCookies();
});

test("login", async () => {
  using requestLog = mswRequestLog(await msw(), {
    redact: ["(?<=neuroglancer=)[a-f0-9]+"],
  });
  (await msw()).use(
    http.get(
      `https://storage.googleapis.com/storage/v1/b/mybucket/o/missing`,
      async () => {
        return new Response(null, { status: 404 });
      },
    ),
    http.all(`${FAKE_NGAUTH_SERVER}/*`, () => passthrough()),
  );
  {
    const readPromise = (await sharedKvStoreContext()).kvStoreContext.read(
      `gs+ngauth+${FAKE_NGAUTH_SERVER}/${BUCKET}/missing`,
    );
    console.log("Waiting for login");
    const loginButton = await (
      await statusMessageObserver()
    ).waitForButton(/\blogin\b/);
    console.log("Clicking login");
    loginButton.click();
    console.log("Waiting for read to complete");
    expect(await readPromise).toBe(undefined);
    expect.soft(await requestLog.popAll()).toMatchInlineSnapshot(`
        [
          {
            "request": {
              "url": "http://localhost:*/token",
            },
            "response": {
              "status": 401,
            },
          },
          {
            "request": {
              "body": "{"token":"fake_token","bucket":"mybucket"}",
              "url": "http://localhost:*/gcs_token",
            },
            "response": {
              "body": "{"token":"fake_gcs_token:mybucket"}",
              "status": 200,
            },
          },
          {
            "request": {
              "headers": [
                "authorization: Bearer fake_gcs_token:mybucket",
              ],
              "url": "https://storage.googleapis.com/storage/v1/b/mybucket/o/missing?alt=media&neuroglancer=*",
            },
            "response": {
              "status": 404,
            },
          },
        ]
      `);
  }

  // Now that cookies has been set, login is not required.
  {
    const readPromise = (await sharedKvStoreContext2()).kvStoreContext.read(
      `gs+ngauth+${FAKE_NGAUTH_SERVER}/${BUCKET}/missing`,
    );
    expect(await readPromise).toBe(undefined);
    expect(await requestLog.popAll()).toMatchInlineSnapshot(`
        [
          {
            "request": {
              "url": "http://localhost:*/token",
            },
            "response": {
              "body": "fake_token",
              "status": 200,
            },
          },
          {
            "request": {
              "body": "{"token":"fake_token","bucket":"mybucket"}",
              "url": "http://localhost:*/gcs_token",
            },
            "response": {
              "body": "{"token":"fake_gcs_token:mybucket"}",
              "status": 200,
            },
          },
          {
            "request": {
              "headers": [
                "authorization: Bearer fake_gcs_token:mybucket",
              ],
              "url": "https://storage.googleapis.com/storage/v1/b/mybucket/o/missing?alt=media&neuroglancer=*",
            },
            "response": {
              "status": 404,
            },
          },
        ]
      `);
  }
});
