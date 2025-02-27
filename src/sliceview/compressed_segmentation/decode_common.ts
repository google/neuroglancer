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
 * Support for decompressing uint32 and uint64 segment label chunks.
 */

/**
 * Determines the offset of the value at the specified dataPosition in a single-channel compressed
 * segmentation.
 *
 * @param baseOffset The base offset into `data' at which the compressed data for this channel
 * starts.
 * @param chunkDataSize A 3-element array specifying the size of the volume,
 * @param blockSize A 3-element array specifying the block size ued for compression.
 * @param dataPosition A 3-element array specifying the position within the volume from which to
 * read.
 * @returns The offset into `data', relative to baseOffset, at which the value is located.
 */
export function decodeValueOffset(
  data: Uint32Array,
  baseOffset: number,
  chunkDataSize: ArrayLike<number>,
  blockSize: ArrayLike<number>,
  dataPosition: ArrayLike<number>,
  uint32sPerElement: number,
) {
  let gridOffset = 0;
  let subchunkOffset = 0;
  let gridStride = 1;
  let subchunkStride = 1;
  for (let i = 0; i < 3; ++i) {
    const posValue = dataPosition[i];
    const subchunkSizeValue = blockSize[i];
    const gridSubscript = Math.floor(posValue / subchunkSizeValue);
    const subchunkSubscript = posValue % subchunkSizeValue;
    gridOffset += gridSubscript * gridStride;
    gridStride *= Math.ceil(chunkDataSize[i] / subchunkSizeValue);
    subchunkOffset += subchunkSubscript * subchunkStride;
    subchunkStride *= subchunkSizeValue;
  }
  const subchunkHeaderOffset = baseOffset + gridOffset * 2;
  const subchunkHeader0 = data[subchunkHeaderOffset];
  const subchunkHeader1 = data[subchunkHeaderOffset + 1];
  let outputValueOffset = subchunkHeader0 & 0xffffff;
  const encodingBits = (subchunkHeader0 >> 24) & 0xff;
  if (encodingBits > 0) {
    const encodedValueBaseOffset = (baseOffset + subchunkHeader1) & 0xffffff;
    const encodedValueOffset =
      encodedValueBaseOffset +
      Math.floor((subchunkOffset * encodingBits) / 32.0);
    const encodedValue = data[encodedValueOffset];
    const wordOffset = (subchunkOffset * encodingBits) % 32;

    const decodedValue =
      (encodedValue >> wordOffset) & ((1 << encodingBits) - 1);
    outputValueOffset += uint32sPerElement * decodedValue;
  }
  return outputValueOffset;
}

function readTableUint64(data: Uint32Array, offset: number): bigint {
  return BigInt(data[offset]) | (BigInt(data[offset + 1]) << 32n);
}

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
export function readSingleChannelValueUint32(
  data: Uint32Array,
  baseOffset: number,
  chunkDataSize: ArrayLike<number>,
  blockSize: ArrayLike<number>,
  dataPosition: ArrayLike<number>,
): number {
  return data[
    decodeValueOffset(
      data,
      baseOffset,
      chunkDataSize,
      blockSize,
      dataPosition,
      /*uint32sPerElement=*/ 1,
    ) + baseOffset
  ];
}

export function readSingleChannelValueUint64(
  data: Uint32Array,
  baseOffset: number,
  chunkDataSize: ArrayLike<number>,
  blockSize: ArrayLike<number>,
  dataPosition: ArrayLike<number>,
): bigint {
  return readTableUint64(
    data,
    decodeValueOffset(
      data,
      baseOffset,
      chunkDataSize,
      blockSize,
      dataPosition,
      /*uint32sPerElement=*/ 2,
    ) + baseOffset,
  );
}

/**
 * Reads the single value (of a single channel) at the specified dataPosition in a multi-channel
 * compressed segmentation.
 *
 * @param dataPosition A 4-element [x, y, z, channel] array specifying the position to read.
 */
export function readValueUint32(
  data: Uint32Array,
  baseOffset: number,
  chunkDataSize: ArrayLike<number>,
  blockSize: ArrayLike<number>,
  dataPosition: ArrayLike<number>,
): number {
  return readSingleChannelValueUint32(
    data,
    baseOffset + data[dataPosition[3]],
    chunkDataSize,
    blockSize,
    dataPosition,
  );
}
export function readValueUint64(
  data: Uint32Array,
  baseOffset: number,
  chunkDataSize: ArrayLike<number>,
  blockSize: ArrayLike<number>,
  dataPosition: ArrayLike<number>,
): bigint {
  return readSingleChannelValueUint64(
    data,
    baseOffset + data[dataPosition[3]],
    chunkDataSize,
    blockSize,
    dataPosition,
  );
}

/**
 * Decodes a single channel of a compressed segmentation.
 *
 * This is not particularly efficient, because it is intended for testing purposes only.
 */
export function decodeChannel<T extends number | bigint>(
  out: { length: number; [index: number]: T },
  data: Uint32Array,
  baseOffset: number,
  chunkDataSize: ArrayLike<number>,
  blockSize: ArrayLike<number>,
) {
  let uint32sPerElement: number;
  let readTableValue: (offset: number) => T;
  if (out instanceof Uint32Array) {
    uint32sPerElement = 1;
    readTableValue = (offset) => data[offset] as T;
  } else {
    uint32sPerElement = 2;
    readTableValue = (offset) => readTableUint64(data, offset) as T;
  }
  const expectedLength = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
  if (expectedLength !== out.length) {
    throw new Error(
      `Output length ${out.length} is not equal to expected length ${expectedLength}.`,
    );
  }
  const vx = chunkDataSize[0];
  const vy = chunkDataSize[1];
  const vz = chunkDataSize[2];
  const dataPosition = [0, 0, 0];
  let outputOffset = 0;
  for (let z = 0; z < vz; ++z) {
    dataPosition[2] = z;
    for (let y = 0; y < vy; ++y) {
      dataPosition[1] = y;
      for (let x = 0; x < vx; ++x) {
        dataPosition[0] = x;
        const outputValueOffset =
          decodeValueOffset(
            data,
            baseOffset,
            chunkDataSize,
            blockSize,
            dataPosition,
            uint32sPerElement,
          ) + baseOffset;
        out[outputOffset++] = readTableValue(outputValueOffset);
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
export function decodeChannels<T extends Uint32Array | BigUint64Array>(
  out: T,
  data: Uint32Array,
  baseOffset: number,
  chunkDataSize: ArrayLike<number>,
  blockSize: ArrayLike<number>,
): T {
  const channelOutputLength =
    chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
  const expectedLength = channelOutputLength * chunkDataSize[3];
  if (expectedLength !== out.length) {
    throw new Error(
      `Output length ${out.length} is not equal to expected length ${expectedLength}.`,
    );
  }
  const numChannels = chunkDataSize[3];
  for (let channel = 0; channel < numChannels; ++channel) {
    decodeChannel<number | bigint>(
      out.subarray(
        channelOutputLength * channel,
        channelOutputLength * (channel + 1),
      ),
      data,
      baseOffset + data[channel],
      chunkDataSize,
      blockSize,
    );
  }
  return out;
}
