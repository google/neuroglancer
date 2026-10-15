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

import type { CodecChainSpec } from "#src/datasource/zarr/codec/index.js";
import type { DataType } from "#src/util/data_type.js";

export enum ChunkKeyEncoding {
  DEFAULT = 0,
  V2 = 1,
  // https://github.com/zarr-developers/zarr-extensions/tree/main/chunk-key-encodings/offset
  OFFSET = 2,
}

export type DimensionSeparator = "/" | ".";

export type NodeType = "array" | "group";

export interface ArrayMetadata {
  zarrVersion: 2 | 3;
  nodeType: "array";
  rank: number;
  shape: number[];
  chunkShape: number[];
  dataType: DataType;
  fillValue: number | bigint;
  dimensionNames: (string | null)[];
  dimensionUnits: (string | null)[];
  userAttributes: Record<string, unknown>;
  dimensionSeparator: DimensionSeparator;
  chunkKeyEncoding: ChunkKeyEncoding;
  // One entry per dimension under `ChunkKeyEncoding.OFFSET`.
  chunkKeyOffset: number[] | undefined;
  codecs: CodecChainSpec;
}

/** Store key of the write chunk at grid coordinates `keyCoords`. */
export function encodeChunkKey(
  metadata: Pick<
    ArrayMetadata,
    "rank" | "chunkKeyEncoding" | "dimensionSeparator" | "chunkKeyOffset"
  >,
  keyCoords: ArrayLike<number>,
): string {
  const { rank, chunkKeyEncoding, dimensionSeparator, chunkKeyOffset } =
    metadata;
  let key = "";
  let sep: string;
  if (chunkKeyEncoding === ChunkKeyEncoding.V2) {
    sep = "";
    if (rank === 0) {
      key += "0";
    }
  } else {
    key += "c";
    sep = dimensionSeparator;
  }
  for (let i = 0; i < rank; ++i) {
    const offset = chunkKeyOffset?.[i] ?? 0;
    key += `${sep}${keyCoords[i] + offset}`;
    sep = dimensionSeparator;
  }
  return key;
}

export interface GroupMetadata {
  zarrVersion: 2 | 3;
  nodeType: "group";
  userAttributes: Record<string, unknown>;
}

export type Metadata = ArrayMetadata | GroupMetadata;
