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

import { buf as crc32cbuf } from "crc-32/crc32c.js";
import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { decodeLeb128, decodeLeb128Bigint } from "#src/util/leb128.js";

export enum CompressionMethod {
  UNCOMPRESSED = 0,
  ZSTD = 1,
}

export async function decodeEnvelope(
  buffer: ArrayBuffer,
  expectedMagic: number,
  maxVersion: number,
  signal: AbortSignal,
): Promise<{
  reader: Reader;
  version: number;
}> {
  if (buffer.byteLength < 4 + 8 + 4 + 2) {
    throw new Error("Unexpected EOF");
  }
  const dv = new DataView(buffer);
  const magic = dv.getUint32(0, /*littleEndian=*/ false);
  if (magic !== expectedMagic) {
    throw new Error(
      `Expected magic value 0x${expectedMagic.toString(16)} but received 0x${magic.toString(16)}`,
    );
  }
  const length = dv.getBigUint64(4, /*littleEndian=*/ true);
  if (length != BigInt(buffer.byteLength)) {
    throw new Error(
      `Expected length ${buffer.byteLength} but received: ${length}`,
    );
  }

  const checksum = dv.getUint32(buffer.byteLength - 4, /*littleEndian=*/ true);
  const actualChecksum =
    crc32cbuf(new Uint8Array(buffer, 0, buffer.byteLength - 4)) >>> 0;
  if (checksum != actualChecksum) {
    throw new Error(
      `Expected CRC32c checksum of ${checksum}, but received ${actualChecksum}`,
    );
  }

  // Technically this is a varint, but all currentl-supported values are 1 byte.
  const version = dv.getUint8(12);
  if (version > maxVersion) {
    throw new Error(
      `Expected version to be <= ${maxVersion}, but received: ${version}`,
    );
  }

  const compressionFormat = dv.getUint8(13);
  let content = new Uint8Array(buffer, 14, buffer.byteLength - 14 - 4);
  switch (compressionFormat) {
    case CompressionMethod.UNCOMPRESSED:
      // uncompressed
      break;
    case CompressionMethod.ZSTD:
      // zstd
      content = await requestAsyncComputation(
        decodeZstd,
        signal,
        [buffer],
        content,
      );
      break;
    default:
      throw new Error(`Unknown compression format ${compressionFormat}`);
  }
  return {
    reader: {
      offset: 0,
      data: new DataView(
        content.buffer,
        content.byteOffset,
        content.byteLength,
      ),
    },
    version,
  };
}

export interface Reader {
  offset: number;
  data: DataView<ArrayBuffer>;
}

export function readBytes(
  reader: Reader,
  count: number,
): Uint8Array<ArrayBuffer> {
  const { offset, data } = reader;
  if (offset + count > data.byteLength) {
    throw new Error(`Unexpected EOF`);
  }
  reader.offset += count;
  return new Uint8Array(data.buffer, data.byteOffset + offset, count);
}

export function readLeb128(reader: Reader): number {
  const { value, offset } = decodeLeb128(reader.data, reader.offset);
  reader.offset = offset;
  return value;
}

export function readLeb128Bigint(reader: Reader): bigint {
  const { value, offset } = decodeLeb128Bigint(reader.data, reader.offset);
  reader.offset = offset;
  return value;
}

export function readLeb128Bounded(reader: Reader, maxValue: number): number {
  const value = readLeb128(reader);
  if (value > maxValue) {
    throw new Error(`Expected value <= ${maxValue}, but received: ${value}`);
  }
  return value;
}

export function readUint8(reader: Reader): number {
  const { offset, data } = reader;
  if (offset + 1 > data.byteLength) {
    throw new Error(`Unexpected EOF`);
  }
  reader.offset += 1;
  return data.getUint8(offset);
}

export function readInt32le(reader: Reader): number {
  const { offset, data } = reader;
  if (offset + 4 > data.byteLength) {
    throw new Error(`Unexpected EOF`);
  }
  reader.offset += 4;
  return data.getInt32(offset, /*littleEndian=*/ true);
}

export function readUint64le(reader: Reader): bigint {
  const { offset, data } = reader;
  if (offset + 8 > data.byteLength) {
    throw new Error(`Unexpected EOF`);
  }
  reader.offset += 8;
  return data.getBigUint64(offset, /*littleEndian=*/ true);
}

export function ensureEof(reader: Reader) {
  if (reader.offset !== reader.data.byteLength) {
    throw new Error(`Expected EOF at byte ${reader.offset}`);
  }
}

export type ArrayReader<T, Options> = (
  reader: Reader,
  count: number,
  options: Options,
) => T[];

export function readArrayOf<T, Options>(
  readElement: (reader: Reader, options: Options) => T,
): ArrayReader<T, Options> {
  return (reader, count, options) => {
    const values: T[] = [];
    for (let i = 0; i < count; ++i) {
      values[i] = readElement(reader, options);
    }
    return values;
  };
}

type StructOfArrays<T> = {
  [Property in keyof T]: ArrayLike<T[Property]>;
} & Record<keyof T, ArrayLike<unknown>>;

type StructOfArrayReaders<T, Options> = Record<
  string,
  ArrayReader<unknown, Options>
> & {
  [Property in keyof T]: ArrayReader<T[Property], Options>;
};

export function toArrayOfStructs<T>(
  count: number,
  arrays: StructOfArrays<T>,
): T[] {
  const keys = Object.keys(arrays) as (keyof T)[];
  const structs: T[] = [];
  for (let i = 0; i < count; ++i) {
    const value = Object.fromEntries(
      keys.map((key) => [key, arrays[key][i]]),
    ) as T;
    structs[i] = value;
  }
  return structs;
}

export function readStructOfArrays<T, Options extends object = object>(
  members: StructOfArrayReaders<T, Options>,
  validate?: (value: T, options: Options) => void,
): ArrayReader<T, Options> {
  return (reader, count, options) => {
    const arrays = Object.fromEntries(
      Object.entries(members).map(([key, read]) => [
        key,
        read(reader, count, options),
      ]),
    ) as StructOfArrays<T>;
    const structs = toArrayOfStructs<T>(count, arrays);
    if (validate !== undefined) {
      for (let i = 0; i < count; ++i) {
        validate?.(structs[i], options);
      }
    }
    return structs;
  };
}
