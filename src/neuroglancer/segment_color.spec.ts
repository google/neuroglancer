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
import {SegmentColorShaderManager, SegmentColorHash} from 'neuroglancer/segment_color';
import {Uint64} from 'neuroglancer/util/uint64';
import {encodeBytesToFloat32} from 'neuroglancer/webgl/shader_lib';

describe('segment_color', () => {
  it('the JavaScript implementation matches the WebGL shader implementation', () => {
    fragmentShaderTest(3, tester => {
      const shaderManager = new SegmentColorShaderManager('getColor');
      let {gl, builder} = tester;
      shaderManager.defineShader(builder);
      builder.addUniform('highp vec4', 'inputValue', 2);
      const colorHash = SegmentColorHash.getDefault();
      builder.setFragmentMain(`
uint64_t x;
x.low = inputValue[0];
x.high = inputValue[1];

highp vec3 color = getColor(x);
gl_FragData[0] = packFloatIntoVec4(color.x);
gl_FragData[1] = packFloatIntoVec4(color.y);
gl_FragData[2] = packFloatIntoVec4(color.z);
`);
      tester.build();
      let {shader} = tester;
      shader.bind();
      shaderManager.enable(gl, shader, colorHash);

      function testValue(x: Uint64) {
        let temp = new Uint32Array(2);
        temp[0] = x.low;
        temp[1] = x.high;
        let inputValue = encodeBytesToFloat32(temp);
        gl.uniform4fv(shader.uniform('inputValue'), inputValue);
        tester.execute();

        let actual = new Float32Array(3);
        for (let i = 0; i < 3; ++i) {
          actual[i] = tester.readFloat(i);
        }

        let expected = new Float32Array(3);
        colorHash.compute(expected, x);

        expect(actual).toEqual(expected, `x = ${x}`);
      }

      testValue(Uint64.parseString('0'));
      testValue(Uint64.parseString('8'));
      const COUNT = 100;
      for (let iter = 0; iter < COUNT; ++iter) {
        let x = Uint64.random();
        testValue(x);
      }
    });
  });
});
