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

import type { AnnotationPropertySpec } from "#src/annotation/index.js";

const shaderTokenPattern =
  /\/\/.*?$|\/\*(?:.|\n)*?\*\/|'(?:\\.|[^\\'])*'|"(?:\\.|[^\\"])*"|[A-Za-z_]\w*/gm;

export function upgradeLegacyAnnotationShader(
  shader: string,
  properties: readonly Readonly<AnnotationPropertySpec>[],
) {
  const replacements = new Map<string, string>();
  for (const property of properties) {
    if (property.type !== "bool") continue;
    replacements.set(
      `prop_${property.identifier}`,
      `uint_prop_${property.identifier}`,
    );
  }
  return shader.replace(shaderTokenPattern, (token) => {
    if (!/^[_A-Za-z]/.test(token)) return token;
    return replacements.get(token) ?? token;
  });
}
