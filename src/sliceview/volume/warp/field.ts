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
  // All resolutions, finest first (just "path" if not given).
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
  // Field of the inverse transformation, relative to this group.
  inverse?: string;
}

function parseMatrix(rows: number, cols: number) {
  return (x: unknown) =>
    parseFixedLengthArray(new Array<number[]>(rows), x, (row) =>
      parseFixedLengthArray(new Array<number>(cols), row, verifyFiniteFloat),
    );
}

/** Parses `attributes.displacement_field` of a displacement-field group. */
export function parseDisplacementFieldMetadata(
  obj: unknown,
): DisplacementFieldMetadata {
  verifyObject(obj);
  const unit = verifyObjectProperty(obj, "unit", verifyString);
  const unitMeters = UNIT_TO_METERS[unit];
  if (unitMeters === undefined) {
    throw new Error(
      `Unsupported displacement field unit: ${JSON.stringify(unit)}`,
    );
  }
  const interpolation = verifyOptionalObjectProperty(
    obj,
    "interpolation",
    verifyString,
    "linear",
  );
  if (interpolation !== "linear") {
    throw new Error(
      `Unsupported displacement field interpolation: ${JSON.stringify(interpolation)}`,
    );
  }
  const path = verifyObjectProperty(obj, "path", verifyString);
  const indexToOutput = verifyObjectProperty(
    obj,
    "index_to_output",
    parseMatrix(3, 4),
  );
  return {
    path,
    scales: verifyOptionalObjectProperty(
      obj,
      "scales",
      (x) =>
        parseArray(x, (s) => ({
          path: verifyObjectProperty(s, "path", verifyString),
          indexToOutput: verifyObjectProperty(
            s,
            "index_to_output",
            parseMatrix(3, 4),
          ),
          maxError: verifyOptionalObjectProperty(
            s,
            "interpolation_error",
            (e) => verifyObjectProperty(e, "max", verifyFiniteFloat),
          ),
        })),
      [{ path, indexToOutput, maxError: undefined }],
    ),
    vectorAxis: verifyObjectProperty(obj, "vector_axis", verifyInt),
    outputAxes: verifyObjectProperty(obj, "output_axes", (x) =>
      parseFixedLengthArray(new Array<string>(3), x, verifyString),
    ),
    unitMeters,
    indexToOutput,
    vectorToOutput: verifyObjectProperty(
      obj,
      "vector_to_output",
      parseMatrix(3, 3),
    ),
    inverse: verifyOptionalObjectProperty(obj, "inverse", verifyString),
    bounds: verifyOptionalObjectProperty(obj, "bounds", (b) => ({
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
  const metadata = verifyObjectProperty(
    attributes,
    "displacement_field",
    parseDisplacementFieldMetadata,
  );
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
        resolveRelativeUrl(groupUrl, metadata.inverse),
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
  // Warped model space (output axes order).
  modelSpace: CoordinateSpace;
  // Output-axis indices of the moving output space, in field output-axes order.
  outputDims: number[];
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
  if (movingTransform.rank !== 3 || movingTransform.sourceRank !== 3) {
    throw new Error("warp: the moving volume must be 3-dimensional");
  }
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
  const modelSpace = makeCoordinateSpace({
    names: metadata.outputAxes,
    units: ["m", "m", "m"],
    scales: Float64Array.from(scales),
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({
        lowerBounds: Float64Array.from(lower),
        upperBounds: Float64Array.from(upper),
      }),
    ],
  });
  return {
    modelSpace,
    outputDims,
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
export function movingModelToOutput(
  movingTransform: CoordinateSpaceTransform,
  geometry: WarpGeometry,
): number[] {
  const m = rowMajorFromColumnMajor(
    movingTransform.transform,
    movingTransform.rank,
  );
  const inScales = movingTransform.inputSpace.scales;
  const outScales = movingTransform.outputSpace.scales;
  for (let i = 0; i < 3; ++i) {
    for (let j = 0; j < 3; ++j) {
      m[i * 4 + j] *= inScales[j] / outScales[i];
    }
  }
  // Rows of the moving output space, reordered to the field output axes.
  const select = new Array<number>(16).fill(0);
  geometry.outputDims.forEach((d, i) => {
    select[i * 4 + d] = 1;
  });
  select[15] = 1;
  return mul4(select, m);
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
