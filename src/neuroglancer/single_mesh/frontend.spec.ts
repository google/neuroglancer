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

    fragmentShaderTest(
        {vertexIndex: 'uint'}, {
          posX: 'float',
          posY: 'float',
          posZ: 'float',
          normX: 'float',
          normY: 'float',
          normZ: 'float',
        },
        tester => {
          let shaderManager = new SingleMeshShaderManager(attributeNames, attributeInfo);
          const attributeFormats = getAttributeTextureFormats(attributeInfo);

          let {gl, builder} = tester;
          builder.addVarying('highp vec3', 'vVertexPosition');
          builder.addVarying('highp vec3', 'vVertexNormal');
          shaderManager.defineAttributeAccess(builder, 'vertexIndex');
          builder.addVertexMain(`
  vVertexPosition = vertexPosition;
  vVertexNormal = vertexNormal;
`);
          builder.setFragmentMain(`
  posX = vVertexPosition.x;
  posY = vVertexPosition.y;
  posZ = vVertexPosition.z;
  normX = vVertexNormal.x;
  normY = vVertexNormal.y;
  normZ = vVertexNormal.z;
`);
          vertexData.copyToGPU(gl, attributeFormats);
          tester.build();
          let {shader} = tester;
          shader.bind();

          for (let index of [0, 1, 2, 32104, 100201, 143212]) {
            shaderManager.bindVertexData(gl, shader, vertexData);
            tester.execute({vertexIndex: index});
            const {values} = tester;
            const pos = [values.posX, values.posY, values.posZ];
            const norm = [values.normX, values.normY, values.normZ];
            for (let i = 0; i < 3; ++i) {
              expect(pos[i]).toEqual(
                  vertexData.vertexPositions[index * 3 + i],
                  `vertexPositions: index=${index}, i=${i}`);
              expect(norm[i]).toEqual(
                  vertexData.vertexNormals[index * 3 + i], `vertexNormals: index=${index}, i=${i}`);
            }
          }
        });
  });
});
