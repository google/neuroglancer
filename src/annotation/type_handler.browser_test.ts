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

import "#src/annotation/bounding_box.js";
import "#src/annotation/ellipsoid.js";
import "#src/annotation/line.js";
import "#src/annotation/point.js";
import "#src/annotation/polyline.js";

import { describe, expect, it } from "vitest";
import type { AnnotationPropertySpec } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import {
  type AnnotationShaderGetter,
  getAnnotationTypeRenderHandler,
} from "#src/annotation/type_handler.js";
import { WatchableValue } from "#src/trackable_value.js";
import { initializeWebGL } from "#src/webgl/context.js";
import {
  makeTrackableFragmentMain,
  makeWatchableShaderError,
} from "#src/webgl/dynamic_shader.js";
import {
  getFallbackBuilderState,
  parseShaderUiControls,
  ShaderControlState,
} from "#src/webgl/shader_ui_controls.js";

describe("annotation property shaders", () => {
  it("compiles a shader that colors by boolean property", () => {
    const canvas = document.createElement("canvas");
    const gl = initializeWebGL(canvas);
    const fragmentMain = makeTrackableFragmentMain(`
void main() {
  if (prop_highlight() != 0u) {
    setColor(vec3(1.0, 0.0, 0.0));
  } else {
    setColor(vec3(0.0, 0.0, 1.0));
  }
}
`);
    const shaderControlState = new ShaderControlState(fragmentMain);
    const fallbackShaderParameters = new WatchableValue(
      getFallbackBuilderState(parseShaderUiControls(fragmentMain.value)),
    );
    const shaderError = makeWatchableShaderError();
    const properties: AnnotationPropertySpec[] = [
      {
        identifier: "highlight",
        description: undefined,
        type: "bool",
        default: 0,
      },
    ];
    const renderHandler = getAnnotationTypeRenderHandler(AnnotationType.POINT);
    const renderHelper = new renderHandler.perspectiveViewRenderHelper(
      gl,
      AnnotationType.POINT,
      /*rank=*/ 3,
      properties,
      shaderControlState,
      fallbackShaderParameters,
      shaderError,
    );
    renderHelper.targetIsSliceView = false;
    renderHelper.pickIdsPerInstance = renderHandler.pickIdsPerInstance;

    const shaderGetter = (
      renderHelper as typeof renderHelper & {
        shaderGetter3d: AnnotationShaderGetter;
      }
    ).shaderGetter3d;
    const shaderResult = shaderGetter((builder) => {
      builder.addOutputBuffer("vec4", "out_color", 0);
      builder.addFragmentCode(`
void emit(vec4 color, highp uint pickId) {
  out_color = color;
}
`);
    });

    expect(shaderError.value).toBeNull();
    expect(shaderResult.shader).not.toBeNull();
    expect(shaderResult.shader!.vertexSource).toContain(
      "highp uint prop_highlight()",
    );
    expect(shaderResult.shader!.vertexSource).toContain(
      "if (prop_highlight() != 0u)",
    );

    renderHelper.dispose();
    shaderControlState.dispose();
  });
});
