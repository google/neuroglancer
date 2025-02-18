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

import type {
  ByteRange,
  ByteRangeRequest,
  DriverReadOptions,
  FileHandle,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { readFileHandle } from "#src/kvstore/index.js";

export function composeByteRangeRequest(
  outer: ByteRange,
  inner: ByteRangeRequest | undefined,
): { outer: ByteRange; inner: ByteRange } {
  if (inner === undefined) {
    return { outer, inner: { offset: 0, length: outer.length } };
  }
  if ("suffixLength" in inner) {
    const length = Math.min(outer.length, inner.suffixLength);
    return {
      outer: { offset: outer.offset + (outer.length - length), length },
      inner: { offset: outer.length - length, length },
    };
  }
  if (inner.offset + inner.length > outer.length) {
    throw new Error(
      `Requested byte range ${JSON.stringify(
        inner,
      )} not valid for value of length ${outer.length}`,
    );
  }
  return {
    outer: { offset: outer.offset + inner.offset, length: inner.length },
    inner,
  };
}

export function handleByteRangeRequestFromUint8Array(
  value: Uint8Array,
  byteRange: ByteRangeRequest | undefined,
): ReadResponse {
  const {
    outer: { offset, length },
  } = composeByteRangeRequest({ offset: 0, length: value.length }, byteRange);
  return {
    offset,
    length,
    totalSize: value.length,
    response: new Response(value.subarray(offset, offset + length)),
  };
}

export class FileByteRangeHandle implements FileHandle {
  constructor(
    public base: FileHandle,
    public byteRange: ByteRange,
  ) {}

  async stat(options: StatOptions): Promise<StatResponse | undefined> {
    options;
    return { totalSize: this.byteRange.length };
  }

  async read(options: DriverReadOptions): Promise<ReadResponse> {
    const { byteRange } = this;
    const { outer: outerByteRange, inner: innerByteRange } =
      composeByteRangeRequest(byteRange, options.byteRange);
    if (outerByteRange.length === 0) {
      return {
        response: new Response(new Uint8Array(0)),
        totalSize: byteRange.length,
        ...innerByteRange,
      };
    }
    const response = await readFileHandle(this.base, {
      signal: options.signal,
      byteRange: outerByteRange,
      strictByteRange: true,
      throwIfMissing: true,
    });
    return {
      response: response.response,
      totalSize: byteRange.length,
      ...innerByteRange,
    };
  }

  getUrl() {
    const { offset, length } = this.byteRange;
    return `${this.base.getUrl()}|range:${offset}-${offset + length}`;
  }
}
