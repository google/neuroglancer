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

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { parseJpegConfiguration } from "#src/datasource/zarr/codec/jpeg/config.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

export interface Configuration {
  width: number;
  height: number;
  numComponents: 1 | 3;
}

/** The zarr-extensions `jpeg` codec; see config.ts for the rules. */
registerCodec({
  name: "jpeg",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    const { encodedColorSpace, numComponents: configured } =
      parseJpegConfiguration(configuration);

    const { dataType, chunkShape } = decodedArrayInfo;
    if (dataType !== DataType.UINT8) {
      throw new Error(
        `jpeg: requires uint8 data, but received ${DataType[dataType]}`,
      );
    }
    const rank = chunkShape.length;
    const numComponents = rank === 2 ? 1 : chunkShape[2];
    if (
      (rank !== 2 && rank !== 3) ||
      (numComponents !== 1 && numComponents !== 3)
    ) {
      throw new Error(
        `jpeg: chunk shape must be (H, W), (H, W, 1) or (H, W, 3), but received [${chunkShape}]`,
      );
    }
    if (numComponents !== configured) {
      throw new Error(
        `jpeg: ${encodedColorSpace} does not match ${numComponents} component(s)`,
      );
    }
    const [height, width] = chunkShape;
    if (height > 65535 || width > 65535) {
      throw new Error(`jpeg: [${chunkShape}] exceeds 65535 x 65535`);
    }
    return { configuration: { width, height, numComponents } };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
  ): CodecArrayLayoutInfo {
    configuration;
    return {
      physicalToLogicalDimension: Array.from(
        decodedArrayInfo.chunkShape,
        (_, i) => i,
      ),
      readChunkShape: decodedArrayInfo.chunkShape,
    };
  },
});
