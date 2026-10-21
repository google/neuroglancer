/**
 * @license
 * Copyright 2019 Google Inc.
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
import {
  formatValueWithUnit,
  parseValueWithUnit,
  pickDisplayUnit,
  roundValueToDisplayUnit,
  parseScale,
  scaleByExp10,
  formatScaleWithUnit,
} from "#src/util/si_units.js";

describe("property value units", () => {
  it("selects and converts a linear SI display unit", () => {
    const unit = pickDisplayUnit([5e-9, 30e-9], "m");
    expect(unit).toEqual({ scale: 1e-9, suffix: "nm" });
    expect(formatValueWithUnit(5e-9, unit)).toBe("5.00nm");
    expect(parseValueWithUnit("5nm", "m")).toBe(5e-9);
    expect(parseValueWithUnit("5", "m", unit)).toBe(5e-9);
  });

  it("applies SI prefixes to powered units", () => {
    const unit = pickDisplayUnit([1e-12, 25e-12], "m^2");
    expect(unit).toEqual({ scale: 1e-12, suffix: "µm^2" });
    expect(formatValueWithUnit(25e-12, unit)).toBe("25.00µm^2");
    expect(parseValueWithUnit("25um^2", "m^2")).toBe(25e-12);
  });

  it("rejects units that do not match the property", () => {
    expect(parseValueWithUnit("5ns", "m")).toBeUndefined();
  });

  it("defaults widget interactions to two decimals", () => {
    const unit = { scale: 1e-9, suffix: "nm" };
    const rounded = roundValueToDisplayUnit(26.049236e-9, unit);
    expect(formatValueWithUnit(rounded, unit)).toBe("26.05nm");
  });

  it("rounds initial unlimited bounds outward", () => {
    const unit = { scale: 1e-9, suffix: "nm" };
    expect(formatValueWithUnit(25.001e-9, unit, "down")).toBe("25.00nm");
    expect(formatValueWithUnit(29.999e-9, unit, "up")).toBe("30.00nm");
    expect(formatValueWithUnit(25e-9, unit, "down")).toBe("25.00nm");
    expect(formatValueWithUnit(30e-9, unit, "up")).toBe("30.00nm");
  });

  it("preserves manually entered additional decimal places", () => {
    const unit = { scale: 1e-9, suffix: "nm" };
    const value = parseValueWithUnit("26.1234nm", "m", unit)!;
    expect(formatValueWithUnit(value, unit)).toBe("26.1234nm");
  });
});

describe("parseScale", () => {
  const patterns: [string, { scale: number; unit: string } | undefined][] = [
    ["0", undefined],
    ["0nm", undefined],
    ["1x", undefined],
    ["", { scale: 1, unit: "" }],
    ["nm", { scale: 1e-9, unit: "m" }],
    ["ns", { scale: 1e-9, unit: "s" }],
    ["us", { scale: 1e-6, unit: "s" }],
    ["µs", { scale: 1e-6, unit: "s" }],
    ["2µs", { scale: 2e-6, unit: "s" }],
    ["1.2e3m", { scale: 1.2e3, unit: "m" }],
  ];
  for (const [s, result] of patterns) {
    it(`works for ${JSON.stringify(s)}`, () => {
      expect(parseScale(s)).toEqual(result);
    });
  }
});

describe("scaleByExp10", () => {
  it("works for simple cases", () => {
    expect(scaleByExp10(3, 2)).toEqual(3e2);
    expect(scaleByExp10(3, -9)).toEqual(3e-9);
    expect(scaleByExp10(50, -9)).toEqual(50e-9);
  });
});

describe("formatScaleWithUnit", () => {
  it("works for simple cases", () => {
    const examples: [
      { scale: number; unit: string },
      { scale: string; prefix: string; unit: string },
    ][] = [
      [
        { scale: 1, unit: "" },
        { scale: "", prefix: "", unit: "" },
      ],
      [
        { scale: 4e-9, unit: "m" },
        { scale: "4", prefix: "n", unit: "m" },
      ],
      [
        { scale: 1e-9, unit: "m" },
        { scale: "", prefix: "n", unit: "m" },
      ],
      [
        { scale: 1e-9, unit: "" },
        { scale: "1e-9", prefix: "", unit: "" },
      ],
    ];
    for (const [{ scale, unit }, result] of examples) {
      expect(formatScaleWithUnit(scale, unit)).toEqual(result);
    }
  });
});
