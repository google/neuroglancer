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

import {hashCombine} from 'neuroglancer/gpu_hash/hash_function';
import {HashMapUint64, HashSetUint64} from 'neuroglancer/gpu_hash/hash_table';
import {GPUHashTable, HashMapShaderManager, HashSetShaderManager} from 'neuroglancer/gpu_hash/shader';
import {DataType} from 'neuroglancer/util/data_type';
import {getRandomUint32} from 'neuroglancer/util/random';
import {Uint64} from 'neuroglancer/util/uint64';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

const COUNT = 100;

describe('gpu_hash.shader', () => {
  it('hashCombineUint32', () => {
    fragmentShaderTest({inputValue: 'uint', hashSeed: 'uint'}, {outputValue: 'uint'}, tester => {
      const {builder} = tester;
      let hashTableShaderManager = new HashSetShaderManager('h');
      hashTableShaderManager.defineShader(builder);
      builder.setFragmentMain(`outputValue = hashCombine(hashSeed, inputValue);`);
      const testHash = (hashSeed: number, inputValue: number) => {
        tester.execute({hashSeed, inputValue});
        let expected = hashCombine(hashSeed, inputValue);
        expect(tester.values.outputValue).toEqual(expected);
      };
      for (let k = 0; k < 50; ++k) {
        testHash(getRandomUint32(), getRandomUint32());
      }
    });
  });


  it('hashCombine', () => {
    fragmentShaderTest(
        {inputValue: DataType.UINT64, hashSeed: 'uint'}, {outputValue: 'uint'}, tester => {
          const {builder} = tester;
          let hashTableShaderManager = new HashSetShaderManager('h');
          hashTableShaderManager.defineShader(builder);
          builder.setFragmentMain(`outputValue = hashCombine(hashSeed, inputValue);`);
          for (let k = 0; k < 20; ++k) {
            const inputValue = Uint64.random();
            const hashSeed = getRandomUint32();
            tester.execute({hashSeed, inputValue});
            let expected = hashCombine(hashSeed, inputValue.low);
            expected = hashCombine(expected, inputValue.high);
            expect(tester.values.outputValue).toEqual(expected);
          }
        });
  });

  it('GPUHashTable:HashSetUint64', () => {
    fragmentShaderTest({inputValue: DataType.UINT64}, {outputValue: 'bool'}, tester => {
      let {gl, builder} = tester;
      let hashTableShaderManager = new HashSetShaderManager('h');
      hashTableShaderManager.defineShader(builder);
      builder.setFragmentMain(`outputValue = h_has(inputValue);`);
      const {shader} = tester;

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
        hashTableShaderManager.enable(gl, shader, gpuHashTable);
        tester.execute({inputValue: x});
        return tester.values.outputValue;
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
    fragmentShaderTest(
        {key: DataType.UINT64}, {isPresent: 'bool', outputValue: DataType.UINT64}, tester => {
          let {gl, builder} = tester;
          let shaderManager = new HashMapShaderManager('h');
          shaderManager.defineShader(builder);
          builder.setFragmentMain(`isPresent = h_get(key, outputValue);`);
          const {shader} = tester;
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
            shaderManager.enable(gl, shader, gpuHashTable);
            tester.execute({key: x});
            const {values} = tester;
            let expectedValue = new Uint64();
            let expectedHas = hashTable.get(x, expectedValue);
            const has = values.isPresent;
            expect(has).toBe(expectedHas, `x=${x}`);
            if (has) {
              expect(values.outputValue.toString()).toBe(expectedValue.toString(), `x=${x}`);
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
