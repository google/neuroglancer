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

export interface Completion { value: string; }

export interface CompletionWithDescription extends Completion { description?: string; }

export interface BasicCompletionResult {
  completions: Completion[];
  offset: number;
}

export function applyCompletionOffset<T extends{offset: number}>(
    offset: number, completionResult: T) {
  completionResult.offset += offset;
  return completionResult;
}

export function getPrefixMatches(prefix: string, options: Iterable<string>) {
  let result: Completion[] = [];
  for (let option of options) {
    if (option.startsWith(prefix)) {
      result.push({value: option});
    }
  }
  return result;
}

export function getPrefixMatchesWithDescriptions<T>(
    prefix: string, options: Iterable<T>, getValue: (x: T) => string,
    getDescription: (x: T) => string | undefined) {
  let result: CompletionWithDescription[] = [];
  for (let option of options) {
    let key = getValue(option);
    if (key.startsWith(prefix)) {
      result.push({value: key, description: getDescription(option)});
    }
  }
  return result;
}
