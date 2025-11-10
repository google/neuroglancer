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

import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type {
  DriverListOptions,
  DriverReadOptions,
  KvStore,
  ListResponse,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import {
  encodePathForUrl,
  kvstoreEnsureDirectoryPipelineUrl,
} from "#src/kvstore/url.js";

function ensureOpfsAvailable(context: string): void {
  if (
    typeof navigator === "undefined" ||
    (navigator as any).storage === undefined
  ) {
    throw new Error(
      `${context}: OPFS (navigator.storage) is not available in this environment`,
    );
  }
}

async function getRootDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
  ensureOpfsAvailable("opfs");
  return await (navigator as any).storage.getDirectory();
}

function splitPath(path: string): string[] {
  const normalized = path.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized === "" ? [] : normalized.split("/");
}

async function getDirectoryHandleForPath(
  baseDir: FileSystemDirectoryHandle,
  pathSegments: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let current: FileSystemDirectoryHandle = baseDir;
  for (const segment of pathSegments) {
    if (segment === "") continue;
    current = await current.getDirectoryHandle(segment, { create });
  }
  return current;
}

async function getFileHandleForPath(
  baseDir: FileSystemDirectoryHandle,
  pathSegments: string[],
  create: boolean,
): Promise<FileSystemFileHandle> {
  if (pathSegments.length === 0) {
    throw new Error("getFileHandleForPath: empty path provided");
  }
  const dirSegments = pathSegments.slice(0, -1);
  const fileName = pathSegments[pathSegments.length - 1];
  const parent = await getDirectoryHandleForPath(baseDir, dirSegments, create);
  return await parent.getFileHandle(fileName, { create });
}

export class OpfsKvStore implements KvStore {
  private readonly basePathSegments: string[];
  private rootDirectoryPromise: Promise<FileSystemDirectoryHandle> | undefined;

  constructor(
    public sharedKvStoreContext: SharedKvStoreContextCounterpart,
    basePath: string,
  ) {
    this.basePathSegments = splitPath(basePath);
  }

  private getRoot(): Promise<FileSystemDirectoryHandle> {
    if (this.rootDirectoryPromise !== undefined)
      return this.rootDirectoryPromise;
    this.rootDirectoryPromise = getRootDirectoryHandle();
    return this.rootDirectoryPromise;
  }

  private async getBaseDirectory(): Promise<FileSystemDirectoryHandle> {
    const root = await this.getRoot();
    return await getDirectoryHandleForPath(
      root,
      this.basePathSegments,
      /*create=*/ true,
    );
  }

  async stat(
    key: string,
    _options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const base = await this.getBaseDirectory();
    const pathSegments = splitPath(key);
    try {
      const fileHandle = await getFileHandleForPath(
        base,
        pathSegments,
        /*create=*/ false,
      );
      const file = await fileHandle.getFile();
      return { totalSize: file.size };
    } catch (e) {
      if (
        e instanceof DOMException &&
        (e.name === "NotFoundError" || e.name === "NotAllowedError")
      ) {
        return undefined;
      }
      throw new Error(
        `stat(${key}) failed for ${this.getUrl(key)}: ${String((e as Error).message ?? e)}`,
      );
    }
  }

  async read(
    key: string,
    _options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const base = await this.getBaseDirectory();
    const pathSegments = splitPath(key);
    try {
      const fileHandle = await getFileHandleForPath(
        base,
        pathSegments,
        /*create=*/ false,
      );
      const file = await fileHandle.getFile();
      const buffer = await file.arrayBuffer();
      const response = new Response(buffer);
      return {
        response,
        offset: 0,
        length: buffer.byteLength,
        totalSize: buffer.byteLength,
      };
    } catch (e) {
      if (
        e instanceof DOMException &&
        (e.name === "NotFoundError" || e.name === "NotAllowedError")
      ) {
        return undefined;
      }
      throw new Error(
        `read(${key}) failed for ${this.getUrl(key)}: ${String((e as Error).message ?? e)}`,
      );
    }
  }

  async write(key: string, value: ArrayBuffer): Promise<void> {
    const base = await this.getBaseDirectory();
    const pathSegments = splitPath(key);
    const fh = await getFileHandleForPath(base, pathSegments, /*create=*/ true);
    const writable = await (fh as any).createWritable({
      keepExistingData: false,
    });
    try {
      await writable.write(new Uint8Array(value));
    } finally {
      await writable.close();
    }
  }

  async delete(key: string): Promise<void> {
    const base = await this.getBaseDirectory();
    const parts = splitPath(key);
    if (parts.length === 0) throw new Error("delete: empty key");
    const parent = await getDirectoryHandleForPath(
      base,
      parts.slice(0, -1),
      /*create=*/ false,
    );
    await (parent as any).removeEntry(parts[parts.length - 1], {
      recursive: false,
    });
  }

  async list(
    prefix: string,
    _options: DriverListOptions,
  ): Promise<ListResponse> {
    const base = await this.getBaseDirectory();
    const prefixSegments = splitPath(prefix);

    const dirForPrefix = await (async () => {
      try {
        return await getDirectoryHandleForPath(
          base,
          prefixSegments,
          /*create=*/ false,
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === "NotFoundError") {
          return undefined;
        }
        throw e;
      }
    })();

    if (dirForPrefix === undefined) {
      return { entries: [], directories: [] };
    }

    const entries: Array<{ key: string }> = [];
    const directories = new Set<string>();

    for await (const [name, handle] of (
      dirForPrefix as any
    ).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      const fullKey =
        prefix === ""
          ? name
          : `${prefix}${prefix.endsWith("/") ? "" : "/"}${name}`;
      if ((handle as FileSystemDirectoryHandle).kind === "directory") {
        directories.add(fullKey);
      } else {
        entries.push({ key: fullKey });
      }
    }

    const sortedEntries = entries.sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    const sortedDirectories = Array.from(directories).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

    return { entries: sortedEntries, directories: sortedDirectories };
  }

  getUrl(key: string): string {
    const base = this.basePathSegments.join("/");
    const baseUrl =
      base === "" ? "opfs://" : `opfs://${encodePathForUrl(base)}/`;
    const ensured = kvstoreEnsureDirectoryPipelineUrl(baseUrl);
    return ensured + (key === "" ? "" : encodePathForUrl(key));
  }

  get supportsOffsetReads(): boolean {
    return false;
  }
  get supportsSuffixReads(): boolean {
    return false;
  }
}
