/**
 * @license
 * Copyright 2016 Google Inc.
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

import {JpegDecoder} from 'jpgjs';
import {transposeArray2d} from 'neuroglancer/util/array';
import {vec3} from 'neuroglancer/util/geom';

export function decodeJpegStack(data: Uint8Array, chunkDataSize: vec3, numComponents: number) {
  let parser = new JpegDecoder();
  parser.parse(data);
  // Just check that the total number pixels matches the expected value.
  if (parser.width * parser.height !== chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2]) {
    throw new Error(
        `JPEG data does not have the expected dimensions: width=${parser.width}, height=${parser.height}, chunkDataSize=${vec3.str(chunkDataSize)}`);
  }
  if (parser.numComponents !== numComponents) {
    throw new Error(
        `JPEG data does not have the expected number of components: components=${parser.numComponents}, expected=${numComponents}`);
  }
  if (parser.numComponents === 1) {
    return parser.getData(parser.width, parser.height, /*forceRGBOutput=*/false);
  } else if (parser.numComponents === 3) {
    let output = parser.getData(parser.width, parser.height, /*forceRGBOutput=*/false);
    return transposeArray2d(output, parser.width * parser.height, 3);
  } else {
    throw new Error(
      `JPEG data has an unsupported number of components: components=${parser.numComponents}`);
  }
}
