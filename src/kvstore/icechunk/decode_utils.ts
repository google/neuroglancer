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

import { Unpackr } from "msgpackr";
import * as v from "valibot";
import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { crockfordBase32Encode } from "#src/kvstore/icechunk/crockford_base32.js";

export const LATEST_KNOWN_SPEC_VERSION = 1;

// "ICE🧊CHUNK" as UTF-8
const MAGIC = Uint8Array.of(
  0x49,
  0x43,
  0x45,
  0xf0,
  0x9f,
  0xa7,
  0x8a,
  0x43,
  0x48,
  0x55,
  0x4e,
  0x4b,
);

const IMPLEMENTATION_NAME_LENGTH = 24;

const ENVELOPE_HEADER_SIZE =
  MAGIC.length + // magic
  IMPLEMENTATION_NAME_LENGTH + // implementation name
  1 + // spec_version
  1 + // file type
  1; // compression

export enum CompressionMethod {
  UNCOMPRESSED = 0,
  ZSTD = 1,
}

export async function decodeEnvelope(
  buffer: ArrayBuffer,
  maxVersion: number,
  fileType: number,
  signal: AbortSignal,
): Promise<{ content: Uint8Array; specVersion: number }> {
  if (buffer.byteLength < ENVELOPE_HEADER_SIZE) {
    throw new Error(
      `Expected icechunk header of ${ENVELOPE_HEADER_SIZE} bytes, but received: ${buffer.byteLength} bytes`,
    );
  }
  const dv = new DataView(buffer);
  let offset = 0;
  for (let i = 0, n = MAGIC.length; i < n; ++i) {
    if (dv.getUint8(i) !== MAGIC[i]) {
      throw new Error(
        `Expected magic bytes of ${MAGIC.join()} but received: ${new Uint8Array(buffer, 0, n).join()}`,
      );
    }
  }
  offset += MAGIC.length;
  offset += IMPLEMENTATION_NAME_LENGTH;
  const specVersion = dv.getUint8(offset++);
  if (specVersion > maxVersion) {
    throw new Error(
      `Expected version <= ${maxVersion} but received: ${specVersion}`,
    );
  }
  const storedFileType = dv.getUint8(offset++);
  if (storedFileType !== fileType) {
    throw new Error(
      `Expected file type of ${fileType}, but received: ${storedFileType}`,
    );
  }
  const compressionMethod = dv.getUint8(offset++);
  let content = new Uint8Array(buffer, offset);
  switch (compressionMethod) {
    case CompressionMethod.UNCOMPRESSED:
      break;
    case CompressionMethod.ZSTD:
      content = await requestAsyncComputation(
        decodeZstd,
        signal,
        [buffer],
        content,
      );
      content = new Uint8Array(
        content.buffer,
        content.byteOffset,
        content.byteLength,
      );
      break;
    default:
      throw new Error(`Unknown compression method: ${compressionMethod}`);
  }

  return { content, specVersion };
}

export interface DecodedIcechunkMessage {
  content: unknown;
  specVersion: number;
  estimatedSize: number;
}

export async function decodeMsgpack(
  buffer: ArrayBuffer,
  maxVersion: number,
  fileType: number,
  signal: AbortSignal,
): Promise<DecodedIcechunkMessage> {
  const { content, specVersion } = await decodeEnvelope(
    buffer,
    maxVersion,
    fileType,
    signal,
  );
  return {
    content: new Unpackr({
      mapsAsObjects: false,
      int64AsType: "bigint",
    }).unpack(content),
    specVersion,
    estimatedSize: buffer.byteLength * 3,
  };
}

const DataId = v.pipe(
  v.tuple([v.instance(Uint8Array)]),
  v.transform((obj) => obj[0]),
);

export const DataId12 = v.pipe(
  DataId,
  v.length(12),
  v.transform<Uint8Array<ArrayBuffer>, string>(crockfordBase32Encode),
);
export const DataId8 = v.pipe(
  DataId,
  v.length(8),
  v.transform<Uint8Array<ArrayBuffer>, string>(crockfordBase32Encode),
);

const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const bigIntToSafeNumber = v.pipe(
  v.bigint(),
  v.check(
    (x) => x >= MIN_SAFE_INTEGER_BIGINT && x <= MAX_SAFE_INTEGER_BIGINT,
    `Number outside supported range: [${Number.MIN_SAFE_INTEGER}, ${Number.MAX_SAFE_INTEGER}]`,
  ),
  v.transform(Number),
);

export const Integer = v.union([
  bigIntToSafeNumber,
  v.pipe(v.number(), v.integer()),
]);

export function tupleToObject<TEntries extends v.ObjectEntries>(
  entries: TEntries,
) {
  const keys = Object.keys(entries);
  return v.pipe(
    v.array(v.any()),
    v.length(keys.length),
    v.transform((x: unknown[]) =>
      Object.fromEntries(keys.map((key, i) => [key, x[i]])),
    ),
    v.strictObject(entries),
  );
}

export const ManifestId = DataId12;
export type ManifestId = v.InferOutput<typeof ManifestId>;
export const ChunkId = DataId12;
export type ChunkId = v.InferOutput<typeof ChunkId>;
export const NodeId = DataId8;
export type NodeId = v.InferOutput<typeof NodeId>;

export function parseDecodedMsgpack<
  TOutput,
  TIssue extends v.BaseIssue<unknown>,
>(
  schema: v.BaseSchema<unknown, TOutput, TIssue>,
  name: string,
  decoded: DecodedIcechunkMessage,
): TOutput & { estimatedSize: number } {
  try {
    return {
      ...v.parse(schema, decoded.content),
      estimatedSize: decoded.estimatedSize,
    };
  } catch (e) {
    if (v.isValiError(e)) {
      throw new Error(
        `Error parsing icechunk ${name}: ${JSON.stringify(v.flatten(e.issues))}`,
      );
    }
    throw e;
  }
}
