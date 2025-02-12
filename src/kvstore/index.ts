/**
 * @license
 * Copyright 2023 Google Inc.
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

import type { ProgressOptions } from "#src/util/progress_listener.js";
import { defaultStringCompare } from "#src/util/string.js";

export interface ByteRange {
  offset: number;
  length: number;
}

export type ByteRangeRequest =
  | ByteRange
  | {
      suffixLength: number;
    };

export interface ReadResponse {
  response: Response;
  offset: number;
  length: number | undefined;
  totalSize: number | undefined;
}

export interface DriverReadOptions extends Partial<ProgressOptions> {
  byteRange?: ByteRangeRequest;
  throwIfMissing?: boolean;
}

export class NotFoundError extends Error {
  constructor(handle: FileHandle, options?: { cause: any }) {
    super(`${handle.getUrl()} not found`, options);
  }
}

export interface ReadOptions extends DriverReadOptions {
  strictByteRange?: boolean;
}

export type DriverListOptions = Partial<ProgressOptions>;

export type ListResponseKeyKind = "path" | "suffix" | "url";

export interface ListOptions extends DriverListOptions {
  responseKeys?: ListResponseKeyKind;
}

export interface ListEntry {
  key: string;
}

export interface ListResponse {
  entries: ListEntry[];
  directories: string[];
}

export interface StatOptions extends Partial<ProgressOptions> {
  throwIfMissing?: boolean;
}

export interface StatResponse {
  totalSize: number | undefined;
}

export interface ReadableKvStore<Key = string> {
  stat(key: Key, options: StatOptions): Promise<StatResponse | undefined>;
  read(key: Key, options: DriverReadOptions): Promise<ReadResponse | undefined>;
  getUrl(key: Key): string;

  // Reads with non-zero byte offset are supported.
  supportsOffsetReads: boolean;

  // Reads with `suffixLength` byte range are supported.
  supportsSuffixReads: boolean;
}

export interface ListableKvStore {
  list?: (prefix: string, options: DriverListOptions) => Promise<ListResponse>;
}

export interface KvStore extends ReadableKvStore, ListableKvStore {
  // Indicates that the only valid key is the empty string.
  singleKey?: boolean;
}

export interface KvStoreWithPath {
  store: KvStore;
  path: string;
}

export function getKvStoreUrl(kvstore: KvStoreWithPath): string {
  return kvstore.store.getUrl(kvstore.path);
}

export function readKvStore<Key>(
  store: ReadableKvStore<Key>,
  key: Key,
  options: ReadOptions & { throwIfMissing: true },
): Promise<ReadResponse>;

export function readKvStore<Key>(
  store: ReadableKvStore<Key>,
  key: Key,
  options?: ReadOptions,
): Promise<ReadResponse | undefined>;

export async function readKvStore<Key>(
  store: ReadableKvStore<Key>,
  key: Key,
  options: ReadOptions = {},
): Promise<ReadResponse | undefined> {
  return readFileHandle(new KvStoreFileHandle(store, key), options);
}

export function readFileHandle(
  handle: FileHandle,
  options: ReadOptions & { throwIfMissing: true },
): Promise<ReadResponse>;

export function readFileHandle(
  handle: FileHandle,
  options?: ReadOptions,
): Promise<ReadResponse | undefined>;

export async function readFileHandle(
  handle: FileHandle,
  options: ReadOptions = {},
): Promise<ReadResponse | undefined> {
  const response = await handle.read(options);
  if (options?.throwIfMissing === true) {
    if (response === undefined) {
      throw new NotFoundError(handle);
    }
  }
  if (options?.strictByteRange === true && response !== undefined) {
    const { byteRange } = options;
    const { offset, length } = response;
    if (byteRange !== undefined) {
      if (
        "suffixLength" in byteRange
          ? length !== byteRange.suffixLength
          : offset !== byteRange.offset ||
            (length !== undefined && length !== byteRange.length)
      ) {
        throw new Error(
          `Received truncated response for ${handle.getUrl()}, expected ${JSON.stringify(
            byteRange,
          )} but received offset=${offset}, length=${length}`,
        );
      }
    }
  }
  return response;
}

function transformListResponse(
  response: ListResponse,
  prefix: string,
  kvStore: KvStore,
  responseKeys?: ListResponseKeyKind,
) {
  switch (responseKeys) {
    case "suffix": {
      const offset = prefix.length;
      return {
        directories: response.directories.map((key) => key.substring(offset)),
        entries: response.entries.map(({ key, ...entry }) => ({
          ...entry,
          key: key.substring(offset),
        })),
      };
    }
    case "url": {
      return {
        directories: response.directories.map((key) => kvStore.getUrl(key)),
        entries: response.entries.map(({ key, ...entry }) => ({
          ...entry,
          key: kvStore.getUrl(key),
        })),
      };
    }
    default: {
      return response;
    }
  }
}

export async function listKvStore(
  kvStore: KvStore,
  prefix: string,
  options: ListOptions = {},
): Promise<ListResponse> {
  if (!kvStore.list) {
    throw new Error("Listing not supported");
  }
  return transformListResponse(
    await kvStore.list(prefix, options),
    prefix,
    kvStore,
    options.responseKeys,
  );
}

export async function listKvStoreRecursively(
  kvStore: KvStore,
  prefix: string,
  options: ListOptions = {},
): Promise<ListEntry[]> {
  if (!kvStore.list) {
    throw new Error("Listing not supported");
  }
  const entries: ListEntry[] = [];
  async function process(path: string) {
    const response = await kvStore.list!(path, options);
    entries.push(...response.entries);
    await Promise.all(response.directories.map((name) => process(name + "/")));
  }
  await process(prefix);
  return transformListResponse(
    normalizeListResponse({ entries, directories: [] }),
    prefix,
    kvStore,
    options.responseKeys,
  ).entries;
}

export function kvStoreAppendPath(
  kvstore: KvStoreWithPath,
  suffix: string,
): KvStoreWithPath {
  return { store: kvstore.store, path: kvstore.path + suffix };
}

export interface FileHandle {
  stat(options: StatOptions): Promise<StatResponse | undefined>;
  read(options: DriverReadOptions): Promise<ReadResponse | undefined>;
  getUrl(): string;
}

export class KvStoreFileHandle<Key> implements FileHandle {
  constructor(
    public store: ReadableKvStore<Key>,
    public key: Key,
  ) {}

  stat(options: StatOptions): Promise<StatResponse | undefined> {
    return this.store.stat(this.key, options);
  }

  read(options: DriverReadOptions): Promise<ReadResponse | undefined> {
    return this.store.read(this.key, options);
  }

  getUrl() {
    return this.store.getUrl(this.key);
  }
}

export function normalizeListResponse(response: ListResponse): ListResponse {
  response.entries.sort(({ key: a }, { key: b }) => defaultStringCompare(a, b));
  response.directories.sort(defaultStringCompare);
  return response;
}
