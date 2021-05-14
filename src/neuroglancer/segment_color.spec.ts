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
import {DataType} from 'neuroglancer/util/data_type';
import {Uint64} from 'neuroglancer/util/uint64';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

describe('segment_color', () => {
  it('the JavaScript implementation matches the WebGL shader implementation', () => {
    fragmentShaderTest(
        {inputValue: DataType.UINT64}, {outR: 'float', outG: 'float', outB: 'float'}, tester => {
          const shaderManager = new SegmentColorShaderManager('getColor');
          const {builder} = tester;
          shaderManager.defineShader(builder);
          const colorHash = SegmentColorHash.getDefault();
          builder.setFragmentMain(`
highp vec3 color = getColor(inputValue);
outR = color.r;
outG = color.g;
outB = color.b;
`);
          tester.build();
          const {gl, shader} = tester;
          shader.bind();
          shaderManager.enable(gl, shader, colorHash.value);

          function testValue(x: Uint64) {
            tester.execute({inputValue: x});
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
