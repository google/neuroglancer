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

import {PRIME_MODULUS} from 'neuroglancer/gpu_hash/hash_function';
import {HashTable, NUM_ALTERNATIVES} from 'neuroglancer/gpu_hash/hash_table';
import {GPUHashTable, HashTableShaderManager} from 'neuroglancer/gpu_hash/shader';
import {Uint64} from 'neuroglancer/util/uint64';
import {encodeBytesToFloat32, glsl_exactDot} from 'neuroglancer/webgl/shader_lib';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

const COUNT = 100;

describe('gpu_hash.shader', () => {
  it('hash function part', () => {
    fragmentShaderTest(6, tester => {
      let {gl, builder} = tester;
      let hashTableShaderManager = new HashTableShaderManager('h');
      hashTableShaderManager.defineShader(builder);
      builder.addUniform('vec4', 'inputValue', 2);
      builder.addFragmentCode(glsl_exactDot);
      {
        let alt = 0, i = 0;
        let bIndex = alt * 4 + 2 * i;
        let aIndex = alt * 4 + 2 * i;
        let {aName, bName, numAlternatives} = hashTableShaderManager;

        let s = `
uint64_t x;
x.low = inputValue[0];
x.high = inputValue[1];

x.low *= 255.0;
x.high *= 255.0;
float modulus = ${bName}[${numAlternatives * 4 + i}];
float scalar = ${bName}[${numAlternatives * 4 + 3 + i}];
vec4 a0 = ${aName}[${aIndex}];
vec4 a1 = ${aName}[${aIndex + 1}];
float b = ${bName}[${bIndex}];
float c = ${bName}[${bIndex + 1}];

  float dotResult0 = exactDot(a0, x.low) + exactDot(a1, x.high);
  float dotResult = imod(dotResult0, modulus);
  float dotResult2 = imod(dotResult * dotResult, modulus);
  float y = imod(dotResult2 * c, modulus);
  float modResult = imod(dotResult + y + b, modulus);

gl_FragData[4] = packFloatIntoVec4(dotResult0);
gl_FragData[0] = packFloatIntoVec4(dotResult);
gl_FragData[1] = packFloatIntoVec4(dotResult2);
gl_FragData[5] = packFloatIntoVec4(dotResult * dotResult);
gl_FragData[2] = packFloatIntoVec4(y);
gl_FragData[3] = packFloatIntoVec4(modResult);
`;

        builder.setFragmentMain(s);
      }

      tester.build();
      let {shader} = tester;
      shader.bind();

      for (let k = 0; k < 20; ++k) {
        let hashTable = new HashTable();
        let gpuHashTable = tester.registerDisposer(GPUHashTable.get(gl, hashTable));

        for (let i = 0; i < COUNT; ++i) {
          let x = Uint64.random();
          let temp = new Uint32Array(2);
          temp[0] = x.low;
          temp[1] = x.high;
          let inputValue = encodeBytesToFloat32(temp);
          gl.uniform4fv(shader.uniform('inputValue'), inputValue);
          hashTableShaderManager.enable(gl, shader, gpuHashTable);
          tester.execute();
          let alt = 0;
          let i = 0;

          let dotResult0 = tester.readFloat(4);
          let dotResult = tester.readFloat(0);
          let dotResult2 = tester.readFloat(1);
          let dotResultSquared = tester.readFloat(5);
          let y = tester.readFloat(2);
          let modResult = tester.readFloat(3);
          let modulus = PRIME_MODULUS;

          let h = hashTable.hashFunctions[alt][i];
          let expectedDotResult0 = h.computeDotProduct(x.low, x.high);
          let expectedDotResult = expectedDotResult0 % modulus;
          let expectedDotResultSquared = expectedDotResult * expectedDotResult;
          let expectedDotResult2 = (expectedDotResult * expectedDotResult) % modulus;
          let expectedY = (expectedDotResult2 * h.c) % modulus;
          let expectedModResult = (dotResult + y + h.b + 0.25) % modulus;
          expect(dotResult0).toEqual(expectedDotResult0);
          expect(dotResult).toEqual(expectedDotResult);
          expect(dotResultSquared).toEqual(expectedDotResultSquared);
          expect((dotResult2 + modulus) % modulus)
              .toEqual(expectedDotResult2, `dotResult=${dotResult}`);
          expect((y + modulus) % modulus).toEqual(expectedY);
          expect(modResult).toEqual(expectedModResult);
        }

        gpuHashTable.dispose();
      }
    });
  });
  it('hash function', () => {
    fragmentShaderTest(3 * 2, tester => {
      let {gl, builder} = tester;
      let hashTableShaderManager = new HashTableShaderManager('h');
      hashTableShaderManager.defineShader(builder);
      builder.addUniform('vec4', 'inputValue', 2);
      let s = `
uint64_t x;
x.low = inputValue[0];
x.high = inputValue[1];
`;
      {
        let outputNumber = 0;
        for (let alt = 0; alt < 3; ++alt) {
          for (let i = 0; i < 2; ++i) {
            s += `
gl_FragData[${outputNumber++}] = packFloatIntoVec4(h_computeHash_${alt}_${i}(x));
`;
          }
        }
      }
      builder.setFragmentMain(s);
      tester.build();
      let {shader} = tester;
      shader.bind();

      let hashTable = new HashTable();
      let gpuHashTable = tester.registerDisposer(GPUHashTable.get(gl, hashTable));
      for (let i = 0; i < COUNT; ++i) {
        let x = Uint64.random();
        let temp = new Uint32Array(2);
        temp[0] = x.low;
        temp[1] = x.high;
        let inputValue = encodeBytesToFloat32(temp);
        gl.uniform4fv(shader.uniform('inputValue'), inputValue);
        hashTableShaderManager.enable(gl, shader, gpuHashTable);
        tester.execute();
        let outputNumber = 0;
        for (let alt = 0; alt < 3; ++alt) {
          let output0 = tester.readFloat(outputNumber++);
          let output1 = tester.readFloat(outputNumber++);
          let hashes = hashTable.hashFunctions[alt];
          let {width, height} = hashTable;
          let expected0 = ((hashes[0].compute(x.low, x.high) % width) + 0.25) / width;
          let expected1 = ((hashes[1].compute(x.low, x.high) % height) + 0.5) / height;
          expect(expected0).toBeCloseTo(output0, 1e-6, `x = ${[x.low, x.high]}, alt = ${alt}`);
          expect(expected1).toBeCloseTo(output1, 1e-6);
        }
      }

    });
  });

  it('GPUHashTable', () => {
    fragmentShaderTest(1 + 2 * NUM_ALTERNATIVES, tester => {
      let numAlternatives = NUM_ALTERNATIVES;
      let {gl, builder} = tester;
      let hashTableShaderManager = new HashTableShaderManager('h');
      hashTableShaderManager.defineShader(builder);
      builder.addUniform('vec4', 'inputValue', 2);
      let {bName, samplerName} = hashTableShaderManager;
      let s = `
uint64_t x;
x.low = inputValue[0];
x.high = inputValue[1];
gl_FragData[0] = h_has(x) ? vec4(1.0, 1.0, 1.0, 1.0) : vec4(0.0, 0.0, 0.0, 0.0);
float highOffset = ${bName}[${numAlternatives * 4 + 2}];
`;
      {
        let outputNumber = 1;
        for (let alt = 0; alt < NUM_ALTERNATIVES; ++alt) {
          s += `
{
  vec2 v = h_computeHash_${alt}(x);
  gl_FragData[${outputNumber++}] = texture2D(${samplerName}[${alt}], v);
  gl_FragData[${outputNumber++}] = texture2D(${samplerName}[${alt}], vec2(v.x + highOffset, v.y));
}
`;
        }
      }
      builder.setFragmentMain(s);
      tester.build();
      let {shader} = tester;
      shader.bind();

      let hashTable = new HashTable();
      let gpuHashTable = tester.registerDisposer(GPUHashTable.get(gl, hashTable));
      let testValues = new Array<Uint64>();
      while (testValues.length < COUNT) {
        let x = Uint64.random();
        if (hashTable.has(x.low, x.high)) {
          continue;
        }
        testValues.push(x);
        hashTable.add(x.low, x.high);
      }
      let notPresentValues = new Array<Uint64>();
      while (notPresentValues.length < COUNT) {
        let x = Uint64.random();
        if (hashTable.has(x.low, x.high)) {
          continue;
        }
        notPresentValues.push(x);
      }
      let executeIndex = 0;
      function checkPresent(x: Uint64) {
        let temp = new Uint32Array(2);
        temp[0] = x.low;
        temp[1] = x.high;
        let inputValue = encodeBytesToFloat32(temp);
        gl.uniform4fv(shader.uniform('inputValue'), inputValue);
        hashTableShaderManager.enable(gl, shader, gpuHashTable);
        tester.execute();
        let curIndex = executeIndex;
        ++executeIndex;
        let outputNumber = 1;
        for (let alt = 0; alt < NUM_ALTERNATIVES; ++alt) {
          let valueLow = tester.readUint32(outputNumber++);
          let valueHigh = tester.readUint32(outputNumber++);
          let h = hashTable.getHash(alt, x.low, x.high);
          let expectedValueLow = hashTable.tables[alt][h];
          let expectedValueHigh = hashTable.tables[alt][h + 1];
          expect(valueLow).toEqual(
              expectedValueLow, `curIndex = ${curIndex}, x = ${[x.low, x.high]}, alt = ${alt}`);
          expect(valueHigh).toEqual(
              expectedValueHigh, `curIndex = ${curIndex}, x = ${[x.low, x.high]}, alt = ${alt}`);
        }
        let resultBytes = tester.readBytes();
        return resultBytes[0] === 255;
      }
      testValues.forEach((x, i) => {
        expect(hashTable.has(x.low, x.high)).toBe(true, `cpu: i = ${i}, x = ${x}`);
        expect(checkPresent(x))
            .toBe(
                true,
                `gpu: i = ${i}, x = ${x}, index = ${hashTable.hasWithTableIndex(x.low, x.high)}`);
      });
      notPresentValues.forEach((x, i) => {
        expect(hashTable.has(x.low, x.high)).toBe(false, `cpu: i = ${i}, x = ${x}`);
        expect(checkPresent(x)).toBe(false, `gpu: i = ${i}, x = ${x}`);
      });
    });
  });
});
