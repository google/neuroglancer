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
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import type { WarpfieldConfiguration } from "#src/datasource/zarr/codec/warpfield/config.js";
import { parseWarpfieldConfiguration } from "#src/datasource/zarr/codec/warpfield/config.js";
import { DataType } from "#src/util/data_type.js";

export type Configuration = WarpfieldConfiguration;

registerCodec({
  name: "warpfield",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    const config = parseWarpfieldConfiguration(configuration);
    const { dataType, chunkShape } = decodedArrayInfo;
    if (dataType !== DataType.FLOAT32) {
      throw new Error(
        `warpfield: only float32 arrays are supported, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    if (config.axisRoles.length !== chunkShape.length) {
      throw new Error(
        `warpfield: ${config.axisRoles.length} axis_roles for an array of rank ${chunkShape.length}`,
      );
    }
    return { configuration: config };
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
