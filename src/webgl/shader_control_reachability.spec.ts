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
import type { ShaderProgram } from "#src/webgl/shader.js";
import { computeActiveControls } from "#src/webgl/shader_control_reachability.js";
import type { ShaderControlsParseResult } from "#src/webgl/shader_ui_controls.js";

function makePropertyControlParseResult(
  code: string,
): ShaderControlsParseResult {
  return {
    source: code,
    code,
    controls: new Map([
      [
        "selectedProperty",
        {
          type: "property",
          segmentProperties: {
            tags: [],
            numericalProperties: new Map([["value", 2]]),
            stringProperties: [],
          },
        },
      ],
    ]),
    preprocessing: { stringLiteralIds: new Map() },
    errors: [],
  };
}

const shaderWithoutUniforms = {
  uniforms: new Map(),
} as unknown as ShaderProgram;

describe("computeActiveControls", () => {
  it("marks a referenced property control active", () => {
    const parseResult = makePropertyControlParseResult(`
vec4 segmentColor(vec4 color) {
  if (!selectedProperty) color.a = 0.2;
  return color;
}`);

    expect(computeActiveControls(shaderWithoutUniforms, parseResult)).toEqual(
      new Set(["selectedProperty"]),
    );
  });

  it("does not match a property control as part of another identifier", () => {
    const parseResult = makePropertyControlParseResult(
      "bool value = selectedPropertyFallback;",
    );

    expect(computeActiveControls(shaderWithoutUniforms, parseResult)).toEqual(
      new Set(),
    );
  });

  it("marks an invlerp control with a surviving helper uniform active", () => {
    const parseResult: ShaderControlsParseResult = {
      source: "color.r = normalizedValue();",
      code: "color.r = normalizedValue();",
      controls: new Map([
        [
          "normalizedValue",
          {
            type: "imageInvlerp",
            dataType: 2,
            default: {
              range: [0, 1],
              window: [0, 1],
              channel: [],
            },
            clamp: false,
          },
        ],
      ]),
      preprocessing: { stringLiteralIds: new Map() },
      errors: [],
    };
    const shader = {
      uniforms: new Map([
        [
          "uLerpParams_u_shaderControl_normalizedValue",
          {} as WebGLUniformLocation,
        ],
      ]),
    } as unknown as ShaderProgram;

    expect(computeActiveControls(shader, parseResult)).toEqual(
      new Set(["normalizedValue"]),
    );
  });
});
