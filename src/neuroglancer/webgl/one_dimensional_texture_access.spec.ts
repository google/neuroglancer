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
import {Uint64} from 'neuroglancer/util/uint64';
import {compute1dTextureFormat, compute1dTextureLayout, OneDimensionalTextureAccessHelper, OneDimensionalTextureFormat, OneDimensionalTextureLayout, setOneDimensionalTextureData} from 'neuroglancer/webgl/one_dimensional_texture_access';
import {setVec4FromUint32, encodeBytesToFloat32, glsl_unnormalizeUint8, glsl_uintleToFloat} from 'neuroglancer/webgl/shader_lib';
import {fragmentShaderTest} from 'neuroglancer/webgl/shader_testing';

describe('one_dimensional_texture_access', () => {
  it('uint32 access works correctly', () => {
    fragmentShaderTest(6, tester => {
      let {gl, builder} = tester;
      const dataType = DataType.UINT32;
      const numComponents = 1;
      const format = new OneDimensionalTextureFormat();
      const layout = new OneDimensionalTextureLayout();
      compute1dTextureFormat(format, dataType, numComponents);

      const data = new Uint32Array(128 * 128 * 128);
      for (let i = 0; i < data.length; ++i) {
        data[i] = i;
      }

      compute1dTextureLayout(layout, gl, format.texelsPerElement, data.length);

      const accessHelper = new OneDimensionalTextureAccessHelper('textureAccess');
      const textureUnitSymbol = Symbol('textureUnit');
      accessHelper.defineShader(builder);
      builder.addUniform('highp float', 'uOffset');
      builder.addUniform('highp vec4', 'uExpected');
      builder.addTextureSampler2D('uSampler', textureUnitSymbol);
      builder.addFragmentCode(
          accessHelper.getAccessor('readValue', 'uSampler', dataType, numComponents));
      builder.addFragmentCode(glsl_unnormalizeUint8);
      builder.addFragmentCode(glsl_uintleToFloat);
      builder.setFragmentMain(`
uint32_t value = readValue(uOffset);
gl_FragData[4] = packFloatIntoVec4(uintleToFloat(value.value.xyz));
gl_FragData[5] = packFloatIntoVec4(all(equal(value.value, uExpected)) ? 1.0 : 0.0);
value.value = unnormalizeUint8(value.value);
gl_FragData[0] = packFloatIntoVec4(value.value.x);
gl_FragData[1] = packFloatIntoVec4(value.value.y);
gl_FragData[2] = packFloatIntoVec4(value.value.z);
gl_FragData[3] = packFloatIntoVec4(value.value.w);
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
        gl.uniform1f(shader.uniform('uOffset'), x);
        gl.uniform4fv(shader.uniform('uExpected'), setVec4FromUint32(new Float32Array(4), value));

        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        tester.execute();
        gl.bindTexture(gl.TEXTURE_2D, null);

        let actual = new Float32Array(4);
        let expected = new Float32Array(4);
        for (let i = 0; i < 4; ++i) {
          actual[i] = tester.readFloat(i);
          expected[i] = (value >>> (8 * i)) & 0xFF;
        }
        expect(actual).toEqual(expected, `offset = ${x}, value = ${x}`);
        expect(tester.readFloat(4)).toEqual(value, `uint24le value != expected, offset = ${x}, value = ${x}`);
        expect(tester.readFloat(5)).toEqual(1.0, `uExpected != value in shader, offset = ${x}, value = ${x}`);
      }

      for (let i = 0; i < 100; ++i) {
        testOffset(i);
      }

      const COUNT = 100;
      for (let i = 0; i < COUNT; ++i) {
        let offset = Math.floor(Math.random() * data.length);
        testOffset(offset);
      }
    });
  });
});
