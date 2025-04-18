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

import { describe, bench } from "vitest";
import { encodeChannels as encodeChannelsUint32 } from "#src/sliceview/compressed_segmentation/encode_uint32.js";
import { encodeChannels as encodeChannelsUint64 } from "#src/sliceview/compressed_segmentation/encode_uint64.js";
import { makeRandomArrayByChoosingWithReplacement } from "#src/sliceview/compressed_segmentation/test_util.js";
import { TypedArrayBuilder } from "#src/util/array.js";
import { prod4, vec3Key } from "#src/util/geom.js";

declare const TEST_DATA_SERVER: string;

describe("64x64x64 example", async () => {
  const exampleChunkDataUint8Array = await (
    await fetch(
      `${TEST_DATA_SERVER}codec/compressed_segmentation/64x64x64-raw-uint64-segmentation.dat`,
    )
  ).arrayBuffer();
  const exampleChunkData64 = new BigUint64Array(exampleChunkDataUint8Array);
  const exampleChunkData32 = Uint32Array.from(exampleChunkData64, (x) =>
    Number(x & 0xffffffffn),
  );
  const blockSize = [8, 8, 8];
  const output = new TypedArrayBuilder(Uint32Array, 1000000);
  const volumeSize = [64, 64, 64, 1];
  bench("encode_uint64", () => {
    output.clear();
    encodeChannelsUint64(output, blockSize, exampleChunkData64, volumeSize);
  });
  bench("encode_uint32", () => {
    output.clear();
    encodeChannelsUint32(output, blockSize, exampleChunkData32, volumeSize);
  });
});

describe("compressed_segmentation", () => {
  const blockSize = [8, 8, 8];
  const output = new TypedArrayBuilder(Uint32Array, 1000000);
  for (const volumeSize of [
    //
    [16, 16, 16, 1], //
    // [64, 64, 64, 1],  //
  ]) {
    const numPossibleValues = 15;
    const input = makeRandomArrayByChoosingWithReplacement(
      BigUint64Array,
      prod4(volumeSize),
      numPossibleValues,
    );
    bench(`encode_uint64 ${vec3Key(volumeSize)}`, () => {
      output.clear();
      encodeChannelsUint64(output, blockSize, input, volumeSize);
    });
  }
});
