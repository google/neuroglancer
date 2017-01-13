// DO NOT EDIT.  Generated from
// templates/neuroglancer/sliceview/compressed_segmentation/decode.template.ts.
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

/**
 * @file
 * Support for decompressing uint64 segment label chunks.
 */

import {decodeValueOffset} from 'neuroglancer/sliceview/compressed_segmentation/decode_common';



/**
 * Reads the single value at the specified dataPosition in a single-channel compressed segmentation.
 *
 * @param baseOffset The base offset into `data' at which the compressed data for this channel
 * starts.
 * @param chunkDataSize A 3-element array specifying the size of the volume.
 * @param blockSize A 3-element array specifying the block size ued for compression.
 * @param dataPosition A 3-element array specifying the position within the volume from which to
 * read.
 *
 * Stores the result in `out'.
 */
export function readSingleChannelValue(

    data: Uint32Array, baseOffset: number, chunkDataSize: ArrayLike<number>,
    blockSize: ArrayLike<number>, dataPosition: ArrayLike<number>) {
  let outputValueOffset =
      decodeValueOffset(data, baseOffset, chunkDataSize, blockSize, dataPosition, 1) + baseOffset;

  return data[outputValueOffset];
}

/**
 * Reads the single value (of a single channel) at the specified dataPosition in a multi-channel
 * compressed segmentation.
 *
 * @param dataPosition A 4-element [x, y, z, channel] array specifying the position to read.
 */
export function readValue(

    data: Uint32Array, baseOffset: number, chunkDataSize: ArrayLike<number>,
    blockSize: ArrayLike<number>, dataPosition: ArrayLike<number>) {
  return readSingleChannelValue(

      data, baseOffset + data[dataPosition[3]], chunkDataSize, blockSize, dataPosition);
}

/**
 * Decodes a single channel of a compressed segmentation.
 *
 * This is not particularly efficient, because it is intended for testing purposes only.
 */
export function decodeChannel(
    out: Uint32Array, data: Uint32Array, baseOffset: number, chunkDataSize: ArrayLike<number>,
    blockSize: ArrayLike<number>) {
  const expectedLength = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2] * 1;
  if (expectedLength !== out.length) {
    throw new Error(
        `Output length ${out.length} is not equal to expected length ${expectedLength}.`);
  }
  let vx = chunkDataSize[0];
  let vy = chunkDataSize[1];
  let vz = chunkDataSize[2];
  let dataPosition = [0, 0, 0];
  let outputOffset = 0;
  for (let z = 0; z < vz; ++z) {
    dataPosition[2] = z;
    for (let y = 0; y < vy; ++y) {
      dataPosition[1] = y;
      for (let x = 0; x < vx; ++x) {
        dataPosition[0] = x;
        let outputValueOffset =
            decodeValueOffset(data, baseOffset, chunkDataSize, blockSize, dataPosition, 1) +
            baseOffset;
        out[outputOffset++] = data[outputValueOffset];
      }
    }
  }
  return out;
}

/**
 * Decodes a multi-channel compressed segmentation.
 *
 * This is not particularly efficient, because it is intended for testing purposes only.
 */
export function decodeChannels(
    out: Uint32Array, data: Uint32Array, baseOffset: number, chunkDataSize: ArrayLike<number>,
    blockSize: ArrayLike<number>) {
  const channelOutputLength = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2] * 1;
  const expectedLength = channelOutputLength * chunkDataSize[3];
  if (expectedLength !== out.length) {
    throw new Error(
        `Output length ${out.length} is not equal to expected length ${expectedLength}.`);
  }
  const numChannels = chunkDataSize[3];
  for (let channel = 0; channel < numChannels; ++channel) {
    decodeChannel(
        out.subarray(channelOutputLength * channel, channelOutputLength * (channel + 1)), data,
        baseOffset + data[channel], chunkDataSize, blockSize);
  }
  return out;
}
