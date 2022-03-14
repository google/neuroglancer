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

import {decompressPng} from 'neuroglancer/sliceview/png';
import {decodePng} from 'neuroglancer/async_computation/decode_png_request';
import {registerAsyncComputation} from 'neuroglancer/async_computation/handler';

registerAsyncComputation(
    decodePng,
    async function(
      data: Uint8Array, width: number, height: number, 
      numComponents: number, bytesPerPixel:number, 
      convertToGrayscale: boolean
    ) {
      const result = await decompressPng(
        data, width, height, numComponents, 
        bytesPerPixel, convertToGrayscale
      );
      return { value: result, transfer: [result.buffer] };
    });
