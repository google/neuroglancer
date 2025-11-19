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

import "#src/kvstore/http/register_frontend.js";
import "#src/kvstore/zip/register_frontend.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import yauzl from "yauzl";
import { getKvStoreCompletions } from "#src/datasource/kvstore_completions.js";
import { constantFixture } from "#tests/fixtures/fixture.js";
import { httpServerFixture } from "#tests/fixtures/http_server.js";
import { TEST_DATA_DIR } from "#tests/kvstore/test_data.js";
import {
  testKvStore,
  sharedKvStoreContext,
  readAllFromKvStore,
} from "#tests/kvstore/test_util.js";

const serverFixture = httpServerFixture(constantFixture(TEST_DATA_DIR));

function readAllUsingYauzl(zipPath: string) {
  return new Promise((resolve, reject) => {
    const map = new Map<string, Buffer>();
    yauzl.open(zipPath, { lazyEntries: true }, function (err, zipfile) {
      if (err) {
        reject(err);
        return;
      }
      zipfile.on("entry", async (entry) => {
        if (entry.fileName.endsWith("/")) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, async (err, readStream) => {
          if (err) {
            reject(err);
            return;
          }
          const parts: Buffer[] = [];
          readStream.on("data", (chunk) => {
            parts.push(chunk);
          });
          readStream.on("end", () => {
            map.set(entry.fileName, Buffer.concat(parts));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => {
        zipfile.close();
        resolve(map);
      });
      zipfile.readEntry();
    });
  });
}

async function compareToYauzl(relativePath: string) {
  const url = (await serverFixture.serverUrl()) + `${relativePath}|zip:`;
  const { kvStoreContext } = await sharedKvStoreContext();
  const kvStore = kvStoreContext.getKvStore(url);
  const contentFromZip = await readAllFromKvStore(kvStore.store, kvStore.path);
  const expectedFiles = await readAllUsingYauzl(
    path.join(TEST_DATA_DIR, relativePath),
  );
  expect(contentFromZip).toEqual(expectedFiles);
}

describe("yauzl success cases", async () => {
  const relativePath = "zip/from-yauzl/success";
  const zipFiles = await fs.readdir(path.join(TEST_DATA_DIR, relativePath));
  test.for(zipFiles)("%s", async (zipFile) => {
    await compareToYauzl(`${relativePath}/${zipFile}`);
  });
});

test("zip64 larger than 65557", async () => {
  await compareToYauzl("zip/zip64_larger_than_65557.zip");
});

describe("yauzl failure cases", async () => {
  const relativePath = "zip/from-yauzl/failure";
  const zipFiles = await fs.readdir(path.join(TEST_DATA_DIR, relativePath));
  test.for(zipFiles)("%s", async (zipFile) => {
    const url =
      (await serverFixture.serverUrl()) + `${relativePath}/${zipFile}|zip:`;
    const { kvStoreContext } = await sharedKvStoreContext();
    const kvStore = kvStoreContext.getKvStore(url);
    const expectedError = new RegExp(
      zipFile
        .replace(/(_[0-9]+)?\.zip$/, "")
        .split(/\s+/)
        .join(".*"),
      "i",
    );
    await expect(
      readAllFromKvStore(kvStore.store, kvStore.path).then(() => null),
    ).rejects.toThrowError(expectedError);
  });
});

describe("kvstore operations", () => {
  testKvStore(
    async () => (await serverFixture.serverUrl()) + "zip/files.zip|zip:",
  );
});

describe("completion", () => {
  test("empty prefix", async () => {
    const url = (await serverFixture.serverUrl()) + "zip/files.zip|zip:";
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
        "offset": 41,
      }
    `);
  });

  test("single letter prefix", async () => {
    const url = (await serverFixture.serverUrl()) + "zip/files.zip|zip:b";
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
            "value": "baz/",
          },
          {
            "value": "b|",
          },
        ],
        "defaultCompletion": undefined,
        "offset": 41,
      }
    `);
  });
});
