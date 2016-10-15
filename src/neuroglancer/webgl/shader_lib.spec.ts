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

import {vec4} from 'neuroglancer/util/geom';
import {getRandomValues} from 'neuroglancer/util/random';
import {glsl_addUint32, glsl_divmodUint32, setVec4FromUint32} from 'neuroglancer/webgl/shader_lib';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

/**
 * Returns an array of `count` integers in the range [min, max].
 */
function getRandomInts(count: number, min: number, max: number) {
  let result = new Array<number>(count);
  for (let i = 0; i < count; ++i) {
    result[i] = Math.floor(Math.random() * (max - min + 1)) + min;
  }
  return result;
}

describe('webgl/shader_lib', () => {
  it('addUint32', () => {
    fragmentShaderTest(1, tester => {
      let {gl, builder} = tester;
      builder.addFragmentCode(glsl_addUint32);
      builder.addUniform('highp vec4', 'uValue1');
      builder.addUniform('highp vec4', 'uValue2');
      builder.setFragmentMain(`
uint32_t a, b; a.value = uValue1; b.value = uValue2;
gl_FragData[0] = add(a, b).value;
`);

      tester.build();
      let {shader} = tester;
      shader.bind();

      function testPair(a: number, b: number) {
        let result = (a + b) >>> 0;
        gl.uniform4fv(shader.uniform('uValue1'), setVec4FromUint32(vec4.create(), a));
        gl.uniform4fv(shader.uniform('uValue2'), setVec4FromUint32(vec4.create(), b));
        tester.execute();
        let value = tester.readUint32();
        expect(value).toEqual(result, `${a} + ${b}`);
      }

      function testPairs(values: Uint32Array) {
        for (let i = 0; i < values.length; i += 2) {
          testPair(values[i], values[i + 1]);
        }
      }

      testPairs(Uint32Array.of(0, 1, 3, 2, 3, 17));

      const count = 50;
      testPairs(getRandomValues(new Uint32Array(count * 2)));

    });
  });

  it('divmodUint32', () => {
    fragmentShaderTest(2, tester => {
      let {gl, builder} = tester;
      builder.addFragmentCode(glsl_divmodUint32);
      builder.addUniform('highp vec4', 'uDividend');
      builder.addUniform('highp float', 'uDivisor');
      builder.setFragmentMain(`
uint32_t a; a.value = uDividend;
uint32_t quotient;
gl_FragData[0] = packFloatIntoVec4(divmod(a, uDivisor, quotient));
gl_FragData[1] = quotient.value;
`);

      tester.build();
      let {shader} = tester;
      shader.bind();

      function testPair(a: number, b: number) {
        let expectedRemainder = a % b;
        let expectedQuotient = (a - expectedRemainder) / b;
        gl.uniform4fv(shader.uniform('uDividend'), setVec4FromUint32(vec4.create(), a));
        gl.uniform1f(shader.uniform('uDivisor'), b);
        tester.execute();
        let remainder = tester.readFloat(0);
        let quotient = tester.readUint32(1);
        expect(remainder).toEqual(expectedRemainder, `${a} % ${b}`);
        expect(quotient).toEqual(expectedQuotient, `${a} // ${b}`);
      }

      function testPairs(dividends: Uint32Array, divisors: number[]) {
        dividends.forEach((dividend, i) => { testPair(dividend, divisors[i]); });
      }

      testPairs(
          Uint32Array.of(0, 1, 3, 2, 3, 17, (1 << 32) - 1), [1, 2, 3, 4, 5, 6, (1 << 16) - 1]);

      const count = 50;
      testPairs(getRandomValues(new Uint32Array(count)), getRandomInts(count, 0, (1 << 16) - 1));
    });
  });
});
