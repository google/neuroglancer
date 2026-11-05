/**
 * @license
 * Copyright 2025 Google Inc.
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

// Implements the `jpegxl` array -> bytes codec.
//
// Following the JPEG XL zarr extension, this codec has a fixed, simple shape
// contract: the (already reshaped) chunk it receives must equal the native JXL
// image shape `[frames, height, width, samples]` with unit `frames`/`samples`
// axes dropped, i.e. one of `[h, w]`, `[h, w, c]`, `[f, h, w]`, or
// `[f, h, w, c]`.  Adapting an arbitrary chunk shape into one of these is the
// job of the upstream `reshape` (and, if a channel axis must be moved,
// `transpose`) codecs -- this codec performs no dimension guessing.

import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { verifyObject } from "#src/util/json.js";

// The codec carries no decode-relevant configuration: the data type and shape
// come from the array info, and any encode-time options (effort, distance,
// lossless, ...) are recorded in the JXL codestream itself and ignored here.
export type Configuration = Record<string, never>;

const SUPPORTED_DATA_TYPES = new Set<DataType>([
  DataType.UINT8,
  DataType.UINT16,
  DataType.FLOAT32,
]);

export function verifyJpegXlArrayInfo(arrayInfo: CodecArrayInfo) {
  if (!SUPPORTED_DATA_TYPES.has(arrayInfo.dataType)) {
    throw new Error(
      `jpegxl: unsupported data type ${DataType[arrayInfo.dataType]}; ` +
        "supported types are uint8, uint16, and float32",
    );
  }
  const rank = arrayInfo.chunkShape.length;
  if (rank < 2 || rank > 4) {
    throw new Error(
      `jpegxl: expected a 2-, 3-, or 4-dimensional image chunk shape ` +
        `([h,w], [h,w,c], [f,h,w], or [f,h,w,c]), but received rank ${rank} ` +
        `(${JSON.stringify(arrayInfo.chunkShape)}); use a reshape codec to ` +
        "produce a compatible shape",
    );
  }
}

registerCodec({
  name: "jpegxl",
  kind: CodecKind.arrayToBytes,
  resolve(configuration: unknown, decodedArrayInfo: CodecArrayInfo) {
    verifyObject(configuration);
    verifyJpegXlArrayInfo(decodedArrayInfo);
    // The compressed size is not known ahead of time.
    return { configuration: {} as Configuration, encodedSize: undefined };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
  ) {
    configuration;
    // JXL pixels are returned in C order (`[frames, height, width, samples]`),
    // matching the reshaped chunk shape one-to-one.
    return {
      physicalToLogicalDimension: Array.from(
        decodedArrayInfo.chunkShape,
        (_, i) => i,
      ),
      readChunkShape: decodedArrayInfo.chunkShape,
    };
  },
});
