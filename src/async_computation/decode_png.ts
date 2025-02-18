/**
 * @license
 * Copyright 2022 William Silversmith
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

import { decodePng } from "#src/async_computation/decode_png_request.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";
import { decompressPng } from "#src/sliceview/png/index.js";

registerAsyncComputation(
  decodePng,
  async (
    data,
    width: number | undefined,
    height: number | undefined,
    // Expected width * height
    area: number | undefined,
    numComponents: number | undefined,
    bytesPerPixel: number,
    convertToGrayscale: boolean,
  ) => {
    const result = await decompressPng(
      data,
      width,
      height,
      area,
      numComponents,
      bytesPerPixel,
      convertToGrayscale,
    );
    return { value: result, transfer: [result.uint8Array.buffer] };
  },
);
