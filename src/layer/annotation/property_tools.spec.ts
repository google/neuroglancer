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
import {
  getEnumPropertyBindingConfigurationKey,
  keyForEnumOptionIndex,
} from "#src/layer/annotation/property_tools.js";

describe("annotation property tool bindings", () => {
  test("uses direct keys for at most ten enum options", () => {
    expect(getEnumPropertyBindingConfigurationKey(0)).toBe("direct:0");
    expect(getEnumPropertyBindingConfigurationKey(10)).toBe("direct:10");
    expect(getEnumPropertyBindingConfigurationKey(11)).toBe("numeric");
  });

  test("maps ten enum options to 1-9 and 0", () => {
    expect(
      Array.from({ length: 10 }, (_, index) => keyForEnumOptionIndex(index)),
    ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
    expect(keyForEnumOptionIndex(10)).toBeUndefined();
  });
});
