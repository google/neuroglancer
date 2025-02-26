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
  getFrustrumPlanes,
  isAABBVisible,
  mat4,
  quat,
  computeScalesAndUnits,
  vec3,
} from "#src/util/geom.js";
import { AXES_RELATIVE_ORIENTATION } from "#src/widget/display_dimensions_widget.js";

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

describe("isOrientationAxisAligned", () => {
  it("works for default axis-aligned orientations", () => {
    const scales = vec3.fromValues(1, 2, 3);
    const units = ["m", "Hz", "s"];
    const xyOrientation = AXES_RELATIVE_ORIENTATION.get("xy");
    const xyResult = {
      width: {
        scale: 1,
        unit: "m",
      },
      height: {
        scale: 2,
        unit: "Hz",
      },
    };
    expect(
      computeScalesAndUnits(xyOrientation, scales, units),
    ).toStrictEqual(xyResult);
    const xzOrientation = AXES_RELATIVE_ORIENTATION.get("xz");
    const xzResult = {
      width: {
        scale: 1,
        unit: "m",
      },
      height: {
        scale: 3,
        unit: "s",
      },
    };
    expect(
      computeScalesAndUnits(xzOrientation, scales, units),
    ).toStrictEqual(xzResult);
    const yzOrientation = AXES_RELATIVE_ORIENTATION.get("yz");
    const yzResult = {
      width: {
        scale: 3,
        unit: "s",
      },
      height: {
        scale: 2,
        unit: "Hz",
      },
    };
    expect(
      computeScalesAndUnits(yzOrientation, scales, units),
    ).toStrictEqual(yzResult);
  });
  it("works for uniform scale and units orientations", () => {
    const scales = vec3.fromValues(1, 1, 1);
    const units = ["m", "m", "m"];
    const default_orientation = quat.create();
    const q1 = quat.create();
    const uniformResult = {
      width: {
        scale: 1,
        unit: "m",
      },
      height: {
        scale: 1,
        unit: "m",
      },
    };
    // For any rotation, you get the same result
    for (let i = 0; i < 10; i++) {
      quat.rotateX(q1, default_orientation, Math.random() * Math.PI * 2);
      quat.rotateY(q1, q1, Math.random() * Math.PI * 2);
      quat.rotateZ(q1, q1, Math.random() * Math.PI * 2);
      expect(computeScalesAndUnits(q1, scales, units)).toStrictEqual(
        uniformResult,
      );
    }
  });
  it("works for non default axis aligned orientations", () => {
    const alt_yz_orientation = quat.fromValues(0.5, 0.5, 0.5, 0.5);
    const scales = vec3.fromValues(1, 2, 3);
    const units = ["m", "Hz", "s"];
    const alt_yz_result = {
      width: {
        scale: 2,
        unit: "Hz",
      },
      height: {
        scale: 3,
        unit: "s",
      },
    };
    expect(
      computeScalesAndUnits(alt_yz_orientation, scales, units),
    ).toStrictEqual(alt_yz_result);
  });
});
