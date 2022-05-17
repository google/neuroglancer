/**
 * @license
 * Copyright 2021 William Silversmith
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

import {decompressFpzip} from 'neuroglancer/sliceview/fpzip';
import {decodeFpzip} from 'neuroglancer/async_computation/decode_fpzip_request';
import {registerAsyncComputation} from 'neuroglancer/async_computation/handler';

registerAsyncComputation(
    decodeFpzip,
    async function(data: Uint8Array) {      
      const result = await decompressFpzip(data);
      return { value: result, transfer: [result.buffer] };
    });
