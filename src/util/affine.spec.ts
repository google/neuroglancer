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
import { extractScalesFromAffineMatrix } from "#src/util/affine.js";

describe("extractScalesFromAffineMatrix", () => {
  it("correctly handles identity transform", () => {
    // 4D homogenous identity matrix
    const identityMatrix = new Float64Array([
      1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
      1.0,
    ]);

    const scales = extractScalesFromAffineMatrix(identityMatrix, 3);
    expect(scales).toEqual(new Float64Array([1.0, 1.0, 1.0]));

    const scalesWithGlobalBasis = extractScalesFromAffineMatrix(
      identityMatrix,
      3,
      new Float64Array([2.0, 3.0, 4.0]),
    );
    expect(scalesWithGlobalBasis).toEqual(new Float64Array([2.0, 3.0, 4.0]));
  });

  it("extracts scales from pure scale transform", () => {
    const scaleMatrix = new Float64Array([
      2.0,
      0.0,
      0.0,
      0.0, // first column: [2, 0, 0, 0]
      0.0,
      3.0,
      0.0,
      0.0, // second column: [0, 3, 0, 0]
      0.0,
      0.0,
      4.0,
      0.0, // third column: [0, 0, 4, 0]
      0.0,
      0.0,
      0.0,
      1.0, // fourth column: [0, 0, 0, 1]
    ]);

    const scales = extractScalesFromAffineMatrix(scaleMatrix, 3);
    expect(scales).toEqual(new Float64Array([2.0, 3.0, 4.0]));
  });

  it("extracts scales from pure rotation transform", () => {
    const rotationMatrix = new Float64Array([
      0.0,
      1.0,
      0.0,
      0.0, // first column: [0, 1, 0, 0]
      -1.0,
      0.0,
      0.0,
      0.0, // second column: [-1, 0, 0, 0]
      0.0,
      0.0,
      1.0,
      0.0, // third column: [0, 0, 1, 0]
      0.0,
      0.0,
      0.0,
      1.0, // fourth column: [0, 0, 0, 1]
    ]);

    const scales = extractScalesFromAffineMatrix(rotationMatrix, 3);
    expect(scales).toEqual(new Float64Array([1.0, 1.0, 1.0]));
  });

  it("extracts scales from pure shear transform", () => {
    const shearMatrix = new Float64Array([
      1.0,
      0.0,
      0.0,
      0.0, // first column: [1, 0, 0, 0]
      0.5,
      1.0,
      0.0,
      0.0, // second column: [0.5, 1, 0, 0]
      0.0,
      0.0,
      1.0,
      0.0, // third column: [0, 0, 1, 0]
      0.0,
      0.0,
      0.0,
      1.0, // fourth column: [0, 0, 0, 1]
    ]);

    const scales = extractScalesFromAffineMatrix(shearMatrix, 3);
    // First column: [1, 0, 0] -> length = 1.0
    // Second column: [0.5, 1, 0] -> length = sqrt(0.5^2 + 1^2) = sqrt(1.25) ≈ 1.118
    // Third column: [0, 0, 1] -> length = 1.0
    expect(scales[0]).toEqual(1.0);
    expect(scales[1]).toBeCloseTo(Math.sqrt(1.25));
    expect(scales[2]).toEqual(1.0);
  });

  it("extracts scales from affine representing a scale transform", () => {
    const anisotropicMatrix = new Float64Array([
      0.001,
      0.0,
      0.0,
      0.0, // first column: [0.001, 0, 0, 0]
      0.0,
      1000.0,
      0.0,
      0.0, // second column: [0, 1000, 0, 0]
      0.0,
      0.0,
      1.0,
      0.0, // third column: [0, 0, 1, 0]
      0.0,
      0.0,
      0.0,
      1.0, // fourth column: [0, 0, 0, 1]
    ]);

    const scales = extractScalesFromAffineMatrix(anisotropicMatrix, 3);
    expect(scales[0]).toBeCloseTo(0.001);
    expect(scales[1]).toBeCloseTo(1000.0);
    expect(scales[2]).toBeCloseTo(1.0);
  });

  it("extracts scales from affine transform combining scale, rotation, and shear", () => {
    const complexMatrix = new Float64Array([
      1.414,
      2.121,
      0.0,
      0.0, // first column: [√2, 3√2/2, 0, 0]
      -1.414,
      2.121,
      0.0,
      0.0, // second column: [-√2, 3√2/2, 0, 0]
      0.0,
      0.0,
      1.5,
      0.0, // third column: [0, 0, 1.5, 0]
      5.0,
      10.0,
      2.0,
      1.0, // fourth column: translation [5, 10, 2, 1]
    ]);

    // Translation should be ignored in scale extraction
    const scales = extractScalesFromAffineMatrix(complexMatrix, 3);

    // Square roots passed in base matrix so that expected values are easy here
    expect(scales[0]).toBeCloseTo(Math.sqrt(2 + 4.5));
    expect(scales[1]).toBeCloseTo(Math.sqrt(2 + 4.5));
    expect(scales[2]).toEqual(1.5);

    // With global scale factors
    // Basis vector lengths: [2, 3, 4]
    const scalesWithGlobalBasis = extractScalesFromAffineMatrix(
      complexMatrix,
      3,
      new Float64Array([2.0, 3.0, 4.0]),
    );
    expect(scalesWithGlobalBasis[0]).toBeCloseTo(Math.sqrt(2 * 4 + 4.5 * 9));
    expect(scalesWithGlobalBasis[1]).toBeCloseTo(Math.sqrt(2 * 4 + 4.5 * 9));
    expect(scalesWithGlobalBasis[2]).toBeCloseTo(1.5 * 4.0);
  });

  it("does not add +1 and -1 components to get zero", () => {
    const matrix = new Float64Array([
      1.0,
      -1.0,
      0.0,
      0.0, // first column: [1, -1, 0, 0]
      1.0,
      2.0,
      0.0,
      0.0, // second column: [1, 2, 0, 0]
      0.0,
      0.0,
      1.0,
      0.0, // third column: [0, 0, 1, 0]
      0.0,
      0.0,
      0.0,
      1.0, // fourth column: [0, 0, 0, 1])
    ]);
    const scales = extractScalesFromAffineMatrix(matrix, 3);
    expect(scales[0]).toBeCloseTo(Math.sqrt(2));
    expect(scales[1]).toBeCloseTo(Math.sqrt(5));
    expect(scales[2]).toEqual(1.0);
  });
});
