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

import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Disposer } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import type {
  ShaderControlsBuilderState,
  ShaderControlsParseResult,
} from "#src/webgl/shader_ui_controls.js";

const UNIFORM_PREFIX = "u_shaderControl_";

function uniformName(controlName: string): string {
  return `${UNIFORM_PREFIX}${controlName}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCheckboxUsedInCode(
  controlName: string,
  parseResult: ShaderControlsParseResult,
): boolean {
  return new RegExp(`\\b${escapeRegExp(controlName)}\\b`).test(
    parseResult.code,
  );
}

// Returns the set of #uicontrol names whose generated uniforms survived GLSL
// link-time dead-code elimination. Controls that compile to no uniforms
// (checkbox, which becomes a `#define`) are considered active only if the
// parsed shader code actually references the generated identifier.
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
      // Checkboxes become `#define`s at compile time; they have no uniform, so
      // infer reachability from whether the shader code references the symbol.
      if (isCheckboxUsedInCode(name, parseResult)) {
        active.add(name);
      }
      continue;
    }
    if (
      control.type === "imageInvlerp" ||
      control.type === "propertyInvlerp" ||
      control.type === "transferFunction"
    ) {
      // These inject helper functions plus one or more underlying uniforms
      // (bound/interval uniforms for invlerp, texture sampler for transfer
      // function), each named `<kind>_u_shaderControl_<name>`.
      // Matching the whole suffix keeps control `c` from matching `ca`.
      const suffix = `_${uniformName(name)}`;
      let found = false;
      for (const [uName, location] of uniforms) {
        if (location !== null && uName.endsWith(suffix)) {
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
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.size !== b.size) return false;
  for (const name of a) if (!b.has(name)) return false;
  return true;
}

// A shader that has not drawn yet may read controls outside the set.
export type ActiveControlHint = ReadonlySet<string> | undefined;

// A panel's attachment, or a slice view's entry for the layer.
export type ViewBinding = RefCounted | { readonly disposers: Disposer[] };

export interface TrackedShader {
  readonly shader: ShaderProgram | null;
  readonly parameters: ShaderControlsBuilderState;
  // A fallback shader is built from older shader text.
  readonly fallback: boolean;
}

interface BindingRecord {
  readonly parameters: ShaderControlsBuilderState;
  readonly controlsByProgram: Map<WebGLProgram, ReadonlySet<string>>;
}

// Holds the drawn shaders of each layer-to-view binding until the view releases it.
export class ActiveShaderControls {
  private readonly hint_ = new WatchableValue<ActiveControlHint>(undefined);
  private readonly records = new Map<ViewBinding, BindingRecord>();
  private latestParameters: ShaderControlsBuilderState | undefined;

  get hint(): WatchableValueInterface<ActiveControlHint> {
    return this.hint_;
  }

  trackShader(
    { shader, parameters, fallback }: TrackedShader,
    binding: ViewBinding,
  ) {
    if (fallback || shader === null) return;
    if (!this.records.has(binding)) {
      const forget = () => this.forget(binding);
      if (binding instanceof RefCounted) {
        binding.registerDisposer(forget);
      } else {
        binding.disposers.push(forget);
      }
    }
    this.latestParameters = parameters;
    let record = this.records.get(binding);
    if (record === undefined || record.parameters !== parameters) {
      record = { parameters, controlsByProgram: new Map() };
      this.records.set(binding, record);
    } else if (record.controlsByProgram.has(shader.program)) {
      return;
    }
    record.controlsByProgram.set(
      shader.program,
      computeActiveControls(shader, parameters.parseResult),
    );
    this.updateHint();
  }

  private forget(binding: ViewBinding) {
    this.records.delete(binding);
    this.updateHint();
  }

  private updateHint() {
    const hint = new Set<string>();
    let hasCurrentRecord = false;
    for (const { parameters, controlsByProgram } of this.records.values()) {
      // A view that has not drawn since the shader settings changed is stale.
      if (parameters !== this.latestParameters) continue;
      hasCurrentRecord = true;
      for (const controls of controlsByProgram.values()) {
        for (const name of controls) hint.add(name);
      }
    }
    // Without a current record, the last hint stays rather than flash every control.
    if (!hasCurrentRecord) return;
    if (!activeControlsEqual(this.hint_.value, hint)) {
      this.hint_.value = hint;
    }
  }
}
