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

import type { ShaderProgram } from "#src/webgl/shader.js";
import type { ShaderControlsParseResult } from "#src/webgl/shader_ui_controls.js";

const UNIFORM_PREFIX = "u_shaderControl_";

function uniformName(controlName: string): string {
  return `${UNIFORM_PREFIX}${controlName}`;
}

// Returns the set of #uicontrol names whose generated uniforms survived GLSL
// link-time dead-code elimination. Controls that compile to no uniforms
// (checkbox, which becomes a `#define`) are always considered active.
//
// `shader.uniforms` is the map populated by ShaderProgram at link time:
// each declared uniform name maps to its location (`WebGLUniformLocation`)
// or `null` if the GLSL driver eliminated it.
export function computeActiveControls(
  shader: ShaderProgram,
  parseResult: ShaderControlsParseResult,
): Set<string> {
  const active = new Set<string>();
  const { uniforms } = shader;
  for (const [name, control] of parseResult.controls) {
    if (control.type === "checkbox") {
      // Checkboxes become `#define`s at compile time; they have no uniform.
      // They gate other controls, so always show them.
      active.add(name);
      continue;
    }
    if (
      control.type === "imageInvlerp" ||
      control.type === "propertyInvlerp" ||
      control.type === "transferFunction"
    ) {
      // These inject helper functions plus one or more underlying uniforms
      // (bound/interval uniforms for invlerp, texture sampler for transfer
      // function). Any surviving uniform with the control's prefix means the
      // helper is reachable.
      const prefix = uniformName(name);
      let found = false;
      for (const [uName, location] of uniforms) {
        if (location !== null && uName.startsWith(prefix)) {
          found = true;
          break;
        }
      }
      if (found) active.add(name);
      continue;
    }
    // slider, color: single uniform per control.
    if (uniforms.get(uniformName(name)) != null) {
      active.add(name);
    }
  }
  return active;
}

export function activeControlsEqual(
  a: Set<string> | undefined,
  b: Set<string> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.size !== b.size) return false;
  for (const name of a) if (!b.has(name)) return false;
  return true;
}
