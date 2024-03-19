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
import type { Uint64 } from "#src/util/uint64.js";

export enum ChunkKeyEncoding {
  DEFAULT = 0,
  V2 = 1,
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
  fillValue: number | Uint64;
  dimensionNames: (string | null)[];
  dimensionUnits: (string | null)[];
  userAttributes: Record<string, unknown>;
  dimensionSeparator: DimensionSeparator;
  chunkKeyEncoding: ChunkKeyEncoding;
  codecs: CodecChainSpec;
}

export interface GroupMetadata {
  zarrVersion: 2 | 3;
  nodeType: "group";
  userAttributes: Record<string, unknown>;
}

export type Metadata = ArrayMetadata | GroupMetadata;
