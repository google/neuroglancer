/**
 * @license
 * Copyright 2024 Google Inc.
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
import { parseOmeMetadata } from "#src/datasource/zarr/ome.js";
import { createIdentity } from "#src/util/matrix.js";

const intrinsicCoordinateSystem = {
  name: "physical",
  axes: [
    { type: "space", name: "z", unit: "micrometer" },
    { type: "space", name: "y", unit: "micrometer" },
    { type: "space", name: "x", unit: "micrometer" },
  ],
};

function makeOmeAttrsWithTransform(transform: any) {
  return {
    ome: {
      version: "0.6",
      multiscales: [
        {
          name: "multiscales",
          coordinateSystems: [intrinsicCoordinateSystem],
          datasets: [
            {
              path: "array",
              coordinateTransformations: [transform],
            },
          ],
        },
      ],
    },
  };
}

const worldCoordinateSystem = {
  name: "world",
  axes: [
    { type: "space", name: "z", unit: "micrometer" },
    { type: "space", name: "y", unit: "micrometer" },
    { type: "space", name: "x", unit: "micrometer" },
  ],
};

function makeOmeAttrsWithTwoTransforms(
  arrayToInstrinsicTransform: any,
  instrinsicToWorldTransform: any,
) {
  return {
    ome: {
      version: "0.6",
      multiscales: [
        {
          name: "multiscales",
          coordinateSystems: [worldCoordinateSystem, intrinsicCoordinateSystem],
          datasets: [
            {
              path: "array",
              coordinateTransformations: [arrayToInstrinsicTransform],
            },
          ],
          coordinateTransformations: [instrinsicToWorldTransform],
        },
      ],
    },
  };
}

describe("OME-Zarr 0.6 coordinate transformations", () => {
  it("should parse an identity transformation", () => {
    const attrs = makeOmeAttrsWithTransform({
      type: "identity",
      output: "physical",
    });
    const metadata = parseOmeMetadata("test://", attrs, 3);
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    );
  });

  it("should parse a scale transformation", () => {
    const attrs = makeOmeAttrsWithTransform({
      type: "scale",
      scale: [10, 0.3, 2],
      output: "physical",
    });
    const metadata = parseOmeMetadata("test://", attrs, 3);
    // The scale gets extracted out, so the base transform is identity
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    );
    console.log(metadata);
    const scales = metadata!.multiscale.coordinateSpace.scales;
    expect(scales[0]).toBeCloseTo(1e-5); // 10 micrometer in meters
    expect(scales[1]).toBeCloseTo(3e-7); // 0.3 micrometer in meters
    expect(scales[2]).toBeCloseTo(2e-6); // 2 micrometer in meters
  });

  it("should parse a translation transformation", () => {
    const attrs = makeOmeAttrsWithTransform({
      type: "translation",
      translation: [10, 20, 30],
      output: "physical",
    });
    const metadata = parseOmeMetadata("test://", attrs, 3);
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]),
    );
  });

  it("should parse a rotation transformation", () => {
    const attrs = makeOmeAttrsWithTransform({
      type: "rotation",
      rotation: [
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
      ],
      output: "physical",
    });
    const metadata = parseOmeMetadata("test://", attrs, 3);
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      new Float64Array([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1]),
    );
  });

  it("should parse a mapAxis transformation", () => {
    const attrs = makeOmeAttrsWithTransform({
      type: "mapAxis",
      mapAxis: [1, 0, 2],
      output: "physical",
    });
    const metadata = parseOmeMetadata("test://", attrs, 3);
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      new Float64Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    );
  });

  it("should parse an affine transformation", () => {
    const attrs = makeOmeAttrsWithTransform({
      type: "affine",
      affine: [
        [1, 0.4, 0.1, 4.5],
        [0.1, 0.8, 0.4, 6.9],
        [0.3, 0.2, 0.9, 8.1],
      ],
      output: "physical",
    });
    const metadata = parseOmeMetadata("test://", attrs, 3);
    // We need to back the scale out of the affine matrix
    // That scale is the lengths of the column vectors
    const expectedScales = [
      Math.sqrt(1 * 1 + 0.1 * 0.1 + 0.3 * 0.3),
      Math.sqrt(0.4 * 0.4 + 0.8 * 0.8 + 0.2 * 0.2),
      Math.sqrt(0.1 * 0.1 + 0.4 * 0.4 + 0.9 * 0.9),
    ];
    const scales = metadata!.multiscale.coordinateSpace.scales;
    expect(scales[0]).toBeCloseTo(expectedScales[0] * 1e-6);
    expect(scales[1]).toBeCloseTo(expectedScales[1] * 1e-6);
    expect(scales[2]).toBeCloseTo(expectedScales[2] * 1e-6);
    // Each scale factor should be applied along the column, and separately
    // to the translation
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      new Float64Array([
        1 / expectedScales[0],
        0.1 / expectedScales[0],
        0.3 / expectedScales[0],
        0,
        0.4 / expectedScales[1],
        0.8 / expectedScales[1],
        0.2 / expectedScales[1],
        0,
        0.1 / expectedScales[2],
        0.4 / expectedScales[2],
        0.9 / expectedScales[2],
        0,
        4.5 / expectedScales[0],
        6.9 / expectedScales[1],
        8.1 / expectedScales[2],
        1,
      ]),
    );
  });

  it("should combine transforms in a sequence", () => {
    const attrs = makeOmeAttrsWithTransform({
      type: "sequence",
      output: "physical",
      input: "array",
      transformations: [
        { type: "scale", scale: [2, 3, 4] },
        { type: "translation", translation: [20, 30, 40] },
        {
          type: "rotation",
          rotation: [
            [0, 1, 0],
            [0, 0, 1],
            [1, 0, 0],
          ],
        },
      ],
    });
    const metadata = parseOmeMetadata("test://", attrs, 3);
    // After scale + translation, the affine is (row-major):
    // [2, 0, 0, 20], [0, 3, 0, 30], [0, 0, 4, 40], [0, 0, 0, 1]
    // After applying rotation R = [[0,1,0],[0,0,1],[1,0,0]]:
    // [0, 3, 0, 30], [0, 0, 4, 40], [2, 0, 0, 20], [0, 0, 0, 1]
    // baseScales = column norms = [2, 3, 4].
    // baseTransformScaled = combined affine with each column c divided by baseScales[c].
    // Linear part becomes a pure rotation matrix.
    // Translation: rotation applies to [20,30,40] giving [30,40,20], then row i divided
    // by baseScales[i]: [30/2, 40/3, 20/4] = [15, 40/3, 5].
    const expectedScales = [2, 3, 4];
    const scales = metadata!.multiscale.coordinateSpace.scales;
    expect(scales[0]).toBeCloseTo(expectedScales[0] * 1e-6);
    expect(scales[1]).toBeCloseTo(expectedScales[1] * 1e-6);
    expect(scales[2]).toBeCloseTo(expectedScales[2] * 1e-6);
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      new Float64Array([0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 15, 40 / 3, 5, 1]),
    );
  });

  it("should respect transforms order in a sequence", () => {
    const attrs = makeOmeAttrsWithTwoTransforms(
      {
        type: "scale",
        output: "physical",
        input: "array",
        scale: [2, 3, 4],
      },
      {
        type: "sequence",
        output: "world",
        input: "physical",
        transformations: [
          {
            type: "rotation",
            rotation: [
              [0, 1, 0],
              [0, 0, 1],
              [1, 0, 0],
            ],
          },
          { type: "translation", translation: [20, 30, 40] },
        ],
      },
    );
    const metadata = parseOmeMetadata("test://", attrs, 3);
    // After scale + rotation, the affine is (row-major):
    // [0, 3, 0, 0], [0, 0, 4, 0], [2, 0, 0, 0], [0, 0, 0, 1]
    // After applying translation, the affine is (row-major):
    // [0, 3, 0, 20], [0, 0, 4, 30], [2, 0, 0, 40], [0, 0, 0, 1]
    // baseScales = column norms = [2, 3, 4].
    // baseTransformScaled = combined affine with each column c divided by baseScales[c].
    // Linear part becomes a pure rotation matrix.
    // Translation: [20, 30, 40] then element i divided
    // by baseScales[i]: [20/2, 30/3, 40/4] = [10, 10, 10].
    const expectedScales = [2, 3, 4];
    const scales = metadata!.multiscale.coordinateSpace.scales;
    expect(scales[0]).toBeCloseTo(expectedScales[0] * 1e-6);
    expect(scales[1]).toBeCloseTo(expectedScales[1] * 1e-6);
    expect(scales[2]).toBeCloseTo(expectedScales[2] * 1e-6);
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      new Float64Array([0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 10, 10, 1]),
    );
  });

  it("should use the last coordinate system if multiple provided", () => {
    const attrs = {
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "multiscales",
            coordinateSystems: [
              {
                name: "first_system",
                axes: [{ type: "space", name: "x", unit: "micrometer" }],
              },
              intrinsicCoordinateSystem,
            ],
            datasets: [
              {
                path: "array",
                coordinateTransformations: [
                  {
                    type: "identity",
                    output: "physical",
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const metadata = parseOmeMetadata("test://", attrs, 3);
    const space = metadata!.multiscale.coordinateSpace;
    expect(space.names).toStrictEqual(["z", "y", "x"]);
    expect(space.units).toStrictEqual(["m", "m", "m"]);
  });

  it("should throw an error for non-supported transformation types", () => {
    const attrs = makeOmeAttrsWithTransform({
      type: "non_existent_transform",
      output: "physical",
    });
    expect(() => parseOmeMetadata("test://", attrs, 3)).toThrow(
      'Error parsing "datasets" property: Unsupported coordinate transform type: "non_existent_transform"',
    );
  });
});

describe("OME-Zarr 0.6 multiscale parsing", () => {
  it("should parse multiscale with multiple datasets", () => {
    // Example from https://ngff.openmicroscopy.org/rfc/5
    const attrs = {
      zarr_format: 3,
      node_type: "group",
      attributes: {
        ome: {
          version: "0.5",
          multiscales: [
            {
              name: "example",
              coordinateSystems: [
                {
                  name: "intrinsic",
                  axes: [
                    { name: "t", type: "time", unit: "millisecond" },
                    { name: "c", type: "channel" },
                    { name: "z", type: "space", unit: "micrometer" },
                    { name: "y", type: "space", unit: "micrometer" },
                    { name: "x", type: "space", unit: "micrometer" },
                  ],
                },
              ],
              datasets: [
                {
                  path: "0",
                  coordinateTransformations: [
                    {
                      // the voxel size for the first scale level (0.5 micrometer)
                      // and the time unit (0.1 milliseconds), which is the same for each scale level
                      type: "scale",
                      scale: [0.1, 1.0, 0.5, 0.5, 0.5],
                      input: "0",
                      output: "intrinsic",
                    },
                  ],
                },
                {
                  path: "1",
                  coordinateTransformations: [
                    {
                      // the voxel size for the second scale level (downscaled by a factor of 2 -> 1 micrometer)
                      // and the time unit (0.1 milliseconds), which is the same for each scale level
                      type: "scale",
                      scale: [0.1, 1.0, 1.0, 1.0, 1.0],
                      input: "1",
                      output: "intrinsic",
                    },
                  ],
                },
                {
                  path: "2",
                  coordinateTransformations: [
                    {
                      // the voxel size for the third scale level (downscaled by a factor of 4 -> 2 micrometer)
                      // and the time unit (0.1 milliseconds), which is the same for each scale level
                      type: "scale",
                      scale: [0.1, 1.0, 2.0, 2.0, 2.0],
                      input: "2",
                      output: "intrinsic",
                    },
                  ],
                },
              ],
              type: "gaussian",
              metadata: {
                description:
                  "the fields in metadata depend on the downscaling implementation. Here, the parameters passed to the skimage function are given",
                method: "skimage.transform.pyramid_gaussian",
                version: "0.16.1",
                args: "[true]",
                kwargs: { multichannel: true },
              },
            },
          ],
        },
      },
    };
    const metadata = parseOmeMetadata("test://", attrs.attributes, 3);
    // The base transform should just be the identity
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      createIdentity(Float64Array, 6),
    );
    // The scales should be extracted from the base transform
    const expectedScales = [
      1e-4, // 0.1 millisecond in seconds
      1, // channel has no unit
      5e-7, // 0.5 micrometer in meters
      5e-7, // 0.5 micrometer in meters
      5e-7, // 0.5 micrometer in meters
    ];
    const scales = metadata!.multiscale.coordinateSpace.scales;
    expect(scales).toHaveLength(5);
    for (let i = 0; i < scales.length; i++) {
      expect(scales[i]).toBeCloseTo(expectedScales[i]);
    }

    // Now for the scale transforms in the multiscales
    // The first level should be essentially the identity,
    // but with the half voxel shift in the translation
    const scaleTransforms = metadata!.multiscale.scales;
    expect(scaleTransforms).toHaveLength(3);
    const firstLevelTransform = createIdentity(Float64Array, 6);
    for (let i = 0; i < 5; i++) {
      firstLevelTransform[30 + i] = -0.5;
    }
    expect(scaleTransforms[0].transform).toStrictEqual(firstLevelTransform);

    // The second level needs to account for the 2x downsampling in spatial dims
    // The first two columns are unchanged (time and channel), the rest are scaled by 2.0
    const secondLevelTransform = createIdentity(Float64Array, 6);
    for (let i = 0; i < 5; i++) {
      secondLevelTransform[30 + i] = -0.5;
    }
    for (let i = 2; i < 6; i++) {
      for (let j = 2; j < 5; j++) {
        secondLevelTransform[6 * i + j] *= 2.0;
      }
    }
    expect(scaleTransforms[1].transform).toStrictEqual(secondLevelTransform);

    // The third level needs to account for the 4x downsampling in spatial dims
    // The first two columns are unchanged (time and channel), the rest are scaled by 4.0
    const thirdLevelTransform = createIdentity(Float64Array, 6);
    for (let i = 0; i < 5; i++) {
      thirdLevelTransform[30 + i] = -0.5;
    }
    for (let i = 2; i < 6; i++) {
      for (let j = 2; j < 5; j++) {
        thirdLevelTransform[6 * i + j] *= 4.0;
      }
    }
    expect(scaleTransforms[2].transform).toStrictEqual(thirdLevelTransform);
  });
});

describe("OME-Zarr 0.6 sequence transformation validation", () => {
  it("should validate sequence transform with correct input/output", () => {
    const attrs = {
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "multiscales",
            coordinateSystems: [intrinsicCoordinateSystem],
            datasets: [
              {
                path: "array",
                coordinateTransformations: [
                  {
                    type: "sequence",
                    output: "physical",
                    input: "array",
                    transformations: [
                      { type: "scale", scale: [4, 3, 2] },
                      { type: "translation", translation: [32, 21, 10] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // This should not throw an error
    expect(() => parseOmeMetadata("test://", attrs, 3)).not.toThrow();
  });

  it("should accept transforms with empty string input/output (optional fields)", () => {
    const attrs = {
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "multiscales",
            coordinateSystems: [intrinsicCoordinateSystem],
            datasets: [
              {
                path: "s0",
                coordinateTransformations: [
                  {
                    type: "scale",
                    output: "physical",
                    input: "", // Empty string means not specified
                    scale: [4, 3, 2],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // This should not throw an error - empty strings are treated as "not specified"
    expect(() => parseOmeMetadata("test://", attrs, 3)).not.toThrow();
  });

  it("should reject sequence transform with wrong output coordinate system", () => {
    const attrs = {
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "multiscales",
            coordinateSystems: [intrinsicCoordinateSystem],
            datasets: [
              {
                path: "array",
                coordinateTransformations: [
                  {
                    type: "sequence",
                    output: "wrong_system",
                    input: "array",
                    transformations: [{ type: "scale", scale: [4, 3, 2] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // This should throw an error
    expect(() => parseOmeMetadata("test://", attrs, 3)).toThrow(
      /output is "wrong_system" but expected "physical"/,
    );
  });

  it("should reject sequence transform with wrong input", () => {
    const attrs = {
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "multiscales",
            coordinateSystems: [intrinsicCoordinateSystem],
            datasets: [
              {
                path: "array",
                coordinateTransformations: [
                  {
                    type: "sequence",
                    output: "physical",
                    input: "wrong_path",
                    transformations: [{ type: "scale", scale: [4, 3, 2] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // This should throw an error
    expect(() => parseOmeMetadata("test://", attrs, 3)).toThrow(
      /input is "wrong_path" but expected "array"/,
    );
  });

  it("should reject nested sequence transforms", () => {
    const attrs = {
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "multiscales",
            coordinateSystems: [intrinsicCoordinateSystem],
            datasets: [
              {
                path: "array",
                coordinateTransformations: [
                  {
                    type: "sequence",
                    output: "physical",
                    input: "array",
                    transformations: [
                      {
                        type: "sequence",
                        transformations: [{ type: "scale", scale: [4, 3, 2] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // This should throw an error
    expect(() => parseOmeMetadata("test://", attrs, 3)).toThrow(
      /sequence transformation MUST NOT be part of another sequence transformation/,
    );
  });

  it("should validate chaining of inner transforms in sequence", () => {
    const attrs = {
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "multiscales",
            coordinateSystems: [
              {
                name: "intermediate",
                axes: [
                  { type: "space", name: "z", unit: "micrometer" },
                  { type: "space", name: "y", unit: "micrometer" },
                  { type: "space", name: "x", unit: "micrometer" },
                ],
              },
              intrinsicCoordinateSystem,
            ],
            datasets: [
              {
                path: "array",
                coordinateTransformations: [
                  {
                    type: "sequence",
                    output: "physical",
                    input: "array",
                    transformations: [
                      {
                        type: "scale",
                        scale: [4, 3, 2],
                        input: "array",
                        output: "intermediate",
                      },
                      {
                        type: "translation",
                        translation: [32, 21, 10],
                        input: "intermediate",
                        output: "physical",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // This should not throw an error as the chain is valid
    expect(() => parseOmeMetadata("test://", attrs, 3)).not.toThrow();
  });

  it("should reject broken chain in sequence transforms", () => {
    const attrs = {
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "multiscales",
            coordinateSystems: [
              {
                name: "intermediate",
                axes: [
                  { type: "space", name: "z", unit: "micrometer" },
                  { type: "space", name: "y", unit: "micrometer" },
                  { type: "space", name: "x", unit: "micrometer" },
                ],
              },
              intrinsicCoordinateSystem,
            ],
            datasets: [
              {
                path: "array",
                coordinateTransformations: [
                  {
                    type: "sequence",
                    output: "physical",
                    input: "array",
                    transformations: [
                      {
                        type: "scale",
                        scale: [4, 3, 2],
                        input: "array",
                        output: "intermediate",
                      },
                      {
                        type: "translation",
                        translation: [32, 21, 10],
                        input: "wrong_system", // Wrong input - doesn't match previous output
                        output: "physical",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // This should throw an error as the chain is broken
    expect(() => parseOmeMetadata("test://", attrs, 3)).toThrow(
      /transform 0 has output "intermediate" but transform 1 has input "wrong_system"/,
    );
  });
});

describe("OME-Zarr version-gated transform behavior (issue #905)", () => {
  it("should produce identity baseTransform for v0.4 with scale+translation", () => {
    // v0.4 uses the old behavior: identity base transform, translations baked into per-scale transforms
    const attrs = {
      multiscales: [
        {
          version: "0.4",
          axes: [
            { type: "space", name: "z", unit: "micrometer" },
            { type: "space", name: "y", unit: "micrometer" },
            { type: "space", name: "x", unit: "micrometer" },
          ],
          datasets: [
            {
              path: "0",
              coordinateTransformations: [
                { type: "scale", scale: [2, 2, 2] },
                { type: "translation", translation: [100, 200, 300] },
              ],
            },
          ],
        },
      ],
    };
    const metadata = parseOmeMetadata("test://", attrs, 2);
    expect(metadata).not.toBeUndefined();

    // baseTransform should be identity for v0.4
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      createIdentity(Float64Array, 4),
    );

    // The per-scale transform should have the translation baked in,
    // divided by the base scales (which are [2, 2, 2])
    const t = metadata!.multiscale.scales[0].transform;
    // Diagonal should be 1 (2/2 = 1 for each axis)
    expect(t[0]).toBeCloseTo(1); // z scale / baseScale_z
    expect(t[5]).toBeCloseTo(1); // y scale / baseScale_y
    expect(t[10]).toBeCloseTo(1); // x scale / baseScale_x

    // Translation column: (translation - halfVoxelOffset) / baseScale
    // Half voxel offset for scale [2,2,2] is [1,1,1] (scale * 0.5)
    // So translation column = (100-1)/2, (200-1)/2, (300-1)/2
    expect(t[12]).toBeCloseTo((100 - 1) / 2);
    expect(t[13]).toBeCloseTo((200 - 1) / 2);
    expect(t[14]).toBeCloseTo((300 - 1) / 2);
  });

  it("should handle v0.4 with multiple scales correctly", () => {
    const attrs = {
      multiscales: [
        {
          version: "0.4",
          axes: [
            { type: "space", name: "y", unit: "micrometer" },
            { type: "space", name: "x", unit: "micrometer" },
          ],
          datasets: [
            {
              path: "0",
              coordinateTransformations: [
                { type: "scale", scale: [1, 1] },
                { type: "translation", translation: [10, 20] },
              ],
            },
            {
              path: "1",
              coordinateTransformations: [
                { type: "scale", scale: [2, 2] },
                { type: "translation", translation: [10, 20] },
              ],
            },
            {
              path: "2",
              coordinateTransformations: [
                { type: "scale", scale: [4, 4] },
                { type: "translation", translation: [10, 20] },
              ],
            },
          ],
        },
      ],
    };
    const metadata = parseOmeMetadata("test://", attrs, 2);
    expect(metadata).not.toBeUndefined();

    // baseTransform should be identity for v0.4
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      createIdentity(Float64Array, 3),
    );

    // Base scales extracted from first scale level: [1, 1]
    const baseScales = metadata!.multiscale.baseInfo.baseScales;
    expect(baseScales[0]).toBeCloseTo(1);
    expect(baseScales[1]).toBeCloseTo(1);

    const scaleTransforms = metadata!.multiscale.scales;
    expect(scaleTransforms).toHaveLength(3);

    // First level: scale [1,1], translation [10,20]
    // Half voxel offset: [0.5, 0.5]
    // translation column = (10-0.5)/1, (20-0.5)/1 = 9.5, 19.5
    const t0 = scaleTransforms[0].transform;
    expect(t0[0]).toBeCloseTo(1); // scale_y / baseScale_y
    expect(t0[4]).toBeCloseTo(1); // scale_x / baseScale_x
    expect(t0[6]).toBeCloseTo(9.5);
    expect(t0[7]).toBeCloseTo(19.5);

    // Second level: scale [2,2], translation [10,20]
    // Half voxel offset: [1, 1]
    // translation column = (10-1)/1, (20-1)/1 = 9, 19
    const t1 = scaleTransforms[1].transform;
    expect(t1[0]).toBeCloseTo(2); // scale_y / baseScale_y
    expect(t1[4]).toBeCloseTo(2); // scale_x / baseScale_x
    expect(t1[6]).toBeCloseTo(9);
    expect(t1[7]).toBeCloseTo(19);

    // Third level: scale [4,4], translation [10,20]
    // Half voxel offset: [2, 2]
    // translation column = (10-2)/1, (20-2)/1 = 8, 18
    const t2 = scaleTransforms[2].transform;
    expect(t2[0]).toBeCloseTo(4); // scale_y / baseScale_y
    expect(t2[4]).toBeCloseTo(4); // scale_x / baseScale_x
    expect(t2[6]).toBeCloseTo(8);
    expect(t2[7]).toBeCloseTo(18);
  });

  it("should surface baseTransform for v0.6 with scale+translation", () => {
    // v0.6 uses the new behavior: surfaced baseTransformScaled as model transform
    const attrs = {
      ome: {
        version: "0.6",
        multiscales: [
          {
            name: "multiscales",
            coordinateSystems: [intrinsicCoordinateSystem],
            datasets: [
              {
                path: "array",
                coordinateTransformations: [
                  {
                    type: "sequence",
                    output: "physical",
                    transformations: [
                      { type: "scale", scale: [2, 2, 2] },
                      { type: "translation", translation: [100, 200, 300] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const metadata = parseOmeMetadata("test://", attrs, 3);
    expect(metadata).not.toBeUndefined();

    // baseTransform should NOT be identity for v0.6 — it should contain
    // the translation (divided by base scales)
    const bt = metadata!.multiscale.baseInfo.baseTransform;
    expect(bt).not.toStrictEqual(createIdentity(Float64Array, 4));

    // The translation column of the base transform should contain
    // the base translation divided by base scales (before half voxel shift)
    // Base scales are [2, 2, 2]
    // baseTransformScaled is computed before half-voxel shift
    // translation / baseScale = [100/2, 200/2, 300/2] = [50, 100, 150]
    expect(bt[12]).toBeCloseTo(50);
    expect(bt[13]).toBeCloseTo(100);
    expect(bt[14]).toBeCloseTo(150);
  });

  it("should preserve tile positions for multi-tile v0.4 datasets", () => {
    // Simulate two tiles at different spatial locations, both using v0.4
    // This is the scenario that broke when #876 changed the default behavior
    const makeTileAttrs = (tx: number, ty: number) => ({
      multiscales: [
        {
          version: "0.4",
          axes: [
            { type: "space", name: "y", unit: "micrometer" },
            { type: "space", name: "x", unit: "micrometer" },
          ],
          datasets: [
            {
              path: "0",
              coordinateTransformations: [
                { type: "scale", scale: [1, 1] },
                { type: "translation", translation: [ty, tx] },
              ],
            },
          ],
        },
      ],
    });

    const tile1 = parseOmeMetadata("test://tile1/", makeTileAttrs(0, 0), 2);
    const tile2 = parseOmeMetadata(
      "test://tile2/",
      makeTileAttrs(1000, 2000),
      2,
    );

    expect(tile1).not.toBeUndefined();
    expect(tile2).not.toBeUndefined();

    // Both tiles should have identity base transforms (old behavior)
    expect(tile1!.multiscale.baseInfo.baseTransform).toStrictEqual(
      createIdentity(Float64Array, 3),
    );
    expect(tile2!.multiscale.baseInfo.baseTransform).toStrictEqual(
      createIdentity(Float64Array, 3),
    );

    // Translations should be baked into per-scale transforms
    const t1 = tile1!.multiscale.scales[0].transform;
    const t2 = tile2!.multiscale.scales[0].transform;

    // Tile1 at origin: half voxel offset = [0.5, 0.5]
    // translation column = (0-0.5)/1, (0-0.5)/1 = -0.5, -0.5
    expect(t1[6]).toBeCloseTo(-0.5);
    expect(t1[7]).toBeCloseTo(-0.5);

    // Tile2 at (2000, 1000): half voxel offset = [0.5, 0.5]
    // translation column = (2000-0.5)/1, (1000-0.5)/1 = 1999.5, 999.5
    expect(t2[6]).toBeCloseTo(1999.5);
    expect(t2[7]).toBeCloseTo(999.5);
  });

  it("should produce identity baseTransform for v0.5-dev", () => {
    const attrs = {
      multiscales: [
        {
          version: "0.5-dev",
          axes: [
            { type: "space", name: "y", unit: "micrometer" },
            { type: "space", name: "x", unit: "micrometer" },
          ],
          datasets: [
            {
              path: "0",
              coordinateTransformations: [
                { type: "scale", scale: [2, 2] },
                { type: "translation", translation: [50, 100] },
              ],
            },
          ],
        },
      ],
    };
    const metadata = parseOmeMetadata("test://", attrs, 2);
    expect(metadata).not.toBeUndefined();

    // v0.5-dev should use old behavior (identity base transform)
    expect(metadata!.multiscale.baseInfo.baseTransform).toStrictEqual(
      createIdentity(Float64Array, 3),
    );
  });
});

it("should handle anisotropic scales with rotations for 0.6 (issue #952)", () => {
  const attrs = {
    ome: {
      version: "0.6",
      multiscales: [
        {
          coordinateSystems: [
            {
              name: "world",
              axes: [
                { name: "z", type: "space", unit: "micrometer" },
                { name: "y", type: "space", unit: "micrometer" },
                { name: "x", type: "space", unit: "micrometer" },
              ],
            },
            {
              name: "physical",
              axes: [
                { name: "z", type: "space", unit: "micrometer" },
                { name: "y", type: "space", unit: "micrometer" },
                { name: "x", type: "space", unit: "micrometer" },
              ],
            },
          ],
          datasets: [
            {
              path: "array",
              coordinateTransformations: [
                {
                  type: "sequence",
                  input: "array",
                  output: "physical",
                  transformations: [
                    { type: "scale", scale: [2.0, 0.5, 0.25] },
                    { type: "translation", translation: [0, 0, 0] },
                  ],
                },
              ],
            },
          ],
          coordinateTransformations: [
            {
              type: "affine",
              input: "physical",
              output: "world",
              affine: [
                [-0.7071, -0.7071, 0, 0],
                [0.7071, -0.7071, 0, 0],
                [0, 0, 1, 0],
              ],
            },
          ],
        },
      ],
    },
  };
  const metadata = parseOmeMetadata("test://", attrs, 3);
  expect(metadata).not.toBeUndefined();
  const scales = metadata!.multiscale.coordinateSpace.scales;
  expect(scales[0]).toBeCloseTo(2 * 1e-6);
  expect(scales[1]).toBeCloseTo(0.5 * 1e-6);
  expect(scales[2]).toBeCloseTo(0.25 * 1e-6);

  const baseTransform = metadata!.multiscale.baseInfo.baseTransform;
  // Column 1 - [-0.7071, 0.7071, 0, 0]
  expect(baseTransform[0]).toBeCloseTo(-0.7071);
  expect(baseTransform[1]).toBeCloseTo(0.7071);
  expect(baseTransform[2]).toEqual(0);
  expect(baseTransform[3]).toEqual(0);
  // Column 2 - [0.7071, -0.7071, 0, 0]
  expect(baseTransform[4]).toBeCloseTo(-0.7071);
  expect(baseTransform[5]).toBeCloseTo(-0.7071);
  expect(baseTransform[6]).toEqual(0);
  expect(baseTransform[7]).toEqual(0);
  // Column 3 - [0, 0, 1, 0]
  expect(baseTransform.slice(8, 12)).toEqual(new Float64Array([0, 0, 1, 0]));
  // Column 4 - [0, 0, 0, 1]
  expect(baseTransform.slice(12)).toEqual(new Float64Array([0, 0, 0, 1]));
});
