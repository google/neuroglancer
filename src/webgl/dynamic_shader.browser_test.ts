/**
 * @license
 * Copyright 2026 Google Inc.
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

import { describe, expect, it } from "vitest";
import { RefCounted } from "#src/util/disposable.js";
import {
  makeAggregateWatchableShaderError,
  makeWatchableShaderError,
  shaderCodeWithLineDirective,
} from "#src/webgl/dynamic_shader.js";
import { ShaderBuilder, ShaderCompilationError } from "#src/webgl/shader.js";
import { webglTest } from "#src/webgl/testing.js";

describe("shaderCodeWithLineDirective", () => {
  it("does not blame the user's code for an error in code generated after it", () => {
    webglTest((gl) => {
      const builder = new ShaderBuilder(gl);
      builder.addOutputBuffer("vec4", "out_color", 0);
      builder.setVertexMain("gl_Position = vec4(0.0);");
      builder.addFragmentCode(
        shaderCodeWithLineDirective("float userValue() {\n  return 1.0;\n}"),
      );
      builder.addFragmentCode(
        "float generatedValue() { return undefinedName; }\n",
      );
      builder.setFragmentMain("out_color = vec4(generatedValue());");

      let error: unknown;
      try {
        builder.build();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ShaderCompilationError);
      const { errorMessages } = error as ShaderCompilationError;
      expect(errorMessages.length).toBeGreaterThan(0);
      expect(errorMessages.map(({ file }) => file)).not.toContain(1);
    });
  });
});

describe("makeAggregateWatchableShaderError", () => {
  it("does not let one shader success clear another shader error", () => {
    const refCounted = new RefCounted();
    const volumeError = makeWatchableShaderError();
    const meshError = makeWatchableShaderError();
    const offscreenError = makeWatchableShaderError();
    const aggregate = makeAggregateWatchableShaderError(refCounted, [
      volumeError,
      meshError,
      offscreenError,
    ]);
    const error = Object.create(ShaderCompilationError.prototype);

    volumeError.value = error;
    meshError.value = null;
    offscreenError.value = null;

    expect(aggregate.value).toBe(error);
    volumeError.value = null;
    expect(aggregate.value).toBeNull();
    refCounted.dispose();
  });
});
