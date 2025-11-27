/**
 * @license
 * Copyright 2025 Google LLC
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

// Backport of https://github.com/vitest-dev/vitest/pull/8390

import type { Environment } from "vitest";
import { builtinEnvironments } from "vitest/environments";

const KEYS = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "AbortController",
  "AbortSignal",
  "URL",
  "URLSearchParams",
];

export default <Environment>{
  name: "jsdom-patched",
  transformMode: "web",
  async setup(global, options) {
    const kv = Object.fromEntries(KEYS.map((key) => [key, global[key]]));
    const envReturn = await builtinEnvironments["jsdom"].setup(global, options);
    for (const [k, v] of Object.entries(kv)) {
      Object.defineProperty(global, k, {
        value: v,
      });
    }
    return {
      async teardown(global) {
        await envReturn.teardown(global);
      },
    };
  },
};
