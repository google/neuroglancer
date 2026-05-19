/**
 * @license
 * Copyright 2022 Google Inc.
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

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import type {
  SingleChannelMetadata,
  ChannelMetadata,
} from "#src/datasource/index.js";
import {
  joinBaseUrlAndPath,
  kvstoreEnsureDirectoryPipelineUrl,
} from "#src/kvstore/url.js";
import {
  makeAffineRelativeToBaseTransform,
  extractScalesFromAffineMatrix,
} from "#src/util/affine.js";
import { parseRGBColorSpecification } from "#src/util/color.js";
import {
  parseArray,
  parseFixedLengthArray,
  verifyBoolean,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { clampToInterval } from "#src/util/lerp.js";
import * as matrix from "#src/util/matrix.js";
import { allSiPrefixes } from "#src/util/si_units.js";

export interface OmeMultiscaleScale {
  url: string;
  transform: Float64Array;
}

export interface OmeMultiscaleMetadata {
  scales: OmeMultiscaleScale[];
  coordinateSpace: CoordinateSpace;
  baseInfo: {
    baseScales: Float64Array;
    baseTransform: Float64Array;
  };
}

export interface OmeMetadata {
  multiscale: OmeMultiscaleMetadata;
  channels: ChannelMetadata | undefined;
}

const SUPPORTED_OME_MULTISCALE_VERSIONS = new Set([
  "0.4",
  "0.5-dev",
  "0.5",
  "0.6.dev1",
  "0.6.dev3",
  "0.6",
]);

const OME_UNITS = new Map<string, { unit: string; scale: number }>([
  ["angstrom", { unit: "m", scale: 1e-10 }],
  ["foot", { unit: "m", scale: 0.3048 }],
  ["inch", { unit: "m", scale: 0.0254 }],
  ["mile", { unit: "m", scale: 1609.34 }],
  // eslint-disable-next-line no-loss-of-precision
  ["parsec", { unit: "m", scale: 3.0856775814913673e16 }],
  ["yard", { unit: "m", scale: 0.9144 }],
  ["minute", { unit: "s", scale: 60 }],
  ["hour", { unit: "s", scale: 60 * 60 }],
  ["day", { unit: "s", scale: 60 * 60 * 24 }],
]);

for (const unit of ["meter", "second"]) {
  for (const siPrefix of allSiPrefixes) {
    const { longPrefix } = siPrefix;
    if (longPrefix === undefined) continue;
    OME_UNITS.set(`${longPrefix}${unit}`, {
      unit: unit[0],
      scale: 10 ** siPrefix.exponent,
    });
  }
}

interface Axis {
  name: string;
  unit: string;
  scale: number;
  type: string | undefined;
}

function parseOmeroChannel(omeroChannel: unknown): SingleChannelMetadata {
  verifyObject(omeroChannel);

  const getProp = <T>(
    key: string,
    verifier: (value: unknown) => T,
  ): T | undefined => verifyOptionalObjectProperty(omeroChannel, key, verifier);
  const inputWindow = getProp("window", verifyObject);
  const getWindowProp = <T>(
    key: string,
    verifier: (value: unknown) => T,
  ): T | undefined =>
    inputWindow
      ? verifyOptionalObjectProperty(inputWindow, key, verifier)
      : undefined;

  const active = getProp("active", verifyBoolean);
  const coefficient = getProp("coefficient", verifyFiniteFloat);
  let colorString = getProp("color", verifyString);
  // If six hex digits, needs the # in front of the hex color
  if (colorString && /^[0-9a-f]{6}$/i.test(colorString)) {
    colorString = `#${colorString}`;
  }
  const color = parseRGBColorSpecification(colorString);
  const inverted = getProp("inverted", verifyBoolean);
  const label = getProp("label", verifyString);

  const windowMin = getWindowProp("min", verifyFiniteFloat);
  const windowMax = getWindowProp("max", verifyFiniteFloat);
  const windowStart = getWindowProp("start", verifyFiniteFloat);
  const windowEnd = getWindowProp("end", verifyFiniteFloat);

  const window =
    windowMin !== undefined && windowMax !== undefined
      ? ([windowMin, windowMax] as [number, number])
      : undefined;

  const range =
    windowStart !== undefined && windowEnd !== undefined
      ? inverted
        ? ([windowEnd, windowStart] as [number, number])
        : ([windowStart, windowEnd] as [number, number])
      : undefined;
  // If there is a window, then clamp the range to the window.
  if (window !== undefined && range !== undefined) {
    range[0] = clampToInterval(window, range[0]) as number;
    range[1] = clampToInterval(window, range[1]) as number;
  }

  return {
    active,
    label,
    color,
    coefficient,
    range,
    window,
  };
}

function parseOmeroMetadata(omero: unknown): ChannelMetadata {
  verifyObject(omero);
  const name = verifyOptionalObjectProperty(omero, "name", verifyString);
  const channels = verifyObjectProperty(omero, "channels", (x) =>
    parseArray(x, parseOmeroChannel),
  );

  return { name, channels };
}

function parseOmeAxis(axis: unknown): Axis {
  verifyObject(axis);
  const name = verifyObjectProperty(axis, "name", verifyString);
  const type = verifyOptionalObjectProperty(axis, "type", verifyString);
  const parsedUnit = verifyOptionalObjectProperty(
    axis,
    "unit",
    (unit) => {
      const x = OME_UNITS.get(unit);
      if (x === undefined) {
        throw new Error(`Unsupported unit: ${JSON.stringify(unit)}`);
      }
      return x;
    },
    { unit: "", scale: 1 },
  );
  return { name, unit: parsedUnit.unit, scale: parsedUnit.scale, type };
}

function parseOmeAxes(axes: unknown): CoordinateSpace {
  const parsedAxes = parseArray(axes, parseOmeAxis);
  return makeCoordinateSpace({
    names: parsedAxes.map((axis) => {
      const { name, type } = axis;
      if (type === "channel") {
        return `${name}'`;
      }
      return name;
    }),
    scales: Float64Array.from(parsedAxes, (axis) => axis.scale),
    units: parsedAxes.map((axis) => axis.unit),
  });
}

function parseOmeCoordinateSystem(coordinateSystem: unknown): CoordinateSpace {
  verifyObject(coordinateSystem);
  const axes = verifyObjectProperty(coordinateSystem, "axes", (x) =>
    parseArray(x, parseOmeAxis),
  );
  return makeCoordinateSpace({
    names: axes.map((axis) => {
      const { name, type } = axis;
      if (type === "channel") {
        return `${name}'`;
      }
      return name;
    }),
    scales: Float64Array.from(axes, (axis) => axis.scale),
    units: axes.map((axis) => axis.unit),
  });
}

function parseScaleTransform(rank: number, obj: unknown) {
  const scales = verifyObjectProperty(obj, "scale", (values) =>
    parseFixedLengthArray(
      new Float64Array(rank),
      values,
      verifyFinitePositiveFloat,
    ),
  );
  return matrix.createHomogeneousScaleMatrix(Float64Array, scales);
}

function parseIdentityTransform(rank: number, obj: unknown) {
  obj;
  return matrix.createIdentity(Float64Array, rank + 1);
}

function parseTranslationTransform(rank: number, obj: unknown) {
  const translation = verifyObjectProperty(obj, "translation", (values) =>
    parseFixedLengthArray(new Float64Array(rank), values, verifyFiniteFloat),
  );
  return matrix.createHomogeneousTranslationMatrix(Float64Array, translation);
}

function parseAffineTransform(rank: number, obj: unknown) {
  const affineMatrix = verifyObjectProperty(obj, "affine", (values) => {
    const parsed = parseArray(values, (row) =>
      parseFixedLengthArray(new Float64Array(rank + 1), row, verifyFiniteFloat),
    );
    if (parsed.length !== rank) {
      throw new Error(
        `Expected affine matrix to have ${rank} rows, but received: ${parsed.length}`,
      );
    }
    return parsed;
  });
  // Convert to homogeneous matrix format (rank+1 x rank+1)
  const transform = matrix.createIdentity(Float64Array, rank + 1);
  for (let i = 0; i < rank; ++i) {
    for (let j = 0; j <= rank; ++j) {
      transform[j * (rank + 1) + i] = affineMatrix[i][j];
    }
  }
  return transform;
}

function parseRotationTransform(rank: number, obj: unknown) {
  const rotationMatrix = verifyObjectProperty(obj, "rotation", (values) => {
    const parsed = parseArray(values, (row) =>
      parseFixedLengthArray(new Float64Array(rank), row, verifyFiniteFloat),
    );
    if (parsed.length !== rank) {
      throw new Error(
        `Expected rotation matrix to have ${rank} rows, but received: ${parsed.length}`,
      );
    }
    return parsed;
  });
  // Convert to homogeneous matrix format (rank+1 x rank+1)
  const transform = matrix.createIdentity(Float64Array, rank + 1);
  for (let i = 0; i < rank; ++i) {
    for (let j = 0; j < rank; ++j) {
      transform[j * (rank + 1) + i] = rotationMatrix[i][j];
    }
  }
  return transform;
}

function parseMapAxisTransform(rank: number, obj: unknown) {
  const mapAxis = verifyObjectProperty(obj, "mapAxis", (values) =>
    parseFixedLengthArray(new Float64Array(rank), values, (x) => {
      const val = verifyFiniteFloat(x);
      if (!Number.isInteger(val) || val < 0 || val >= rank) {
        throw new Error(
          `Invalid mapAxis index: ${val}. Must be integer between 0 and ${
            rank - 1
          }`,
        );
      }
      return val;
    }),
  );

  // Verify permutation
  const seen = new Set<number>();
  for (const val of mapAxis) {
    if (seen.has(val)) {
      throw new Error(`Duplicate axis index in mapAxis: ${val}`);
    }
    seen.add(val);
  }

  const transform = new Float64Array((rank + 1) * (rank + 1));
  // Set the bottom right value of the matrix to 1
  transform[transform.length - 1] = 1;

  // The value at position `i` in the array indicates which input axis becomes the `i`-th output axis.
  // Output[i] = Input[mapAxis[i]]
  // So Row i has a 1 at Column mapAxis[i]
  for (let i = 0; i < rank; ++i) {
    transform[mapAxis[i] * (rank + 1) + i] = 1;
  }
  return transform;
}

function parseSequenceTransform(rank: number, obj: unknown) {
  verifyObject(obj);

  const transformations = verifyObjectProperty(
    obj,
    "transformations",
    (x) => x,
  );

  // Validate that inner transformations don't contain nested sequences
  if (Array.isArray(transformations)) {
    parseArray(transformations, (innerTransform) => {
      verifyObject(innerTransform);
      const innerType = verifyObjectProperty(
        innerTransform,
        "type",
        verifyString,
      );
      if (innerType === "sequence") {
        throw new Error(
          "A sequence transformation MUST NOT be part of another sequence transformation",
        );
      }
    });
  }

  return parseOmeCoordinateTransforms(rank, transformations);
}

const coordinateTransformParsers = new Map([
  ["identity", parseIdentityTransform],
  ["scale", parseScaleTransform],
  ["translation", parseTranslationTransform],
  ["rotation", parseRotationTransform],
  ["mapAxis", parseMapAxisTransform],
  ["affine", parseAffineTransform],
  ["sequence", parseSequenceTransform],
]);

function parseOmeCoordinateTransform(
  rank: number,
  transformJson: unknown,
): Float64Array<ArrayBuffer> {
  verifyObject(transformJson);
  const transformType = verifyObjectProperty(
    transformJson,
    "type",
    verifyString,
  );
  const parser = coordinateTransformParsers.get(transformType);
  if (parser === undefined) {
    throw new Error(
      `Unsupported coordinate transform type: ${JSON.stringify(transformType)}`,
    );
  }
  return parser(rank, transformJson) as Float64Array<ArrayBuffer>;
}

function parseOmeCoordinateTransforms(
  rank: number,
  transforms: unknown,
): Float64Array {
  let transform = matrix.createIdentity(Float64Array, rank + 1);
  if (transforms === undefined) return transform;
  parseArray(transforms, (transformJson) => {
    const newTransform = parseOmeCoordinateTransform(rank, transformJson);
    transform = matrix.multiply(
      new Float64Array(transform.length) as Float64Array<ArrayBuffer>,
      rank + 1,
      newTransform,
      rank + 1,
      transform,
      rank + 1,
      rank + 1,
      rank + 1,
      rank + 1,
    );
  });
  return transform;
}

function validateCoordinateTransformations(
  transformations: unknown,
  expectedInput: string,
  expectedOutput: string,
  path: string,
) {
  if (!Array.isArray(transformations)) return;

  // For a single transformation or the outermost sequence
  if (transformations.length === 1) {
    const transform = transformations[0];
    verifyObject(transform);

    const input = verifyOptionalObjectProperty(
      transform,
      "input",
      verifyString,
    );
    const output = verifyOptionalObjectProperty(
      transform,
      "output",
      verifyString,
    );
    const type = verifyObjectProperty(transform, "type", verifyString);

    // Validate input matches expected (array path)
    // Empty string or undefined means the field is not specified
    if (input !== undefined && input !== "" && input !== expectedInput) {
      throw new Error(
        `Invalid coordinate transformation for dataset at path "${path}": ` +
          `input is "${input}" but expected "${expectedInput}"`,
      );
    }

    // Validate output matches expected (intrinsic coordinate system)
    // Empty string or undefined means the field is not specified
    if (output !== undefined && output !== "" && output !== expectedOutput) {
      throw new Error(
        `Invalid coordinate transformation for dataset at path "${path}": ` +
          `output is "${output}" but expected "${expectedOutput}"`,
      );
    }

    // For sequence transforms, validate inner transforms
    if (type === "sequence") {
      const innerTransforms = verifyObjectProperty(
        transform,
        "transformations",
        (x) => x,
      );
      if (Array.isArray(innerTransforms)) {
        // Validate the chain of inner transforms
        for (let i = 0; i < innerTransforms.length; i++) {
          const innerTransform = innerTransforms[i];
          verifyObject(innerTransform);

          const innerInput = verifyOptionalObjectProperty(
            innerTransform,
            "input",
            verifyString,
          );
          const innerOutput = verifyOptionalObjectProperty(
            innerTransform,
            "output",
            verifyString,
          );

          // First transform in sequence should have input matching the sequence's input
          if (
            i === 0 &&
            innerInput !== undefined &&
            innerInput !== expectedInput
          ) {
            throw new Error(
              `Invalid sequence transformation for dataset at path "${path}": ` +
                `first inner transform has input "${innerInput}" but expected "${expectedInput}"`,
            );
          }

          // Last transform in sequence should have output matching the sequence's output
          if (
            i === innerTransforms.length - 1 &&
            innerOutput !== undefined &&
            innerOutput !== expectedOutput
          ) {
            throw new Error(
              `Invalid sequence transformation for dataset at path "${path}": ` +
                `last inner transform has output "${innerOutput}" but expected "${expectedOutput}"`,
            );
          }

          // Validate chaining between consecutive transforms
          if (i > 0) {
            const prevTransform = innerTransforms[i - 1];
            verifyObject(prevTransform);
            const prevOutput = verifyOptionalObjectProperty(
              prevTransform,
              "output",
              verifyString,
            );

            if (
              prevOutput !== undefined &&
              innerInput !== undefined &&
              prevOutput !== innerInput
            ) {
              throw new Error(
                `Invalid sequence transformation for dataset at path "${path}": ` +
                  `transform ${i - 1} has output "${prevOutput}" but transform ${i} has input "${innerInput}". ` +
                  `Transforms in a sequence must have matching input/output for consecutive transforms.`,
              );
            }
          }
        }
      }
    }
  }
}

function parseMultiscaleScale(
  rank: number,
  url: string,
  obj: unknown,
  intrinsicCoordinateSystemName: string | undefined,
): OmeMultiscaleScale {
  const path = verifyObjectProperty(obj, "path", verifyString);
  const transformations = verifyObjectProperty(
    obj,
    "coordinateTransformations",
    (x) => x,
  );

  // Validate transformations before parsing (only for 0.6+ with coordinate systems)
  if (intrinsicCoordinateSystemName !== undefined) {
    validateCoordinateTransformations(
      transformations,
      path,
      intrinsicCoordinateSystemName,
      path,
    );
  }

  const transform = parseOmeCoordinateTransforms(rank, transformations);
  const scaleUrl = kvstoreEnsureDirectoryPipelineUrl(
    joinBaseUrlAndPath(url, path),
  );
  return { url: scaleUrl, transform };
}

function parseOmeMultiscale(
  url: string,
  multiscale: unknown,
  version: string,
): OmeMultiscaleMetadata {
  verifyObject(multiscale);

  // Check if using 0.6+ format with coordinateSystems
  let coordinateSpace: CoordinateSpace;
  let intrinsicCoordinateSystemName: string | undefined;

  const coordinateSystemsRaw = verifyOptionalObjectProperty(
    multiscale,
    "coordinateSystems",
    (x) => x,
  );

  if (
    coordinateSystemsRaw !== undefined &&
    Array.isArray(coordinateSystemsRaw) &&
    coordinateSystemsRaw.length > 0
  ) {
    // OME-ZARR 0.6+: Use the last (intrinsic) coordinate system
    const coordinateSystems = parseArray(
      coordinateSystemsRaw,
      parseOmeCoordinateSystem,
    );
    coordinateSpace = coordinateSystems[coordinateSystems.length - 1];

    // Extract the name of the intrinsic coordinate system from the raw object
    const intrinsicCoordinateSystemRaw =
      coordinateSystemsRaw[coordinateSystemsRaw.length - 1];
    verifyObject(intrinsicCoordinateSystemRaw);
    intrinsicCoordinateSystemName = verifyObjectProperty(
      intrinsicCoordinateSystemRaw,
      "name",
      verifyString,
    );
  } else {
    // OME-ZARR 0.4/0.5: Use axes directly
    coordinateSpace = verifyObjectProperty(multiscale, "axes", parseOmeAxes);
  }

  const rank = coordinateSpace.rank;
  const transform = verifyOptionalObjectProperty(
    multiscale,
    "coordinateTransformations",
    (x) => parseOmeCoordinateTransforms(rank, x),
    matrix.createIdentity(Float64Array, rank + 1),
  );
  const scales = verifyObjectProperty(multiscale, "datasets", (obj) =>
    parseArray(obj, (x) => {
      const scale = parseMultiscaleScale(
        rank,
        url,
        x,
        intrinsicCoordinateSystemName,
      );
      scale.transform = matrix.multiply(
        new Float64Array((rank + 1) ** 2) as Float64Array<ArrayBuffer>,
        rank + 1,
        transform,
        rank + 1,
        scale.transform,
        rank + 1,
        rank + 1,
        rank + 1,
        rank + 1,
      );
      return scale;
    }),
  );
  if (scales.length === 0) {
    throw new Error("At least one scale must be specified");
  }

  const baseTransform = scales[0].transform.slice();
  const baseScales = extractScalesFromAffineMatrix(baseTransform, rank);
  for (let i = 0; i < rank; ++i) {
    coordinateSpace.scales[i] *= baseScales[i];
  }

  for (const scale of scales) {
    const t = scale.transform;
    // In OME's coordinate space, the origin of a voxel is its center, while in Neuroglancer it is
    // the "lower" (in coordinates) corner. Translate by the physical size of half a voxel in the
    // current scale.
    for (let i = 0; i < rank; ++i) {
      let offset = 0;
      for (let j = 0; j < rank; ++j) {
        offset += t[j * (rank + 1) + i] * 0.5;
      }
      t[rank * (rank + 1) + i] -= offset;
    }
  }

  const useNewBehavior =
    version !== "0.4" && version !== "0.5-dev" && version !== "0.5";

  if (useNewBehavior) {
    // Current behavior (>= 0.6): per-scale transforms relative to base,
    // baseTransformScaled surfaced as model transform
    // The inverse of the base transform is used in the per-scale
    // calculation of the affine transform to apply on top of the base transform.
    const inverseBaseTransformWithScale = new Float64Array(
      baseTransform.length,
    );
    matrix.inverse(
      inverseBaseTransformWithScale,
      rank + 1,
      baseTransform,
      rank + 1,
      rank + 1,
    );

    // The base transform with scaling removed is used
    // to provide a default transform in the layer source tab
    // and for the bounding box transformation
    // The scaleTransformSubmatrix in getRenderLayerTransform
    // in render_coordinate_transform.ts
    // applies a column-wise scaling, and here we apply the inverse
    // so that the scale is not baked into the base transform
    // For each scale factor i, divide column i by that scale factor
    // excluding the last element of the column (since it is 0)
    // Loop from columns 0 to rank-1 to exclude the column
    // representing the translation component and separately
    // divide the translation element i by scale factor i
    const baseTransformWithoutScale = baseTransform.slice();
    for (let i = 0; i < rank; ++i) {
      for (let j = 0; j < rank; ++j) {
        baseTransformWithoutScale[i * (rank + 1) + j] /= baseScales[i];
      }
      baseTransformWithoutScale[rank * (rank + 1) + i] /= baseScales[i];
    }
    for (const scale of scales) {
      scale.transform = makeAffineRelativeToBaseTransform(
        scale.transform,
        inverseBaseTransformWithScale,
        rank,
      );
    }
    return {
      coordinateSpace,
      scales,
      baseInfo: { baseScales, baseTransform: baseTransformWithoutScale },
    };
  } else {
    // Old behavior (< 0.6): identity base transform, translations
    // baked into per-scale transforms via simple diagonal division.
    for (const scale of scales) {
      const t = scale.transform;
      for (let i = 0; i < rank; ++i) {
        for (let j = 0; j <= rank; ++j) {
          t[j * (rank + 1) + i] /= baseScales[i];
        }
      }
    }
    return {
      coordinateSpace,
      scales,
      baseInfo: {
        baseScales,
        baseTransform: matrix.createIdentity(Float64Array, rank + 1),
      },
    };
  }
}

export function parseOmeMetadata(
  url: string,
  attrs: any,
  zarrVersion: number,
): OmeMetadata | undefined {
  const ome = attrs.ome;
  const multiscales = ome == undefined ? attrs.multiscales : ome.multiscales; // >0.4
  const omero = attrs.omero;

  if (!Array.isArray(multiscales)) return undefined;
  const errors: string[] = [];
  for (const multiscale of multiscales) {
    if (
      typeof multiscale !== "object" ||
      multiscale == null ||
      Array.isArray(multiscale)
    ) {
      // Not valid OME multiscale spec.
      return undefined;
    }

    const version = ome == undefined ? multiscale.version : ome.version; // >0.4

    if (version === undefined) return undefined;
    if (!SUPPORTED_OME_MULTISCALE_VERSIONS.has(version)) {
      errors.push(
        `OME multiscale metadata version ${JSON.stringify(
          version,
        )} is not supported`,
      );
      continue;
    }
    if (version !== "0.4" && version !== "0.5-dev" && zarrVersion !== 3) {
      errors.push(
        `OME multiscale metadata version ${JSON.stringify(
          version,
        )} is not supported for zarr v${zarrVersion}`,
      );
      continue;
    }
    const multiScaleInfo = parseOmeMultiscale(url, multiscale, version);
    const channelMetadata = omero ? parseOmeroMetadata(omero) : undefined;
    return { multiscale: multiScaleInfo, channels: channelMetadata };
  }
  if (errors.length !== 0) {
    throw new Error(errors[0]);
  }
  return undefined;
}
