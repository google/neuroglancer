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
 * @file Displacement fields for warped sources: the field group's metadata,
 * loading it, and the geometry shared by warped volumes
 * (`warp/frontend.ts`) and warped meshes (`mesh/warp/frontend.ts`).
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type {
  CoordinateSpace,
  CoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type { DataSource, DataSourceRegistry } from "#src/datasource/index.js";
import type { MultiscaleVolumeChunkSource as ZarrMultiscaleVolumeChunkSource } from "#src/datasource/zarr/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { ZarrArrayAccess } from "#src/sliceview/volume/warp/base.js";
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
} from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

const UNIT_TO_METERS: Record<string, number> = {
  meter: 1,
  millimeter: 1e-3,
  micrometer: 1e-6,
  nanometer: 1e-9,
};

export interface DisplacementFieldMetadata {
  path: string;
  vectorAxis: number;
  outputAxes: string[];
  // Meters per unit of the field's output coordinates and vectors.
  unitMeters: number;
  // Row-major 3x4: spatial array index (sample n at n) -> output, of "path".
  indexToOutput: number[][];
  // All resolutions, finest first.
  scales: {
    path: string;
    indexToOutput: number[][];
    // Max deviation from the finest level when linearly interpolated, in field
    // units, if known.
    maxError?: number;
  }[];
  // Row-major 3x3: components -> output displacement.
  vectorToOutput: number[][];
  bounds?: { path: string; blockShape: number[] };
  // URL of the field of the inverse transformation (from the scene).
  inverse?: string;
}

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

/**
 * Parses a displacement field: an OME-Zarr 0.6 multiscale image with one axis
 * of type "displacement" (RFC-5), whose vectors are expressed in the
 * coordinate system its datasets map to. An affine in the multiscale's
 * coordinateTransformations, from that coordinate system to another one, gives
 * the output space (otherwise the output space is that coordinate system).
 * `attributes.warpfield` adds per-level interpolation errors and the bounds
 * array.
 */
export function parseDisplacementFieldMetadata(
  attributes: unknown,
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
  if (spatial.length !== 3) {
    throw new Error("Only 3-d displacement fields are supported");
  }
  const units = new Set(spatial.map((i) => fieldSystem.axes[i].unit ?? ""));
  const unit = [...units][0];
  const unitMeters = UNIT_TO_METERS[unit];
  if (units.size !== 1 || unitMeters === undefined) {
    throw new Error(
      `Unsupported displacement field units: ${JSON.stringify([...units])}`,
    );
  }
  // Optional affine from the field's coordinate system to the output space.
  let affine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ];
  let outputAxes = spatial.map((i) => fieldSystem.axes[i].name);
  const extra = verifyOptionalObjectProperty(
    multiscale,
    "coordinateTransformations",
    (x) => parseArray(x, (t) => t),
    [],
  );
  for (const t of extra) {
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
    outputAxes = outputSystem.axes
      .filter((a) => a.type !== "displacement")
      .map((a) => a.name);
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
      const err = verifyOptionalObjectProperty(l, "interpolation_error", (e) =>
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
      row[3] + spatial.reduce((a, c, j) => a + row[j] * translation[c], 0),
    ]);
    return { path, indexToOutput, maxError: levelErrors.get(path) };
  });
  return {
    path: scales[0].path,
    vectorAxis,
    outputAxes,
    unitMeters,
    indexToOutput: scales[0].indexToOutput,
    scales,
    vectorToOutput: affine.map((row) => row.slice(0, 3)),
    bounds: verifyOptionalObjectProperty(extras, "bounds", (b) => ({
      path: verifyObjectProperty(b, "path", verifyString),
      blockShape: verifyObjectProperty(b, "block_shape", (x) =>
        parseFixedLengthArray(new Array<number>(3), x, verifyInt),
      ),
    })),
  };
}

export interface DisplacementField {
  url: string;
  metadata: DisplacementFieldMetadata;
  // One array per entry of metadata.scales.
  fields: ZarrMultiscaleVolumeChunkSource[];
  // The field of the inverse transformation, if the metadata names one.
  inverse?: DisplacementField;
  bounds: ZarrMultiscaleVolumeChunkSource | undefined;
}

export interface GetDisplacementFieldOptions extends Partial<ProgressOptions> {
  globalCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  signal: AbortSignal;
}

/** Normalizes "zarr3://URL", "URL|zarr3:" and "URL" to a group URL ending in "/". */
function normalizeGroupUrl(url: string) {
  let u = url.trim();
  u = u.replace(/^zarr[23]?:\/\//, "");
  u = u.replace(/\|zarr[23]?:$/, "");
  if (!u.endsWith("/")) u += "/";
  return u;
}

/** Resolves `relative` (which may use "..") against a group URL ending in "/". */
function resolveRelativeUrl(groupUrl: string, relative: string) {
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

export async function getDisplacementField(
  registry: DataSourceRegistry,
  url: string,
  options: GetDisplacementFieldOptions,
  loadInverse = true,
): Promise<DisplacementField> {
  const groupUrl = normalizeGroupUrl(url);
  const { kvStoreContext } = registry.sharedKvStoreContext;
  const response = await kvStoreContext.read(`${groupUrl}zarr.json`, options);
  if (response === undefined) {
    throw new Error(`No zarr group at ${groupUrl}`);
  }
  const groupJson = await response.response.json();
  const attributes = verifyOptionalObjectProperty(
    groupJson,
    "attributes",
    verifyObject,
    {},
  );
  const metadata = parseDisplacementFieldMetadata(attributes);
  if (loadInverse) {
    metadata.inverse = await findInverseInScene(
      kvStoreContext,
      groupUrl,
      options,
    );
  }
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
  // The inverse field moves points (mesh vertices) directly; it is optional.
  let inverse: DisplacementField | undefined;
  if (loadInverse && metadata.inverse !== undefined) {
    try {
      inverse = await getDisplacementField(
        registry,
        metadata.inverse,
        options,
        false,
      );
    } catch (e) {
      console.warn(`warp: could not load the inverse field: ${e}`);
    }
  }
  return {
    url: groupUrl,
    metadata,
    fields: fields as ZarrMultiscaleVolumeChunkSource[],
    bounds,
    inverse,
  };
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

export interface WarpGeometry {
  // Warped model space: the field output axes, then the moving volume's
  // channel dimensions.
  modelSpace: CoordinateSpace;
  // Output-axis indices of the moving output space, in field output-axes order.
  outputDims: number[];
  // Output-axis indices of the moving volume's channel (non-spatial) dimensions.
  channelDims: number[];
  // Moving source (input) dimensions that are spatial, in ascending order.
  spatialInputDims: number[];
  // Meters per model unit, per axis.
  scales: number[];
  // Field domain in model coordinates.
  lower: number[];
  upper: number[];
  // Per field level: output -> index, and sample spacing in meters.
  levels: {
    outputToIndex: number[];
    spacingMeters: number;
    maxErrorMeters: number | undefined;
  }[];
  vectorToOutput: number[];
}

export function getWarpGeometry(
  movingTransform: CoordinateSpaceTransform,
  field: DisplacementField,
): WarpGeometry {
  const { metadata } = field;
  const { outputSpace } = movingTransform;
  const { rank, sourceRank } = movingTransform;
  const outputDims = metadata.outputAxes.map((name) => {
    const i = outputSpace.names.indexOf(name);
    if (i === -1) {
      throw new Error(
        `warp: the moving volume has no output dimension ${JSON.stringify(name)} ` +
          `(it has ${JSON.stringify(outputSpace.names)})`,
      );
    }
    if (outputSpace.units[i] !== "m") {
      throw new Error(
        `warp: dimension ${name} of the moving volume is not spatial`,
      );
    }
    return i;
  });
  // The other output dimensions are channels (e.g. "c^"), carried through
  // unwarped; each must come from source dimensions of its own.
  const channelDims = [...Array(rank).keys()].filter(
    (i) => !outputDims.includes(i),
  );
  for (const i of channelDims) {
    if (outputSpace.units[i] === "m") {
      throw new Error(
        `warp: spatial dimension ${outputSpace.names[i]} of the moving volume ` +
          "is not an output axis of the displacement field",
      );
    }
  }
  const full = fullRowMajor(movingTransform.transform, rank, sourceRank);
  const spatialInputDims = outputDims
    .map((o) => {
      let best = -1;
      for (let j = 0; j < sourceRank; ++j) {
        if (channelDims.some((c) => full[c * (sourceRank + 1) + j] !== 0)) {
          continue;
        }
        if (
          best === -1 ||
          Math.abs(full[o * (sourceRank + 1) + j]) >
            Math.abs(full[o * (sourceRank + 1) + best])
        ) {
          best = j;
        }
      }
      return best;
    })
    // Natural order: the moving chunk's spatial dimensions keep their order.
    .sort((a, b) => a - b);
  if (
    spatialInputDims.includes(-1) ||
    new Set(spatialInputDims).size !== 3 ||
    sourceRank - 3 !== channelDims.length
  ) {
    throw new Error(
      "warp: the moving volume must have 3 spatial dimensions, plus " +
        "channel dimensions that do not mix with them",
    );
  }
  const scales = outputDims.map((i) => outputSpace.scales[i]);
  // field units -> model coordinates, per axis
  const toModel = scales.map((s) => metadata.unitMeters / s);
  const toModelMatrix = (rows: number[][]) =>
    mat4FromRows(rows.map((row, i) => row.map((v) => v * toModel[i])));
  const indexToOutput = toModelMatrix(metadata.scales[0].indexToOutput);
  const levels = metadata.scales.map((s) => ({
    outputToIndex: inverseAffine4(toModelMatrix(s.indexToOutput)),
    spacingMeters:
      Math.max(
        ...[0, 1, 2].map((j) =>
          Math.hypot(...s.indexToOutput.map((row) => row[j])),
        ),
      ) * metadata.unitMeters,
    maxErrorMeters:
      s.maxError === undefined ? undefined : s.maxError * metadata.unitMeters,
  }));
  const vectorToOutput = metadata.vectorToOutput.flatMap((row, i) =>
    row.map((v) => v * toModel[i]),
  );
  // Field domain: samples at 0..N-1, extended by half a sample.
  const shape = field.fields[0].multiscale.scales[0].metadata.shape.filter(
    (_, a) => a !== metadata.vectorAxis,
  );
  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; ++c) {
    const p = [0, 1, 2].map((a) => (c & (1 << a) ? shape[a] - 0.5 : -0.5));
    for (let i = 0; i < 3; ++i) {
      const v =
        indexToOutput[i * 4] * p[0] +
        indexToOutput[i * 4 + 1] * p[1] +
        indexToOutput[i * 4 + 2] * p[2] +
        indexToOutput[i * 4 + 3];
      lower[i] = Math.min(lower[i], v);
      upper[i] = Math.max(upper[i], v);
    }
  }
  const { lowerBounds, upperBounds } = outputSpace.bounds;
  const modelSpace = makeCoordinateSpace({
    names: [
      ...metadata.outputAxes,
      ...channelDims.map((i) => outputSpace.names[i]),
    ],
    units: ["m", "m", "m", ...channelDims.map((i) => outputSpace.units[i])],
    scales: Float64Array.from([
      ...scales,
      ...channelDims.map((i) => outputSpace.scales[i]),
    ]),
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({
        lowerBounds: Float64Array.from([
          ...lower,
          ...channelDims.map((i) => lowerBounds[i]),
        ]),
        upperBounds: Float64Array.from([
          ...upper,
          ...channelDims.map((i) => upperBounds[i]),
        ]),
      }),
    ],
  });
  return {
    modelSpace,
    outputDims,
    channelDims,
    spatialInputDims,
    scales,
    lower,
    upper,
    levels,
    vectorToOutput,
  };
}

/**
 * Moving model coordinates -> warped output coordinates (field output axes
 * order), as a row-major 4x4. Linear coefficients of a coordinate space
 * transform relate physical units, so in coordinates they scale by
 * (input scale / output scale), as in getRenderLayerTransform; the
 * translation is in output coordinates already.
 */
/**
 * Row-major (rank + 1) x (sourceRank + 1) matrix of a column-major
 * CoordinateSpaceTransform-style homogeneous matrix.
 */
export function fullRowMajor(
  m: ArrayLike<number>,
  rank: number,
  sourceRank = rank,
): number[] {
  const out = new Array<number>((rank + 1) * (sourceRank + 1)).fill(0);
  for (let i = 0; i <= rank; ++i) {
    for (let j = 0; j <= sourceRank; ++j) {
      out[i * (sourceRank + 1) + j] = m[j * (rank + 1) + i];
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
 * The chunk dimensions of a moving scale that are spatial (those mapping to
 * the model's `spatialInputDims`, in natural order) and the rest (channels).
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
  if (spatialChunkDims.length !== 3) {
    throw new Error(
      "warp: the moving volume's chunks must have 3 spatial dimensions",
    );
  }
  return { spatialChunkDims, channelChunkDims };
}

/**
 * Row-major 4x4: the moving volume's spatial model coordinates (its
 * `spatialInputDims`) -> warped model coordinates (field output axes).
 */
export function movingModelToOutput(
  movingTransform: CoordinateSpaceTransform,
  geometry: WarpGeometry,
): number[] {
  const { rank, sourceRank } = movingTransform;
  const m = spatialSubmatrix(
    fullRowMajor(movingTransform.transform, rank, sourceRank),
    sourceRank,
    geometry.outputDims,
    geometry.spatialInputDims,
  );
  const inScales = movingTransform.inputSpace.scales;
  const outScales = movingTransform.outputSpace.scales;
  for (let i = 0; i < 3; ++i) {
    for (let j = 0; j < 3; ++j) {
      m[i * 4 + j] *=
        inScales[geometry.spatialInputDims[j]] /
        outScales[geometry.outputDims[i]];
    }
  }
  return m;
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
) => DataSource;

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
