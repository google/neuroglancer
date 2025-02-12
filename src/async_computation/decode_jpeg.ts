/**
 * @license
 * Copyright 2019 Google Inc.
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

import { decodeJpeg } from "#src/async_computation/decode_jpeg_request.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";
import { JpegDecoder } from "#src/third_party/jpgjs/jpg.js";
import { transposeArray2d } from "#src/util/array.js";

registerAsyncComputation(
  decodeJpeg,
  async (
    data,
    width: number | undefined,
    height: number | undefined,
    area: number | undefined,
    numComponents: number | undefined,
    convertToGrayscale: boolean,
  ) => {
    const parser = new JpegDecoder();
    parser.parse(data);
    // Just check that the total number pixels matches the expected value.
    if (
      (width !== undefined && width !== parser.width) ||
      (height !== undefined && height !== parser.height) ||
      (area !== undefined && parser.width * parser.height !== area)
    ) {
      throw new Error(
        "JPEG data does not have the expected dimensions: " +
          `width=${parser.width}, height=${parser.height}, ` +
          `expected width=${width}, expected height=${height}, expected area=${area}`,
      );
    }
    width = parser.width;
    height = parser.height;
    if (numComponents !== undefined && parser.numComponents !== numComponents) {
      throw new Error(
        "JPEG data does not have the expected number of components: " +
          `components=${parser.numComponents}, expected=${numComponents}`,
      );
    }
    numComponents = parser.numComponents;
    let result: Uint8Array<ArrayBuffer>;
    if (parser.numComponents === 1) {
      result = parser.getData(
        parser.width,
        parser.height,
        /*forceRGBOutput=*/ false,
      );
    } else if (parser.numComponents === 3) {
      result = parser.getData(
        parser.width,
        parser.height,
        /*forceRGBOutput=*/ false,
      );
      if (convertToGrayscale) {
        const length = width * height;
        const converted = new Uint8Array(length);
        for (let i = 0; i < length; ++i) {
          converted[i] = result[i * 3];
        }
        result = converted;
      } else {
        result = transposeArray2d(result, parser.width * parser.height, 3);
      }
    } else {
      throw new Error(
        `JPEG data has an unsupported number of components: components=${parser.numComponents}`,
      );
    }
    return {
      value: { width, height, numComponents, uint8Array: result },
      transfer: [result.buffer],
    };
  },
);
