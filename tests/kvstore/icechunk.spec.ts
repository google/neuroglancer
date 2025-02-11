/**
 * @license
 * Copyright 2025 Google Inc.
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

import { http, passthrough } from "msw";
import { beforeAll, describe, expect, test } from "vitest";
import { getKvStoreCompletions } from "#src/datasource/kvstore_completions.js";
import { formatRefSpec, parseRefSpec } from "#src/kvstore/icechunk/url.js";
import { listKvStoreRecursively, readKvStore } from "#src/kvstore/index.js";
import {
  createBucket,
  fakeS3ServerFixture,
  writeObject,
} from "#tests/fixtures/fake_s3_server.js";
import { mswFixture } from "#tests/fixtures/msw";
import {
  sharedKvStoreContext,
  testAutoDetect,
} from "#tests/kvstore/test_util.js";

declare const TEST_DATA_SERVER: string;

const BASE_URL = `${TEST_DATA_SERVER}kvstore/icechunk/single_array.icechunk/`;

test.for(["single_array", "hierarchy"])("golden test %s", async (name) => {
  const icechunkUrl = `${TEST_DATA_SERVER}kvstore/icechunk/${name}.icechunk/|icechunk:`;
  const fileUrl = `${TEST_DATA_SERVER}kvstore/icechunk/${name}/`;
  const context = await sharedKvStoreContext();
  const fileKvStore = context.kvStoreContext.getKvStore(fileUrl);
  const icechunkKvStore = context.kvStoreContext.getKvStore(icechunkUrl);
  const fileKeys = await listKvStoreRecursively(
    fileKvStore.store,
    fileKvStore.path,
    { responseKeys: "suffix" },
  );
  const icechunkKeys = await listKvStoreRecursively(
    icechunkKvStore.store,
    icechunkKvStore.path,
    { responseKeys: "suffix" },
  );

  // icechunk driver currently does not list chunk keys
  expect(icechunkKeys.map(({ key }) => key)).toEqual(
    fileKeys
      .filter(({ key }) => key.endsWith("zarr.json"))
      .map(({ key }) => key),
  );

  for (const { key } of fileKeys) {
    const expectedResponse = (
      await readKvStore(fileKvStore.store, fileKvStore.path + key, {
        throwIfMissing: true,
      })
    ).response;
    const actualResponse = (
      await readKvStore(icechunkKvStore.store, icechunkKvStore.path + key, {
        throwIfMissing: true,
      })
    ).response;
    if (key.endsWith("zarr.json")) {
      expect
        .soft(await expectedResponse.json(), key)
        .toEqual(await actualResponse.json());
    } else {
      expect
        .soft(await expectedResponse.arrayBuffer(), key)
        .toEqual(await actualResponse.arrayBuffer());
    }
  }
});

describe("ref access", () => {
  test.for([
    "@branch.main/",
    "@branch.other_branch/",
    "@tag.tag1/",
    "@tag.tag2/",
  ])("version %s equivalent to no version", async (version) => {
    const context = await sharedKvStoreContext();
    const { response: expectedResponse } = await context.kvStoreContext.read(
      `${TEST_DATA_SERVER}kvstore/icechunk/single_array.icechunk/|icechunk:zarr.json`,
      { throwIfMissing: true },
    );
    const { response } = await context.kvStoreContext.read(
      `${TEST_DATA_SERVER}kvstore/icechunk/single_array.icechunk/|icechunk:${version}zarr.json`,
      { throwIfMissing: true },
    );
    await expect(response.json()).resolves.toEqual(
      await expectedResponse.json(),
    );
  });

  test("deleted tag fails", async () => {
    const context = await sharedKvStoreContext();
    await expect(
      context.kvStoreContext.read(
        `${TEST_DATA_SERVER}kvstore/icechunk/single_array.icechunk/|icechunk:@tag.tag3/zarr.json`,
        { throwIfMissing: true },
      ),
    ).rejects.toMatchObject({ cause: new Error("Tag is marked as deleted") });
  });
});

describe("completion", () => {
  test("empty prefix", async () => {
    const url = `${BASE_URL}|icechunk:`;
    const completions = await getKvStoreCompletions(
      await sharedKvStoreContext(),
      {
        url,
      },
    );
    expect(completions).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "Ref specifier",
            "value": "@",
          },
          {
            "value": "zarr.json|",
          },
        ],
        "defaultCompletion": undefined,
        "offset": 72,
      }
    `);
  });

  test("@ prefix", async () => {
    const url = `${BASE_URL}|icechunk:@`;
    const completions = await getKvStoreCompletions(
      await sharedKvStoreContext(),
      {
        url,
      },
    );
    expect(completions).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "Branch",
            "value": "branch.main/",
          },
          {
            "description": "Branch",
            "value": "branch.other_branch/",
          },
          {
            "description": "Tag",
            "value": "tag.tag1/",
          },
          {
            "description": "Tag",
            "value": "tag.tag2/",
          },
          {
            "description": "Tag",
            "value": "tag.tag3/",
          },
          {
            "description": "Snapshot",
            "value": "FWWFQGAW742XMX0F5MF0/",
          },
          {
            "description": "Snapshot",
            "value": "K85ER2WWGSGYGXW0GJC0/",
          },
        ],
        "offset": 73,
      }
    `);
  });

  test("@tag.t prefix", async () => {
    const url = `${BASE_URL}|icechunk:@tag.t`;
    const completions = await getKvStoreCompletions(
      await sharedKvStoreContext(),
      {
        url,
      },
    );
    expect(completions).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "Tag",
            "value": "tag.tag1/",
          },
          {
            "description": "Tag",
            "value": "tag.tag2/",
          },
          {
            "description": "Tag",
            "value": "tag.tag3/",
          },
        ],
        "offset": 73,
      }
    `);
  });

  test("@branch.m prefix", async () => {
    const url = `${BASE_URL}|icechunk:@branch.m`;
    const completions = await getKvStoreCompletions(
      await sharedKvStoreContext(),
      {
        url,
      },
    );
    expect(completions).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "Branch",
            "value": "branch.main/",
          },
        ],
        "offset": 73,
      }
    `);
  });
});

describe("virtual refs", () => {
  const msw = mswFixture();
  const fakeS3Server = fakeS3ServerFixture({ msw });
  const s3Content = new Uint8Array(25);
  for (let i = 0; i < 25; ++i) {
    s3Content[i] = i;
  }
  beforeAll(async () => {
    (await msw()).use(http.all(`${TEST_DATA_SERVER}*`, () => passthrough()));
    const bucket = "mybucket";
    await createBucket(fakeS3Server, "mybucket");
    await writeObject(fakeS3Server, bucket, "myobject", s3Content);
  });
  test("read virtual ref", async () => {
    const context = await sharedKvStoreContext();
    const { response } = await context.kvStoreContext.read(
      `${TEST_DATA_SERVER}kvstore/icechunk/virtual_ref.icechunk/|icechunk:c/0/0`,
      { throwIfMissing: true },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      s3Content.slice(5, 25),
    );
  });
});

test("auto detect", async () => {
  expect(await testAutoDetect(BASE_URL)).toMatchInlineSnapshot(`
    [
      {
        "description": "Icechunk repository",
        "suffix": "icechunk:",
      },
    ]
  `);
});

describe("ref spec parsing", () => {
  describe("valid round trip", () => {
    test.for([
      "ZZZZZZZZZZZZZZZZZZZZ",
      "branch.main",
      "branch.other",
      "tag.foo",
    ])("%s", (version) => {
      const parsed = parseRefSpec(version)!;
      expect(formatRefSpec(parsed!)).toEqual(version);
    });
  });

  describe("invalid", () => {
    test.for(["branch.", "b", "ZZZZZZZZZZZ"])("%s", (version) => {
      expect(() => parseRefSpec(version)).toThrow();
    });
  });
});
