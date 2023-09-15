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

import {DataType} from 'neuroglancer/util/data_type';

export enum CodecKind {
  arrayToArray,
  arrayToBytes,
  bytesToBytes,
}

export interface CodecSpec<Kind extends CodecKind = CodecKind> {
  kind: Kind;
  name: string;
  configuration: unknown;
}

export interface CodecChainSpec {
  [CodecKind.arrayToArray]: CodecSpec<CodecKind.arrayToArray>[];
  [CodecKind.arrayToBytes]: CodecSpec<CodecKind.arrayToBytes>;
  [CodecKind.bytesToBytes]: CodecSpec<CodecKind.bytesToBytes>[];
  arrayInfo: CodecArrayInfo[];
  layoutInfo: CodecArrayLayoutInfo[];
  shardingInfo?: ShardingInfo;
  encodedSize: (number|undefined)[];
}

export interface ShardingInfo {
  subChunkShape: number[];
  subChunkGridShape: number[];
  subChunkCodecs: CodecChainSpec;
}

export interface CodecArrayInfo {
  dataType: DataType;
  // Specifies the chunk shape, indexed by logical dimension.
  chunkShape: number[];
}

export interface CodecArrayLayoutInfo {
  // Maps the physical dimension index of the array (assuming C order storage) to the logical
  // dimension of the (transformed) array.
  //
  // `physicalToLogicalDimension[0]` is the logical dimension index of the outer-most (largest
  // stride) dimension.
  //
  // `physicalToLogicalDimension[physicalToLogicalDimension.length-1]` is the logical dimension
  // index of the inner-most (unit stride) dimension.
  physicalToLogicalDimension: number[];

  // Specifies the read chunk shape, indexed by logical dimension.
  readChunkShape: number[];
}
