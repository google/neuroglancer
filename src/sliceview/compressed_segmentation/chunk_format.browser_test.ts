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

import { describe } from "vitest";
import { chunkFormatTest } from "#src/sliceview/chunk_format_testing.js";
import { ChunkFormat } from "#src/sliceview/compressed_segmentation/chunk_format.js";
import { encodeChannels as encodeChannelsUint32 } from "#src/sliceview/compressed_segmentation/encode_uint32.js";
import { encodeChannels as encodeChannelsUint64 } from "#src/sliceview/compressed_segmentation/encode_uint64.js";
import { makeRandomUint64Array } from "#src/sliceview/compressed_segmentation/test_util.js";
import { DataType } from "#src/util/data_type.js";
import { prod4, vec3, vec3Key } from "#src/util/geom.js";
import { getRandomValues } from "#src/util/random.js";
import { Uint32ArrayBuilder } from "#src/util/uint32array_builder.js";

describe("sliceview/compressed_segmentation/chunk_format", () => {
  describe("data access", () => {
    const vec888 = vec3.fromValues(8, 8, 8);
    function runTest(
      dataType: DataType,
      volumeSize: Uint32Array,
      rawData: Uint32Array,
      compressedSegmentationBlockSize: vec3,
    ) {
      const encodeBuffer = new Uint32ArrayBuilder();
      (dataType === DataType.UINT32
        ? encodeChannelsUint32
        : encodeChannelsUint64)(
        encodeBuffer,
        compressedSegmentationBlockSize,
        rawData,
        volumeSize,
      );
      const encodedData = encodeBuffer.view;
      chunkFormatTest(
        dataType,
        volumeSize,
        (gl) => {
          const chunkFormat = ChunkFormat.get(
            gl,
            dataType,
            compressedSegmentationBlockSize,
            volumeSize[3],
          );
          const textureLayout = chunkFormat.getTextureLayout(gl, volumeSize);
          return [chunkFormat, textureLayout];
        },
        rawData,
        encodedData,
      );
    }
    for (const compressedSegmentationBlockSize of [
      vec888,
      vec3.fromValues(16, 8, 4),
    ]) {
      describe(`sequential values blockSize=${vec3Key(
        compressedSegmentationBlockSize,
      )}`, () => {
        for (const volumeSize of [
          Uint32Array.of(13, 17, 23, 1),
          Uint32Array.of(13, 17, 23, 2),
        ]) {
          const numElements = prod4(volumeSize);
          {
            const rawData = new Uint32Array(numElements * 2);
            for (let i = 0; i < rawData.length; ++i) {
              rawData[i] = i;
            }
            runTest(
              DataType.UINT64,
              volumeSize,
              rawData,
              compressedSegmentationBlockSize,
            );
          }
          {
            const rawData = new Uint32Array(numElements);
            for (let i = 0; i < rawData.length; ++i) {
              rawData[i] = i;
            }
            runTest(
              DataType.UINT32,
              volumeSize,
              rawData,
              compressedSegmentationBlockSize,
            );
          }
        }
      });
    }
    for (const numPossibleValues of [100]) {
      describe(`random values out of ${numPossibleValues} possible`, () => {
        const dataType = DataType.UINT64;
        for (const volumeSize of [
          Uint32Array.of(64, 64, 64, 1),
          Uint32Array.of(36, 36, 36, 1),
        ]) {
          const numElements = prod4(volumeSize);
          const rawData = makeRandomUint64Array(numElements, numPossibleValues);
          runTest(dataType, volumeSize, rawData, vec888);
        }
      });
    }
    describe("random values", () => {
      for (const volumeSize of [
        Uint32Array.of(64, 64, 64, 1),
        Uint32Array.of(36, 36, 36, 1),
      ]) {
        const numElements = prod4(volumeSize);
        const rawData = new Uint32Array(numElements * 2);
        getRandomValues(rawData);
        runTest(DataType.UINT64, volumeSize, rawData, vec888);
      }
      for (const volumeSize of [
        Uint32Array.of(13, 17, 23, 1),
        Uint32Array.of(13, 17, 23, 2),
      ]) {
        const numElements = prod4(volumeSize);
        {
          const rawData = new Uint32Array(numElements * 2);
          getRandomValues(rawData);
          runTest(DataType.UINT64, volumeSize, rawData, vec888);
        }
        {
          const rawData = new Uint32Array(numElements);
          getRandomValues(rawData);
          runTest(DataType.UINT32, volumeSize, rawData, vec888);
        }
      }
    });
  });
});
