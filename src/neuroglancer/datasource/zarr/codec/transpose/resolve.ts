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

import {CodecArrayInfo, CodecArrayLayoutInfo, CodecKind} from 'neuroglancer/datasource/zarr/codec';
import {registerCodec} from 'neuroglancer/datasource/zarr/codec/resolve';
import {parseFixedLengthArray, verifyObject, verifyObjectProperty} from 'neuroglancer/util/json';

export interface Configuration {
  encodedToDecoded: number[];
  decodedToEncoded: number[];
}

registerCodec({
  name: 'transpose',
  kind: CodecKind.arrayToArray,
  resolve(configuration: unknown, decodedArrayInfo: CodecArrayInfo):
      {configuration: Configuration, encodedArrayInfo: CodecArrayInfo} {
        verifyObject(configuration);
        const {order, inverseOrder} = verifyObjectProperty(configuration, 'order', value => {
          const rank = decodedArrayInfo.chunkShape.length;
          const order = new Array<number>(rank);
          const inverseOrder = new Array<number>(rank);
          if (value === 'C') {
            for (let i = 0; i < rank; ++i) {
              order[i] = i;
              inverseOrder[i] = i;
            }
          } else if (value === 'F') {
            for (let i = 0; i < rank; ++i) {
              order[i] = rank - i - 1;
              inverseOrder[i] = rank - i - 1;
            }
          } else {
            parseFixedLengthArray(order, value, (x, i) => {
              if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= rank) {
                throw new Error(
                    `Expected integer in range [0, ${rank}) but received: ${JSON.stringify(x)}`);
              }
              if (inverseOrder[x] !== undefined) {
                throw new Error(`Invalid permutation: ${JSON.stringify(value)}`);
              }
              inverseOrder[x] = i;
              return x;
            });
          }
          return {order, inverseOrder};
        });
        const encodedArrayInfo = {
          dataType: decodedArrayInfo.dataType,
          chunkShape: Array.from(order, i => decodedArrayInfo.chunkShape[i]),
        };
        return {
          configuration: {encodedToDecoded: order, decodedToEncoded: inverseOrder},
          encodedArrayInfo
        };
      },
  getDecodedArrayLayoutInfo(
      configuration: Configuration, decodedArrayInfo: CodecArrayInfo,
      encodedLayout: CodecArrayLayoutInfo): CodecArrayLayoutInfo {
    decodedArrayInfo;
    const decodedOrder =
        Array.from(encodedLayout.physicalToLogicalDimension, encodedDim => configuration.encodedToDecoded[encodedDim]);
    return {
      physicalToLogicalDimension: decodedOrder,
      readChunkShape: Array.from(
          configuration.decodedToEncoded, encodedDim => encodedLayout.readChunkShape[encodedDim]),
    };
  },
});
