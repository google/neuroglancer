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

import { describe, expect, test } from "vitest";
import type { AnnotationPropertySpec } from "#src/annotation/index.js";
import { upgradeLegacyAnnotationShader } from "#src/layer/annotation/shader.js";
import { constantWatchableValue } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";
import {
  addControlsToBuilder,
  getFallbackBuilderState,
  setControlsInShader,
  ShaderControlState,
} from "#src/webgl/shader_ui_controls.js";

const boolProperty = {
  identifier: "visible",
  type: "bool",
  default: 0,
} as AnnotationPropertySpec;

describe("legacy annotation shader migration", () => {
  test("permanently converts direct and macro-expanded bool property calls to uint", () => {
    const legacyShader = `
#define PROPERTY_FUNCTION prop_visible
#define CALL_PROPERTY(functionName) functionName()
#define FORWARD_PROPERTY(functionName) CALL_PROPERTY(functionName)

void main() {
  directValue = prop_visible() == 1u ? 1u : 0u;
  aliasValue = PROPERTY_FUNCTION() == 1u ? 1u : 0u;
  functionMacroValue = CALL_PROPERTY(prop_visible) == 1u ? 1u : 0u;
  nestedValue = FORWARD_PROPERTY(prop_visible) == 1u ? 1u : 0u;
}
`;

    fragmentShaderTest(
      { inputValue: "bool" },
      {
        directValue: "uint",
        aliasValue: "uint",
        functionMacroValue: "uint",
        nestedValue: "uint",
      },
      (tester) => {
        tester.builder.addFragmentCode(
          `
bool prop_visible() { return inputValue; }
highp uint uint_prop_visible() { return prop_visible() ? 1u : 0u; }
`,
        );
        tester.builder.setFragmentMainFunction(
          upgradeLegacyAnnotationShader(legacyShader, [boolProperty]),
        );
        tester.build();

        for (const inputValue of [false, true]) {
          tester.execute({ inputValue });
          const expectedValue = inputValue ? 1 : 0;
          expect(tester.values.directValue).toEqual(expectedValue);
          expect(tester.values.aliasValue).toEqual(expectedValue);
          expect(tester.values.functionMacroValue).toEqual(expectedValue);
          expect(tester.values.nestedValue).toEqual(expectedValue);
        }
      },
    );
  });

  test("supports property invlerp controls backed by bool properties", () => {
    const code = `
#uicontrol invlerp visibility(property="visible", range=[0, 1])
void main() {
  outputValue = vVisibility;
}
`;
    fragmentShaderTest(
      { inputValue: "bool" },
      { outputValue: "float" },
      (tester) => {
        const shaderControlState = new ShaderControlState(
          constantWatchableValue(code),
          constantWatchableValue({
            properties: new Map([["visible", DataType.UINT8]]),
            booleanProperties: new Set(["visible"]),
          }),
        );
        try {
          const parseResult = shaderControlState.parseResult.value;
          tester.builder.addVertexCode(
            "bool prop_visible() { return inputValue; }",
          );
          addControlsToBuilder(
            getFallbackBuilderState(parseResult),
            tester.builder,
          );
          tester.builder.addVarying("highp float", "vVisibility");
          tester.builder.setVertexMain(`
gl_Position = shader_testing_aVertexPosition;
vVisibility = visibility();
`);
          tester.builder.setFragmentMainFunction(parseResult.code);
          tester.build();
          setControlsInShader(
            tester.gl,
            tester.shader,
            shaderControlState,
            parseResult,
          );

          tester.execute({ inputValue: false });
          expect(tester.values.outputValue).toEqual(0);
          tester.execute({ inputValue: true });
          expect(tester.values.outputValue).toEqual(1);
        } finally {
          shaderControlState.dispose();
        }
      },
    );
  });
});
