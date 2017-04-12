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

import {IndexBufferAttributeHelper, makeIndexBuffer} from 'neuroglancer/webgl/index_emulation';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

describe('webgl/index_emulation', () => {
  it('indexBuffer', () => {
    fragmentShaderTest(1, tester => {
      let {gl, builder} = tester;
      let helper = new IndexBufferAttributeHelper('VertexIndex');
      helper.defineShader(builder);
      builder.addVarying('highp float', 'vVertexIndex');
      builder.addFragmentOutput('vec4', 'v4f_fragData0', 0);
      builder.addVertexMain(`vVertexIndex = getVertexIndex();`);
      builder.setFragmentMain(`v4f_fragData0 = packFloatIntoVec4(vVertexIndex);`);

      tester.build();
      let {shader} = tester;
      shader.bind();

      for (let indexValue of [0, 1, 143210]) {
        let indices = Uint32Array.of(indexValue);
        let indexBuffer = makeIndexBuffer(gl, indices);
        try {
          helper.bind(indexBuffer, shader);
          tester.execute();
          helper.disable(shader);
          let value = tester.readFloat();
          expect(value).toEqual(indexValue);
        } finally {
          indexBuffer.dispose();
        }
      }
    });
  });
});
