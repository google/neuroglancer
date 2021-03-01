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

import {decodeChannel, decodeChannels} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint64';
import {encodeBlock, encodeChannel, encodeChannels, newCache} from 'neuroglancer/sliceview/compressed_segmentation/encode_uint64';
import {makeRandomUint64Array} from 'neuroglancer/sliceview/compressed_segmentation/test_util';
import {prod3, prod4} from 'neuroglancer/util/geom';
import {Uint32ArrayBuilder} from 'neuroglancer/util/uint32array_builder';

describe('compressed_segmentation uint64', () => {
  describe('encodeBlock', () => {
    // Test 0-bit encoding.
    it('basic 0-bit', () => {
      const input = Uint32Array.of(3, 0, 3, 0, 3, 0, 3, 0);
      const inputStrides = [2, 4, 8];
      const blockSize = [2, 2, 1];
      const output = new Uint32ArrayBuilder();
      const expected = Uint32Array.of(3, 0);
      const cache = newCache();
      let [encodedBits, tableOffset] =
          encodeBlock(input, 0, inputStrides, blockSize, blockSize, 0, cache, output);
      expect(encodedBits).toBe(0);
      expect(tableOffset).toBe(0);
      expect(output.view).toEqual(expected);
      expect(Array.from(cache)).toEqual([['3,0', 0]]);
    });

    // // Test 0-bit encoding with existing data in output buffer.
    it('basic 0-bit preserve existing', () => {
      const input = Uint32Array.of(3, 0, 3, 0, 3, 0, 3, 0);
      const inputStrides = [2, 4, 8];
      const blockSize = [2, 2, 1];
      const output = new Uint32ArrayBuilder();
      output.appendArray([1, 2, 3]);
      const expected = Uint32Array.of(1, 2, 3, 3, 0);
      const cache = newCache();
      let [encodedBits, tableOffset] =
          encodeBlock(input, 0, inputStrides, blockSize, blockSize, 3, cache, output);
      expect(encodedBits).toBe(0);
      expect(tableOffset).toBe(0);
      expect(output.view).toEqual(expected);
      expect(Array.from(cache)).toEqual([['3,0', 0]]);
    });


    // Test 1-bit encoding.
    it('basic 1-bit', () => {
      let input = Uint32Array.of(4, 0, 3, 0, 4, 0, 4, 0);
      const inputStrides = [2, 4, 8];
      const blockSize = [2, 2, 1];
      const output = new Uint32ArrayBuilder();
      output.appendArray([1, 2, 3]);
      const cache = newCache();
      let [encodedBits, tableOffset] =
          encodeBlock(input, 0, inputStrides, blockSize, blockSize, 3, cache, output);
      expect(encodedBits).toBe(1);
      expect(tableOffset).toBe(1);
      expect(output.view).toEqual(Uint32Array.of(1, 2, 3, 0b1101, 3, 0, 4, 0));
      expect(Array.from(cache)).toEqual([['3,0,4,0', 1]]);
    });

    // Test 1-bit encoding, actual_size != block_size.
    it('size mismatch 1-bit', () => {
      const input = Uint32Array.of(4, 0, 3, 0, 4, 0, 3, 0);
      const inputStrides = [2, 4, 8];
      const blockSize = [3, 2, 1];
      const actualSize = [2, 2, 1];
      const output = new Uint32ArrayBuilder();
      output.appendArray([1, 2, 3]);
      const cache = newCache();
      let [encodedBits, tableOffset] =
          encodeBlock(input, 0, inputStrides, blockSize, actualSize, 3, cache, output);
      expect(encodedBits).toBe(1);
      expect(tableOffset).toBe(1);
      expect(output.view).toEqual(Uint32Array.of(1, 2, 3, 0b001001, 3, 0, 4, 0));
      expect(Array.from(cache)).toEqual([['3,0,4,0', 1]]);
    });

    // Test 2-bit encoding.
    it('basic 2-bit', () => {
      const input = Uint32Array.of(4, 0, 3, 0, 5, 0, 4, 0);
      const inputStrides = [2, 4, 8];
      const blockSize = [2, 2, 1];
      const output = new Uint32ArrayBuilder();
      output.appendArray([1, 2, 3]);
      const cache = newCache();
      let [encodedBits, tableOffset] =
          encodeBlock(input, 0, inputStrides, blockSize, blockSize, 3, cache, output);
      expect(encodedBits).toBe(2);
      expect(tableOffset).toBe(1);
      expect(output.view).toEqual(Uint32Array.of(1, 2, 3, 0b01100001, 3, 0, 4, 0, 5, 0));
      expect(Array.from(cache)).toEqual([['3,0,4,0,5,0', 1]]);
    });
  });

  describe('encodeChannel', () => {
    it('basic', () => {
      const input = Uint32Array.of(
          4, 0, 3, 0, 5, 0, 4, 0,  //
          1, 0, 3, 0, 3, 0, 3, 0   //
      );
      const volumeSize = [2, 2, 2];
      const blockSize = [2, 2, 1];
      const output = new Uint32ArrayBuilder();
      output.appendArray([1, 2, 3]);
      encodeChannel(output, blockSize, input, volumeSize);
      expect(output.view)
          .toEqual(Uint32Array.of(
              1, 2, 3,                       //
              5 | (2 << 24), 4,              //
              12 | (1 << 24), 11,            //
              0b01100001, 3, 0, 4, 0, 5, 0,  //
              0b1110, 1, 0, 3, 0             //
          ));
    });

    it('basic cached 0-bit', () => {
      const input = Uint32Array.of(
          4, 0, 4, 0, 4, 0, 4, 0,  //
          3, 0, 3, 0, 3, 0, 3, 0,  //
          3, 0, 3, 0, 3, 0, 3, 0,  //
          4, 0, 4, 0, 4, 0, 4, 0   //
      );
      const volumeSize = [2, 2, 4];
      const blockSize = [2, 2, 1];
      const output = new Uint32ArrayBuilder();
      output.appendArray([1, 2, 3]);
      encodeChannel(output, blockSize, input, volumeSize);
      expect(output.view)
          .toEqual(Uint32Array.of(
              1, 2, 3,             //
              8 | (0 << 24), 8,    //
              10 | (0 << 24), 10,  //
              10 | (0 << 24), 12,  //
              8 | (0 << 24), 12,   //
              4, 0,                //
              3, 0                 //
          ));
    });

    it('basic cached 2-bit', () => {
      const input = Uint32Array.of(
          4, 0, 3, 0, 5, 0, 4, 0,  //
          1, 0, 3, 0, 3, 0, 3, 0,  //
          3, 0, 1, 0, 1, 0, 1, 0,  //
          5, 0, 5, 0, 3, 0, 4, 0   //
      );
      const volumeSize = [2, 2, 4];
      const blockSize = [2, 2, 1];
      const output = new Uint32ArrayBuilder();
      output.appendArray([1, 2, 3]);
      encodeChannel(output, blockSize, input, volumeSize);
      expect(output.view)
          .toEqual(Uint32Array.of(
              1, 2, 3,                       //
              9 | (2 << 24), 8,              //
              16 | (1 << 24), 15,            //
              16 | (1 << 24), 20,            //
              9 | (2 << 24), 21,             //
              0b01100001, 3, 0, 4, 0, 5, 0,  //
              0b1110, 1, 0, 3, 0,            //
              0b00000001,                    //
              0b01001010                     //
          ));
    });

    for (let volumeSize of [  //
             [1, 2, 1],       //
             [2, 2, 2],       //
             [4, 4, 5],       //
    ]) {
      it(`round trip ${volumeSize.join(',')}`, () => {
        const numPossibleValues = 15;
        const input = makeRandomUint64Array(prod3(volumeSize), numPossibleValues);
        const blockSize = [2, 2, 2];
        const output = new Uint32ArrayBuilder();
        encodeChannel(output, blockSize, input, volumeSize);
        const decoded = new Uint32Array(input.length);
        decodeChannel(decoded, output.view, 0, volumeSize, blockSize);
        expect(decoded).toEqual(input);
      });
    }
  });

  describe('encodeChannels', () => {

    it('basic 1-channel 1-block', () => {
      const blockSize = [2, 2, 1];
      const input = Uint32Array.of(
          4, 0, 4, 0, 4, 0, 4, 0  //
      );
      const volumeSize = [2, 2, 1, 1];
      const output = new Uint32ArrayBuilder();
      encodeChannels(output, blockSize, input, volumeSize);
      expect(output.view)
          .toEqual(Uint32Array.of(
              1,          //
              2, 2, 4, 0  //
          ));
    });

    for (let volumeSize of [  //
             [1, 2, 1, 1],    //
             [1, 2, 1, 3],    //
             [2, 2, 2, 1],    //
             [2, 2, 2, 3],    //
             [4, 4, 5, 3],    //
    ]) {
      it(`round trip ${volumeSize.join(',')}`, () => {
        const numPossibleValues = 15;
        const input = makeRandomUint64Array(prod4(volumeSize), numPossibleValues);
        const blockSize = [2, 2, 2];
        const output = new Uint32ArrayBuilder();
        encodeChannels(output, blockSize, input, volumeSize);
        const decoded = new Uint32Array(input.length);
        decodeChannels(decoded, output.view, 0, volumeSize, blockSize);
        expect(decoded).toEqual(input);
      });
    }
  });
});
