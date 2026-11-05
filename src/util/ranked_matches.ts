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

export function rankedMatches<K extends string, T extends Record<K, string>>(
  items: readonly T[],
  property: K,
  query: string,
): readonly T[] {
  if (query === "") return items;
  const lowerCaseQuery = query.toLowerCase();
  const prefixMatches: T[] = [];
  const substringMatches: T[] = [];
  for (const item of items) {
    const text = item[property].toLowerCase();
    if (text.startsWith(lowerCaseQuery)) prefixMatches.push(item);
    else if (text.includes(lowerCaseQuery)) substringMatches.push(item);
  }
  return [...prefixMatches, ...substringMatches];
}
