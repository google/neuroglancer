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

import { expect, describe, test } from "vitest";
import { DataType } from "#src/util/data_type.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";
import {
  computeTextureFormat,
  OneDimensionalTextureAccessHelper,
  setOneDimensionalTextureData,
  TextureFormat,
} from "#src/webgl/texture_access.js";

function testTextureAccess(dataLength: number) {
  const dataType = DataType.UINT32;
  fragmentShaderTest(
    { uOffset: "uint" },
    { outputValue: dataType },
    (tester) => {
      const { gl, builder } = tester;
      const numComponents = 1;
      const format = new TextureFormat();
      computeTextureFormat(format, dataType, numComponents);

      const data = new Uint32Array(dataLength);
      for (let i = 0; i < data.length; ++i) {
        data[i] = i;
      }

      const accessHelper = new OneDimensionalTextureAccessHelper(
        "textureAccess",
      );
      const textureUnitSymbol = Symbol("textureUnit");
      accessHelper.defineShader(builder);
      builder.addTextureSampler("usampler2D", "uSampler", textureUnitSymbol);
      builder.addFragmentCode(
        accessHelper.getAccessor(
          "readValue",
          "uSampler",
          dataType,
          numComponents,
        ),
      );
      builder.setFragmentMain(`
outputValue = readValue(uOffset);
`);

      tester.build();
      const { shader } = tester;
      shader.bind();

      const textureUnit = shader.textureUnit(textureUnitSymbol);
      const texture = gl.createTexture();
      tester.registerDisposer(() => {
        gl.deleteTexture(texture);
      });
      gl.bindTexture(gl.TEXTURE_2D, texture);
      setOneDimensionalTextureData(gl, format, data);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const COUNT = 100;
      for (const x of [
        255,
        ...Array.from(Array(100).keys()),
        ...Array.from(Array(COUNT), () =>
          Math.floor(Math.random() * data.length),
        ),
      ]) {
        const value = data[x];
        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        tester.execute({ uOffset: x });
        gl.bindTexture(gl.TEXTURE_2D, null);
        expect(tester.values.outputValue, `offset=${x}`).toBe(value);
      }
    },
  );
}

function test1dTextureAccess(dataLength: number) {
  testTextureAccess(dataLength);
}

describe("one_dimensional_texture_access", () => {
  test("uint32 access works correctly for 1-D 128*128*128", () => {
    test1dTextureAccess(128 * 128 * 128);
  });
});
