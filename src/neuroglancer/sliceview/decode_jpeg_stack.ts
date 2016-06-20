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
import {Vec3, vec3} from 'neuroglancer/util/geom';

export function decodeJpegStack(data: Uint8Array, chunkDataSize: Vec3) {
  let parser = new JpegDecoder();
  parser.parse(data);
  if (parser.numComponents !== 1) {
    throw new Error('JPEG data does not have the expected number of components');
  }

  // Just check that the total number pixels matches the expected value.
  if (parser.width * parser.height !== chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2]) {
    throw new Error(
        `JPEG data does not have the expected dimensions: width=${parser.width}, height=${parser.height}, chunkDataSize=${vec3.str(chunkDataSize)}`);
  }
  return parser.getData(parser.width, parser.height, /*forceRGBOutput=*/false);
}
