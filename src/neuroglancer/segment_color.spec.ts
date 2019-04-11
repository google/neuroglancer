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

import {SegmentColorHash, SegmentColorShaderManager} from 'neuroglancer/segment_color';
import {Uint64} from 'neuroglancer/util/uint64';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';
import {glsl_unpackUint64leFromUint32} from './webgl/shader_lib';

describe('segment_color', () => {
  it('the JavaScript implementation matches the WebGL shader implementation', () => {
    fragmentShaderTest({outR: 'float', outG: 'float', outB: 'float'}, tester => {
      const shaderManager = new SegmentColorShaderManager('getColor');
      let {gl, builder} = tester;
      shaderManager.defineShader(builder);
      builder.addUniform('highp uvec2', 'inputValue');
      const colorHash = SegmentColorHash.getDefault();
      builder.addFragmentCode(glsl_unpackUint64leFromUint32);
      builder.setFragmentMain(`
uint64_t x = unpackUint64leFromUint32(inputValue);

highp vec3 color = getColor(x);
outR = color.r;
outG = color.g;
outB = color.b;
`);
      tester.build();
      let {shader} = tester;
      shader.bind();
      shaderManager.enable(gl, shader, colorHash);

      function testValue(x: Uint64) {
        gl.uniform2ui(shader.uniform('inputValue'), x.low, x.high);
        tester.execute();

        let actual = new Float32Array(3);
        for (let i = 0; i < 3; ++i) {
          actual[i] = tester.readFloat(i);
        }

        let expected = new Float32Array(3);
        colorHash.compute(expected, x);
        const {values} = tester;
        expect(values.outR).toBeCloseTo(expected[0]);
        expect(values.outG).toBeCloseTo(expected[1]);
        expect(values.outB).toBeCloseTo(expected[2]);
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
