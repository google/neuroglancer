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

import { describe, it, expect } from "vitest";
import { createBoundedNumberInputElement } from "#src/ui/bounded_number_input.js";
import { DataType } from "#src/util/data_type.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";

describe("createBoundedNumberInputElement", () => {
  it("creates basic number input with default config", () => {
    const input = createBoundedNumberInputElement(42.5, {});

    expect(input.type).toBe("number");
    expect(input.value).toBe("42.5");
    expect(input.autocomplete).toBe("off");
    expect(input.spellcheck).toBe(false);
    expect(input.min).toBe("");
    expect(input.max).toBe("");
    expect(input.step).toBe("");
  });

  it("formats value with custom decimal places", () => {
    const input = createBoundedNumberInputElement(3.14159, { numDecimals: 2 });
    expect(input.value).toBe("3.14");
  });

  it("adds custom CSS class", () => {
    const input = createBoundedNumberInputElement(0, {
      className: "custom-class",
    });
    expect(input.classList.contains("custom-class")).toBe(true);
  });

  it("sets min, max, and step from config", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
      max: 10,
      step: 0.5,
    });

    expect(input.min).toBe("0");
    expect(input.max).toBe("10");
    expect(input.step).toBe("0.5");
  });

  it("sets bounds for FLOAT32 data type", () => {
    const input = createBoundedNumberInputElement(1.5, {
      dataType: DataType.FLOAT32,
    });

    expect(input.min).toBe("");
    expect(input.max).toBe("");
    expect(input.step).toBe("0.1");
  });

  it("set bounds for INT data types", () => {
    for (const dataType of Object.values(DataType)) {
      if (dataType === DataType.FLOAT32) continue; // Skip FLOAT32 as it's
      if (typeof dataType === "string") continue; // Skip string type
      const input = createBoundedNumberInputElement(0, {
        dataType: dataType as DataType,
      });
      const bounds = defaultDataTypeRange[dataType];
      expect(input.min).toBe(String(bounds[0]));
      expect(input.max).toBe(String(bounds[1]));
      expect(input.step).toBe("1");
    }
  });

  it("doesn't set bounds for readonly input", () => {
    const input = createBoundedNumberInputElement(5, {
      readonly: true,
      min: 0,
      max: 10,
    });

    expect(input.min).toBe("");
    expect(input.max).toBe("");
    expect(input.step).toBe("");
  });

  it("clamps value to minimum bound on change", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
      max: 10,
    });

    // Simulate user entering a value below minimum
    input.value = "-5";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("0");
  });

  it("clamps value to maximum bound on change", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
      max: 10,
    });

    // Simulate user entering a value above maximum
    input.value = "15";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("10");
  });

  it("allows valid values within bounds", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
      max: 10,
    });

    // Simulate user entering a valid value
    input.value = "7";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("7");
  });

  it("handles undefined min bound", () => {
    const input = createBoundedNumberInputElement(5, {
      max: 10,
    });

    // Value below undefined min should be allowed
    input.value = "-100";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("-100");
  });

  it("handles undefined max bound", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
    });

    // Value above undefined max should be allowed
    input.value = "1000";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("1000");
  });

  it("uses default step when not specified", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
      max: 10,
    });

    expect(input.step).toBe("1");
  });

  it("dataType does not override explicit step", () => {
    const input = createBoundedNumberInputElement(1.5, {
      dataType: DataType.FLOAT32,
      step: 0.01,
    });

    expect(input.step).toBe("0.01");
  });

  it("min and max data type don't override explicit config", () => {
    const input = createBoundedNumberInputElement(2, {
      dataType: DataType.UINT8,
      min: 1,
      max: 5,
    });
    expect(input.min).toBe("1");
    expect(input.max).toBe("5");
    expect(input.step).toBe("1");
  });

  it("doesn't add change listener when readonly", () => {
    const input = createBoundedNumberInputElement(5, {
      readonly: true,
      min: 0,
      max: 10,
    });

    // Should not clamp since it's readonly
    input.value = "15";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("15");
  });

  it("doesn't add change listener when no bounds are set", () => {
    const input = createBoundedNumberInputElement(5, {});

    // Should not clamp since no bounds
    input.value = "15";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("15");
  });

  it("handles change event with no target", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
      max: 10,
    });

    // Create event without target
    const event = new Event("change");
    Object.defineProperty(event, "target", { value: null });

    // Should not throw error
    expect(() => {
      input.dispatchEvent(event);
    }).not.toThrow();
  });

  it("handles edge case with exact min value", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
      max: 10,
    });

    input.value = "0";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("0");
  });

  it("handles edge case with exact max value", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
      max: 10,
    });

    input.value = "10";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("10");
  });

  it("handles NaN input gracefully", () => {
    const input = createBoundedNumberInputElement(5, {
      min: 0,
      max: 10,
    });

    // Simulate user entering NaN
    input.value = "";
    input.dispatchEvent(new Event("change"));

    expect(input.value).toBe("5"); // Should reset to initial value
  });
});
