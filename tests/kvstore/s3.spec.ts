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

import "#src/kvstore/s3/register.js";
import { beforeAll } from "vitest";
import {
  createBucket,
  fakeS3ServerFixture,
  writeObject,
} from "#tests/fixtures/fake_s3_server.js";
import { constantFixture } from "#tests/fixtures/fixture.js";
import { mswFixture } from "#tests/fixtures/msw";
import { getTestFiles } from "#tests/kvstore/test_data.js";
import { testKvStore } from "#tests/kvstore/test_util.js";

const msw = mswFixture();
const fakeS3Server = fakeS3ServerFixture({ msw });

const BUCKET = "mybucket";

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
});

testKvStore(constantFixture(`s3://${BUCKET}/`));
