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

import type { Reader } from "#src/kvstore/ocdbt/decode_utils.js";
import {
  readArrayOf,
  readBytes,
  readLeb128,
  readLeb128Bigint,
  readLeb128Bounded,
  readStructOfArrays,
} from "#src/kvstore/ocdbt/decode_utils.js";
import { EMPTY_KEY } from "#src/kvstore/ocdbt/key.js";
import { pipelineUrlJoin } from "#src/kvstore/url.js";

export interface IndirectDataReference {
  dataFile: DataFileId;
  offset: bigint;
  length: bigint;
}

export interface ReadIndirectDataReferenceOptions {
  allowMissing?: boolean;
  dataFileTable: DataFileTable;
}

export function readDataFileId(
  reader: Reader,
  options: { dataFileTable: DataFileTable },
) {
  const { dataFileTable } = options;
  const index = readLeb128(reader);
  if (index >= dataFileTable.length) {
    throw new Error(
      `Invalid data file index ${index}, expected value <= ${dataFileTable.length}`,
    );
  }
  return dataFileTable[index];
}

export const readIndirectDataReferences = readStructOfArrays<
  IndirectDataReference,
  ReadIndirectDataReferenceOptions
>(
  {
    dataFile: readArrayOf(readDataFileId),
    offset: readArrayOf(readLeb128Bigint),
    length: readArrayOf(readLeb128Bigint),
  },
  (value, options) => {
    if (locationIsMissing(value)) {
      if (options.allowMissing !== true) {
        throw new Error(`Reference to missing value not allowed`);
      }
    } else {
      if (value.offset + value.length > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(
          `Offset=${value.offset} + length=${value.length} exceeds maximum of ${Number.MAX_SAFE_INTEGER}`,
        );
      }
    }
  },
);

export function locationIsMissing(location: IndirectDataReference): boolean {
  return (
    location.offset === 0xffffffffffffffffn &&
    location.length === 0xffffffffffffffffn
  );
}

const MAX_PATH_LENGTH = 0xffff;

export interface DataFileId {
  baseUrl: string;
  relativePath: string;
}

export type DataFileTable = DataFileId[];

export function readDataFileTable(
  reader: Reader,
  transitiveBaseUrl: string,
): DataFileTable {
  const numFiles = readLeb128(reader);
  const pathLengthBuffer = new Uint16Array(numFiles * 3);
  for (let i = 1, count = numFiles * 3; i < count; ++i) {
    pathLengthBuffer[i] = readLeb128Bounded(reader, MAX_PATH_LENGTH);
  }
  const dataFileIds: DataFileId[] = [];
  let prevBasePath = EMPTY_KEY;
  let prevRelativePathEncoded = EMPTY_KEY;
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < numFiles; ++i) {
    let prefixLength = pathLengthBuffer[i];
    let suffixLength = pathLengthBuffer[i + numFiles];
    const basePathLength = pathLengthBuffer[i + 2 * numFiles];
    const pathLength = prefixLength + suffixLength;
    if (pathLength > MAX_PATH_LENGTH) {
      throw new Error(
        `path_length[${i} = prefix_length(${prefixLength}) + suffix_length(${suffixLength}) = ${pathLength} > ${MAX_PATH_LENGTH}`,
      );
    }
    if (basePathLength > pathLength) {
      throw new Error(
        `base_path_length[${i}] = ${basePathLength} > path_length(${pathLength}) = prefix_length(${prefixLength}) + suffix_length(${suffixLength})`,
      );
    }
    if (
      prefixLength > Math.min(prevBasePath.length, basePathLength) &&
      basePathLength !== prevBasePath.length
    ) {
      throw new Error(
        `path_prefix_length[${i - 1}] = ${prefixLength} > min(base_path_length[${i - 1}] = ${prevBasePath.length}, base_path_length[${i}] = ${basePathLength}) is not valid if base_path_length[${i - 1}] != base_path_length[${i}]`,
      );
    }

    const relativePathLength = prefixLength + suffixLength - basePathLength;

    let baseUrl: string;
    let relativePath: string;
    if (basePathLength === 0) {
      baseUrl = transitiveBaseUrl;
      prevBasePath = EMPTY_KEY;
    } else if (prefixLength >= basePathLength) {
      baseUrl = dataFileIds[i - 1].baseUrl;
      // prevBasePath remains unchanged
    } else {
      const basePath = new Uint8Array(basePathLength);
      let offset = 0;
      const baseSuffixLength = Math.max(basePathLength - prefixLength, 0);
      if (prefixLength > 0) {
        const basePrefixLength = Math.min(prefixLength, basePathLength);
        basePath.set(prevBasePath.subarray(0, basePrefixLength));
        offset = basePrefixLength;
        prefixLength -= basePrefixLength;
      }
      if (baseSuffixLength !== 0) {
        basePath.set(readBytes(reader, baseSuffixLength), offset);
        suffixLength -= baseSuffixLength;
      }

      baseUrl = pipelineUrlJoin(
        transitiveBaseUrl,
        textDecoder.decode(basePath),
      );
      prevBasePath = basePath;
    }

    if (relativePathLength === 0) {
      relativePath = "";
      prevRelativePathEncoded = EMPTY_KEY;
    } else if (
      suffixLength === 0 &&
      relativePathLength === prevRelativePathEncoded.length
    ) {
      relativePath = dataFileIds[i - 1].relativePath;
      // prevRelativePathEncoded remains unchanged
    } else {
      const relativePathEncoded = new Uint8Array(relativePathLength);
      let offset = 0;
      if (prefixLength !== 0) {
        relativePathEncoded.set(
          prevRelativePathEncoded.subarray(0, prefixLength),
          0,
        );
        offset += prefixLength;
      }
      if (suffixLength > 0) {
        relativePathEncoded.set(readBytes(reader, suffixLength), offset);
      }
      relativePath = textDecoder.decode(relativePathEncoded);
      prevRelativePathEncoded = relativePathEncoded;
    }
    dataFileIds[i] = { baseUrl, relativePath };
  }

  return dataFileIds;
}
