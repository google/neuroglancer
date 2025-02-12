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

import "#src/kvstore/proxy.js";
import type { ChunkManager } from "#src/chunk_manager/backend.js";
import { makeSimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import { FileByteRangeHandle } from "#src/kvstore/byte_range/file_handle.js";
import { GzipFileHandle } from "#src/kvstore/gzip/file_handle.js";
import type {
  DriverListOptions,
  DriverReadOptions,
  FileHandle,
  KvStore,
  ListEntry,
  ListResponse,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { readFileHandle } from "#src/kvstore/index.js";
import { encodePathForUrl } from "#src/kvstore/url.js";
import type {
  ZipMetadata,
  Reader,
  ZipEntry,
} from "#src/kvstore/zip/metadata.js";
import {
  readZipMetadata,
  readEntryDataHeader,
  ZipCompressionMethod,
} from "#src/kvstore/zip/metadata.js";
import {
  binarySearch,
  binarySearchLowerBound,
  filterArrayInplace,
} from "#src/util/array.js";
import {
  ProgressSpan,
  type ProgressOptions,
} from "#src/util/progress_listener.js";
import { defaultStringCompare } from "#src/util/string.js";

function makeZipReader(base: FileHandle): Reader {
  return async (
    offset: number,
    length: number,
    options: Partial<ProgressOptions>,
  ) => {
    const readResponse = await readFileHandle(base, {
      throwIfMissing: true,
      byteRange: { offset, length },
      strictByteRange: true,
      signal: options.signal,
      progressListener: options.progressListener,
    });
    return new Uint8Array(await readResponse.response.arrayBuffer());
  };
}

interface CachedZipEntry extends ZipEntry {
  fileDataStart?: number;
}

interface CachedZipMetadata extends ZipMetadata {
  entries: CachedZipEntry[];
}

function getZipMetadataCache(chunkManager: ChunkManager, base: FileHandle) {
  const url = base.getUrl();
  return makeSimpleAsyncCache(chunkManager, `zipMetadata:${url}`, {
    get: async (_unusedCacheKey: undefined, progressOptions) => {
      using _span = new ProgressSpan(progressOptions.progressListener, {
        message: `Reading ZIP central directory from ${url}`,
      });
      const statResponse = await base.stat(progressOptions);
      if (statResponse?.totalSize === undefined) {
        throw new Error(`Failed to determine ZIP file size: ${url}`);
      }
      const metadata = await readZipMetadata(
        makeZipReader(base),
        statResponse.totalSize,
        progressOptions,
      );
      // Zip files sometimes contain zero-length files corresponding to
      // directories.
      filterArrayInplace(
        metadata.entries,
        (entry) => !entry.fileName.endsWith("/"),
      );
      metadata.entries.sort((a, b) =>
        defaultStringCompare(a.fileName, b.fileName),
      );
      return { data: metadata, size: metadata.sizeEstimate };
    },
  });
}

async function getZipMetadata(
  chunkManager: ChunkManager,
  base: FileHandle,
  options: Partial<ProgressOptions>,
): Promise<CachedZipMetadata> {
  const cache = getZipMetadataCache(chunkManager, base);
  try {
    return (await cache.get(undefined, options)) as CachedZipMetadata;
  } finally {
    cache.dispose();
  }
}

function findEntry(
  metadata: CachedZipMetadata,
  key: string,
): CachedZipEntry | undefined {
  const { entries } = metadata;
  const index = binarySearch(entries, key, (key, entry) =>
    defaultStringCompare(key, entry.fileName),
  );
  if (index < 0) return undefined;
  return entries[index];
}

function list(metadata: ZipMetadata, prefix: string) {
  const { entries } = metadata;
  const startIndex = binarySearchLowerBound(
    0,
    entries.length,
    (index) => entries[index].fileName >= prefix,
  );

  const endIndex = binarySearchLowerBound(
    Math.min(entries.length, startIndex + 1),
    entries.length,
    (index) => !entries[index].fileName.startsWith(prefix),
  );

  const listEntries: ListEntry[] = [];
  const directories: string[] = [];

  for (let index = startIndex; index < endIndex; ) {
    const entry = entries[index];
    const i = entry.fileName.indexOf("/", prefix.length);
    if (i === -1) {
      // Filename
      listEntries.push({ key: entry.fileName });
      ++index;
    } else {
      // Directory
      directories.push(entry.fileName.substring(0, i));
      const directoryPrefix = entry.fileName.substring(0, i + 1);
      index = binarySearchLowerBound(
        index + 1,
        endIndex,
        (index) => !entries[index].fileName.startsWith(directoryPrefix),
      );
    }
  }

  return { entries: listEntries, directories };
}

export class ZipKvStore<BaseFileHandle extends FileHandle = FileHandle>
  implements KvStore
{
  constructor(
    public chunkManager: ChunkManager,
    public base: BaseFileHandle,
  ) {}

  private metadata: ZipMetadata | undefined;

  private async getMetadata(options: Partial<ProgressOptions>) {
    let { metadata } = this;
    if (metadata === undefined) {
      metadata = this.metadata = await getZipMetadata(
        this.chunkManager,
        this.base,
        options,
      );
    }
    return metadata;
  }

  getUrl(key: string) {
    return this.base.getUrl() + `|zip:${encodePathForUrl(key)}`;
  }

  async stat(
    key: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const entry = findEntry(await this.getMetadata(options), key);
    if (entry === undefined) return undefined;
    return { totalSize: entry.uncompressedSize };
  }

  async read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const entry = findEntry(await this.getMetadata(options), key);
    if (entry === undefined) return undefined;
    let { fileDataStart } = entry;
    if (fileDataStart === undefined) {
      fileDataStart = entry.fileDataStart = await readEntryDataHeader(
        makeZipReader(this.base),
        entry,
        options,
      );
    }
    let handle: FileHandle = new FileByteRangeHandle(this.base, {
      offset: fileDataStart,
      length: entry.compressedSize,
    });
    switch (entry.compressionMethod) {
      case ZipCompressionMethod.STORE:
        break;
      case ZipCompressionMethod.DEFLATE:
        handle = new GzipFileHandle(handle, "deflate-raw");
        break;
      default:
        throw new Error(
          `Unsupported compression method: ${entry.compressionMethod}`,
        );
    }
    return handle.read(options);
  }

  async list(
    prefix: string,
    options: DriverListOptions,
  ): Promise<ListResponse> {
    const metadata = await this.getMetadata(options);
    return list(metadata, prefix);
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}
