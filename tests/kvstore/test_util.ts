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

import { expect, test } from "vitest";
import type { AutoDetectMatch } from "#src/kvstore/auto_detect.js";
import { autoDetectFormat } from "#src/kvstore/auto_detect.js";
import type { KvStore } from "#src/kvstore/index.js";
import { listKvStoreRecursively, readKvStore } from "#src/kvstore/index.js";
import type { Fixture } from "#tests/fixtures/fixture.js";
import { sharedKvStoreContextFixture } from "#tests/fixtures/shared_kvstore_context.js";

export const sharedKvStoreContext = sharedKvStoreContextFixture();

export function testRead(url: Fixture<string>) {
  test("read not found", async () => {
    expect(
      await (
        await sharedKvStoreContext()
      ).kvStoreContext.read(`${await url()}missing`),
    ).toBe(undefined);
  });
  test("read full", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.read(`${await url()}a`, { throwIfMissing: true });
    expect.soft(response!.totalSize).toEqual(3);
    expect.soft(response!.offset).toEqual(0);
    expect.soft(response!.length).toEqual(3);
    expect.soft(await response!.response.text()).toEqual("abc");
  });
  test("read byte range zero length", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.read(`${await url()}a`, {
      byteRange: { offset: 1, length: 0 },
      throwIfMissing: true,
    });
    expect.soft(response!.totalSize).toEqual(3);
    expect.soft(response!.offset).toEqual(1);
    expect.soft(response!.length).toEqual(0);
    expect.soft(await response!.response.text()).toEqual("");
  });
  test("read byte range zero length empty file", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.read(`${await url()}empty`, {
      byteRange: { offset: 0, length: 0 },
      throwIfMissing: true,
    });
    expect.soft(response!.totalSize).toEqual(0);
    expect.soft(response!.offset).toEqual(0);
    expect.soft(response!.length).toEqual(0);
    expect.soft(await response!.response.text()).toEqual("");
  });
  test("read byte range offset+length", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.read(`${await url()}a`, {
      byteRange: { offset: 1, length: 1 },
      throwIfMissing: true,
    });
    expect.soft(response!.totalSize).toEqual(3);
    expect.soft(response!.offset).toEqual(1);
    expect.soft(response!.length).toEqual(1);
    expect.soft(await response!.response.text()).toEqual("b");
  });
  test("read byte range suffixLength", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.read(`${await url()}a`, {
      byteRange: { suffixLength: 1 },
      throwIfMissing: true,
    });
    expect.soft(response!.totalSize).toEqual(3);
    expect.soft(response!.offset).toEqual(2);
    expect.soft(response!.length).toEqual(1);
    expect.soft(await response!.response.text()).toEqual("c");
  });
  test("read byte range suffixLength=0", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.read(`${await url()}a`, {
      byteRange: { suffixLength: 0 },
      throwIfMissing: true,
    });
    expect.soft(response!.totalSize).toEqual(3);
    expect.soft(response!.offset).toEqual(3);
    expect.soft(response!.length).toEqual(0);
    expect.soft(await response!.response.text()).toEqual("");
  });
  test("stat on directory returns not found", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.stat(`${await url()}baz`);
    expect(response).toEqual(undefined);
  });
  test("read on directory returns not found", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.read(`${await url()}baz`);
    expect(response).toEqual(undefined);
  });

  test("read #", async () => {
    const response = await (
      await sharedKvStoreContext()
    ).kvStoreContext.read(`${await url()}%23`, { throwIfMissing: true });
    expect.soft(response!.totalSize).toEqual(0);
    expect.soft(response!.offset).toEqual(0);
    expect.soft(response!.length).toEqual(0);
    expect.soft(await response!.response.text()).toEqual("");
  });
}

export function testList(url: Fixture<string>) {
  test("list with empty prefix", async () => {
    expect(
      await (
        await sharedKvStoreContext()
      ).kvStoreContext.list(await url(), {
        responseKeys: "suffix",
      }),
    ).toEqual({
      directories: ["baz"],
      entries: [
        {
          key: "#",
        },
        {
          key: "a",
        },
        {
          key: "b",
        },
        {
          key: "c",
        },
        {
          key: "empty",
        },
      ],
    });
  });

  test("list with file prefix", async () => {
    expect(
      await (
        await sharedKvStoreContext()
      ).kvStoreContext.list(`${await url()}e`, {
        responseKeys: "suffix",
      }),
    ).toEqual({
      directories: [],
      entries: [
        {
          key: "mpty",
        },
      ],
    });
  });

  test("list with directory prefix", async () => {
    expect(
      await (
        await sharedKvStoreContext()
      ).kvStoreContext.list(`${await url()}baz/`, {
        responseKeys: "suffix",
      }),
    ).toEqual({
      directories: [],
      entries: [
        { key: "first" },
        {
          key: "x",
        },
        { key: "z" },
      ],
    });
  });
}

export function testKvStore(url: Fixture<string>) {
  testRead(url);
  testList(url);
}

export async function readAllFromKvStore(
  kvStore: KvStore,
  prefix: string,
): Promise<Map<string, Buffer>> {
  const keys = await listKvStoreRecursively(kvStore, prefix, {
    responseKeys: "suffix",
  });
  const values = await Promise.all(
    keys.map(async ({ key }) => {
      const readResponse = await readKvStore(kvStore, prefix + key, {
        throwIfMissing: true,
      });
      return Buffer.from(await readResponse.response.arrayBuffer());
    }),
  );
  return new Map(Array.from(keys, ({ key }, i) => [key, values[i]]));
}

export async function testAutoDetect(url: string): Promise<AutoDetectMatch[]> {
  const kvStoreContext = (await sharedKvStoreContext()).kvStoreContext;
  const result = await autoDetectFormat({
    url,
    kvStoreContext,
    autoDetectDirectory: () => kvStoreContext.autoDetectRegistry.directorySpec,
    autoDetectFile: () => kvStoreContext.autoDetectRegistry.fileSpec,
  });
  return result.matches;
}
