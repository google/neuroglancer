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
import type { OrientedSliceScales } from "#src/util/geom.js";
import {
  getFrustrumPlanes,
  isAABBVisible,
  mat4,
  quat,
  calculateOrientedSliceScales,
  vec3,
} from "#src/util/geom.js";

// This is copied from data_panel_layout.ts to avoid the dependency.
type NamedAxes = "xy" | "xz" | "yz";
const AXES_RELATIVE_ORIENTATION = new Map<NamedAxes, quat | undefined>([
  ["xy", undefined],
  ["xz", quat.rotateX(quat.create(), quat.create(), Math.PI / 2)],
  ["yz", quat.rotateY(quat.create(), quat.create(), Math.PI / 2)],
]);

describe("getFrustrumPlanes", () => {
  it("works for simple example", () => {
    const m = mat4.perspective(mat4.create(), Math.PI / 2, 4.0, 7, 113);
    const planes = getFrustrumPlanes(new Float32Array(24), m);
    const expectedPlanes = [
      // left
      +0.25, 0, -1, 0,
      // right
      -0.25, 0, -1, 0,
      // bottom
      0, 1, -1, 0,
      // top
      0, -1, -1, 0,
      // near
      0, 0, -1, -7,
      // far
      0, 0, 1, 113,
    ];
    planes.every((x, i) => expect(x).toBeCloseTo(expectedPlanes[i]));
  });
});

describe("isAABBVisible", () => {
  it("works for simple example", () => {
    const m = mat4.perspective(mat4.create(), Math.PI / 2, 4.0, 7, 113);
    const planes = getFrustrumPlanes(new Float32Array(24), m);
    expect(isAABBVisible(-1, -1, -20, 1, 1, -15, planes)).toBe(true);
    expect(isAABBVisible(-50, -1, -8, -40, 1, -7, planes)).toBe(false);
    expect(isAABBVisible(40, -1, -8, 50, 1, -7, planes)).toBe(false);
    expect(isAABBVisible(-1, -50, -8, 1, -40, -7, planes)).toBe(false);
    expect(isAABBVisible(-1, 40, -8, 1, 50, -7, planes)).toBe(false);
    expect(isAABBVisible(-1, -1, -112, 1, 1, -113, planes)).toBe(true);
    expect(isAABBVisible(-1, -1, -114, 1, 1, -118, planes)).toBe(false);
  });
});

describe("calculateOrientedSliceScales", () => {
  function validateOrientation(
    inputOrientation: string | quat,
    inputScales: vec3,
    inputUnits: readonly string[],
    expected: OrientedSliceScales | null | "exists",
  ) {
    const orientation =
      typeof inputOrientation === "string"
        ? AXES_RELATIVE_ORIENTATION.get(inputOrientation as NamedAxes)
        : inputOrientation;
    const result = calculateOrientedSliceScales(
      orientation,
      inputScales,
      inputUnits,
    );
    if (expected === "exists") expect(result).not.toBeNull();
    else expect(result).toStrictEqual(expected);
  }

  function checkThreeNonAxisAlignedOrientations(
    inputScales: vec3,
    inputUnits: readonly string[],
    expected: "exists" | null,
  ) {
    const startOrientation = quat.create();
    const orientation = quat.create();
    quat.rotateX(orientation, startOrientation, Math.PI / 4);
    validateOrientation(orientation, inputScales, inputUnits, expected);
    quat.rotateY(orientation, startOrientation, Math.PI / 4);
    validateOrientation(orientation, inputScales, inputUnits, expected);
    quat.rotateZ(orientation, startOrientation, Math.PI / 4);
    validateOrientation(orientation, inputScales, inputUnits, expected);
  }

  it.each([
    [
      "xy",
      { width: { scale: 1, unit: "m" }, height: { scale: 2, unit: "Hz" } },
    ],
    ["xz", { width: { scale: 1, unit: "m" }, height: { scale: 3, unit: "s" } }],
    [
      "yz",
      { width: { scale: 3, unit: "s" }, height: { scale: 2, unit: "Hz" } },
    ],
  ])("works for default axis-aligned orientation: %s", (key, result) => {
    const scales = vec3.fromValues(1, 2, 3);
    const units = ["m", "Hz", "s"];
    validateOrientation(key, scales, units, result);
  });

  it.each([
    [
      "xy",
      { width: { scale: 1, unit: "m" }, height: { scale: 3, unit: "Hz" } },
    ],
    ["xz", { width: { scale: 1, unit: "m" }, height: { scale: -1, unit: "" } }],
    [
      "yz",
      { width: { scale: -1, unit: "" }, height: { scale: 3, unit: "Hz" } },
    ],
  ])(
    "works for 2D dataset default axis-aligned orientation: %s",
    (key, expectedResult) => {
      const scales = vec3.fromValues(1, 3, -1);
      const units = ["m", "Hz", ""];
      validateOrientation(key, scales, units, expectedResult);
    },
  );

  it("works for uniform scale and units regardless of orientation", () => {
    const scales = vec3.fromValues(1, 1, 1);
    const units = ["m", "m", "m"];
    const orientation = quat.create();
    const uniformResult = {
      width: { scale: 1, unit: "m" },
      height: { scale: 1, unit: "m" },
    };

    for (let i = 0; i < 10; i++) {
      quat.rotateX(orientation, orientation, Math.random() * Math.PI * 2);
      quat.rotateY(orientation, orientation, Math.random() * Math.PI * 2);
      quat.rotateZ(orientation, orientation, Math.random() * Math.PI * 2);
      validateOrientation(orientation, scales, units, uniformResult);
    }
  });

  it("rejects non-uniform scale non-axis-aligned orientations", () => {
    const scales = vec3.fromValues(1, 2, 1);
    const units = ["m", "m", "Hz"];
    checkThreeNonAxisAlignedOrientations(scales, units, null);
  });

  it("rejects very close non-uniform scale non-axis-aligned orientations", () => {
    const scales = vec3.fromValues(1e-20, 1e-21, 1.01e-20);
    const units = ["m", "m", "m"];
    checkThreeNonAxisAlignedOrientations(scales, units, null);
  });

  it("works for non-default axis-aligned orientations", () => {
    const scales = vec3.fromValues(1, 2, 3);
    const units = ["m", "Hz", "s"];
    const altYZOrientation = quat.fromValues(0.5, 0.5, 0.5, 0.5);
    const expectedResult = {
      width: { scale: 2, unit: "Hz" },
      height: { scale: 3, unit: "s" },
    };
    validateOrientation(altYZOrientation, scales, units, expectedResult);
  });

  it("identifies close small numbers as equal", () => {
    const scales = vec3.fromValues(1e-19, 1.000000001e-19, 0.99999999999e-19);
    const units = ["m", "m", "m"];
    checkThreeNonAxisAlignedOrientations(scales, units, "exists");
  });

  it("rejects large and somewhat close numbers as non-equal", () => {
    const scales = vec3.fromValues(1e19, 1.001e19, 0.99999e19);
    const units = ["m", "m", "m"];
    checkThreeNonAxisAlignedOrientations(scales, units, null);

    // Because of the default tolerance, a little bit bigger would fail
    // like 100000001 100000000 100000002
    checkThreeNonAxisAlignedOrientations(
      vec3.fromValues(100001, 100000, 100000 - 1),
      ["m", "m", "m"],
      null,
    );
  });
});
