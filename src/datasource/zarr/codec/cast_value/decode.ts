/**
 * @license
 * Copyright 2026 Google Inc.
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

import { castValues } from "#src/datasource/zarr/codec/cast_value/cast.js";
import type { Configuration } from "#src/datasource/zarr/codec/cast_value/resolve.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";

registerCodec({
  name: "cast_value",
  kind: CodecKind.arrayToArray,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal;
    return castValues(
      encoded as unknown as ArrayLike<number>,
      decodedArrayInfo.dataType,
      configuration.rounding,
      configuration.outOfRange,
    );
  },
});
