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

import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

describe('FragmentShaderTester', () => {
  it('uint passthrough', () => {
    fragmentShaderTest({outputValue: 'uint'}, tester => {
      let {gl, builder} = tester;
      builder.addUniform('highp uint', 'inputValue');
      builder.setFragmentMain(`outputValue = inputValue;`);
      tester.build();
      let {shader} = tester;
      shader.bind();
      for (const inputValue of [0, 1, 42, 343432, 4294967295]) {
        gl.uniform1ui(shader.uniform('inputValue'), inputValue);
        tester.execute();
        const values = tester.values;
        expect(values.outputValue).toEqual(inputValue);
      }
    });
  });

  it('float passthrough', () => {
    fragmentShaderTest({outputValue: 'float'}, tester => {
      let {gl, builder} = tester;
      builder.addUniform('highp float', 'inputValue');
      builder.setFragmentMain(`outputValue = inputValue;`);
      tester.build();
      function generateRandomNumber() {
        let buf = new Uint32Array(1);
        let temp = new Float32Array(buf.buffer);
        do {
          crypto.getRandomValues(buf);
        } while (!Number.isNaN(temp[0]));
        return temp[0];
      }

      let {shader} = tester;
      shader.bind();
      let testValues = [0, 1, -1, 2, -2, 3, -3, 5, -5, 1.5, -1.5];
      let count = 100;
      for (let i = 0; i < count; ++i) {
        testValues.push(generateRandomNumber());
      }
      for (const inputValue of testValues) {
        gl.uniform1f(shader.uniform('inputValue'), inputValue);
        tester.execute();
        const values = tester.values;
        expect(values.outputValue).toEqual(inputValue);
      }
    });
  });

  it('float uint passthrough', () => {
    fragmentShaderTest({floatOutput: 'float', uintOutput: 'uint'}, tester => {
      let {gl, builder} = tester;
      builder.addUniform('highp float', 'floatInput');
      builder.addUniform('highp uint', 'uintInput');
      builder.setFragmentMain(`
  floatOutput = floatInput;
  uintOutput = uintInput;
`);
      tester.build();
      function generateRandomNumber() {
        let buf = new Uint32Array(1);
        let temp = new Float32Array(buf.buffer);
        do {
          crypto.getRandomValues(buf);
        } while (!Number.isFinite(temp[0]) ||
                 (temp[0] !== 0 && Math.abs(Math.log2(Math.abs(temp[0]))) > 125));
        return temp[0];
      }

      let {shader} = tester;
      shader.bind();
      let testFloatValues = [5, 0, 1, -1, 2, -2, 3, -3, 5, -5, 1.5, -1.5];
      let testUintValues = [7, 1, 5, 10, 33, 27, 55, 7, 5, 3, 343432, 4294967295];
      let count = 100;
      for (let i = 0; i < count; ++i) {
        testFloatValues.push(generateRandomNumber());
        testUintValues.push(i);
      }
      for (let i = 0; i < testUintValues.length; ++i) {
        const floatInput = testFloatValues[i];
        const uintInput = testUintValues[i];
        gl.uniform1f(shader.uniform('floatInput'), floatInput);
        gl.uniform1ui(shader.uniform('uintInput'), uintInput);
        tester.execute();
        const values = tester.values;
        expect(values.floatOutput).toEqual(floatInput);
        expect(values.uintOutput).toEqual(uintInput);
      }
    });
  });
});
