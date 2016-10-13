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

import {VertexAttributeInfo} from 'neuroglancer/single_mesh/base';
import {getAttributeTextureFormats, SingleMeshShaderManager, VertexChunkData} from 'neuroglancer/single_mesh/frontend';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

describe('single_mesh/frontend', () => {
  it('attributes', () => {
    const attributeNames = ['attrA', 'attrB', 'attrC'];
    const attributeInfo: VertexAttributeInfo[] = [];

    let numVertices = 146423;

    const vertexData = new VertexChunkData();
    vertexData.vertexPositions = new Float32Array(numVertices * 3);
    vertexData.vertexNormals = new Float32Array(numVertices * 3);
    for (let i = 0; i < numVertices * 3; ++i) {
      vertexData.vertexPositions[i] = i;
      vertexData.vertexNormals[i] = i + 0.5;
    }

    vertexData.vertexAttributes = [];

    fragmentShaderTest(6, tester => {
      let shaderManager =
          new SingleMeshShaderManager(attributeNames, attributeInfo, /*fragmentMain=*/'');
      const attributeFormats = getAttributeTextureFormats(attributeInfo);

      let {gl, builder} = tester;
      builder.addUniform('highp float', 'vertexIndex');
      builder.addVarying('highp vec3', 'vVertexPosition');
      builder.addVarying('highp vec3', 'vVertexNormal');
      shaderManager.defineAttributeAccess(builder, 'vertexIndex');
      builder.addVertexMain(`
  vVertexPosition = vertexPosition;
  vVertexNormal = vertexNormal;
`);
      builder.setFragmentMain(`
  gl_FragData[0] = packFloatIntoVec4(vVertexPosition.x);
  gl_FragData[1] = packFloatIntoVec4(vVertexPosition.y);
  gl_FragData[2] = packFloatIntoVec4(vVertexPosition.z);
  gl_FragData[3] = packFloatIntoVec4(vVertexNormal.x);
  gl_FragData[4] = packFloatIntoVec4(vVertexNormal.y);
  gl_FragData[5] = packFloatIntoVec4(vVertexNormal.z);
`);
      vertexData.copyToGPU(gl, attributeFormats);
      tester.build();
      let {shader} = tester;
      shader.bind();

      for (let index of [0, 1, 2, 32104, 100201, 143212]) {
        shaderManager.bindVertexData(gl, shader, vertexData);
        gl.uniform1f(shader.uniform('vertexIndex'), index);
        tester.execute();
        let values = new Float32Array(6);
        for (let i = 0; i < 6; ++i) {
          values[i] = tester.readFloat(i);
        }
        for (let i = 0; i < 3; ++i) {
          expect(values[i]).toEqual(
              vertexData.vertexPositions[index * 3 + i], `vertexPositions: index=${index}, i=${i}`);
          expect(values[i + 3])
              .toEqual(
                  vertexData.vertexNormals[index * 3 + i], `vertexNormals: index=${index}, i=${i}`);
        }
      }
    });
  });
});
