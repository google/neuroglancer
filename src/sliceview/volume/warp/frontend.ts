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
 * @file Warped volumes: view a moving volume in the space of a displacement
 * field, W(x) = M(x + u(x)), without making a copy of the data.
 *
 * The displacement field is a zarr group (see `parseDisplacementFieldMetadata`)
 * whose `attributes.displacement_field` says how to apply it. Each scale of the
 * moving volume becomes a scale of a warped volume on a grid aligned with the
 * output axes, whose chunks are computed in the worker
 * (`warp/backend.ts`) from field and moving chunks.
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type {
  CoordinateSpace,
  CoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type {
  DataSource,
  DataSourceRegistry,
  DataSubsourceEntry,
} from "#src/datasource/index.js";
import type { MultiscaleVolumeChunkSource as ZarrMultiscaleVolumeChunkSource } from "#src/datasource/zarr/frontend.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import type {
  DisplacementFieldAccess,
  ZarrArrayAccess,
} from "#src/sliceview/volume/warp/base.js";
import {
  WarpedVolumeChunkSourceParameters,
  WarpInterpolation,
} from "#src/sliceview/volume/warp/base.js";
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

// Coarser warped scales are added until the warped grid is at most this many
// voxels across.
const MAX_COARSEST_EXTENT = 256;
const MIN_CHUNK_EDGE = 8;
const COARSE_CHUNK_SCALING = 1;

// Warped chunk shape (a single layout).
const WARPED_CHUNK_SHAPES = [[32, 32, 32]];

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

export async function getDisplacementField(
  registry: DataSourceRegistry,
  url: string,
  options: GetDisplacementFieldOptions,
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
  return {
    url: groupUrl,
    metadata,
    fields: fields as ZarrMultiscaleVolumeChunkSource[],
    bounds,
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

function mul4(a: number[], b: number[]): number[] {
  const c = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; ++i)
    for (let j = 0; j < 4; ++j)
      for (let k = 0; k < 4; ++k) c[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return c;
}

/** Inverse of an affine row-major 4x4. */
function inverseAffine4(m: number[]): number[] {
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
function rowMajorFromColumnMajor(m: ArrayLike<number>, rank: number): number[] {
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

function zarrArrayAccess(
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

function canonicalSourceOptions(rank: number): VolumeSourceOptions {
  const m = new Float32Array(rank * rank);
  for (let i = 0; i < rank; ++i) m[i * rank + i] = 1;
  return {
    displayRank: rank,
    multiscaleToViewTransform: m,
    modelChannelDimensionIndices: [],
  };
}

class WarpedVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  WarpedVolumeChunkSourceParameters,
) {
  dependencies: VolumeChunkSource[] | undefined;
}

interface WarpGeometry {
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

function getWarpGeometry(
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

export class WarpedMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return this.moving.dataType;
  }
  get volumeType() {
    return this.moving.volumeType;
  }
  get rank() {
    return 3;
  }

  constructor(
    chunkManager: ChunkManager,
    public moving: MultiscaleVolumeChunkSource,
    public movingTransform: CoordinateSpaceTransform,
    public field: DisplacementField,
    public geometry: WarpGeometry,
  ) {
    super(chunkManager);
  }

  getSources(
    options: VolumeSourceOptions,
  ): SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    const { field, geometry, movingTransform } = this;
    const movingRank = movingTransform.sourceRank;
    const [movingScales, ...otherAlternatives] = this.moving.getSources(
      canonicalSourceOptions(movingRank),
    );
    for (const alternative of otherAlternatives) {
      for (const s of alternative) s.chunkSource.dispose();
    }
    const modelTransform = rowMajorFromColumnMajor(
      movingTransform.transform,
      movingTransform.rank,
    );
    // Linear coefficients relate physical units: in output coordinates they
    // scale by (input scale / output scale), as in getRenderLayerTransform.
    // The translation is in output coordinates already.
    const inScales = movingTransform.inputSpace.scales;
    const outScales = movingTransform.outputSpace.scales;
    for (let i = 0; i < 3; ++i) {
      for (let j = 0; j < 3; ++j) {
        modelTransform[i * 4 + j] *= inScales[j] / outScales[i];
      }
    }
    // Rows of the moving output space, reordered to the field output axes.
    const select = new Array<number>(16).fill(0);
    geometry.outputDims.forEach((d, i) => {
      select[i * 4 + d] = 1;
    });
    select[15] = 1;
    const chunkToModelOf = (
      movingScale: SliceViewSingleResolutionSource<VolumeChunkSource>,
    ) =>
      mul4(
        select,
        mul4(
          modelTransform,
          rowMajorFromColumnMajor(movingScale.chunkToMultiscaleTransform, 3),
        ),
      );
    const voxelSizeOf = (chunkToModel: number[]) =>
      [0, 1, 2].map((i) =>
        Math.hypot(
          chunkToModel[i * 4],
          chunkToModel[i * 4 + 1],
          chunkToModel[i * 4 + 2],
        ),
      );
    // Warped scales: one per moving scale, then coarser ones sampled from the
    // coarsest moving scale until the warped grid is small, so that zoomed-out
    // views compute few voxels even when the moving volume has one scale.
    const levels: {
      movingScale: SliceViewSingleResolutionSource<VolumeChunkSource>;
      factor: number;
    }[] = movingScales.map((movingScale) => ({ movingScale, factor: 1 }));
    {
      const coarsest = movingScales[movingScales.length - 1];
      const size = voxelSizeOf(chunkToModelOf(coarsest));
      const extent = (factor: number) =>
        Math.max(
          ...[0, 1, 2].map(
            (i) => (geometry.upper[i] - geometry.lower[i]) / (size[i] * factor),
          ),
        );
      for (
        let factor = 2;
        extent(factor / 2) > MAX_COARSEST_EXTENT;
        factor *= 2
      ) {
        coarsest.chunkSource.addRef();
        levels.push({ movingScale: coarsest, factor });
      }
    }
    const sources = levels.map(({ movingScale, factor }) => {
      const chunkToModel = chunkToModelOf(movingScale);
      // Voxel size of this scale along each output axis.
      const voxelSize = voxelSizeOf(chunkToModel).map((v) => v * factor);
      const upperVoxelBound = Float32Array.from([0, 1, 2], (i) =>
        Math.max(
          1,
          Math.ceil((geometry.upper[i] - geometry.lower[i]) / voxelSize[i]),
        ),
      );
      const warpedToOutput = [
        voxelSize[0],
        0,
        0,
        geometry.lower[0],
        0,
        voxelSize[1],
        0,
        geometry.lower[1],
        0,
        0,
        voxelSize[2],
        geometry.lower[2],
        0,
        0,
        0,
        1,
      ];
      const chunkToMultiscaleTransform = new Float32Array(16);
      for (let i = 0; i < 4; ++i) {
        for (let j = 0; j < 4; ++j) {
          chunkToMultiscaleTransform[j * 4 + i] = warpedToOutput[i * 4 + j];
        }
      }
      const movingSource = movingScale.chunkSource;
      // The coarsest field level accurate enough for this scale: its measured
      // interpolation error is at most half a voxel (or, if not measured, its
      // spacing is at most a voxel).
      const warpedVoxelMeters = Math.max(
        ...voxelSize.map((v, i) => v * geometry.scales[i]),
      );
      let level = 0;
      while (level + 1 < geometry.levels.length) {
        const next = geometry.levels[level + 1];
        const ok =
          next.maxErrorMeters !== undefined
            ? next.maxErrorMeters <= 0.5 * warpedVoxelMeters
            : next.spacingMeters <= warpedVoxelMeters * 1.0001;
        if (!ok) break;
        ++level;
      }
      const fieldVolume = field.fields[level];
      const parameters = (
        fieldSource: VolumeChunkSource,
        boundsSource: VolumeChunkSource | undefined,
      ): WarpedVolumeChunkSourceParameters => ({
        movingSource: movingSource.rpcId!,
        outputToMoving: inverseAffine4(chunkToModel),
        warpedToOutput,
        field: {
          array: zarrArrayAccess(fieldVolume, fieldSource),
          vectorAxis: field.metadata.vectorAxis,
          outputToIndex: geometry.levels[level].outputToIndex,
          vectorToOutput: geometry.vectorToOutput,
          bounds:
            boundsSource === undefined
              ? undefined
              : {
                  array: zarrArrayAccess(field.bounds!, boundsSource),
                  blockShape: field.metadata.bounds!.blockShape,
                  outputToIndex: geometry.levels[0].outputToIndex,
                  unitToOutput: geometry.scales.map(
                    (s) => field.metadata.unitMeters / s,
                  ),
                },
        } satisfies DisplacementFieldAccess,
        // Labels are never interpolated. Segmentation layers request their
        // sources with discreteValues; the volume type alone is not enough
        // (zarr, for one, reports label arrays as images).
        interpolation:
          options.discreteValues || this.volumeType === VolumeType.SEGMENTATION
            ? WarpInterpolation.NEAREST
            : WarpInterpolation.LINEAR,
      });
      // One alternative per orientation: chunks thin along one axis, so that a
      // cross section only computes (and fetches moving data for) a thin slab.
      return WARPED_CHUNK_SHAPES.map((chunkDataSize, alternative) => {
        const spec = makeDefaultVolumeChunkSpecifications({
          rank: 3,
          chunkToMultiscaleTransform,
          dataType: this.dataType,
          upperVoxelBound,
          volumeType: this.volumeType,
          // Scales added above the moving ones keep the base scale's physical
          // chunk size (down to a minimum edge), so a cross section still
          // needs only a thin slab of moving data.
          chunkDataSizes: [
            Uint32Array.from(chunkDataSize, (c) =>
              Math.max(
                MIN_CHUNK_EDGE,
                Math.round(c / (factor * COARSE_CHUNK_SCALING)),
              ),
            ),
          ],
          volumeSourceOptions: options,
        })[0];
        // Each alternative holds its own references to its dependencies.
        if (alternative > 0) movingSource.addRef();
        const fieldSource = fieldVolume.getSources(
          canonicalSourceOptions(4),
        )[0][0].chunkSource;
        const boundsSource =
          field.bounds === undefined || field.metadata.bounds === undefined
            ? undefined
            : field.bounds.getSources(canonicalSourceOptions(4))[0][0]
                .chunkSource;
        const dependencies = [movingSource, fieldSource];
        if (boundsSource !== undefined) dependencies.push(boundsSource);
        const chunkSource = this.chunkManager.getChunkSource(
          WarpedVolumeChunkSource,
          { spec, parameters: parameters(fieldSource, boundsSource) },
        );
        // The warped source keeps its dependencies alive; a memoized one
        // already holds its own references.
        if (chunkSource.dependencies === undefined) {
          chunkSource.dependencies = dependencies;
          for (const d of dependencies) chunkSource.registerDisposer(d);
        } else {
          for (const d of dependencies) d.dispose();
        }
        return { chunkSource, chunkToMultiscaleTransform };
      });
    });
    // [scale][alternative] -> [alternative][scale]
    return WARPED_CHUNK_SHAPES.map((_, a) => sources.map((s) => s[a]));
  }
}

/**
 * Wraps a loaded data source so that its volumes are shown in the space of a
 * displacement field. Non-spatial subsources (segment properties) are kept;
 * spatial ones that are not warped (meshes, annotations, ...) are dropped.
 */
export function makeWarpedDataSource(
  chunkManager: ChunkManager,
  moving: DataSource,
  field: DisplacementField,
): DataSource {
  const geometry = getWarpGeometry(moving.modelTransform, field);
  const subsources: DataSubsourceEntry[] = [];
  for (const entry of moving.subsources) {
    const { volume, segmentPropertyMap } = entry.subsource;
    if (volume === undefined) {
      if (segmentPropertyMap !== undefined) {
        subsources.push({
          id: entry.id,
          default: entry.default,
          subsource: { segmentPropertyMap },
        });
      }
      continue;
    }
    const warped = new WarpedMultiscaleVolumeChunkSource(
      chunkManager,
      volume,
      moving.modelTransform,
      field,
      geometry,
    );
    subsources.push({
      id: entry.id,
      default: entry.default,
      subsource: { volume: warped },
    });
  }
  if (!subsources.some((s) => s.subsource.volume !== undefined)) {
    throw new Error("warp: the data source has no volume to warp");
  }
  return {
    subsources,
    modelTransform: makeIdentityTransform(geometry.modelSpace),
    channelMetadata: moving.channelMetadata,
  };
}
