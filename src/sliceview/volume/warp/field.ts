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

/**
 * @file Displacement fields for warped sources: the warp specification,
 * loading a field (a warpfield OME-Zarr group, or any volume the data source
 * registry can open), and the geometry shared by warped volumes
 * (`warp/frontend.ts`) and warped meshes (`mesh/warp/frontend.ts`).
 *
 * A field is described in its own output space (named dimensions, one of
 * which holds the vector components) by one affine per level, from the
 * level's model index (sample n at n) to output coordinates. Which field
 * dimensions are displaced, indexed or dropped, and how they meet the moving
 * source's dimensions, is decided by `resolveWarpDimensions`.
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type {
  CoordinateSpace,
  CoordinateSpaceTransform,
  CoordinateTransformSpecification,
} from "#src/coordinate_transform.js";
import {
  coordinateTransformSpecificationFromJson,
  coordinateTransformSpecificationToJson,
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import type { DataSource, DataSourceRegistry } from "#src/datasource/index.js";
import type { MultiscaleVolumeChunkSource as ZarrMultiscaleVolumeChunkSource } from "#src/datasource/zarr/frontend.js";
import { DataType } from "#src/sliceview/base.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import type {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import type {
  FieldAccess,
  ZarrArrayAccess,
} from "#src/sliceview/volume/warp/base.js";
import type {
  WarpDimensionHints,
  WarpDimensionResolution,
} from "#src/sliceview/volume/warp/resolve.js";
import { resolveWarpDimensions } from "#src/sliceview/volume/warp/resolve.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  parseArray,
  parseFixedLengthArray,
  verifyFiniteFloat,
  verifyInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

// --- Units.

/** Neuroglancer base unit and its amount per unit, for OME axis units. */
const UNITS: Record<string, { unit: string; scale: number }> = {
  meter: { unit: "m", scale: 1 },
  millimeter: { unit: "m", scale: 1e-3 },
  micrometer: { unit: "m", scale: 1e-6 },
  nanometer: { unit: "m", scale: 1e-9 },
  second: { unit: "s", scale: 1 },
  millisecond: { unit: "s", scale: 1e-3 },
  microsecond: { unit: "s", scale: 1e-6 },
  minute: { unit: "s", scale: 60 },
  hour: { unit: "s", scale: 3600 },
};

/** Short unit names accepted by "vectorUnit". */
const SHORT_UNITS: Record<string, { unit: string; scale: number }> = {
  m: UNITS.meter,
  mm: UNITS.millimeter,
  um: UNITS.micrometer,
  µm: UNITS.micrometer,
  nm: UNITS.nanometer,
  s: UNITS.second,
  ms: UNITS.millisecond,
};

function parseUnit(unit: string) {
  const u = UNITS[unit] ?? SHORT_UNITS[unit];
  if (u === undefined) {
    throw new Error(`Unsupported unit: ${JSON.stringify(unit)}`);
  }
  return u;
}

// --- The displacement field options of a transform source.

export type WarpVectorFrame = "LPS" | "RAS";

export interface WarpSpecification {
  url: string;
  // Places (and renames) the field's dimensions, like a source's transform.
  transform?: CoordinateTransformSpecification;
  // The field dimension that holds the vector components.
  vectorDimension?: string;
  // The field dimensions the components displace, in component order.
  vectorDimensions?: string[];
  // Frame of the components of a NIfTI field: "LPS" (ITK, the default for a
  // vector in dimension 5) or "RAS".
  vectorFrame?: WarpVectorFrame;
  // Unit of the components (e.g. "mm", "um", "nm"); by default, output
  // coordinates of the dimension they displace.
  vectorUnit?: string;
  // The field's placement in a transformation chain (an OME-Zarr RFC-5
  // transformation), in place of the field's own output space; not part of
  // the JSON state.
  placement?: WarpFieldPlacement;
}

export interface WarpFieldPlacement {
  // Field coordinates (the non-displacement axes of the coordinate system
  // the field's datasets map to, in order) -> output coordinates: rows of
  // [linear | translation], one per output axis.
  affine: number[][];
  // The output axes: names and OME units (none: the field's own unit).
  axes: { name: string; unit?: string }[];
}

export function parseWarpSpecification(x: unknown): WarpSpecification {
  if (typeof x === "string") return { url: x };
  verifyObject(x);
  return {
    url: verifyObjectProperty(x, "url", verifyString),
    transform: verifyOptionalObjectProperty(
      x,
      "transform",
      coordinateTransformSpecificationFromJson,
    ),
    vectorDimension: verifyOptionalObjectProperty(
      x,
      "vectorDimension",
      verifyString,
    ),
    vectorDimensions: verifyOptionalObjectProperty(
      x,
      "vectorDimensions",
      verifyStringArray,
    ),
    vectorFrame: verifyOptionalObjectProperty(x, "vectorFrame", (v) => {
      if (v !== "LPS" && v !== "RAS") {
        throw new Error(
          `Expected "LPS" or "RAS", but received: ${JSON.stringify(v)}`,
        );
      }
      return v as WarpVectorFrame;
    }),
    vectorUnit: verifyOptionalObjectProperty(x, "vectorUnit", (v) => {
      const s = verifyString(v);
      parseUnit(s);
      return s;
    }),
  };
}

export function warpSpecificationToJson(spec: WarpSpecification | undefined) {
  if (spec === undefined) return undefined;
  const transform = coordinateTransformSpecificationToJson(spec.transform);
  if (
    transform === undefined &&
    spec.vectorDimension === undefined &&
    spec.vectorDimensions === undefined &&
    spec.vectorFrame === undefined &&
    spec.vectorUnit === undefined
  ) {
    return spec.url;
  }
  return {
    url: spec.url,
    transform,
    vectorDimension: spec.vectorDimension,
    vectorDimensions: spec.vectorDimensions,
    vectorFrame: spec.vectorFrame,
    vectorUnit: spec.vectorUnit,
  };
}

export function warpSpecificationsEqual(
  a: WarpSpecification | undefined,
  b: WarpSpecification | undefined,
) {
  return (
    JSON.stringify(warpSpecificationToJson(a)) ===
    JSON.stringify(warpSpecificationToJson(b))
  );
}

// --- Warpfield OME-Zarr metadata.

interface OmeAxis {
  name: string;
  type?: string;
  unit?: string;
}

function parseAxes(x: unknown): OmeAxis[] {
  return parseArray(x, (a) => ({
    name: verifyObjectProperty(a, "name", verifyString),
    type: verifyOptionalObjectProperty(a, "type", verifyString),
    unit: verifyOptionalObjectProperty(a, "unit", verifyString),
  }));
}

function parseFloats(x: unknown) {
  return parseArray(x, verifyFiniteFloat);
}

/** Flattens "sequence" transformations into a list of their members. */
function flattenTransforms(x: unknown): unknown[] {
  return parseArray(x, (t) => t).flatMap((t) =>
    verifyObjectProperty(t, "type", verifyString) === "sequence"
      ? flattenTransforms(verifyObjectProperty(t, "transformations", (y) => y))
      : [t],
  );
}

/**
 * The scale and translation (array index -> coordinate system) of a
 * multiscale dataset: scale and translation transformations, possibly in a
 * sequence, applied in order.
 */
function parseDatasetTransform(rank: number, transforms: unknown) {
  const scale = new Array<number>(rank).fill(1);
  const translation = new Array<number>(rank).fill(0);
  for (const t of flattenTransforms(transforms)) {
    const type = verifyObjectProperty(t, "type", verifyString);
    if (type === "identity") continue;
    if (type === "scale") {
      const s = verifyObjectProperty(t, "scale", parseFloats);
      for (let i = 0; i < rank; ++i) {
        scale[i] *= s[i];
        translation[i] *= s[i];
      }
    } else if (type === "translation") {
      const v = verifyObjectProperty(t, "translation", parseFloats);
      for (let i = 0; i < rank; ++i) translation[i] += v[i];
    } else {
      throw new Error(
        `Unsupported displacement field dataset transformation: ${type}`,
      );
    }
  }
  return { scale, translation };
}

export interface DisplacementFieldMetadata {
  path: string;
  // Array axis that holds the vector components.
  vectorAxis: number;
  vectorAxisName: string;
  // The non-vector array axes, in order.
  spatialAxes: number[];
  spatialAxisNames: string[];
  // Output axes (excluding the vector axis): names, Neuroglancer units and
  // base units per field unit.
  outputAxes: string[];
  outputUnits: string[];
  outputUnitScales: number[];
  // Base units (meters) per field unit of the first length axis; the unit
  // of interpolation errors and of the bounds.
  unitMeters: number;
  // Row-major: spatial array index (sample n at n) -> output, of "path"
  // (rows: output axes; columns: spatialAxes, then the translation).
  indexToOutput: number[][];
  // All resolutions, finest first.
  scales: {
    path: string;
    indexToOutput: number[][];
    // Deviation from the finest level when linearly interpolated, in field
    // units, if known.
    maxError?: number;
  }[];
  // Row-major: field system displacement (columns: spatialAxes) -> output
  // displacement (rows: output axes).
  systemToOutput: number[][];
  // The displaced axes (names of field system axes), if the metadata says.
  displacedAxes?: string[];
  bounds?: { path: string; blockShape: number[] };
  // URL of the field of the inverse transformation (from the scene).
  inverse?: string;
}

/**
 * Parses a displacement field: an OME-Zarr 0.6 multiscale image with one axis
 * of type "displacement" (RFC-5), whose vectors are expressed in the
 * coordinate system its datasets map to. An affine in the multiscale's
 * coordinateTransformations, from that coordinate system to another one, gives
 * the output space (otherwise the output space is that coordinate system).
 * `attributes.warpfield` adds per-level interpolation errors, the bounds
 * array, and optionally the displaced axes.
 */
export function parseDisplacementFieldMetadata(
  attributes: unknown,
  placement?: WarpFieldPlacement,
): DisplacementFieldMetadata {
  const ome = verifyObjectProperty(attributes, "ome", verifyObject);
  const multiscale = verifyObjectProperty(
    ome,
    "multiscales",
    (x) => parseArray(x, verifyObject)[0],
  );
  const systems = verifyObjectProperty(multiscale, "coordinateSystems", (x) =>
    parseArray(x, (c) => ({
      name: verifyObjectProperty(c, "name", verifyString),
      axes: verifyObjectProperty(c, "axes", parseAxes),
    })),
  );
  const datasets = verifyObjectProperty(multiscale, "datasets", (x) =>
    parseArray(x, (d) => ({
      path: verifyObjectProperty(d, "path", verifyString),
      transforms: verifyObjectProperty(
        d,
        "coordinateTransformations",
        (t) => t,
      ),
    })),
  );
  if (datasets.length === 0) {
    throw new Error("Displacement field has no datasets");
  }
  // The coordinate system the datasets map to: the vectors' coordinate system.
  const fieldSystemName = verifyObjectProperty(
    parseArray(datasets[0].transforms, (t) => t).at(-1),
    "output",
    (o) => verifyObjectProperty(o, "name", verifyString),
  );
  const fieldSystem = systems.find((c) => c.name === fieldSystemName);
  if (fieldSystem === undefined) {
    throw new Error(
      `Unknown coordinate system ${JSON.stringify(fieldSystemName)}`,
    );
  }
  const rank = fieldSystem.axes.length;
  const vectorAxis = fieldSystem.axes.findIndex(
    (a) => a.type === "displacement",
  );
  if (vectorAxis === -1) {
    throw new Error('Displacement field has no axis of type "displacement"');
  }
  const spatial = fieldSystem.axes
    .map((_, i) => i)
    .filter((i) => i !== vectorAxis);
  const axisUnits = (axes: OmeAxis[]) =>
    axes.map((a) => {
      if (a.unit === undefined) {
        throw new Error(
          `Displacement field axis ${JSON.stringify(a.name)} has no unit`,
        );
      }
      return parseUnit(a.unit);
    });
  const systemUnits = axisUnits(spatial.map((i) => fieldSystem.axes[i]));
  const lengthUnit = systemUnits.find((u) => u.unit === "m");
  if (lengthUnit === undefined) {
    throw new Error("Displacement field has no length axis");
  }
  // Optional affine from the field's coordinate system to the output space.
  const n = spatial.length;
  let affine: number[][] = spatial.map((_, r) =>
    Array.from({ length: n + 1 }, (_, c) => (c === r ? 1 : 0)),
  );
  let outputAxes = spatial.map((i) => fieldSystem.axes[i].name);
  let outputUnits = systemUnits;
  const extra = verifyOptionalObjectProperty(
    multiscale,
    "coordinateTransformations",
    (x) => parseArray(x, (t) => t),
    [],
  );
  if (placement !== undefined) {
    if (
      placement.affine.length !== n ||
      placement.affine.some((row) => row.length !== n + 1) ||
      placement.axes.length !== n
    ) {
      throw new Error(
        `The displacement field has ${n} spatial axes, but its placement ` +
          `maps ${placement.affine[0]?.length - 1} to ${placement.axes.length}`,
      );
    }
    affine = placement.affine;
    outputAxes = placement.axes.map((a) => a.name);
    // An axis without a unit keeps the field's own.
    outputUnits = placement.axes.map((a, k) =>
      a.unit === undefined ? systemUnits[k] : parseUnit(a.unit),
    );
  }
  for (const t of placement === undefined ? extra : []) {
    const input = verifyObjectProperty(t, "input", (o) =>
      verifyOptionalObjectProperty(o, "name", verifyString),
    );
    if (input !== fieldSystemName) continue;
    if (verifyObjectProperty(t, "type", verifyString) !== "affine") continue;
    const outputName = verifyObjectProperty(t, "output", (o) =>
      verifyObjectProperty(o, "name", verifyString),
    );
    const outputSystem = systems.find((c) => c.name === outputName);
    if (outputSystem === undefined) continue;
    const m = verifyObjectProperty(t, "affine", (x) =>
      parseArray(x, parseFloats),
    );
    // Rows and columns of the spatial axes, and the translation column.
    affine = spatial.map((r) => [...spatial.map((c) => m[r][c]), m[r][rank]]);
    const outAxes = outputSystem.axes.filter((a) => a.type !== "displacement");
    outputAxes = outAxes.map((a) => a.name);
    outputUnits = axisUnits(outAxes);
    break;
  }
  const extras = verifyOptionalObjectProperty(
    attributes,
    "warpfield",
    verifyObject,
    {},
  );
  const levelErrors = new Map<string, number>();
  verifyOptionalObjectProperty(extras, "levels", (x) =>
    parseArray(x, (l) => {
      // The level choice is global, so it uses the 99th percentile when the
      // store gives one: the max is set by the worst sample anywhere (a fold,
      // or an unconstrained field outside the tissue) and would force the
      // finest level everywhere.
      const err = verifyOptionalObjectProperty(
        l,
        "interpolation_error",
        (e) =>
          verifyOptionalObjectProperty(e, "p99", verifyFiniteFloat) ??
          verifyObjectProperty(e, "max", verifyFiniteFloat),
      );
      if (err !== undefined) {
        levelErrors.set(verifyObjectProperty(l, "path", verifyString), err);
      }
    }),
  );
  const scales = datasets.map(({ path, transforms }) => {
    const { scale, translation } = parseDatasetTransform(rank, transforms);
    // index -> field system: scale * n + translation; then the affine.
    const indexToOutput = affine.map((row) => [
      ...spatial.map((c, j) => row[j] * scale[c]),
      row[n] + spatial.reduce((a, c, j) => a + row[j] * translation[c], 0),
    ]);
    return { path, indexToOutput, maxError: levelErrors.get(path) };
  });
  return {
    path: scales[0].path,
    vectorAxis,
    vectorAxisName: fieldSystem.axes[vectorAxis].name,
    spatialAxes: spatial,
    spatialAxisNames: spatial.map((i) => fieldSystem.axes[i].name),
    outputAxes,
    outputUnits: outputUnits.map((u) => u.unit),
    outputUnitScales: outputUnits.map((u) => u.scale),
    unitMeters: lengthUnit.scale,
    indexToOutput: scales[0].indexToOutput,
    scales,
    systemToOutput: affine.map((row) => row.slice(0, n)),
    displacedAxes: verifyOptionalObjectProperty(
      extras,
      "displaced_axes",
      verifyStringArray,
    ),
    bounds: verifyOptionalObjectProperty(extras, "bounds", (b) => ({
      path: verifyObjectProperty(b, "path", verifyString),
      blockShape: verifyObjectProperty(b, "block_shape", (x) =>
        parseFixedLengthArray(new Array<number>(3), x, verifyInt),
      ),
    })),
  };
}

// --- Loaded displacement fields.

export interface DisplacementFieldLevel {
  volume: MultiscaleVolumeChunkSource;
  // Model index of this level (sample n at n; the volume's model dimensions)
  // -> field output coordinates. Row-major: one row per output dimension,
  // columns: model dimensions, then the translation.
  indexToOutput: number[][];
  // Lower index bound per model dimension.
  lower: number[];
  // Interpolation error relative to the finest level, in meters, if known.
  maxErrorMeters?: number;
}

export interface DisplacementField {
  url: string;
  spec: WarpSpecification;
  kind: "warpfield" | "generic";
  // The field's output dimensions, including the vector dimension: names,
  // units, and base units (e.g. meters) per output coordinate.
  outputNames: string[];
  outputUnits: string[];
  outputScales: number[];
  isDisplacementAxis: boolean[];
  // Number of samples along each output dimension.
  outputSizes: number[];
  // Model dimension of each output dimension.
  outputModelDims: number[];
  modelRank: number;
  // Level-0 index range per model dimension: [lower, upper).
  modelLower: number[];
  modelUpper: number[];
  levels: DisplacementFieldLevel[];
  hints: WarpDimensionHints;
  // Displacement (output coordinates, one row per output dimension) of each
  // component, given the output dimensions the components displace.
  vectorToOutput: (componentOutputDims: number[]) => number[][];
  // The field's own placement (model -> output), which the warp
  // specification's transform modifies.
  defaultTransform?: CoordinateSpaceTransform;
  metadata?: DisplacementFieldMetadata;
  bounds?: ZarrMultiscaleVolumeChunkSource;
  // The field of the inverse transformation, if the metadata names one.
  inverse?: DisplacementField;
}

export interface GetDisplacementFieldOptions extends Partial<ProgressOptions> {
  globalCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  signal: AbortSignal;
}

/** Normalizes "zarr3://URL", "URL|zarr3:" and "URL" to a group URL ending in "/". */
export function normalizeGroupUrl(url: string) {
  let u = url.trim();
  u = u.replace(/^zarr[23]?:\/\//, "");
  u = u.replace(/\|zarr[23]?:$/, "");
  if (!u.endsWith("/")) u += "/";
  return u;
}

/** A URL that names a data source other than zarr (opened generically). */
export function isNonZarrUrl(url: string) {
  const u = url.trim();
  const scheme = u.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1];
  const known = ["http", "https", "gs", "s3", "file", "zarr", "zarr2", "zarr3"];
  if (scheme !== undefined && !known.includes(scheme)) return true;
  const pipeline = u.match(/\|([a-z][a-z0-9+.-]*):/gi);
  if (pipeline?.some((p) => !/^\|zarr[23]?:$/i.test(p))) return true;
  return /\.nii(\.gz)?$/i.test(u);
}

function isNiftiUrl(url: string) {
  const u = url.trim();
  return (
    /^nifti:\/\//i.test(u) || /\|nifti:/i.test(u) || /\.nii(\.gz)?$/i.test(u)
  );
}

/** Resolves `relative` (which may use "..") against a group URL ending in "/". */
export function resolveRelativeUrl(groupUrl: string, relative: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(relative)) return relative;
  const m = groupUrl.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*)(\/.*)$/i);
  const [origin, path] = m === null ? ["", groupUrl] : [m[1], m[2]];
  const parts = path.split("/").slice(0, -1);
  for (const part of relative.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return `${origin}${parts.join("/")}/`;
}

/** The `displacements` path of a transformation (possibly in a sequence). */
function displacementsPath(t: unknown): string | undefined {
  if (t === undefined) return undefined;
  for (const x of flattenTransforms([t])) {
    if (verifyObjectProperty(x, "type", verifyString) === "displacements") {
      return verifyObjectProperty(x, "path", verifyString);
    }
  }
  return undefined;
}

/**
 * The URL of the field of the inverse transformation: looks for an OME-Zarr
 * scene in the field's parent or grandparent group (RFC-5 keeps transformation
 * arrays in a "coordinateTransformations" group next to the images) with a
 * "bijection" whose forward or inverse transformation uses this field.
 */
async function findInverseInScene(
  kvStoreContext: DataSourceRegistry["sharedKvStoreContext"]["kvStoreContext"],
  groupUrl: string,
  options: GetDisplacementFieldOptions,
): Promise<string | undefined> {
  for (const up of ["..", "../.."]) {
    const sceneUrl = resolveRelativeUrl(groupUrl, up);
    let json: unknown;
    try {
      const response = await kvStoreContext.read(
        `${sceneUrl}zarr.json`,
        options,
      );
      if (response === undefined) continue;
      json = await response.response.json();
    } catch {
      continue;
    }
    const transforms = verifyOptionalObjectProperty(json, "attributes", (a) =>
      verifyOptionalObjectProperty(a, "ome", (o) =>
        verifyOptionalObjectProperty(o, "scene", (s) =>
          verifyOptionalObjectProperty(s, "coordinateTransformations", (x) =>
            parseArray(x, (t) => t),
          ),
        ),
      ),
    );
    for (const t of transforms ?? []) {
      if (verifyObjectProperty(t, "type", verifyString) !== "bijection") {
        continue;
      }
      const [f, i] = ["forward", "inverse"].map((k) => {
        const p = displacementsPath(
          verifyOptionalObjectProperty(t, k, (x) => x),
        );
        return p === undefined ? undefined : resolveRelativeUrl(sceneUrl, p);
      });
      if (f === groupUrl) return i;
      if (i === groupUrl) return f;
    }
  }
  return undefined;
}

/** Index of the largest |value| (ties: the first). */
function argMaxAbs(values: ArrayLike<number>, among?: number[]) {
  let best = -1;
  const candidates = among ?? [...Array(values.length).keys()];
  for (const i of candidates) {
    if (best === -1 || Math.abs(values[i]) > Math.abs(values[best])) best = i;
  }
  return best;
}

/**
 * Coordinate matrix of a coordinate space transform: output coordinates per
 * input coordinate (row-major, rank x (sourceRank + 1), last column the
 * translation). Linear coefficients of a transform relate physical units, so
 * in coordinates they scale by input scale / output scale.
 */
export function coordinateMatrix(t: CoordinateSpaceTransform): number[][] {
  const { rank, sourceRank, transform, inputSpace, outputSpace } = t;
  return Array.from({ length: rank }, (_, i) => [
    ...Array.from(
      { length: sourceRank },
      (_, j) =>
        (transform[j * (rank + 1) + i] * inputSpace.scales[j]) /
        outputSpace.scales[i],
    ),
    transform[rank * (rank + 1) + i],
  ]);
}

/** Inverse of a square affine given as rows of [linear | translation]. */
function inverseAffineRows(rows: number[][]): number[][] {
  const n = rows.length;
  const m = new Float64Array((n + 1) * (n + 1));
  for (let i = 0; i < n; ++i) {
    for (let j = 0; j <= n; ++j) m[j * (n + 1) + i] = rows[i][j];
  }
  m[n * (n + 1) + n] = 1;
  const inv = new Float64Array((n + 1) * (n + 1));
  const det = matrix.inverse(inv, n + 1, m, n + 1, n + 1);
  if (det === 0 || !Number.isFinite(det)) {
    throw new Error("warp: singular transform");
  }
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => inv[j * (n + 1) + i]),
  );
}

/** a ∘ b for affines given as rows of [linear | translation]. */
function composeAffineRows(a: number[][], b: number[][]): number[][] {
  const n = b.length;
  return a.map((row) =>
    Array.from({ length: b[0]?.length ?? 1 }, (_, j) => {
      let s = j === b[0].length - 1 ? row[n] : 0;
      for (let k = 0; k < n; ++k) s += row[k] * b[k][j];
      return s;
    }),
  );
}

/**
 * Applies the warp specification's transform (which places and may rename
 * the field's output dimensions) to a field described in its default output
 * space: R = final ∘ default⁻¹ maps default output coordinates to final ones.
 */
function applyWarpTransform(
  field: DisplacementField,
  defaultTransform: CoordinateSpaceTransform,
  spec: CoordinateTransformSpecification | undefined,
) {
  if (spec === undefined) return field;
  const watchable = new WatchableCoordinateSpaceTransform(defaultTransform);
  watchable.spec = spec;
  const finalTransform = watchable.value;
  if (finalTransform.rank !== defaultTransform.rank) {
    throw new Error("warp: the warp's transform must keep the field's rank");
  }
  const d = coordinateMatrix(defaultTransform);
  const f = coordinateMatrix(finalTransform);
  const r = composeAffineRows(f, inverseAffineRows(d));
  const linear = r.map((row) =>
    row.map((v, j) => (j === row.length - 1 ? 0 : v)),
  );
  const { outputSpace } = finalTransform;
  const defaultDimOf = (finalDim: number) =>
    argMaxAbs(r[finalDim].slice(0, -1));
  const vectorToOutputDefault = field.vectorToOutput;
  const defaultHints = field.hints;
  const renamed = (names: string[] | undefined) =>
    names?.map((name) => {
      const i = field.outputNames.indexOf(name);
      if (i === -1) return name;
      return outputSpace.names[argMaxAbs(r.map((row) => row[i]))];
    });
  return {
    ...field,
    outputNames: Array.from(outputSpace.names),
    outputUnits: Array.from(outputSpace.units),
    outputScales: Array.from(outputSpace.scales),
    isDisplacementAxis: outputSpace.names.map(
      (_, i) => field.isDisplacementAxis[defaultDimOf(i)],
    ),
    outputSizes: outputSpace.names.map(
      (_, i) => field.outputSizes[defaultDimOf(i)],
    ),
    outputModelDims: outputSpace.names.map(
      (_, i) => field.outputModelDims[defaultDimOf(i)],
    ),
    levels: field.levels.map((level) => ({
      ...level,
      indexToOutput: composeAffineRows(r, level.indexToOutput),
    })),
    hints: {
      ...defaultHints,
      metadataVectorDimensions: renamed(defaultHints.metadataVectorDimensions),
      componentOrder: renamed(defaultHints.componentOrder),
    },
    vectorToOutput: (componentOutputDims: number[]) =>
      composeAffineRows(
        linear,
        vectorToOutputDefault(componentOutputDims.map(defaultDimOf)).map(
          (row) => [...row, 0],
        ),
      ).map((row) => row.slice(0, -1)),
  } satisfies DisplacementField;
}

/** Output dimensions as resolver input. */
function fieldDimensions(field: DisplacementField) {
  return field.outputNames.map((name, i) => ({
    name,
    unit: field.outputUnits[i],
    size: field.outputSizes[i],
    isDisplacementAxis: field.isDisplacementAxis[i],
  }));
}

async function getWarpfieldDisplacementField(
  registry: DataSourceRegistry,
  groupUrl: string,
  metadata: DisplacementFieldMetadata,
  spec: WarpSpecification,
  options: GetDisplacementFieldOptions,
  loadInverse: boolean,
): Promise<DisplacementField> {
  const openArray = async (path: string) => {
    const source = await registry.get({
      url: `${groupUrl}${path}/|zarr3:`,
      transform: undefined,
      globalCoordinateSpace: options.globalCoordinateSpace,
      signal: options.signal,
      progressListener: options.progressListener,
    });
    const volume = source.subsources.find((s) => s.subsource.volume)?.subsource
      .volume as ZarrMultiscaleVolumeChunkSource | undefined;
    if (volume === undefined || !("multiscale" in volume)) {
      throw new Error(`${groupUrl}${path} is not a zarr array`);
    }
    return volume;
  };
  const [bounds, ...fields] = await Promise.all([
    metadata.bounds === undefined
      ? Promise.resolve(undefined)
      : openArray(metadata.bounds.path),
    ...metadata.scales.map((s) => openArray(s.path)),
  ]);
  const zarrFields = fields as ZarrMultiscaleVolumeChunkSource[];
  for (const f of zarrFields) {
    if (f.dataType !== DataType.FLOAT32) {
      throw new Error(
        "warp: the displacement field's data type is not float32",
      );
    }
  }
  // The inverse field moves points (mesh vertices) directly; it is optional.
  let inverse: DisplacementField | undefined;
  if (loadInverse && metadata.inverse !== undefined) {
    try {
      inverse = await getDisplacementField(
        registry,
        { url: metadata.inverse },
        options,
        false,
      );
    } catch (e) {
      console.warn(`warp: could not load the inverse field: ${e}`);
    }
  }
  const { vectorAxis, spatialAxes, outputAxes } = metadata;
  const shape = Array.from(zarrFields[0].multiscale.scales[0].metadata.shape);
  const rank = shape.length;
  const numOutput = outputAxes.length;
  // Output dimensions: the output axes, then the vector axis.
  const outputModelDims = [
    ...outputAxes.map(
      (_, i) => spatialAxes[argMaxAbs(metadata.indexToOutput[i].slice(0, -1))],
    ),
    vectorAxis,
  ];
  const levels: DisplacementFieldLevel[] = metadata.scales.map((s, l) => ({
    volume: zarrFields[l],
    indexToOutput: [
      ...s.indexToOutput.map((row) => {
        const out = new Array<number>(rank + 1).fill(0);
        spatialAxes.forEach((a, j) => {
          out[a] = row[j];
        });
        out[rank] = row[spatialAxes.length];
        return out;
      }),
      Array.from({ length: rank + 1 }, (_, j) => (j === vectorAxis ? 1 : 0)),
    ],
    lower: new Array<number>(rank).fill(0),
    maxErrorMeters:
      s.maxError === undefined ? undefined : s.maxError * metadata.unitMeters,
  }));
  // Components displace field system axes; their displacement in output
  // coordinates is the affine's linear part.
  const systemAxisOfOutput = outputAxes.map((_, i) =>
    argMaxAbs(metadata.systemToOutput[i]),
  );
  const field: DisplacementField = {
    url: groupUrl,
    spec,
    kind: "warpfield",
    outputNames: [...outputAxes, metadata.vectorAxisName],
    outputUnits: [...metadata.outputUnits, ""],
    outputScales: [...metadata.outputUnitScales, 1],
    isDisplacementAxis: [...outputAxes.map(() => false), true],
    outputSizes: outputModelDims.map((d) => shape[d]),
    outputModelDims,
    modelRank: rank,
    modelLower: new Array<number>(rank).fill(0),
    modelUpper: shape,
    levels,
    hints: {
      vectorDimension: spec.vectorDimension,
      vectorDimensions: spec.vectorDimensions,
      metadataVectorDimensions: metadata.displacedAxes?.map((name) => {
        const s = metadata.spatialAxisNames.indexOf(name);
        const o = systemAxisOfOutput.indexOf(s);
        return o === -1 ? name : outputAxes[o];
      }),
      // Components are in the field system's axis order.
      componentOrder: outputAxes
        .map((name, i) => ({ name, s: systemAxisOfOutput[i] }))
        .sort((a, b) => a.s - b.s)
        .map((x) => x.name),
    },
    vectorToOutput: (componentOutputDims) => {
      // With every axis displaced, component k is system axis k (whatever
      // the affine); otherwise each displaced output's system axis.
      const systemAxes =
        componentOutputDims.length === spatialAxes.length
          ? componentOutputDims.map((_, k) => k)
          : componentOutputDims.map((c) => systemAxisOfOutput[c]);
      return [...Array(numOutput + 1).keys()].map((o) =>
        systemAxes.map((s) =>
          o === numOutput ? 0 : metadata.systemToOutput[o][s],
        ),
      );
    },
    metadata,
    bounds,
    inverse,
  };
  // A default transform for the warp's transform to modify: model
  // coordinates (voxel n spans [n, n + 1)) -> output coordinates.
  const level0 = levels[0].indexToOutput;
  const inputScales = shape.map((_, a) => {
    if (a === vectorAxis) return 1;
    const o = outputModelDims.indexOf(a);
    return Math.hypot(...level0.map((row) => row[a])) * field.outputScales[o];
  });
  const outputRank = numOutput + 1;
  const transform = new Float64Array((outputRank + 1) ** 2);
  for (let i = 0; i < outputRank; ++i) {
    let t = level0[i][rank];
    for (let j = 0; j < rank; ++j) {
      transform[j * (outputRank + 1) + i] =
        (level0[i][j] * field.outputScales[i]) / inputScales[j];
      t -= 0.5 * level0[i][j];
    }
    transform[outputRank * (outputRank + 1) + i] = t;
  }
  transform[outputRank * (outputRank + 1) + outputRank] = 1;
  const defaultTransform: CoordinateSpaceTransform = {
    rank: outputRank,
    sourceRank: rank,
    inputSpace: makeCoordinateSpace({
      names: shape.map((_, a) =>
        a === vectorAxis
          ? metadata.vectorAxisName
          : metadata.spatialAxisNames[spatialAxes.indexOf(a)],
      ),
      units: shape.map((_, a) =>
        a === vectorAxis ? "" : field.outputUnits[outputModelDims.indexOf(a)],
      ),
      scales: Float64Array.from(inputScales),
      boundingBoxes: [
        makeIdentityTransformedBoundingBox({
          lowerBounds: new Float64Array(rank),
          upperBounds: Float64Array.from(shape),
        }),
      ],
    }),
    outputSpace: makeCoordinateSpace({
      names: field.outputNames,
      units: field.outputUnits,
      scales: Float64Array.from(field.outputScales),
    }),
    transform,
  };
  field.defaultTransform = defaultTransform;
  return applyWarpTransform(field, defaultTransform, spec.transform);
}

async function getGenericDisplacementField(
  registry: DataSourceRegistry,
  spec: WarpSpecification,
  options: GetDisplacementFieldOptions,
): Promise<DisplacementField> {
  const source = await registry.get({
    url: spec.url,
    transform: undefined,
    globalCoordinateSpace: options.globalCoordinateSpace,
    signal: options.signal,
    progressListener: options.progressListener,
  });
  const volume = source.subsources.find((s) => s.subsource.volume)?.subsource
    .volume;
  if (volume === undefined) {
    throw new Error(`warp: ${spec.url} has no volume`);
  }
  if (volume.dataType !== DataType.FLOAT32) {
    throw new Error(
      `warp: the displacement field's data type is ${DataType[volume.dataType].toLowerCase()}, not float32`,
    );
  }
  const defaultTransform = source.modelTransform;
  const { rank, sourceRank, inputSpace, outputSpace } = defaultTransform;
  if (rank !== sourceRank) {
    throw new Error("warp: the displacement field's transform must be square");
  }
  const c = coordinateMatrix(defaultTransform);
  // Model coordinates have voxel n spanning [n, n + 1): sample n is at n + 0.5.
  const indexToOutput = c.map((row) => {
    const out = row.slice();
    for (let j = 0; j < sourceRank; ++j) out[sourceRank] += 0.5 * row[j];
    return out;
  });
  // Voxels span [lower, upper) in model coordinates, so with sample n at
  // index n (coordinate n + 0.5) the indices are lower .. upper - 1. (Channel
  // dimensions are centered on integers: e.g. [-0.5, 1.5) for 2 entries.)
  const lower = Array.from(inputSpace.bounds.lowerBounds);
  const upper = Array.from(inputSpace.bounds.upperBounds);
  const outputModelDims = c.map((row) => argMaxAbs(row.slice(0, -1)));
  const nifti = isNiftiUrl(spec.url);
  // NIfTI (ITK/ANTs) displacement fields: the vector in dimension 5, with
  // components x, y, z in LPS; Neuroglancer's NIfTI space is RAS.
  const niftiVector = nifti && rank >= 5 && outputSpace.names[4] === "c^";
  const frame = spec.vectorFrame ?? (niftiVector ? "LPS" : undefined);
  const vectorUnit =
    spec.vectorUnit === undefined ? undefined : parseUnit(spec.vectorUnit);
  const names = Array.from(outputSpace.names);
  const field: DisplacementField = {
    url: spec.url,
    spec,
    kind: "generic",
    outputNames: names,
    outputUnits: Array.from(outputSpace.units),
    outputScales: Array.from(outputSpace.scales),
    isDisplacementAxis: names.map(() => false),
    outputSizes: outputModelDims.map((d) => Math.round(upper[d] - lower[d])),
    outputModelDims,
    modelRank: sourceRank,
    modelLower: lower,
    modelUpper: upper,
    levels: [{ volume, indexToOutput, lower }],
    hints: {
      vectorDimension: spec.vectorDimension,
      vectorDimensions: spec.vectorDimensions,
      componentOrder: niftiVector ? names.slice(0, 3) : undefined,
    },
    vectorToOutput: (componentOutputDims) =>
      names.map((_, o) =>
        componentOutputDims.map((d, k) => {
          if (o !== d) return 0;
          let v = 1;
          if (vectorUnit !== undefined) {
            v = vectorUnit.scale / outputSpace.scales[d];
          }
          // LPS -> RAS: the first two of NIfTI's x, y, z change sign.
          if (frame === "LPS" && k < 2 && d < 3) v = -v;
          return v;
        }),
      ),
    defaultTransform,
  };
  return applyWarpTransform(field, defaultTransform, spec.transform);
}

export async function getDisplacementField(
  registry: DataSourceRegistry,
  spec: WarpSpecification,
  options: GetDisplacementFieldOptions,
  loadInverse = true,
): Promise<DisplacementField> {
  if (isNonZarrUrl(spec.url)) {
    return getGenericDisplacementField(registry, spec, options);
  }
  const requireWarpfield = () => {
    if (spec.placement !== undefined) {
      throw new Error(
        `warp: ${spec.url} is not an OME-Zarr displacement field (a ` +
          'multiscale with an axis of type "displacement")',
      );
    }
  };
  const groupUrl = normalizeGroupUrl(spec.url);
  const { kvStoreContext } = registry.sharedKvStoreContext;
  let groupJson: unknown;
  try {
    const response = await kvStoreContext.read(`${groupUrl}zarr.json`, options);
    groupJson =
      response === undefined ? undefined : await response.response.json();
  } catch {
    groupJson = undefined;
  }
  const attributes = verifyOptionalObjectProperty(
    groupJson ?? {},
    "attributes",
    verifyObject,
    {},
  );
  // A warpfield (OME displacement multiscale) group; anything else is opened
  // as an ordinary volume.
  const isWarpfield =
    groupJson !== undefined &&
    JSON.stringify(
      verifyOptionalObjectProperty(attributes, "ome", (o) => o) ?? {},
    ).includes('"displacement"');
  if (!isWarpfield) {
    requireWarpfield();
    return getGenericDisplacementField(registry, spec, options);
  }
  const metadata = parseDisplacementFieldMetadata(attributes, spec.placement);
  // A scene's inverse field is in the scene's spaces, not in a placement's.
  if (loadInverse && spec.placement === undefined) {
    metadata.inverse = await findInverseInScene(
      kvStoreContext,
      groupUrl,
      options,
    );
  }
  return getWarpfieldDisplacementField(
    registry,
    groupUrl,
    metadata,
    spec,
    options,
    loadInverse,
  );
}

// --- Small matrix helpers (row-major).

function mat4FromRows(rows: number[][]): number[] {
  const m = new Array<number>(16).fill(0);
  for (let i = 0; i < 3; ++i)
    for (let j = 0; j < 4; ++j) m[i * 4 + j] = rows[i][j];
  m[15] = 1;
  return m;
}

export function mul4(a: number[], b: number[]): number[] {
  const c = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; ++i)
    for (let j = 0; j < 4; ++j)
      for (let k = 0; k < 4; ++k) c[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return c;
}

/** Inverse of an affine row-major 4x4. */
export function inverseAffine4(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = [
    m[0],
    m[1],
    m[2],
    m[4],
    m[5],
    m[6],
    m[8],
    m[9],
    m[10],
  ];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (det === 0) throw new Error("singular transform");
  const r = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  const t = [m[3], m[7], m[11]];
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 3; ++row) {
    for (let col = 0; col < 3; ++col) out[row * 4 + col] = r[row * 3 + col];
    out[row * 4 + 3] = -(
      r[row * 3] * t[0] +
      r[row * 3 + 1] * t[1] +
      r[row * 3 + 2] * t[2]
    );
  }
  out[15] = 1;
  return out;
}

/** Row-major 4x4 from a column-major (rank + 1)^2 homogeneous matrix. */
export function rowMajorFromColumnMajor(
  m: ArrayLike<number>,
  rank: number,
): number[] {
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; ++i) {
    for (let j = 0; j < 4; ++j) {
      const ii = i === 3 ? rank : i;
      const jj = j === 3 ? rank : j;
      out[i * 4 + j] = m[jj * (rank + 1) + ii];
    }
  }
  return out;
}

export function zarrArrayAccess(
  volume: ZarrMultiscaleVolumeChunkSource,
  source: VolumeChunkSource,
): ZarrArrayAccess {
  const { metadata } = volume.multiscale.scales[0];
  const layout = metadata.codecs.layoutInfo[0];
  if (layout.physicalToLogicalDimension.some((d, i) => d !== i)) {
    throw new Error(
      "warp: transposed displacement field arrays are not supported",
    );
  }
  return {
    source: source.rpcId!,
    shape: Array.from(metadata.shape),
    chunkShape: Array.from(layout.readChunkShape),
  };
}

export function canonicalSourceOptions(rank: number): VolumeSourceOptions {
  const m = new Float32Array(rank * rank);
  for (let i = 0; i < rank; ++i) m[i * rank + i] = 1;
  return {
    displayRank: rank,
    multiscaleToViewTransform: m,
    modelChannelDimensionIndices: [],
  };
}

// --- Warp geometry.

export interface WarpGeometryLevel {
  // Warped model coordinates (the F field dimensions) -> model index of the
  // level, one row per model dimension (row-major, columns F + 1). Constant
  // rows for dimensions the field is constant along; the vector row is 0.
  outputToIndex: number[][];
  spacingMeters: number;
  maxErrorMeters: number | undefined;
}

export interface WarpGeometry {
  resolution: WarpDimensionResolution;
  // Number of field dimensions F; the warped model space has them first,
  // then the passthrough dimensions.
  numFieldDims: number;
  // Per field dimension: the field output dimension, the moving output and
  // source dimensions (-1 if the moving source lacks it), and whether it is
  // displaced (otherwise indexed).
  fieldOutputDims: number[];
  movingOutputDims: number[];
  movingInputDims: number[];
  displaced: boolean[];
  // Moving output and source dimensions passed through, and whether each is
  // carried whole (channels).
  passOutputDims: number[];
  passInputDims: number[];
  passWhole: boolean[];
  // Warped model space: the field dimensions, then the passthrough ones.
  modelSpace: CoordinateSpace;
  // Base units per model coordinate, per field dimension.
  scales: number[];
  // Field domain in model coordinates, per field dimension.
  lower: number[];
  upper: number[];
  // Finest field sample spacing in model coordinates, per field dimension.
  fieldSpacing: number[];
  // Model dimension of the field that holds the vector components.
  vectorModelDim: number;
  numComponents: number;
  levels: WarpGeometryLevel[];
  // Components -> displacement in warped model coordinates (F x K).
  vectorToOutput: number[][];
  // Moving source dimensions sampled through the field, ascending.
  spatialInputDims: number[];
  // The 3-d case of before (3 displaced spatial dimensions the moving
  // source has; passthrough dimensions are channels): meshes are warped.
  isSpatial3d: boolean;
  // For the 3-d case: moving output dimensions in field order.
  outputDims: number[];
  messages: string[];
}

export function getWarpGeometry(
  movingTransform: CoordinateSpaceTransform,
  field: DisplacementField,
): WarpGeometry {
  const { outputSpace } = movingTransform;
  const { rank, sourceRank } = movingTransform;
  const resolution = resolveWarpDimensions(
    fieldDimensions(field),
    outputSpace.names.map((name, i) => ({ name, unit: outputSpace.units[i] })),
    field.hints,
  );
  const F = resolution.fieldDims.length;
  const fieldOutputDims = resolution.fieldDims.map((d) => d.fieldDim);
  const movingOutputDims = resolution.fieldDims.map((d) => d.movingDim);
  const displaced = resolution.fieldDims.map((d) => d.role === "displaced");
  const passOutputDims = resolution.passthrough.map((p) => p.movingDim);
  const passWhole = resolution.passthrough.map((p) => p.whole);

  // Moving source dimensions: each matched output dimension comes from its
  // own source dimensions, and warped and passthrough ones do not mix.
  const full = fullRowMajor(movingTransform.transform, rank, sourceRank);
  const coef = (o: number, j: number) => full[o * (sourceRank + 1) + j];
  const inputOf = (o: number, exclude: number[]) => {
    let best = -1;
    for (let j = 0; j < sourceRank; ++j) {
      if (exclude.includes(j)) continue;
      if (best === -1 || Math.abs(coef(o, j)) > Math.abs(coef(o, best))) {
        best = j;
      }
    }
    return best;
  };
  const passInputDims: number[] = [];
  for (const o of passOutputDims) {
    passInputDims.push(inputOf(o, passInputDims));
  }
  const matchedOutputs = movingOutputDims.filter((o) => o !== -1);
  const movingInputDims = movingOutputDims.map((o) =>
    o === -1 ? -1 : inputOf(o, passInputDims),
  );
  const spatialInputDims = movingInputDims
    .filter((j) => j !== -1)
    .sort((a, b) => a - b);
  const mixes =
    spatialInputDims.includes(-1) ||
    new Set(spatialInputDims).size !== spatialInputDims.length ||
    passInputDims.some(
      (j) =>
        j === -1 || coef(passOutputDims[passInputDims.indexOf(j)], j) === 0,
    ) ||
    matchedOutputs.some((o) => passInputDims.some((j) => coef(o, j) !== 0)) ||
    passOutputDims.some((o, p) =>
      [...Array(sourceRank).keys()].some(
        (j) => j !== passInputDims[p] && coef(o, j) !== 0,
      ),
    ) ||
    spatialInputDims.length + passInputDims.length !== sourceRank;
  if (mixes) {
    throw new Error(
      "warp: the source's transform mixes warped dimensions " +
        `${JSON.stringify(matchedOutputs.map((o) => outputSpace.names[o]))} ` +
        "with the others " +
        `${JSON.stringify(passOutputDims.map((o) => outputSpace.names[o]))}`,
    );
  }

  // Warped model space: the field dimensions at the moving source's scales
  // (the field's own for dimensions the source lacks), then passthrough.
  const scales = fieldOutputDims.map((fo, k) =>
    movingOutputDims[k] === -1
      ? field.outputScales[fo]
      : outputSpace.scales[movingOutputDims[k]],
  );
  // field output coordinates -> model coordinates, per field dimension
  const toModel = fieldOutputDims.map(
    (fo, k) => field.outputScales[fo] / scales[k],
  );
  const vectorOutputDim = resolution.vectorDim;
  const vectorModelDim = field.outputModelDims[vectorOutputDim];
  // The model dimensions the field dimensions come from (they may mix among
  // themselves, e.g. a rotated placement); the others are fixed.
  const level0Rows = field.levels[0].indexToOutput;
  const keptAscending = [...Array(field.modelRank).keys()].filter(
    (d) =>
      d !== vectorModelDim &&
      fieldOutputDims.some((fo) => level0Rows[fo][d] !== 0),
  );
  if (
    keptAscending.length !== F ||
    fieldOutputDims.some((fo) => level0Rows[fo][vectorModelDim] !== 0)
  ) {
    throw new Error(
      "warp: the field's transform mixes its warped dimensions with others",
    );
  }
  const levels = field.levels.map((level) => {
    const rows = fieldOutputDims.map((fo, k) =>
      level.indexToOutput[fo].map((v) => v * toModel[k]),
    );
    // Dimensions the field is constant along sit at their lower bound.
    const fixed = [...Array(field.modelRank).keys()].filter(
      (d) => d !== vectorModelDim && !keptAscending.includes(d),
    );
    const block = rows.map((row) => {
      let t = row[field.modelRank];
      for (const d of fixed) {
        if (level.lower[d] !== 0) t += row[d] * level.lower[d];
      }
      return [...keptAscending.map((d) => row[d]), t];
    });
    let inverseRows: number[][];
    if (F === 3) {
      const inv = inverseAffine4(mat4FromRows(block));
      inverseRows = [0, 1, 2].map((i) => inv.slice(i * 4, i * 4 + 4));
    } else {
      inverseRows = inverseAffineRows(block);
    }
    const outputToIndex = [...Array(field.modelRank).keys()].map((d) => {
      const i = keptAscending.indexOf(d);
      if (i !== -1) return inverseRows[i];
      const row = new Array<number>(F + 1).fill(0);
      if (d !== vectorModelDim) row[F] = level.lower[d];
      return row;
    });
    const lengthRows = fieldOutputDims
      .map((fo, k) => ({ fo, k }))
      .filter(({ fo }) => field.outputUnits[fo] === "m");
    const spacingMeters =
      Math.max(
        ...keptAscending.map((d) =>
          Math.hypot(...lengthRows.map(({ fo }) => level.indexToOutput[fo][d])),
        ),
      ) * (lengthRows.length > 0 ? field.outputScales[lengthRows[0].fo] : 1);
    return {
      outputToIndex,
      spacingMeters,
      maxErrorMeters: level.maxErrorMeters,
    };
  });
  const fieldSpacing = fieldOutputDims.map(
    (fo, k) =>
      Math.hypot(...keptAscending.map((d) => level0Rows[fo][d])) * toModel[k],
  );
  const componentOutputDims = resolution.componentDims;
  const fullVector = field.vectorToOutput(componentOutputDims);
  const vectorToOutput = fieldOutputDims.map((fo, k) =>
    fullVector[fo].map((v) => v * toModel[k]),
  );
  // Field domain: samples at lower..upper-1, extended by half a sample.
  const level0 = field.levels[0];
  const lower = new Array<number>(F).fill(Infinity);
  const upper = new Array<number>(F).fill(-Infinity);
  for (let c = 0; c < 1 << F; ++c) {
    const idx = [...Array(field.modelRank).keys()].map((d) => {
      const i = keptAscending.indexOf(d);
      if (i === -1) return d === vectorModelDim ? 0 : level0.lower[d];
      return c & (1 << i)
        ? field.modelUpper[d] - 0.5
        : field.modelLower[d] - 0.5;
    });
    for (let k = 0; k < F; ++k) {
      const row = level0.indexToOutput[fieldOutputDims[k]];
      let v = row[field.modelRank];
      for (let d = 0; d < field.modelRank; ++d) v += row[d] * idx[d];
      v *= toModel[k];
      lower[k] = Math.min(lower[k], v);
      upper[k] = Math.max(upper[k], v);
    }
  }
  const { lowerBounds, upperBounds } = outputSpace.bounds;
  // A displaced dimension the field has one sample along: the field is
  // constant along it, so the warped volume spans the source.
  fieldOutputDims.forEach((fo, k) => {
    const o = movingOutputDims[k];
    if (field.outputSizes[fo] === 1 && displaced[k] && o !== -1) {
      lower[k] = lowerBounds[o];
      upper[k] = upperBounds[o];
    }
  });
  const modelSpace = makeCoordinateSpace({
    names: [
      ...fieldOutputDims.map((fo) => field.outputNames[fo]),
      ...passOutputDims.map((o) => outputSpace.names[o]),
    ],
    units: [
      ...fieldOutputDims.map((fo, k) =>
        movingOutputDims[k] === -1
          ? field.outputUnits[fo]
          : outputSpace.units[movingOutputDims[k]],
      ),
      ...passOutputDims.map((o) => outputSpace.units[o]),
    ],
    scales: Float64Array.from([
      ...scales,
      ...passOutputDims.map((o) => outputSpace.scales[o]),
    ]),
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({
        lowerBounds: Float64Array.from([
          ...lower,
          ...passOutputDims.map((o) => lowerBounds[o]),
        ]),
        upperBounds: Float64Array.from([
          ...upper,
          ...passOutputDims.map((o) => upperBounds[o]),
        ]),
      }),
    ],
  });
  const isSpatial3d =
    F === 3 &&
    displaced.every((d) => d) &&
    movingOutputDims.every((o) => o !== -1 && outputSpace.units[o] === "m") &&
    passWhole.every((w) => w);
  return {
    resolution,
    numFieldDims: F,
    fieldOutputDims,
    movingOutputDims,
    movingInputDims,
    displaced,
    passOutputDims,
    passInputDims,
    passWhole,
    modelSpace,
    scales,
    lower,
    upper,
    fieldSpacing,
    vectorModelDim,
    numComponents: resolution.numComponents,
    levels,
    vectorToOutput,
    spatialInputDims,
    isSpatial3d,
    outputDims: movingOutputDims,
    messages: resolution.messages,
  };
}

/**
 * Worker access to one field level through a chunk source of its volume:
 * the geometry's model indices mapped to chunk indices.
 */
export function fieldLevelAccess(
  geometry: WarpGeometry,
  level: number,
  source: SliceViewSingleResolutionSource<VolumeChunkSource>,
): FieldAccess {
  const { spec } = source.chunkSource;
  const rank = spec.rank;
  const F = geometry.numFieldDims;
  const c2m = fullRowMajor(source.chunkToMultiscaleTransform, rank);
  // Each chunk dimension is one model dimension, scaled and offset.
  const modelOfChunk = [...Array(rank).keys()].map((d) => {
    const m = [...Array(rank).keys()].filter(
      (i) => c2m[i * (rank + 1) + d] !== 0,
    );
    if (m.length !== 1) {
      throw new Error("warp: unsupported displacement field chunk layout");
    }
    return m[0];
  });
  const { outputToIndex } = geometry.levels[level];
  const rows = modelOfChunk.map((m, d) => {
    const a = c2m[m * (rank + 1) + d];
    const b = c2m[m * (rank + 1) + rank];
    const row = outputToIndex[m];
    if (a === 1 && b === 0) return row;
    // model index + 0.5 = a (chunk index + 0.5) + b
    const out = row.map((v) => v / a);
    out[F] += (0.5 - b) / a - 0.5;
    return out;
  });
  return {
    source: source.chunkSource.rpcId!,
    rank,
    chunkDataSize: Array.from(spec.chunkDataSize),
    baseVoxelOffset: Array.from(spec.baseVoxelOffset),
    lowerVoxelBound: Array.from(spec.lowerVoxelBound),
    upperVoxelBound: Array.from(spec.upperVoxelBound),
    vectorDim: modelOfChunk.indexOf(geometry.vectorModelDim),
    numComponents: geometry.numComponents,
    outputToIndex: rows.flat(),
    vectorToOutput: geometry.vectorToOutput.flat(),
  };
}

/**
 * Row-major (rank + 1) x (sourceRank + 1) matrix of a column-major
 * CoordinateSpaceTransform-style homogeneous matrix (rank + 1)^2: the source
 * dimensions' columns, then the translation.
 */
export function fullRowMajor(
  m: ArrayLike<number>,
  rank: number,
  sourceRank = rank,
): number[] {
  const out = new Array<number>((rank + 1) * (sourceRank + 1)).fill(0);
  for (let i = 0; i <= rank; ++i) {
    for (let j = 0; j <= sourceRank; ++j) {
      const jj = j === sourceRank ? rank : j;
      out[i * (sourceRank + 1) + j] = m[jj * (rank + 1) + i];
    }
  }
  return out;
}

/**
 * Row-major 4x4 of the rows `rows` and columns `cols` (and the translation)
 * of a row-major (rank + 1) x (sourceRank + 1) matrix.
 */
export function spatialSubmatrix(
  full: number[],
  sourceRank: number,
  rows: number[],
  cols: number[],
): number[] {
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 3; ++i) {
    for (let j = 0; j < 3; ++j) {
      out[i * 4 + j] = full[rows[i] * (sourceRank + 1) + cols[j]];
    }
    out[i * 4 + 3] = full[rows[i] * (sourceRank + 1) + sourceRank];
  }
  out[15] = 1;
  return out;
}

/**
 * The chunk dimensions of a moving scale that are sampled through the field
 * (those mapping to `spatialInputDims`, in natural order) and the rest.
 */
export function splitChunkDims(
  chunkToMultiscaleTransform: ArrayLike<number>,
  rank: number,
  spatialInputDims: number[],
): { spatialChunkDims: number[]; channelChunkDims: number[] } {
  const full = fullRowMajor(chunkToMultiscaleTransform, rank);
  const spatialChunkDims: number[] = [];
  const channelChunkDims: number[] = [];
  for (let j = 0; j < rank; ++j) {
    const spatial = spatialInputDims.some(
      (r) => full[r * (rank + 1) + j] !== 0,
    );
    (spatial ? spatialChunkDims : channelChunkDims).push(j);
  }
  if (spatialChunkDims.length !== spatialInputDims.length) {
    throw new Error(
      "warp: the moving volume's chunks mix warped and other dimensions",
    );
  }
  return { spatialChunkDims, channelChunkDims };
}

/**
 * Row-major (F + 1) x (spatialInputDims.length + 1): the moving volume's
 * model coordinates of `spatialInputDims` -> warped model coordinates (rows
 * of field dimensions the source lacks are 0). For the 3-d case, a 4x4.
 */
export function movingModelToOutput(
  movingTransform: CoordinateSpaceTransform,
  geometry: WarpGeometry,
): number[] {
  const { rank, sourceRank } = movingTransform;
  const full = fullRowMajor(movingTransform.transform, rank, sourceRank);
  const inScales = movingTransform.inputSpace.scales;
  const outScales = movingTransform.outputSpace.scales;
  const F = geometry.numFieldDims;
  const cols = geometry.spatialInputDims;
  if (geometry.isSpatial3d) {
    const m = spatialSubmatrix(full, sourceRank, geometry.outputDims, cols);
    for (let i = 0; i < 3; ++i) {
      for (let j = 0; j < 3; ++j) {
        m[i * 4 + j] *= inScales[cols[j]] / outScales[geometry.outputDims[i]];
      }
    }
    return m;
  }
  const n = cols.length;
  const out = new Array<number>((F + 1) * (n + 1)).fill(0);
  for (let k = 0; k < F; ++k) {
    const o = geometry.movingOutputDims[k];
    if (o === -1) continue;
    cols.forEach((j, c) => {
      out[k * (n + 1) + c] =
        (full[o * (sourceRank + 1) + j] * inScales[j]) / outScales[o];
    });
    out[k * (n + 1) + n] = full[o * (sourceRank + 1) + sourceRank];
  }
  out[F * (n + 1) + n] = 1;
  return out;
}

/**
 * Builds the warped version of a data source. Registered by
 * `warp/frontend.ts`, which is loaded with the zarr data source
 * (`datasource/zarr/register_default.ts`). Layers look it up here instead of
 * importing `warp/frontend.ts`, so that code which only manages layers (and its
 * tests, which run without WebGL) does not load the volume rendering modules.
 */
export type WarpedDataSourceFactory = (
  chunkManager: ChunkManager,
  moving: DataSource,
  field: DisplacementField,
) => { source: DataSource; messages: string[] };

let warpedDataSourceFactory: WarpedDataSourceFactory | undefined;

export function registerWarpedDataSourceFactory(
  factory: WarpedDataSourceFactory,
) {
  warpedDataSourceFactory = factory;
}

export function getWarpedDataSourceFactory(): WarpedDataSourceFactory {
  if (warpedDataSourceFactory === undefined) {
    throw new Error(
      "Warped data sources are not available: the zarr data source is not enabled",
    );
  }
  return warpedDataSourceFactory;
}
