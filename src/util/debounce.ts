/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { DebouncedFunc, DebounceSettings } from "lodash-es";
import { debounce } from "lodash-es";
import type { WatchableValue } from "#src/trackable_value.js";

export function dynamicDebounce<T extends (...args: any) => any>(
  func: T,
  wait: WatchableValue<number>,
  options?: (wait: number) => DebounceSettings,
) {
  let debouncedFunc: DebouncedFunc<T> | undefined = undefined;
  const updateDebounce = () => {
    debouncedFunc?.flush(); // or cancel
    debouncedFunc = debounce(func, wait.value, options?.(wait.value));
  };
  const unregister = wait.changed.add(updateDebounce);
  updateDebounce();
  return Object.assign(
    (...args: Parameters<T>) => {
      return debouncedFunc!(...args);
    },
    {
      cancel: () => {
        debouncedFunc?.cancel();
      },
      dispose: () => {
        debouncedFunc?.cancel();
        unregister();
      },
      flush: () => {
        debouncedFunc?.flush();
      },
    },
  );
}
