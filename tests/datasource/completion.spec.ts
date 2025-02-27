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

import "#src/kvstore/http/register_frontend.js";
import "#src/kvstore/zip/register_frontend.js";

import { describe, expect, test } from "vitest";
import { getKvStoreCompletions } from "#src/datasource/kvstore_completions.js";
import { dataSourceProviderFixture } from "#tests/fixtures/datasource_provider.js";
import { constantFixture } from "#tests/fixtures/fixture.js";
import { httpServerFixture } from "#tests/fixtures/http_server.js";
import { sharedKvStoreContextFixture } from "#tests/fixtures/shared_kvstore_context.js";
import { TEST_FILES_DIR } from "#tests/kvstore/test_data.js";

describe("http completion", () => {
  const serverFixture = httpServerFixture(constantFixture(TEST_FILES_DIR));
  const kvStoreContextFixture = sharedKvStoreContextFixture();
  test("get completions", async () => {
    const serverUrl = await serverFixture.serverUrl();
    expect(
      await getKvStoreCompletions(await kvStoreContextFixture(), {
        url: serverUrl,
      }),
    ).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "value": "baz/",
          },
          {
            "value": "%23|",
          },
          {
            "value": "a|",
          },
          {
            "value": "b|",
          },
          {
            "value": "c|",
          },
          {
            "value": "empty|",
          },
        ],
        "defaultCompletion": undefined,
        "offset": 23,
      }
    `);
  });

  test("get completions with partial name", async () => {
    const serverUrl = await serverFixture.serverUrl();
    expect(
      await getKvStoreCompletions(await kvStoreContextFixture(), {
        url: serverUrl + "b",
      }),
    ).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "value": "baz/",
          },
          {
            "value": "b|",
          },
        ],
        "defaultCompletion": undefined,
        "offset": 23,
      }
    `);
  });

  test("get completions with subdirectory", async () => {
    const serverUrl = await serverFixture.serverUrl();
    expect(
      await getKvStoreCompletions(await kvStoreContextFixture(), {
        url: serverUrl + "baz/",
      }),
    ).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "value": "first|",
          },
          {
            "value": "x|",
          },
          {
            "value": "z|",
          },
        ],
        "defaultCompletion": undefined,
        "offset": 27,
      }
    `);
  });
});

describe("datasource completion", () => {
  const datasourceProviderFixture = dataSourceProviderFixture();

  test("get empty completions", async () => {
    expect(await (await datasourceProviderFixture()).completeUrl({ url: "" }))
      .toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "http (unauthenticated)",
            "value": "http://",
          },
          {
            "description": "https (unauthenticated)",
            "value": "https://",
          },
          {
            "description": "Local in-memory",
            "value": "local://",
          },
        ],
        "offset": 0,
      }
    `);
  });
});
