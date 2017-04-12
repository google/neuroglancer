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
import {glsl_packFloat, glsl_packFloat01ToFixedPoint, unpackFloat01FromFixedPoint} from 'neuroglancer/webgl/shader_lib';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

describe('FragmentShaderTester', () => {
  it('value passthrough', () => {
    fragmentShaderTest(1, tester => {
      let {gl, builder} = tester;
      builder.addUniform('vec4', 'inputValue');
      builder.addFragmentOutput('vec4', 'v4f_fragData0', 0);
      builder.setFragmentMain(`v4f_fragData0 = inputValue;`);
      tester.build();
      let {shader} = tester;
      let inputValue = vec4.fromValues(0, 64 / 255, 128 / 255, 192 / 255);
      shader.bind();
      gl.uniform4fv(shader.uniform('inputValue'), inputValue);
      tester.execute();
      let outputValue = tester.readVec4();
      expect(outputValue).toEqual(inputValue);
    });
  });

  it('packFloat', () => {
    fragmentShaderTest(1, tester => {
      let {gl, builder} = tester;
      builder.addUniform('highp float', 'inputValue');
      builder.addFragmentOutput('vec4', 'v4f_fragData0', 0);
      builder.addFragmentCode(glsl_packFloat);
      builder.setFragmentMain(`v4f_fragData0 = packFloatIntoVec4(inputValue);`);
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
      let testValues = [0, 1, -1, 2, -2, 3, -3, 5, -5, 1.5, -1.5];
      let count = 100;
      for (let i = 0; i < count; ++i) {
        testValues.push(generateRandomNumber());
      }
      for (let x of testValues) {
        gl.uniform1f(shader.uniform('inputValue'), x);
        tester.execute();
        let outputValue = tester.readFloat();
        expect(outputValue).toEqual(x);
      }
    });
  });

  it('packFloat2', () => {
    fragmentShaderTest(2, tester => {
      let {gl, builder} = tester;
      builder.addUniform('highp float', 'inputValue1');
      builder.addUniform('highp float', 'inputValue2');
      builder.addFragmentOutput('vec4', 'v4f_fragData1', 1);
      builder.addFragmentOutput('vec4', 'v4f_fragData2', 2);
      builder.addFragmentCode(glsl_packFloat);
      builder.setFragmentMain(`
  v4f_fragData1 = packFloatIntoVec4(inputValue1);
  v4f_fragData2 = packFloatIntoVec4(inputValue2);
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
      let testValues = [0, 1, -1, 2, -2, 3, -3, 5, -5, 1.5, -1.5];
      let count = 100;
      for (let i = 0; i < count; ++i) {
        testValues.push(generateRandomNumber());
      }
      for (let x of testValues) {
        let inputValues = Float32Array.of(x, x + 0.5);
        gl.uniform1f(shader.uniform('inputValue1'), inputValues[0]);
        gl.uniform1f(shader.uniform('inputValue2'), inputValues[1]);
        tester.execute();
        let outputValue1 = tester.readFloat(0);
        let outputValue2 = tester.readFloat(1);
        expect(outputValue1).toEqual(inputValues[0]);
        expect(outputValue2).toEqual(inputValues[1]);
      }
    });
  });

  it('packFloat01ToFixedPoint', () => {
    fragmentShaderTest(1, tester => {
      let {gl, builder} = tester;
      builder.addUniform('highp float', 'inputValue');
      builder.addFragmentOutput('vec4', 'v4f_fragData0', 0);
      builder.addFragmentCode(glsl_packFloat01ToFixedPoint);
      builder.setFragmentMain(`v4f_fragData0 = packFloat01ToFixedPoint(inputValue);`);
      tester.build();
      function generateRandomNumber() {
        let buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return buf[0] / (Math.pow(2, 32));
      }

      let {shader} = tester;
      shader.bind();
      let testValues = [0, 0.1, 0.01, 0.003, 0.5, 0.98];
      let count = 100;
      for (let i = 0; i < count; ++i) {
        testValues.push(generateRandomNumber());
      }
      for (let x of testValues) {
        gl.uniform1f(shader.uniform('inputValue'), x);
        tester.execute();
        let bytes = tester.readBytes();
        let outputValue = unpackFloat01FromFixedPoint(bytes);
        let absDiff = Math.abs(outputValue - x);
        expect(absDiff).toBeLessThan(
            Math.pow(2, -23), `x = ${x}, outputValue = ${outputValue}, difference = ${absDiff}`);
      }
    });
  });
});
