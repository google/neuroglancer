/**
 * @license
 * Copyright 2020 Google Inc.
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

import {glsl_log2Exact} from 'neuroglancer/webgl/shader_lib';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

describe('glsl_log2Exact', () => {
  it('works for small examples', () => {
    fragmentShaderTest({outputValue: 'uint'}, tester => {
      let {gl, builder} = tester;
      builder.addUniform('highp uint', 'inputValue');
      builder.addFragmentCode(glsl_log2Exact);
      builder.setFragmentMain(`outputValue = log2Exact(inputValue);`);
      tester.build();
      let {shader} = tester;
      shader.bind();
      for (let i = 0; i <= 31; ++i) {
        const j = 2**i;
        gl.uniform1ui(shader.uniform('inputValue'), j);
        tester.execute();
        const values = tester.values;
        expect(values.outputValue).toBe(i, `i=${i}, 2^i=${j}`);
      }
    });
  });
});
