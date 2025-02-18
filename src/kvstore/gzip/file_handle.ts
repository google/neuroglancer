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
  DriverReadOptions,
  FileHandle,
  ReadableKvStore,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { decodeGzipStream } from "#src/util/gzip.js";

export const EXPECTED_HEADER_OVERHEAD = 100;

export class GzipFileHandle<BaseHandle extends FileHandle = FileHandle>
  implements FileHandle
{
  constructor(
    public base: BaseHandle,
    public format: CompressionFormat,
  ) {}

  async stat(options: StatOptions): Promise<StatResponse | undefined> {
    await this.base.stat(options);
    return { totalSize: undefined };
  }

  async read(options: DriverReadOptions): Promise<ReadResponse | undefined> {
    const { byteRange } = options;
    if (byteRange === undefined) {
      const readResponse = await this.base.read(options);
      if (readResponse === undefined) return undefined;
      return {
        response: new Response(
          decodeGzipStream(readResponse.response, this.format),
        ),
        offset: 0,
        length: undefined,
        totalSize: undefined,
      };
    }
    if ("suffixLength" in byteRange || byteRange.offset !== 0) {
      throw new Error(
        `Byte range with offset not supported: ${JSON.stringify(byteRange)}`,
      );
    }

    // There is no way to force a flush on a `DecompressionStream`; to ensure we
    // have all available output from the input, we must close the readable
    // stream, which prevents any further writes. This means if more input is
    // required, we have to redo the decode. In almost all cases, though,
    // `EXPECTED_HEADER_OVERHEAD` should be sufficient and it won't be necessary
    // to fetch additional encoded data.
    let decodedArray = new Uint8Array(byteRange.length);
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let encodedBytesReceived = 0;
    let expectedEncodedBytes = byteRange.length + EXPECTED_HEADER_OVERHEAD;
    while (true) {
      const readResponse = await this.base.read({
        ...options,
        byteRange: {
          offset: encodedBytesReceived,
          length: expectedEncodedBytes - encodedBytesReceived,
        },
      });
      if (readResponse === undefined) return undefined;
      {
        const part = new Uint8Array(await readResponse.response.arrayBuffer());
        parts.push(part);
        encodedBytesReceived += part.length;
      }

      const decompressionStream = new DecompressionStream("gzip");
      const writer = decompressionStream.writable.getWriter();
      const writePromises: Promise<void>[] = [];
      for (const part of parts) {
        writePromises.push(writer.write(part));
      }
      writePromises.push(writer.close());
      const reader = decompressionStream.readable.getReader();
      let decodedOffset = 0;
      try {
        while (decodedOffset < decodedArray.length) {
          let { value } = await reader.read();
          if (value === undefined) {
            // no more decoded data available
            break;
          }
          const remainingLength = decodedArray.length - decodedOffset;
          if (value.length > remainingLength) {
            value = value.subarray(0, remainingLength);
          }
          decodedArray.set(value, decodedOffset);
          decodedOffset += value.length;
        }

        if (
          decodedOffset === decodedArray.length ||
          encodedBytesReceived === readResponse.totalSize
        ) {
          if (decodedOffset < decodedArray.length) {
            decodedArray = decodedArray.subarray(0, decodedOffset);
          }
          return {
            response: new Response(decodedArray),
            offset: 0,
            length: decodedArray.length,
            totalSize: undefined,
          };
        }
      } finally {
        await reader.cancel();
        await Promise.allSettled(writePromises);
      }

      expectedEncodedBytes += Math.min(
        100,
        decodedArray.length - decodedOffset,
      );
    }
  }

  getUrl() {
    return this.base.getUrl() + "|gzip";
  }
}

export async function gzipRead<Key>(
  base: ReadableKvStore<Key>,
  baseKey: Key,
  format: CompressionFormat,
  options: DriverReadOptions,
) {
  const { byteRange } = options;
  if (byteRange === undefined) {
    const readResponse = await base.read(baseKey, options);
    if (readResponse === undefined) return undefined;
    return {
      response: new Response(decodeGzipStream(readResponse.response, format)),
      offset: 0,
      length: undefined,
      totalSize: undefined,
    };
  }
  if ("suffixLength" in byteRange || byteRange.offset !== 0) {
    throw new Error(
      `Byte range with offset not supported: ${JSON.stringify(byteRange)}`,
    );
  }

  // There is no way to force a flush on a `DecompressionStream`; to ensure we
  // have all available output from the input, we must close the readable
  // stream, which prevents any further writes. This means if more input is
  // required, we have to redo the decode. In almost all cases, though,
  // `EXPECTED_HEADER_OVERHEAD` should be sufficient and it won't be necessary
  // to fetch additional encoded data.
  let decodedArray = new Uint8Array(byteRange.length);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let encodedBytesReceived = 0;
  let expectedEncodedBytes = byteRange.length + EXPECTED_HEADER_OVERHEAD;
  while (true) {
    const readResponse = await base.read(baseKey, {
      ...options,
      byteRange: {
        offset: encodedBytesReceived,
        length: expectedEncodedBytes - encodedBytesReceived,
      },
    });
    if (readResponse === undefined) return undefined;
    {
      const part = new Uint8Array(await readResponse.response.arrayBuffer());
      parts.push(part);
      encodedBytesReceived += part.length;
    }

    const decompressionStream = new DecompressionStream("gzip");
    const writer = decompressionStream.writable.getWriter();
    const writePromises: Promise<void>[] = [];
    for (const part of parts) {
      writePromises.push(writer.write(part));
    }
    writePromises.push(writer.close());
    const reader = decompressionStream.readable.getReader();
    let decodedOffset = 0;
    try {
      while (decodedOffset < decodedArray.length) {
        let { value } = await reader.read();
        if (value === undefined) {
          // no more decoded data available
          break;
        }
        const remainingLength = decodedArray.length - decodedOffset;
        if (value.length > remainingLength) {
          value = value.subarray(0, remainingLength);
        }
        decodedArray.set(value, decodedOffset);
        decodedOffset += value.length;
      }

      if (
        decodedOffset === decodedArray.length ||
        encodedBytesReceived === readResponse.totalSize
      ) {
        if (decodedOffset < decodedArray.length) {
          decodedArray = decodedArray.subarray(0, decodedOffset);
        }
        return {
          response: new Response(decodedArray),
          offset: 0,
          length: decodedArray.length,
          totalSize: undefined,
        };
      }
    } finally {
      await reader.cancel();
      await Promise.allSettled(writePromises);
    }

    expectedEncodedBytes += Math.min(100, decodedArray.length - decodedOffset);
  }
}
