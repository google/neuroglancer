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

export type ShaderStringLiteralIdMap = ReadonlyMap<string, number>;

export interface ShaderStringPreprocessingResult {
  code: string;
  stringLiteralIds: ShaderStringLiteralIdMap;
}

// Matches double-quoted string literals without terminating on escaped quotes.
const doubleQuotedStringPattern = /"(?:\\.|[^\\"])*"/g;

export function preprocessStrings(
  userShader: string,
): ShaderStringPreprocessingResult {
  const stringLiteralIds = new Map<string, number>();
  const code = userShader.replace(doubleQuotedStringPattern, (token) => {
    const value = JSON.parse(token) as string;
    let index = stringLiteralIds.get(value);
    if (index === undefined) {
      index = stringLiteralIds.size + 1;
      stringLiteralIds.set(value, index);
    }
    return `${index}u`;
  });
  return { code, stringLiteralIds };
}
