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

import {HashMapUint64, HashSetUint64} from 'neuroglancer/gpu_hash/hash_table';
import {GPUHashTable, HashMapShaderManager, HashSetShaderManager} from 'neuroglancer/gpu_hash/shader';
import {Uint64} from 'neuroglancer/util/uint64';
import {glsl_unpackUint64leFromUint32} from 'neuroglancer/webgl/shader_lib';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';
import {getRandomUint32} from '../util/random';
import {hashCombine} from './hash_function';

const COUNT = 100;

describe('gpu_hash.shader', () => {
  it('hashCombineUint32', () => {
    fragmentShaderTest({outputValue: 'uint'}, tester => {
      let {gl, builder} = tester;
      let hashTableShaderManager = new HashSetShaderManager('h');
      hashTableShaderManager.defineShader(builder);
      builder.addUniform('highp uint', 'inputValue');
      builder.addUniform('highp uint', 'hashSeed');
      {
        let s = `
outputValue = hashCombine(hashSeed, inputValue);
`;
        builder.setFragmentMain(s);
      }

      tester.build();
      let {shader} = tester;
      shader.bind();
      const testHash = (hashSeed: number, inputValue: number) => {
        gl.uniform1ui(shader.uniform('hashSeed'), hashSeed);
        gl.uniform1ui(shader.uniform('inputValue'), inputValue);
        tester.execute();
        let expected = hashCombine(hashSeed, inputValue);
        expect(tester.values.outputValue).toEqual(expected);
      };
      for (let k = 0; k < 50; ++k) {
        testHash(getRandomUint32(), getRandomUint32());
      }
    });
  });


  it('hashCombine', () => {
    fragmentShaderTest({outputValue: 'uint'}, tester => {
      let {gl, builder} = tester;
      let hashTableShaderManager = new HashSetShaderManager('h');
      hashTableShaderManager.defineShader(builder);
      builder.addUniform('highp uvec2', 'inputValue');
      builder.addUniform('highp uint', 'hashSeed');
      {
        let s = `
uint64_t x;
x.value = inputValue;
outputValue = hashCombine(hashSeed, x);
`;
        builder.setFragmentMain(s);
      }

      tester.build();
      let {shader} = tester;
      shader.bind();
      for (let k = 0; k < 20; ++k) {
        const inputValue = Uint64.random();
        const hashSeed = getRandomUint32();
        gl.uniform1ui(shader.uniform('hashSeed'), hashSeed);
        gl.uniform2ui(shader.uniform('inputValue'), inputValue.low, inputValue.high);
        tester.execute();
        let expected = hashCombine(hashSeed, inputValue.low);
        expected = hashCombine(expected, inputValue.high);
        expect(tester.values.outputValue).toEqual(expected);
      }
    });
  });

  it('GPUHashTable:HashSetUint64', () => {
    fragmentShaderTest({outputValue: 'uint'}, tester => {
      let {gl, builder} = tester;
      let hashTableShaderManager = new HashSetShaderManager('h');
      hashTableShaderManager.defineShader(builder);
      builder.addFragmentCode(glsl_unpackUint64leFromUint32);
      builder.addUniform('highp uvec2', 'inputValue');
      let s = `
outputValue = uint(h_has(unpackUint64leFromUint32(inputValue)));
`;
      builder.setFragmentMain(s);
      tester.build();
      let {shader} = tester;
      shader.bind();

      let hashTable = new HashSetUint64();
      let gpuHashTable = tester.registerDisposer(GPUHashTable.get(gl, hashTable));
      let testValues = new Array<Uint64>();
      while (testValues.length < COUNT) {
        let x = Uint64.random();
        if (hashTable.has(x)) {
          continue;
        }
        testValues.push(x);
        hashTable.add(x);
      }
      let notPresentValues = new Array<Uint64>();
      notPresentValues.push(new Uint64(hashTable.emptyLow, hashTable.emptyHigh));
      while (notPresentValues.length < COUNT) {
        let x = Uint64.random();
        if (hashTable.has(x)) {
          continue;
        }
        notPresentValues.push(x);
      }
      function checkPresent(x: Uint64) {
        gl.uniform2ui(shader.uniform('inputValue'), x.low, x.high);
        hashTableShaderManager.enable(gl, shader, gpuHashTable);
        tester.execute();
        return tester.values.outputValue === 1;
      }
      testValues.forEach((x, i) => {
        expect(hashTable.has(x)).toBe(true, `cpu: i = ${i}, x = ${x}`);
        expect(checkPresent(x))
            .toBe(true, `gpu: i = ${i}, x = ${x}, index = ${hashTable.indexOf(x)}`);
      });
      notPresentValues.forEach((x, i) => {
        expect(hashTable.has(x)).toBe(false, `cpu: i = ${i}, x = ${x}`);
        expect(checkPresent(x)).toBe(false, `gpu: i = ${i}, x = ${x}`);
      });
    });
  });

  it('GPUHashTable:HashMapUint64', () => {
    fragmentShaderTest({isPresent: 'uint', outLow: 'uint', outHigh: 'uint'}, tester => {
      let {gl, builder} = tester;
      let shaderManager = new HashMapShaderManager('h');
      shaderManager.defineShader(builder);
      builder.addUniform('highp uvec2', 'inputValue');
      builder.setFragmentMain(`
uint64_t key = unpackUint64leFromUint32(inputValue);
uint64_t value;
isPresent = uint(h_get(key, value));
outLow = value.value[0];
outHigh = value.value[1];
`);
      tester.build();
      let {shader} = tester;
      shader.bind();
      let hashTable = new HashMapUint64();
      let gpuHashTable = tester.registerDisposer(GPUHashTable.get(gl, hashTable));
      let testValues = new Array<Uint64>();
      while (testValues.length < COUNT) {
        let x = Uint64.random();
        if (hashTable.has(x)) {
          continue;
        }
        testValues.push(x);
        hashTable.set(x, Uint64.random());
      }
      let notPresentValues = new Array<Uint64>();
      notPresentValues.push(new Uint64(hashTable.emptyLow, hashTable.emptyHigh));
      while (notPresentValues.length < COUNT) {
        let x = Uint64.random();
        if (hashTable.has(x)) {
          continue;
        }
        notPresentValues.push(x);
      }
      function checkPresent(x: Uint64) {
        gl.uniform2ui(shader.uniform('inputValue'), x.low, x.high);
        shaderManager.enable(gl, shader, gpuHashTable);
        tester.execute();
        const {values} = tester;
        let expectedValue = new Uint64();
        let expectedHas = hashTable.get(x, expectedValue);
        const has = values.isPresent === 1;
        expect(has).toBe(expectedHas, `x=${x}`);
        if (has) {
          expect(values.outLow).toBe(expectedValue.low, `x=${x}, low`);
          expect(values.outHigh).toBe(expectedValue.high, `x=${x}, high`);
        }
      }
      testValues.forEach((x, i) => {
        expect(hashTable.has(x)).toBe(true, `cpu: i = ${i}, x = ${x}`);
        checkPresent(x);
      });
      notPresentValues.forEach(x => {
        checkPresent(x);
      });
    });
  });
});
