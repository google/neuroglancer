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

import {DataType} from 'neuroglancer/util/data_type';
import {GL} from 'neuroglancer/webgl/context';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';
import {compute1dTextureLayout, computeTextureFormat, OneDimensionalTextureAccessHelper, OneDimensionalTextureLayout, setOneDimensionalTextureData, TextureFormat} from 'neuroglancer/webgl/texture_access';

function testTextureAccess(
    dataLength: number,
    setLayout: (layout: OneDimensionalTextureLayout, gl: GL, texelsPerElement: number) => void) {
  fragmentShaderTest({outputValue: 'uint'}, tester => {
    let {gl, builder} = tester;
    const dataType = DataType.UINT32;
    const numComponents = 1;
    const format = new TextureFormat();
    const layout = new OneDimensionalTextureLayout();
    computeTextureFormat(format, dataType, numComponents);

    const data = new Uint32Array(dataLength);
    for (let i = 0; i < data.length; ++i) {
      data[i] = i;
    }

    setLayout(layout, gl, format.texelsPerElement);

    const accessHelper = new OneDimensionalTextureAccessHelper('textureAccess');
    const textureUnitSymbol = Symbol('textureUnit');
    accessHelper.defineShader(builder);
    builder.addUniform('highp uint', 'uOffset');
    builder.addTextureSampler('usampler2D', 'uSampler', textureUnitSymbol);
    builder.addFragmentCode(
        accessHelper.getAccessor('readValue', 'uSampler', dataType, numComponents));
    builder.setFragmentMain(`
outputValue = readValue(uOffset).value;
`);

    tester.build();
    let {shader} = tester;
    shader.bind();

    accessHelper.setupTextureLayout(gl, shader, layout);

    const textureUnit = shader.textureUnit(textureUnitSymbol);
    let texture = gl.createTexture();
    tester.registerDisposer(() => {
      gl.deleteTexture(texture);
    });
    gl.bindTexture(gl.TEXTURE_2D, texture);
    setOneDimensionalTextureData(gl, layout, format, data);
    gl.bindTexture(gl.TEXTURE_2D, null);

    function testOffset(x: number) {
      let value = data[x];
      gl.uniform1ui(shader.uniform('uOffset'), x);

      gl.activeTexture(gl.TEXTURE0 + textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      tester.execute();
      gl.bindTexture(gl.TEXTURE_2D, null);
      expect(tester.values.outputValue).toBe(value,
            `offset = ${x}, value = ${value}`);
    }

    testOffset(255 /*+ 256 * 256 * 9*/);
    for (let i = 0; i < 100; ++i) {
      testOffset(i);
    }

    const COUNT = 100;
    for (let i = 0; i < COUNT; ++i) {
      let offset = Math.floor(Math.random() * data.length);
      testOffset(offset);
    }
  });
}

function test1dTextureAccess(dataLength: number) {
  testTextureAccess(dataLength, (layout, gl, texelsPerElement) => {
    compute1dTextureLayout(layout, gl, texelsPerElement, dataLength);
  });
}

describe('one_dimensional_texture_access', () => {
  it('uint32 access works correctly for 1-D 128*128*128', () => {
    test1dTextureAccess(128 * 128 * 128);
  });
});
