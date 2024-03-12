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

import { it, describe, expect } from "vitest";
import {
  IndexBufferAttributeHelper,
  makeIndexBuffer,
} from "#src/webgl/index_emulation.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";

describe("webgl/index_emulation", () => {
  it("indexBuffer", () => {
    fragmentShaderTest({}, { outputValue: "uint" }, (tester) => {
      const { gl, builder } = tester;
      const helper = new IndexBufferAttributeHelper("aVertexIndex");
      helper.defineShader(builder);
      builder.addVarying("highp uint", "vVertexIndex", "flat");
      builder.addVertexMain("vVertexIndex = aVertexIndex;");
      builder.setFragmentMain("outputValue = vVertexIndex;");

      tester.build();
      const { shader } = tester;
      shader.bind();

      for (const indexValue of [5, 1, 143210]) {
        const indices = Uint32Array.of(
          indexValue,
          indexValue,
          indexValue,
          indexValue,
        );
        const indexBuffer = makeIndexBuffer(gl, indices);
        try {
          helper.bind(indexBuffer, shader);
          tester.execute();
          helper.disable(shader);
          expect(tester.values.outputValue).toEqual(indexValue);
        } finally {
          indexBuffer.dispose();
        }
      }
    });
  });
});
