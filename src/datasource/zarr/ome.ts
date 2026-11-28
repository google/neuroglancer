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
  // The transformation from the intrinsic system to the output system, when
  // it has a displacement field: the image is then in its intrinsic system
  // (`coordinateSpace`), and the layer applies the chain.
  transformChain?: OmeTransformChain;
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
  const color =
    colorString !== undefined
      ? parseRGBColorSpecification(colorString)
      : undefined;
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

// RFC-5 displacement and coordinate fields store their vectors along an axis of
// type "displacement" / "coordinate"; like channels, it is not a spatial axis.
function isChannelLikeAxisType(type: string | undefined) {
  return type === "channel" || type === "displacement" || type === "coordinate";
}

function parseOmeAxes(axes: unknown): CoordinateSpace {
  const parsedAxes = parseArray(axes, parseOmeAxis);
  return makeCoordinateSpace({
    names: parsedAxes.map((axis) => {
      const { name, type } = axis;
      if (isChannelLikeAxisType(type)) {
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
      if (isChannelLikeAxisType(type)) {
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

export function parseOmeCoordinateTransforms(
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

// --- Transformation chains: linear transformations and at most one
// displacement field (RFC-5).
//
// A transformation from an input coordinate system to an output system may
// combine linear transformations with one displacement field: e.g.
// sequence[affine, inverseOf(displacements), affine]. It is split into
//   input -> output = post ∘ W ∘ pre,
// with `pre` and `post` linear and W the field's map, in the field's own
// coordinates. Rendering pulls output points back into the source, so it uses
// W's inverse D(p) = p + u(p) (a field sampled on the output side):
// inverseOf(displacements), or a bijection whose inverse is one. A field that
// maps the other way (W itself) is marked "derive": its inverse is derived
// from it where needed (`warp/derived_field.ts`). A bijection's other field,
// if it is D⁻¹ in D's coordinates, is kept for moving points. The
// split is found by inverting the transformation symbolically into
//   input <- after ∘ D ∘ before <- output,
// so that pre = after⁻¹ and post = before⁻¹. Without a field, pre is the
// identity and post the whole transformation.

/** An axis of an RFC-5 coordinate system (OME JSON). */
export interface OmeChainAxis {
  name: string;
  type?: string;
  unit?: string;
}

/**
 * A transformation between two coordinate systems of the same rank, as
 * post ∘ W ∘ pre (see above).
 */
export interface OmeTransformChain {
  inputAxes: OmeChainAxis[];
  outputAxes: OmeChainAxis[];
  // Homogeneous (rank + 1)^2 column-major matrices, in the coordinate
  // systems' own units: input -> field coordinates, and field coordinates ->
  // output.
  pre: Float64Array;
  post: Float64Array;
  field?: {
    // URL of the field group (an OME-Zarr multiscale with a displacement
    // axis).
    url: string;
    // The axes (indices into the chain's axes) the field acts on, in order:
    // the field's own spatial axes.
    spaceAxes: number[];
    // The field maps the input's points to the output (W, not D): drawing
    // uses its derived inverse.
    derive?: boolean;
    // A stored field of D's inverse (the other field of a bijection), for
    // moving points: D⁻¹ = P ∘ D' ∘ P⁻¹, with D' the field at `url` and P
    // (`placement`, homogeneous (rank + 1)^2 column-major, acting on the space
    // axes) its placement in D's coordinates.
    inverse?: { url: string; placement: Float64Array };
  };
}

/** Neuroglancer base unit and scale of an OME unit (none: "", 1). */
export function parseOmeUnit(unit: string | undefined) {
  if (unit === undefined) return { unit: "", scale: 1 };
  const x = OME_UNITS.get(unit);
  if (x === undefined) {
    throw new Error(`Unsupported unit: ${JSON.stringify(unit)}`);
  }
  return x;
}

/** Neuroglancer's name for an OME axis (channel-like axes are local). */
export function omeAxisDimensionName(axis: OmeChainAxis) {
  return isChannelLikeAxisType(axis.type) ? `${axis.name}'` : axis.name;
}

export function parseOmeChainAxes(x: unknown): OmeChainAxis[] {
  return parseArray(x, (a) => ({
    name: verifyObjectProperty(a, "name", verifyString),
    type: verifyOptionalObjectProperty(a, "type", verifyString),
    unit: verifyOptionalObjectProperty(a, "unit", verifyString),
  }));
}

const LINEAR_TRANSFORM_TYPES = new Set([
  "identity",
  "scale",
  "translation",
  "rotation",
  "mapAxis",
  "affine",
]);

/**
 * Whether a transformation needs the RFC-5 chain parser: it has a
 * displacement or coordinate field, or an inverseOf / bijection.
 */
function isChainTransform(t: unknown): boolean {
  if (typeof t !== "object" || t === null) return false;
  const { type } = t as { type?: unknown };
  switch (type) {
    case "displacements":
    case "coordinates":
    case "inverseOf":
    case "bijection":
    case "byDimension":
      return true;
    case "sequence": {
      const members = (t as { transformations?: unknown }).transformations;
      return Array.isArray(members) && members.some(isChainTransform);
    }
    default:
      return false;
  }
}

interface ChainContext {
  // Rank of the image's coordinate systems.
  rank: number;
  // Indices of the output system's space axes: a transformation of that many
  // dimensions (a field's own affines) acts on them.
  spaceAxes: number[];
  // URL of the group whose metadata holds the transformation.
  baseUrl: string;
}

/** Rank of a linear transformation from its parameters, if they say. */
function linearTransformRank(t: unknown): number | undefined {
  const length = (key: string) => {
    const v = (t as Record<string, unknown>)[key];
    return Array.isArray(v) ? v.length : undefined;
  };
  switch (verifyObjectProperty(t, "type", verifyString)) {
    case "scale":
      return length("scale");
    case "translation":
      return length("translation");
    case "affine":
      return length("affine");
    case "rotation":
      return length("rotation");
    case "mapAxis":
      return length("mapAxis");
    default:
      return undefined;
  }
}

function homogeneousMultiply(rank: number, a: Float64Array, b: Float64Array) {
  return matrix.multiply(
    new Float64Array((rank + 1) ** 2),
    rank + 1,
    a,
    rank + 1,
    b,
    rank + 1,
    rank + 1,
    rank + 1,
    rank + 1,
  );
}

function homogeneousInverse(rank: number, a: Float64Array) {
  const out = new Float64Array((rank + 1) ** 2);
  const det = matrix.inverse(out, rank + 1, a, rank + 1, rank + 1);
  if (det === 0 || !Number.isFinite(det)) {
    throw new Error("A transformation in the chain is not invertible");
  }
  return out;
}

/**
 * A homogeneous matrix of rank `r` acting on the chain's space axes (a field's
 * own affines act on the field's spatial axes only), as one of the chain's
 * rank.
 */
function embedLinear(ctx: ChainContext, r: number, m: Float64Array) {
  const { rank, spaceAxes } = ctx;
  if (r === rank) return m;
  if (r !== spaceAxes.length) {
    throw new Error(
      `A transformation of ${r} dimensions does not fit a coordinate system ` +
        `of ${rank} dimensions (${spaceAxes.length} of them space axes)`,
    );
  }
  const out = matrix.createIdentity(Float64Array, rank + 1);
  for (let i = 0; i < r; ++i) {
    for (let j = 0; j < r; ++j) {
      out[spaceAxes[j] * (rank + 1) + spaceAxes[i]] = m[j * (r + 1) + i];
    }
    out[rank * (rank + 1) + spaceAxes[i]] = m[r * (r + 1) + i];
  }
  return out;
}

/** The matrix of a linear transformation, or undefined if it is not linear. */
function parseChainLinear(
  ctx: ChainContext,
  t: unknown,
): Float64Array | undefined {
  verifyObject(t);
  const type = verifyObjectProperty(t, "type", verifyString);
  if (LINEAR_TRANSFORM_TYPES.has(type)) {
    const r = linearTransformRank(t) ?? ctx.rank;
    const parser = coordinateTransformParsers.get(type)!;
    return embedLinear(ctx, r, parser(r, t) as Float64Array);
  }
  switch (type) {
    case "sequence": {
      let m: Float64Array = matrix.createIdentity(Float64Array, ctx.rank + 1);
      for (const member of verifyObjectProperty(t, "transformations", (x) =>
        parseArray(x, (y) => y),
      )) {
        const next = parseChainLinear(ctx, member);
        if (next === undefined) return undefined;
        m = homogeneousMultiply(ctx.rank, next, m);
      }
      return m;
    }
    case "inverseOf": {
      const inner = parseChainLinear(
        ctx,
        verifyObjectProperty(t, "transformation", (x) => x),
      );
      return inner === undefined
        ? undefined
        : homogeneousInverse(ctx.rank, inner);
    }
    case "bijection":
      return parseChainLinear(
        ctx,
        verifyObjectProperty(t, "forward", (x) => x),
      );
    case "displacements":
    case "coordinates":
      return undefined;
    default:
      throw new Error(
        `Unsupported coordinate transform type: ${JSON.stringify(type)}`,
      );
  }
}

/** A transformation after ∘ D ∘ before, with D a displacement field. */
interface FieldForm {
  before: Float64Array;
  url: string;
  after: Float64Array;
  // D is the inverse of the field's map (see OmeTransformChain).
  derive?: boolean;
  // A stored field of D⁻¹ (see OmeTransformChain).
  inverse?: { url: string; placement: Float64Array };
}

/**
 * Resolves a path (which may use "..") or URL against a group URL, as a
 * directory URL ending in "/".
 */
export function resolveTransformPath(baseUrl: string, path: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return kvstoreEnsureDirectoryPipelineUrl(path);
  }
  const m = baseUrl.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)?$/i);
  const [origin, basePath] = m === null ? ["", baseUrl] : [m[1], m[2] ?? "/"];
  const parts = basePath.split("/").filter((x) => x !== "");
  for (const part of path.split("/")) {
    if (part === "..") {
      if (parts.length === 0) {
        throw new Error(
          `Invalid relative path ${JSON.stringify(path)} from ${baseUrl}`,
        );
      }
      parts.pop();
    } else if (part !== "." && part !== "") {
      parts.push(part);
    }
  }
  return `${origin}/${parts.join("/")}/`;
}

/**
 * Combines transformations applied in order, of which exactly one is a field
 * (a FieldForm) and the others matrices.
 */
function combineFieldForm(
  ctx: ChainContext,
  members: (Float64Array | FieldForm)[],
): FieldForm {
  const { rank } = ctx;
  let before: Float64Array = matrix.createIdentity(Float64Array, rank + 1);
  let after: Float64Array = matrix.createIdentity(Float64Array, rank + 1);
  let field: FieldForm | undefined;
  for (const m of members) {
    if (m instanceof Float64Array) {
      if (field === undefined) before = homogeneousMultiply(rank, m, before);
      else after = homogeneousMultiply(rank, m, after);
    } else {
      if (field !== undefined) {
        throw new Error(
          "Only one displacement field per transformation is supported",
        );
      }
      field = m;
    }
  }
  if (field === undefined) {
    throw new Error("Expected a displacement field");
  }
  return {
    before: homogeneousMultiply(rank, field.before, before),
    url: field.url,
    after: homogeneousMultiply(rank, after, field.after),
    derive: field.derive,
    inverse: field.inverse,
  };
}

function isHomogeneousIdentity(rank: number, m: Float64Array) {
  for (let i = 0; i <= rank; ++i) {
    for (let j = 0; j <= rank; ++j) {
      if (Math.abs(m[j * (rank + 1) + i] - (i === j ? 1 : 0)) > 1e-6) {
        return false;
      }
    }
  }
  return true;
}

/**
 * A bijection's member `t` (as `form`) with the other member's field, when it
 * is D⁻¹ placed by an affine. With t = a ∘ D ∘ b and the other member
 * t⁻¹ = a' ∘ D' ∘ b', D⁻¹ = (b ∘ a') ∘ D' ∘ (b' ∘ a) = P ∘ D' ∘ Q: the
 * other field, placed by P, is D⁻¹ when Q = P⁻¹ (e.g. two fields sampled on
 * different grids, each between translations). P must not mix the space axes
 * with the others.
 */
function withBijectionInverse(
  ctx: ChainContext,
  form: FieldForm,
  other: unknown,
): FieldForm {
  let o: FieldForm;
  try {
    o = forwardFieldForm(ctx, other);
  } catch {
    return form;
  }
  const { rank, spaceAxes } = ctx;
  const placement = homogeneousMultiply(rank, form.before, o.after);
  const q = homogeneousMultiply(rank, o.before, form.after);
  if (
    form.derive ||
    o.derive ||
    !isHomogeneousIdentity(rank, homogeneousMultiply(rank, placement, q))
  ) {
    return form;
  }
  const isSpace = (i: number) => spaceAxes.includes(i);
  for (let i = 0; i < rank; ++i) {
    for (let j = 0; j <= rank; ++j) {
      const v = placement[j * (rank + 1) + i];
      const identity = i === j ? 1 : 0;
      // Space rows may mix space columns (and translate); others must be
      // the identity.
      if (isSpace(i) ? j < rank && !isSpace(j) && v !== 0 : v !== identity) {
        return form;
      }
    }
  }
  return { ...form, inverse: { url: o.url, placement } };
}

function parseFieldMembers(t: unknown) {
  return verifyObjectProperty(t, "transformations", (x) =>
    parseArray(x, (y) => y),
  );
}

function checkInterpolation(t: unknown) {
  const interpolation = verifyOptionalObjectProperty(
    t,
    "interpolation",
    verifyString,
  );
  if (interpolation !== undefined && interpolation !== "linear") {
    throw new Error(
      `Unsupported displacement field interpolation: ${JSON.stringify(
        interpolation,
      )} (only "linear")`,
    );
  }
}

/** The transformation `t` itself as after ∘ D ∘ before. */
function forwardFieldForm(ctx: ChainContext, t: unknown): FieldForm {
  const type = verifyObjectProperty(t, "type", verifyString);
  switch (type) {
    case "displacements": {
      checkInterpolation(t);
      const identity = matrix.createIdentity(Float64Array, ctx.rank + 1);
      return {
        before: identity,
        url: resolveTransformPath(
          ctx.baseUrl,
          verifyObjectProperty(t, "path", verifyString),
        ),
        after: identity,
      };
    }
    case "sequence":
      return combineFieldForm(
        ctx,
        parseFieldMembers(t).map(
          (m) => parseChainLinear(ctx, m) ?? forwardFieldForm(ctx, m),
        ),
      );
    case "bijection":
      return withBijectionInverse(
        ctx,
        forwardFieldForm(
          ctx,
          verifyObjectProperty(t, "forward", (x) => x),
        ),
        verifyObjectProperty(t, "inverse", (x) => x),
      );
    case "inverseOf":
      return inverseFieldForm(
        ctx,
        verifyObjectProperty(t, "transformation", (x) => x),
      );
    default:
      throw new Error(
        `Unsupported coordinate transform type: ${JSON.stringify(type)}`,
      );
  }
}

/** The inverse of the transformation `t` as after ∘ D ∘ before. */
function inverseFieldForm(ctx: ChainContext, t: unknown): FieldForm {
  const type = verifyObjectProperty(t, "type", verifyString);
  switch (type) {
    case "displacements":
      // The field maps the image's points to the output space; drawing
      // needs its inverse, which is derived from it.
      return { ...forwardFieldForm(ctx, t), derive: true };
    case "sequence":
      // (m_k ∘ ... ∘ m_0)⁻¹ = m_0⁻¹ ∘ ... ∘ m_k⁻¹: the inverses in reverse.
      return combineFieldForm(
        ctx,
        parseFieldMembers(t)
          .reverse()
          .map((m) => {
            const linear = parseChainLinear(ctx, m);
            return linear === undefined
              ? inverseFieldForm(ctx, m)
              : homogeneousInverse(ctx.rank, linear);
          }),
      );
    case "bijection":
      return withBijectionInverse(
        ctx,
        forwardFieldForm(
          ctx,
          verifyObjectProperty(t, "inverse", (x) => x),
        ),
        verifyObjectProperty(t, "forward", (x) => x),
      );
    case "inverseOf":
      return forwardFieldForm(
        ctx,
        verifyObjectProperty(t, "transformation", (x) => x),
      );
    default:
      throw new Error(
        `Unsupported coordinate transform type: ${JSON.stringify(type)}`,
      );
  }
}

/** The space axes of a coordinate system: type "space", else length units. */
function spaceAxesOf(axes: OmeChainAxis[]) {
  const space = axes
    .map((a, i) => (a.type === "space" ? i : -1))
    .filter((i) => i !== -1);
  if (space.length !== 0) return space;
  return axes
    .map((a, i) =>
      a.unit !== undefined && OME_UNITS.get(a.unit)?.unit === "m" ? i : -1,
    )
    .filter((i) => i !== -1);
}

/**
 * Parses a transformation from the coordinate system with axes `inputAxes`
 * to the one with `outputAxes` (OME JSON; with `inverse`, the transformation
 * is used from its output system to its input system) into
 * post ∘ W ∘ pre. Relative field paths resolve against `baseUrl`, the URL of
 * the group whose metadata holds the transformation.
 */
export function parseOmeTransformChain(
  transformation: unknown,
  inputAxes: OmeChainAxis[],
  outputAxes: OmeChainAxis[],
  baseUrl: string,
  inverse = false,
): OmeTransformChain {
  if (inverse) [inputAxes, outputAxes] = [outputAxes, inputAxes];
  const rank = outputAxes.length;
  if (inputAxes.length !== rank) {
    throw new Error(
      `Transformations between coordinate systems of different ranks ` +
        `(${inputAxes.length} and ${rank}) are not supported`,
    );
  }
  let spaceAxes = spaceAxesOf(outputAxes);
  if (spaceAxes.length === 0) spaceAxes = spaceAxesOf(inputAxes);
  const ctx: ChainContext = { rank, spaceAxes, baseUrl };
  const identity = matrix.createIdentity(Float64Array, rank + 1);
  const linear = parseChainLinear(ctx, transformation);
  if (linear !== undefined) {
    return {
      inputAxes,
      outputAxes,
      pre: identity,
      post: inverse ? homogeneousInverse(rank, linear) : linear,
    };
  }
  // The pull-back (output -> input) is after ∘ D ∘ before.
  const {
    before,
    url,
    after,
    derive,
    inverse: inverseField,
  } = inverse
    ? forwardFieldForm(ctx, transformation)
    : inverseFieldForm(ctx, transformation);
  const pre = homogeneousInverse(rank, after);
  const post = homogeneousInverse(rank, before);
  // The field acts on the space axes: its placements must not mix them with
  // the others.
  const isSpace = (i: number) => spaceAxes.includes(i);
  for (const m of [pre, post]) {
    for (let i = 0; i < rank; ++i) {
      for (let j = 0; j < rank; ++j) {
        if (isSpace(i) !== isSpace(j) && m[j * (rank + 1) + i] !== 0) {
          throw new Error(
            "The transformation mixes the displacement field's space axes " +
              "with other axes",
          );
        }
      }
    }
  }
  return {
    inputAxes,
    outputAxes,
    pre,
    post,
    field: {
      url,
      spaceAxes,
      ...(derive ? { derive } : {}),
      ...(inverseField !== undefined ? { inverse: inverseField } : {}),
    },
  };
}

/** pre and post of a chain without a field, as one matrix. */
export function omeTransformChainLinear(chain: OmeTransformChain) {
  return homogeneousMultiply(chain.outputAxes.length, chain.post, chain.pre);
}

/** A transformation of an OME-Zarr document and its coordinate systems. */
export interface OmeTransformationEntry {
  transformation: unknown;
  name?: string;
  input: { name?: string; path?: string };
  output: { name?: string; path?: string };
}

/**
 * The transformations of an OME-Zarr group's "ome" metadata that a transform
 * source can use, with the coordinate systems they refer to by name:
 * - a scene ("scene": coordinateSystems and coordinateTransformations);
 * - a group of transformations (coordinateSystems and
 *   coordinateTransformations directly in "ome");
 * - an image (its multiscale's transformations from the intrinsic system).
 * Undefined if the metadata has none of these.
 */
export function getOmeTransformations(ome: unknown):
  | {
      kind: "scene" | "transformations" | "image";
      systems: { name: string; axes: OmeChainAxis[] }[];
      transformations: OmeTransformationEntry[];
    }
  | undefined {
  if (typeof ome !== "object" || ome === null) return undefined;
  const parseSystems = (x: unknown) =>
    parseArray(x ?? [], (c) => ({
      name: verifyObjectProperty(c, "name", verifyString),
      axes: verifyObjectProperty(c, "axes", parseOmeChainAxes),
    }));
  const parseEntries = (x: unknown) =>
    parseArray(x, (t) => {
      verifyObject(t);
      return {
        transformation: t,
        name: verifyOptionalObjectProperty(t, "name", verifyString),
        input: verifyOptionalObjectProperty(t, "input", parseOmeInputOutput, {
          name: undefined,
          path: undefined,
        }),
        output: verifyOptionalObjectProperty(t, "output", parseOmeInputOutput, {
          name: undefined,
          path: undefined,
        }),
      };
    });
  const o = ome as Record<string, unknown>;
  const scene = o.scene as Record<string, unknown> | undefined;
  if (scene?.coordinateTransformations !== undefined) {
    return {
      kind: "scene",
      systems: parseSystems(scene.coordinateSystems),
      transformations: parseEntries(scene.coordinateTransformations),
    };
  }
  if (o.coordinateTransformations !== undefined) {
    return {
      kind: "transformations",
      systems: parseSystems(o.coordinateSystems),
      transformations: parseEntries(o.coordinateTransformations),
    };
  }
  const multiscale = Array.isArray(o.multiscales)
    ? (o.multiscales[0] as Record<string, unknown> | undefined)
    : undefined;
  if (multiscale?.coordinateSystems === undefined) return undefined;
  const intrinsic = verifyObjectProperty(multiscale, "datasets", (x) =>
    parseArray(x, parseMultiscaleOutput),
  )[0]?.name;
  if (intrinsic === undefined) return undefined;
  return {
    kind: "image",
    systems: parseSystems(multiscale.coordinateSystems),
    transformations: parseEntries(
      multiscale.coordinateTransformations ?? [],
    ).filter((t) => t.input.name === intrinsic && t.output.name !== undefined),
  };
}

/**
 * The name of an OME-Zarr image's intrinsic coordinate system: the output of
 * its datasets' transformations.
 */
export function getOmeIntrinsicSystem(ome: unknown) {
  const multiscale = verifyObjectProperty(
    ome,
    "multiscales",
    (x) => parseArray(x, verifyObject)[0],
  );
  const name = verifyObjectProperty(multiscale, "datasets", (x) =>
    parseArray(x, parseMultiscaleOutput),
  )[0]?.name;
  const systems = verifyObjectProperty(multiscale, "coordinateSystems", (x) =>
    parseArray(x, (c) => ({
      name: verifyObjectProperty(c, "name", verifyString),
      axes: verifyObjectProperty(c, "axes", parseOmeChainAxes),
    })),
  );
  return { name, systems };
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
      parseOmeInputOutput,
    );
    const type = verifyObjectProperty(transform, "type", verifyString);

    // Validate input matches expected (array path)
    // Empty string or undefined means the field is not specified
    if (
      input !== undefined &&
      input.path !== "" &&
      input.path !== expectedInput
    ) {
      throw new Error(
        `Invalid coordinate transformation for dataset at path "${path}": ` +
          `input is "${input.path}" but expected "${expectedInput}"`,
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
            parseOmeInputOutput,
          );
          const innerOutput = verifyOptionalObjectProperty(
            innerTransform,
            "output",
            parseOmeInputOutput,
          );

          // First transform in sequence should have input matching the sequence's input
          if (
            i === 0 &&
            innerInput !== undefined &&
            innerInput.path !== expectedInput
          ) {
            throw new Error(
              `Invalid sequence transformation for dataset at path "${path}": ` +
                `first inner transform has input "${innerInput.path}" but expected "${expectedInput}"`,
            );
          }

          // Last transform in sequence should have output matching the sequence's output
          if (
            i === innerTransforms.length - 1 &&
            innerOutput !== undefined &&
            innerOutput.name !== expectedOutput
          ) {
            throw new Error(
              `Invalid sequence transformation for dataset at path "${path}": ` +
                `last inner transform has output "${innerOutput.name}" but expected "${expectedOutput}"`,
            );
          }

          // Validate chaining between consecutive transforms
          if (i > 0) {
            const prevTransform = innerTransforms[i - 1];
            verifyObject(prevTransform);
            const prevOutput = verifyOptionalObjectProperty(
              prevTransform,
              "output",
              parseOmeInputOutput,
            );

            if (
              prevOutput?.name !== undefined &&
              innerInput?.name !== undefined &&
              prevOutput.name !== innerInput.name
            ) {
              throw new Error(
                `Invalid sequence transformation for dataset at path "${path}": ` +
                  `transform ${i - 1} has output "${prevOutput.name}" but transform ${i} has input "${innerInput.name}". ` +
                  `Transforms in a sequence must have matching input/output for consecutive transforms.`,
              );
            }
          }
        }
      }
    }
  }
}

function parseOmeInputOutput(obj: unknown) {
  // OME 0.6 expects object but the RFC allowed strings where
  // the string represented either path or name depending on level
  // and we declare to support dev versions
  if (typeof obj === "object") {
    return {
      name: verifyOptionalObjectProperty(obj, "name", verifyString),
      path: verifyOptionalObjectProperty(obj, "path", verifyString),
    };
  } else if (typeof obj === "string") {
    return {
      name: obj,
      path: obj,
    };
  } else {
    throw new Error("Expected input/output to be string or object");
  }
}

function parseMultiscaleOutput(obj: unknown) {
  const transformationInputs = verifyObjectProperty(
    obj,
    "coordinateTransformations",
    (y) => parseArray(y, (x) => x.output),
  );
  return parseOmeInputOutput(transformationInputs[0]);
}

// Find each coordinate transform with an input of the intrinsic system
// as those are the only ones which could be applied directly
function findTransformationsWithIntrinsicInput(
  transformations: unknown,
  intrinsicCoordinateSystemName: string,
): { transformation: unknown; outputCoordinateSystemName: string }[] {
  if (transformations === undefined) return [];
  const parsed = parseArray(transformations, (transformation) => {
    verifyObject(transformation);
    return {
      transformation,
      input: verifyOptionalObjectProperty(
        transformation,
        "input",
        parseOmeInputOutput,
      ),
      output: verifyOptionalObjectProperty(
        transformation,
        "output",
        parseOmeInputOutput,
      ),
    };
  });
  const transforms = [];
  for (const { transformation, input, output } of parsed) {
    if (input?.name !== intrinsicCoordinateSystemName) continue;
    if (output?.name === undefined) continue;
    // Avoid finding child labels groups
    if (
      output.path !== undefined &&
      output.path.includes("labels") &&
      output.path !== output.name
    )
      continue;
    transforms.push({
      transformation,
      outputCoordinateSystemName: output.name,
    });
  }
  return transforms;
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

  const coordinateSystemsJson = verifyOptionalObjectProperty(
    multiscale,
    "coordinateSystems",
    (x) => x,
  );
  const coordinateTransformsJson = verifyOptionalObjectProperty(
    multiscale,
    "coordinateTransformations",
    (x) => x,
  );
  let coordinateTransformsToApply: unknown = coordinateTransformsJson;
  // An RFC-5 chain to the output system: linear (applied like the others), or
  // with a displacement field.
  let chainLinear: Float64Array | undefined;
  let transformChain: OmeTransformChain | undefined;

  if (
    coordinateSystemsJson !== undefined &&
    Array.isArray(coordinateSystemsJson) &&
    coordinateSystemsJson.length > 0
  ) {
    // 0.6+ - Directly from the OME-Zarr spec:
    // "In terms of metadata, the coordinate system referred to as the “intrinsic” coordinate system in this document, is the coordinate system that is referenced by all multiscale coordinate transformations under datasets as their output."
    // As such, we iterate over all the scales once to find this output name
    const outputNames = verifyObjectProperty(multiscale, "datasets", (obj) =>
      parseArray(obj, parseMultiscaleOutput),
    );
    intrinsicCoordinateSystemName = outputNames[0]?.name;
    const mismatch = outputNames.findIndex(
      (x) => x?.name !== intrinsicCoordinateSystemName,
    );
    if (mismatch !== -1) {
      throw new Error(
        `All output names of multiscale.datasets must be the same, candidate name from first scale is ${intrinsicCoordinateSystemName}, but found ${outputNames[mismatch].name} at scale ${mismatch}`,
      );
    }
    if (intrinsicCoordinateSystemName === undefined) {
      throw new Error(`There must be an intrinsic coordinateSystem`);
    }

    const coordinateSystems = parseArray(
      coordinateSystemsJson,
      parseOmeCoordinateSystem,
    );

    const applicableCoordinateTransforms =
      findTransformationsWithIntrinsicInput(
        coordinateTransformsJson,
        intrinsicCoordinateSystemName,
      );
    // As we have no coordinate space selector, we just apply
    // the first found applicable transform
    coordinateTransformsToApply =
      applicableCoordinateTransforms.length === 0
        ? undefined
        : [applicableCoordinateTransforms[0].transformation];

    // The image ends in the space that the applied transformation outputs to, or in the
    // intrinsic space when no transformation applies.
    const nameToMatch =
      applicableCoordinateTransforms[0]?.outputCoordinateSystemName ??
      intrinsicCoordinateSystemName;

    const coordinateSpaceMatch = coordinateSystemsJson.findIndex(
      (x) => x.name === nameToMatch,
    );
    if (coordinateSpaceMatch === -1) {
      const reason =
        nameToMatch === intrinsicCoordinateSystemName ? "intrinsic" : "output";
      throw new Error(
        `Could not find any coordinate system for the ${reason} system ${nameToMatch}`,
      );
    }
    coordinateSpace = coordinateSystems[coordinateSpaceMatch];
    const applied = applicableCoordinateTransforms[0]?.transformation;
    if (applied !== undefined && isChainTransform(applied)) {
      const intrinsicMatch = coordinateSystemsJson.findIndex(
        (x) => x.name === intrinsicCoordinateSystemName,
      );
      if (intrinsicMatch === -1) {
        throw new Error(
          `Could not find any coordinate system for the intrinsic system ${intrinsicCoordinateSystemName}`,
        );
      }
      const axesOf = (i: number) =>
        verifyObjectProperty(
          coordinateSystemsJson[i],
          "axes",
          parseOmeChainAxes,
        );
      const chain = parseOmeTransformChain(
        applied,
        axesOf(intrinsicMatch),
        axesOf(coordinateSpaceMatch),
        url,
      );
      if (chain.field === undefined) {
        chainLinear = omeTransformChainLinear(chain);
      } else {
        // The image stays in its intrinsic system; the layer applies the
        // chain (see `layer/layer_data_source.ts`).
        transformChain = chain;
        coordinateSpace = coordinateSystems[intrinsicMatch];
      }
      coordinateTransformsToApply = undefined;
    }
  } else {
    // OME-ZARR 0.4/0.5: Use axes directly
    coordinateSpace = verifyObjectProperty(multiscale, "axes", parseOmeAxes);
  }

  const rank = coordinateSpace.rank;
  const transform =
    chainLinear ??
    parseOmeCoordinateTransforms(rank, coordinateTransformsToApply);
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
      transformChain,
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
  const { ome } = attrs;
  const metadata = ome ?? attrs; // 0.5+ nests under `ome`; 0.4 keeps fields at root
  const { multiscales, omero } = metadata;

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

    const version = ome?.version ?? multiscale.version; // 0.5+ moved version onto `ome`

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
