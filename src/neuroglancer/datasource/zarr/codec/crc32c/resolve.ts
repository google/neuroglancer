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

import {CodecKind} from 'neuroglancer/datasource/zarr/codec';
import {registerCodec} from 'neuroglancer/datasource/zarr/codec/resolve';

export interface Configuration {}

registerCodec({
  name: 'crc32c',
  kind: CodecKind.bytesToBytes,
  resolve(configuration: unknown, decodedSize: number|undefined):
      {configuration: Configuration, encodedSize: number | undefined} {
        configuration;
        let encodedSize: number|undefined;
        if (decodedSize !== undefined) {
          encodedSize = decodedSize + 4;
        }
        return {configuration: {}, encodedSize};
      },
});
