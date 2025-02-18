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

import { defaultStringCompare } from "#src/util/string.js";

export interface Completion {
  value: string;
}

export interface CompletionWithDescription extends Completion {
  description?: string;
}

export interface BasicCompletionResult<C extends Completion = Completion> {
  completions: C[];
  // Default completion to show.
  //
  // If not specified, the longest common prefix of all completions is the
  // "default completion" to show inline as a hint and to append if the user
  // presses TAB.  This option overrides that.
  defaultCompletion?: string;
  offset: number;
}

export const emptyCompletionResult = {
  offset: 0,
  completions: [],
};

export function applyCompletionOffset<T extends { offset: number } | undefined>(
  offset: number,
  completionResult: T,
): T {
  if (completionResult === undefined) return completionResult;
  return { ...completionResult, offset: completionResult.offset + offset };
}

export function getPrefixMatches(prefix: string, options: Iterable<string>) {
  const result: Completion[] = [];
  for (const option of options) {
    if (option.startsWith(prefix)) {
      result.push({ value: option });
    }
  }
  result.sort((a, b) => defaultStringCompare(a.value, b.value));
  return result;
}

export function getPrefixMatchesWithDescriptions<T>(
  prefix: string,
  options: Iterable<T>,
  getValue: (x: T) => string,
  getDescription: (x: T) => string | undefined,
) {
  const result: CompletionWithDescription[] = [];
  for (const option of options) {
    const key = getValue(option);
    if (key.startsWith(prefix)) {
      result.push({ value: key, description: getDescription(option) });
    }
  }
  result.sort((a, b) => defaultStringCompare(a.value, b.value));
  return result;
}

export async function completeQueryStringParameters<T extends Completion>(
  queryString: string,
  keyCompleter: (value: string) => Promise<BasicCompletionResult<T>>,
  valueCompleter: (
    key: string,
    value: string,
  ) => Promise<BasicCompletionResult<T>>,
): Promise<BasicCompletionResult<T>> {
  if (queryString.startsWith("{")) return emptyCompletionResult;
  const m = queryString.match(/^(?:(.*)[&;])?([^&;]*)$/);
  const part = m![2];
  const offset = queryString.length - part.length;
  const equalsIndex = part.indexOf("=");
  if (equalsIndex === -1) {
    const completions = await keyCompleter(part);
    return {
      offset: completions.offset + offset,
      completions: completions.completions.map((x) => ({
        ...x,
        value: `${x.value}=`,
      })),
    };
  }
  return applyCompletionOffset(
    offset + equalsIndex + 1,
    await valueCompleter(
      part.substring(0, equalsIndex),
      part.substring(equalsIndex + 1),
    ),
  );
}

export interface QueryStringCompletionTableEntry<
  C extends Completion = Completion,
> {
  readonly key: C;
  readonly values: readonly C[];
}

export type QueryStringCompletionTable<C extends Completion = Completion> =
  readonly QueryStringCompletionTableEntry<C>[];

export async function completeQueryStringParametersFromTable<
  C extends Completion,
>(queryString: string, table: QueryStringCompletionTable<C>) {
  return completeQueryStringParameters(
    queryString,
    async (key) => {
      const results: C[] = [];
      for (const entry of table) {
        const keyEntry = entry.key;
        if (keyEntry.value.startsWith(key)) results.push(keyEntry);
      }
      return { offset: 0, completions: results };
    },
    async (key, value) => {
      for (const entry of table) {
        if (entry.key.value !== key) continue;
        return {
          offset: 0,
          completions: entry.values.filter((x) => x.value.startsWith(value)),
        };
      }
      return emptyCompletionResult;
    },
  );
}

export async function concatCompletions<C extends Completion>(
  url: string,
  inputs: (
    | undefined
    | BasicCompletionResult<C>
    | Promise<BasicCompletionResult<C> | undefined>
  )[],
): Promise<BasicCompletionResult<C>> {
  const resultSets: BasicCompletionResult<C>[] = [];
  let minOffset = Number.POSITIVE_INFINITY;
  for (const result of await Promise.allSettled(inputs)) {
    if (result.status === "rejected") continue;
    const { value } = result;
    if (value === undefined || value.completions.length === 0) continue;
    resultSets.push(value);
    minOffset = Math.min(minOffset, value.offset);
  }
  if (resultSets.length === 0) return emptyCompletionResult;
  if (resultSets.length === 1) return resultSets[0];
  const completions: C[] = [];
  let defaultCompletion: string | undefined;
  for (const resultSet of resultSets) {
    defaultCompletion = defaultCompletion ?? resultSet.defaultCompletion;
    for (let completion of resultSet.completions) {
      if (resultSet.offset !== minOffset) {
        completion = {
          ...completion,
          value: url.slice(minOffset, resultSet.offset) + completion.value,
        };
      }
      completions.push(completion);
    }
  }
  return { offset: minOffset, completions, defaultCompletion };
}
