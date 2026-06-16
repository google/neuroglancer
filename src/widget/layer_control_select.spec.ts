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

import { afterEach, describe, expect, it } from "vitest";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { selectLayerControl } from "#src/widget/layer_control_select.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("selectLayerControl", () => {
  it("renders labels separately from values", () => {
    const value = new WatchableValue<string>("beta");
    const factory = selectLayerControl<any, string>(() => ({
      value,
      options: [
        { value: "alpha", label: "Alpha mode (alpha)" },
        { value: "beta", label: "Beta mode (beta)" },
      ],
    }));
    const context = new RefCounted();
    try {
      const { controlElement } = factory.makeControl({} as any, context, {
        labelContainer: document.createElement("div"),
        labelTextContainer: document.createElement("div"),
        display: {} as any,
        visibility: {} as any,
      });
      const select = controlElement as HTMLSelectElement;
      expect(
        Array.from(select.options, (option) => option.textContent),
      ).toEqual(["Alpha mode (alpha)", "Beta mode (beta)"]);
      expect(select.selectedIndex).toBe(1);
    } finally {
      context.dispose();
    }
  });

  it("updates the underlying numeric value from the selected option", () => {
    const value = new WatchableValue<number>(2);
    const factory = selectLayerControl<any, number>(() => ({
      value,
      options: [
        { value: 1, label: "One" },
        { value: 2, label: "Two" },
      ],
    }));
    const context = new RefCounted();
    try {
      const { controlElement } = factory.makeControl({} as any, context, {
        labelContainer: document.createElement("div"),
        labelTextContainer: document.createElement("div"),
        display: {} as any,
        visibility: {} as any,
      });
      const select = controlElement as HTMLSelectElement;
      select.selectedIndex = 0;
      select.dispatchEvent(new Event("change"));
      expect(value.value).toBe(1);
    } finally {
      context.dispose();
    }
  });
});
