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

import "#src/kvstore/s3/register_frontend.js";
import "#src/kvstore/http/register_frontend.js";
import { beforeAll, describe, expect, test } from "vitest";
import {
  createBucket,
  fakeS3ServerFixture,
  writeObject,
} from "#tests/fixtures/fake_s3_server.js";
import { constantFixture } from "#tests/fixtures/fixture.js";
import { mswFixture } from "#tests/fixtures/msw";
import { getTestFiles } from "#tests/kvstore/test_data.js";
import { testKvStore, sharedKvStoreContext } from "#tests/kvstore/test_util.js";

const msw = mswFixture();
const fakeS3Server = fakeS3ServerFixture({ msw });

const BUCKET = "mybucket";
const OTHER_BUCKET = "otherbucket";

const SPECIAL_CHAR_CODES: number[] = [];
for (let i = 1; i <= 9; ++i) {
  SPECIAL_CHAR_CODES.push(i);
}

beforeAll(async () => {
  // Add data to S3.
  await createBucket(fakeS3Server, BUCKET);
  for (const [relativePath, content] of await getTestFiles()) {
    await writeObject(
      fakeS3Server,
      BUCKET,
      relativePath,
      new Uint8Array(content),
    );
  }

  // Create another bucket for testing special character handling in list
  // operations.
  await createBucket(fakeS3Server, OTHER_BUCKET);
  for (const charCode of SPECIAL_CHAR_CODES) {
    await writeObject(
      fakeS3Server,
      OTHER_BUCKET,
      String.fromCharCode(charCode),
      Uint8Array.of(charCode),
    );
  }
});

describe("s3://", () => {
  testKvStore(constantFixture(`s3://${BUCKET}/`));
});

describe("s3+http:// virtual-hosted style URL", () => {
  testKvStore(constantFixture(`s3+https://${BUCKET}.s3.amazonaws.com/`));
});

describe("s3+http:// path-style URL", () => {
  testKvStore(constantFixture(`s3+https://s3.amazonaws.com/${BUCKET}/`));
});

describe("http:// virtual hosted-style URL", () => {
  testKvStore(constantFixture(`https://${BUCKET}.s3.amazonaws.com/`));
});

describe("http:// path-style URL", () => {
  testKvStore(constantFixture(`https://s3.amazonaws.com/${BUCKET}/`));
});

describe("special characters", () => {
  test.for(SPECIAL_CHAR_CODES)("charCode=%s", async (charCode) => {
    const context = await sharedKvStoreContext();
    const response = await context.kvStoreContext.read(
      `s3://${OTHER_BUCKET}/${encodeURIComponent(String.fromCharCode(charCode))}`,
      { throwIfMissing: true },
    );
    expect(await response.response.arrayBuffer()).toEqual(
      Uint8Array.of(charCode).buffer,
    );
  });
  test("list", async () => {
    const context = await sharedKvStoreContext();
    const response = await context.kvStoreContext.list(
      `s3://${OTHER_BUCKET}/`,
      { responseKeys: "path" },
    );
    expect(response).toEqual({
      directories: [],
      entries: SPECIAL_CHAR_CODES.map((charCode) => ({
        key: String.fromCharCode(charCode),
      })),
    });
  });
});
