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

import type {
  AutoDetectFileOptions,
  AutoDetectMatch,
  AutoDetectRegistry,
} from "#src/kvstore/auto_detect.js";
import { GzipFileHandle } from "#src/kvstore/gzip/file_handle.js";
import type {
  DriverReadOptions,
  KvStore,
  ReadResponse,
  StatOptions,
  StatResponse,
  FileHandle,
} from "#src/kvstore/index.js";
import { isGzipFormat } from "#src/util/gzip.js";

export class GzipKvStore implements KvStore {
  constructor(
    public base: FileHandle,
    public scheme: string,
    public format: CompressionFormat,
  ) {}

  getUrl(key: string) {
    this.validatePath(key);
    return this.base.getUrl() + `|${this.scheme}`;
  }

  private validatePath(path: string) {
    if (path) {
      throw new Error(
        `"${this.scheme}:" does not support non-empty path ${JSON.stringify(path)}`,
      );
    }
  }

  async stat(
    key: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    this.validatePath(key);
    await this.base.stat(options);
    return { totalSize: undefined };
  }

  async read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    this.validatePath(key);
    return new GzipFileHandle(this.base, this.format).read(options);
  }

  get supportsOffsetReads() {
    return false;
  }
  get supportsSuffixReads() {
    return false;
  }
  get singleKey() {
    return true;
  }
}

async function detectGzip(
  options: AutoDetectFileOptions,
): Promise<AutoDetectMatch[]> {
  if (!isGzipFormat(options.prefix)) {
    return [];
  }
  return [{ suffix: "gzip:", description: "gzip-compressed" }];
}

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerFileFormat({
    prefixLength: 3,
    suffixLength: 0,
    match: detectGzip,
  });
}
