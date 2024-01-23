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
