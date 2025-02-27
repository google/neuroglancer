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

import { FileByteRangeHandle } from "#src/kvstore/byte_range/file_handle.js";
import type {
  DriverReadOptions,
  KvStore,
  ReadResponse,
  StatOptions,
  StatResponse,
  FileHandle,
  ByteRange,
} from "#src/kvstore/index.js";

function parseKey(key: string): ByteRange {
  const m = key.match(/^([0-9]+)-([0-9]+)$/);
  if (m !== null) {
    const begin = Number(m[1]);
    const end = Number(m[2]);
    if (end >= begin) {
      return { offset: begin, length: end - begin };
    }
  }
  throw new Error(
    `Invalid key ${JSON.stringify(key)} for "byte-range:", expected "<begin>-<end>"`,
  );
}

export class ByteRangeKvStore implements KvStore {
  constructor(public base: FileHandle) {}

  getUrl(key: string) {
    return this.base.getUrl() + `|byte-range:${key}`;
  }

  async stat(
    key: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const { length } = parseKey(key);
    options;
    return { totalSize: length };
  }

  async read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const byteRange = parseKey(key);
    return new FileByteRangeHandle(this.base, byteRange).read(options);
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
  get singleKey() {
    return true;
  }
}
