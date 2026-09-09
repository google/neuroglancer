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

import { describe, expect, test, vi } from "vitest";
import {
  bindPropertyListSortControl,
  createPropertyListQueryInput,
  createPropertyListStatisticsShell,
  getNextPropertyListSortDirection,
  type PropertyListSortDirection,
} from "#src/ui/property_list.js";

describe("property-list sort controls", () => {
  test("supports two-state and clearable transitions", () => {
    expect(getNextPropertyListSortDirection(undefined, false)).toBe(
      "ascending",
    );
    expect(getNextPropertyListSortDirection("ascending", false)).toBe(
      "descending",
    );
    expect(getNextPropertyListSortDirection("descending", false)).toBe(
      "ascending",
    );
    expect(
      getNextPropertyListSortDirection("descending", true),
    ).toBeUndefined();
  });

  test("updates visuals, accessibility, pointer, and keyboard activation", () => {
    const label = document.createElement("span");
    let direction: PropertyListSortDirection | undefined;
    const onChange = vi.fn((value) => {
      direction = value;
    });
    const control = bindPropertyListSortControl({
      label,
      fieldId: "score",
      allowClear: true,
      getDirection: () => direction,
      onChange,
    });
    expect(control.sortIcon.textContent).toBe("▲");
    expect(control.sortIcon.dataset.active).toBeUndefined();
    expect(label.getAttribute("aria-pressed")).toBe("false");

    label.click();
    expect(onChange).toHaveBeenLastCalledWith("ascending");
    expect(control.sortIcon.dataset.active).toBe("true");

    label.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onChange).toHaveBeenLastCalledWith("descending");
    expect(control.sortIcon.textContent).toBe("▼");

    label.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(label.title).toBe("Sort by score in ascending order");
  });
});

describe("property-list presentation", () => {
  test("creates a consistently configured query input", () => {
    const input = createPropertyListQueryInput({
      placeholder: "Filter properties",
      selectOnFocus: true,
    });
    const select = vi.spyOn(input, "select");
    input.dispatchEvent(new FocusEvent("focus"));
    expect(input.type).toBe("text");
    expect(input.placeholder).toBe("Filter properties");
    expect(input.autocomplete).toBe("off");
    expect(input.spellcheck).toBe(false);
    expect(select).toHaveBeenCalledOnce();
  });

  test("exposes statistics slots and controls shell visibility", () => {
    const shell = createPropertyListStatisticsShell();
    expect(shell.root.contains(shell.count)).toBe(true);
    expect(shell.root.contains(shell.content)).toBe(true);
    expect(shell.root.style.display).toBe("none");
    expect(shell.separator.style.display).toBe("none");
    shell.setVisible(true);
    expect(shell.root.style.display).toBe("");
    expect(shell.separator.style.display).toBe("");
  });
});
