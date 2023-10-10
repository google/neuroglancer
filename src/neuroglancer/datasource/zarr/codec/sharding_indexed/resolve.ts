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

import {CodecArrayInfo, CodecArrayLayoutInfo, CodecChainSpec, CodecKind} from 'neuroglancer/datasource/zarr/codec';
import {parseCodecChainSpec, registerCodec} from 'neuroglancer/datasource/zarr/codec/resolve';
import {parseChunkShape} from 'neuroglancer/datasource/zarr/metadata/parse';
import {DataType} from 'neuroglancer/util/data_type';
import {verifyObject, verifyObjectProperty} from 'neuroglancer/util/json';

export interface Configuration {
  indexCodecs: CodecChainSpec;
  subChunkCodecs: CodecChainSpec;
  subChunkShape: number[];
  subChunkGridShape: number[];
}

registerCodec({
  name: 'sharding_indexed',
  kind: CodecKind.arrayToBytes,
  resolve(configuration: unknown, decodedArrayInfo: CodecArrayInfo) {
    verifyObject(configuration);
    const subChunkShape = verifyObjectProperty(
        configuration, 'chunk_shape',
        value => parseChunkShape(value, decodedArrayInfo.chunkShape.length));
    const subChunkGridShape = Array.from(decodedArrayInfo.chunkShape, (outerSize, i) => {
      const innerSize = subChunkShape[i];
      if ((outerSize % innerSize) !== 0) {
        throw new Error(`sub-chunk shape of ${
            JSON.stringify(innerSize)} does not evenly divide outer chunk shape of ${
            JSON.stringify(decodedArrayInfo.chunkShape)}`);
      }
      return outerSize / innerSize;
    });
    const indexShape = Array.from(subChunkGridShape);
    indexShape.push(2);
    const indexCodecs = verifyObjectProperty(
        configuration, 'index_codecs',
        value => parseCodecChainSpec(value, {dataType: DataType.UINT64, chunkShape: indexShape}));
    if (indexCodecs.encodedSize[indexCodecs.encodedSize.length - 1] === undefined) {
      throw new Error(`index_codecs must specify fixed-size encoding`);
    }
    const subChunkCodecs = verifyObjectProperty(
        configuration, 'codecs',
        value => parseCodecChainSpec(
            value, {dataType: decodedArrayInfo.dataType, chunkShape: subChunkShape}));
    return {
      configuration: {indexCodecs, subChunkCodecs, subChunkShape, subChunkGridShape},
      shardingInfo: {subChunkShape, subChunkGridShape, subChunkCodecs},
    };
  },
  getDecodedArrayLayoutInfo(configuration: Configuration, decodedArrayInfo: CodecArrayInfo):
      CodecArrayLayoutInfo {
        decodedArrayInfo;
        return configuration.subChunkCodecs.layoutInfo[0];
      },
});
