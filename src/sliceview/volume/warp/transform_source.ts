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
 * @file Transform sources: the transformation from a data source's space to
 * the layer's, given by URL ("transformSource" on a layer data source) or by
 * the source's own metadata (an OME-Zarr image whose transformation has a
 * displacement field).
 *
 * A transform source is one of
 * - an RFC-5 transformation (OME-Zarr 0.6): linear transformations and at
 *   most one displacement field, split into post ∘ W ∘ pre (see
 *   `parseOmeTransformChain`). It is read from an OME-Zarr scene, a group of
 *   transformations, an image (its transformation from its intrinsic system),
 *   or a JSON file holding such metadata;
 * - a displacement field alone (a warpfield OME-Zarr group, or any volume the
 *   data source registry can open, e.g. a NIfTI ITK field), placed in its own
 *   output space.
 *
 * The data source's own transform (the layer's "transform", edited in the
 * Source tab) is applied after the transform source, so that it starts as the
 * chain's last linear part (`post`); with "prependTransform", it is applied
 * before, starting as the source's own placement.
 *
 * Documentation: docs/concepts/transform_sources.rst.
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type {
  CoordinateArray,
  CoordinateSpace,
  CoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import {
  getOutputSpaceWithTransformedBoundingBoxes,
  makeCoordinateSpace,
} from "#src/coordinate_transform.js";
import type { DataSource, DataSourceRegistry } from "#src/datasource/index.js";
import type {
  OmeChainAxis,
  OmeTransformChain,
} from "#src/datasource/zarr/ome.js";
import {
  getOmeIntrinsicSystem,
  getOmeTransformations,
  omeAxisDimensionName,
  omeTransformChainLinear,
  parseOmeTransformChain,
  parseOmeUnit,
  resolveTransformPath,
} from "#src/datasource/zarr/ome.js";
import { coordinateMatrix } from "#src/sliceview/volume/warp/affine.js";
import type {
  GetDisplacementFieldOptions,
  WarpSpecification,
} from "#src/sliceview/volume/warp/field.js";
import {
  getDisplacementField,
  getStoredInverseField,
  getWarpedDataSourceFactory,
  isDisplacementField,
  isNonZarrUrl,
  normalizeGroupUrl,
  parseWarpSpecification,
  readJson,
  warpSpecificationToJson,
} from "#src/sliceview/volume/warp/field.js";
import {
  verifyBoolean,
  verifyObject,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";

export type TransformChain = OmeTransformChain;

// --- The specification ("transformSource" on a layer data source).

export interface TransformSourceSpecification extends WarpSpecification {
  // The transformation to use, by name, when the metadata has several.
  name?: string;
  // Use the transformation from its output system to its input system.
  inverse?: boolean;
}

export function parseTransformSourceSpecification(
  x: unknown,
): TransformSourceSpecification {
  if (typeof x === "string") return { url: x };
  verifyObject(x);
  const fieldTransform = (x as Record<string, unknown>).fieldTransform;
  return {
    // The displacement field options; "fieldTransform" places (and may
    // rename) a field given alone.
    ...parseWarpSpecification({
      ...(x as Record<string, unknown>),
      transform: fieldTransform,
    }),
    name: verifyOptionalObjectProperty(x, "name", verifyString),
    inverse: verifyOptionalObjectProperty(x, "inverse", verifyBoolean),
  };
}

export function transformSourceSpecificationToJson(
  spec: TransformSourceSpecification | undefined,
) {
  if (spec === undefined) return undefined;
  const warp = warpSpecificationToJson(spec);
  if (
    typeof warp === "string" &&
    spec.name === undefined &&
    spec.inverse !== true
  ) {
    return warp;
  }
  const { transform, ...rest } =
    typeof warp === "string" ? { url: warp, transform: undefined } : warp!;
  return {
    ...rest,
    fieldTransform: transform,
    name: spec.name,
    inverse: spec.inverse === true ? true : undefined,
  };
}

// --- Loading.

export type ResolvedTransformSource =
  | { kind: "chain"; chain: TransformChain }
  | { kind: "field"; spec: WarpSpecification };

function transformationLabel(t: {
  name?: string;
  input: { name?: string; path?: string };
  output: { name?: string; path?: string };
}) {
  const ref = (r: { name?: string; path?: string }) => r.name ?? r.path ?? "?";
  return t.name ?? `${ref(t.input)} -> ${ref(t.output)}`;
}

/**
 * Reads a transform source: an RFC-5 transformation, or a displacement field
 * given alone.
 */
export async function resolveTransformSource(
  registry: DataSourceRegistry,
  spec: TransformSourceSpecification,
  options: GetDisplacementFieldOptions,
): Promise<ResolvedTransformSource> {
  const url = spec.url.trim();
  const chooses = spec.name !== undefined || spec.inverse === true;
  const asField = (): ResolvedTransformSource => {
    if (chooses) {
      throw new Error(
        `${url} is not a group of transformations ("name" and "inverse" ` +
          "choose among an OME-Zarr scene's transformations)",
      );
    }
    return { kind: "field", spec };
  };
  let ome: unknown;
  let baseUrl: string;
  const isJsonFile = /\.json$/i.test(url);
  if (isJsonFile) {
    // A JSON file: OME-Zarr metadata ({"ome": ...}, a zarr.json, or the
    // contents of "ome").
    const json = (await readJson(registry, url, options)) as
      | Record<string, any>
      | undefined;
    if (json === undefined) throw new Error(`Could not read ${url}`);
    ome = json.ome ?? json.attributes?.ome ?? json;
    baseUrl = url.replace(/[^/]*$/, "");
  } else {
    if (isNonZarrUrl(url)) return asField();
    baseUrl = normalizeGroupUrl(url);
    const json = (await readJson(registry, `${baseUrl}zarr.json`, options)) as
      | Record<string, any>
      | undefined;
    ome = json?.attributes?.ome;
    // A plain array, or a zarr v2 group: a field opened as a volume.
    if (ome === undefined) return asField();
  }
  if (isDisplacementField(ome)) {
    if (isJsonFile) {
      throw new Error(`${url} describes a displacement field: give its group`);
    }
    return asField();
  }
  const found = getOmeTransformations(ome);
  if (found === undefined || found.transformations.length === 0) {
    // An image without RFC-5 transformations (e.g. OME-Zarr 0.4/0.5) is a
    // field given as a volume, as is any other group of data.
    if (!isJsonFile && found?.kind !== "scene") return asField();
    throw new Error(`${url} has no RFC-5 coordinate transformations`);
  }
  let candidates = found.transformations;
  if (spec.name !== undefined) {
    candidates = candidates.filter((t) => transformationLabel(t) === spec.name);
    if (candidates.length === 0) {
      throw new Error(
        `${url} has no transformation named ${JSON.stringify(spec.name)}; ` +
          `it has ${JSON.stringify(found.transformations.map(transformationLabel))}`,
      );
    }
  }
  // An image's first transformation is the one its own layer uses.
  if (candidates.length > 1 && found.kind !== "image") {
    throw new Error(
      `${url} has ${candidates.length} transformations; choose one by ` +
        `"name": ${JSON.stringify(candidates.map(transformationLabel))}`,
    );
  }
  const entry = candidates[0];
  const axesOf = async (ref: {
    name?: string;
    path?: string;
  }): Promise<OmeChainAxis[]> => {
    const system = found.systems.find((c) => c.name === ref.name);
    if (system !== undefined) return system.axes;
    if (ref.path !== undefined) {
      // An image of the scene: its intrinsic system, or one named.
      const imageUrl = resolveTransformPath(baseUrl, ref.path);
      const json = (await readJson(
        registry,
        `${imageUrl}zarr.json`,
        options,
      )) as Record<string, any> | undefined;
      const imageOme = json?.attributes?.ome;
      if (imageOme === undefined) {
        throw new Error(`Could not read the OME-Zarr image ${imageUrl}`);
      }
      const { name: intrinsic, systems } = getOmeIntrinsicSystem(imageOme);
      const imageSystem = systems.find(
        (c) => c.name === (ref.name ?? intrinsic),
      );
      if (imageSystem !== undefined) return imageSystem.axes;
    }
    throw new Error(
      `Unknown coordinate system ${JSON.stringify(ref.name ?? ref.path)}`,
    );
  };
  const [inputAxes, outputAxes] = await Promise.all([
    axesOf(entry.input),
    axesOf(entry.output),
  ]);
  return {
    kind: "chain",
    chain: parseOmeTransformChain(
      entry.transformation,
      inputAxes,
      outputAxes,
      baseUrl,
      spec.inverse === true,
    ),
  };
}

// --- Neuroglancer transforms of a chain.

/** A chain axis as a Neuroglancer dimension; scale: base units per unit. */
interface ChainDimension {
  name: string;
  unit: string;
  scale: number;
}

function chainDimensions(axes: OmeChainAxis[]): ChainDimension[] {
  return axes.map((a) => {
    const { unit, scale } = parseOmeUnit(a.unit);
    return { name: omeAxisDimensionName(a), unit, scale };
  });
}

/**
 * The dimensions of `space` that a chain's input axes are, by name (an axis
 * "c" of type channel is the dimension "c'"). If no name matches, the space
 * axes are the length dimensions of `space`, in order, when there are as
 * many.
 */
export function matchChainAxes(
  axes: OmeChainAxis[],
  space: CoordinateSpace,
): number[] {
  const names = space.names;
  const dims = axes.map((a) => {
    let d = names.indexOf(omeAxisDimensionName(a));
    if (d === -1) d = names.indexOf(a.name);
    return d;
  });
  if (dims.every((d) => d !== -1) && new Set(dims).size === dims.length) {
    return dims;
  }
  if (dims.every((d) => d === -1)) {
    const lengthDims = [...names.keys()].filter((i) => space.units[i] === "m");
    const isLength = axes.every((a) => parseOmeUnit(a.unit).unit === "m");
    if (isLength && lengthDims.length === axes.length) return lengthDims;
  }
  throw new Error(
    `The transformation's input axes ` +
      `${JSON.stringify(axes.map(omeAxisDimensionName))} do not match the ` +
      `source's dimensions ${JSON.stringify(names)}`,
  );
}

/**
 * `t` followed by `affine` (homogeneous (n + 1)^2, column-major, in chain
 * units) on the dimensions `dims` of t's output, which are the chain's input
 * axes, with `inScales` base units per chain unit. The output dimensions are
 * `outDims` (the chain's output axes), then t's other output dimensions
 * unchanged. Output scales are about one voxel of t's input, so that
 * coordinates count voxels as for other sources.
 */
export function composeChainAffine(
  t: CoordinateSpaceTransform,
  dims: number[],
  inScales: number[],
  affine: Float64Array,
  outDims: ChainDimension[],
): CoordinateSpaceTransform {
  const { rank, sourceRank, inputSpace, outputSpace } = t;
  if (sourceRank !== rank) {
    throw new Error(
      "A transform source cannot follow a transform that adds dimensions",
    );
  }
  const n = dims.length;
  // Output coordinates per input coordinate (rows: output dimensions).
  const c = coordinateMatrix(t);
  // Chain coordinates per input coordinate.
  const chain = dims.map((d, k) =>
    c[d].map((v) => (v * outputSpace.scales[d]) / inScales[k]),
  );
  const rows: number[][] = [];
  const names: string[] = [];
  const units: string[] = [];
  const scales: number[] = [];
  const coordinateArrays: (CoordinateArray | undefined)[] = [];
  for (let i = 0; i < n; ++i) {
    const row = new Array<number>(rank + 1).fill(0);
    for (let k = 0; k < n; ++k) {
      const a = affine[k * (n + 1) + i];
      if (a !== 0) chain[k].forEach((v, j) => (row[j] += a * v));
    }
    row[rank] += affine[n * (n + 1) + i];
    const unitScale = outDims[i].scale;
    let scale = 0;
    for (let j = 0; j < rank; ++j) {
      scale = Math.max(scale, Math.abs(row[j]) * unitScale);
    }
    scale = scale === 0 ? unitScale : Number(scale.toPrecision(6));
    rows.push(row.map((v) => (v * unitScale) / scale));
    names.push(outDims[i].name);
    units.push(outDims[i].unit);
    scales.push(scale);
    coordinateArrays.push(undefined);
  }
  for (let d = 0; d < rank; ++d) {
    if (dims.includes(d)) continue;
    rows.push(c[d]);
    names.push(outputSpace.names[d]);
    units.push(outputSpace.units[d]);
    scales.push(outputSpace.scales[d]);
    coordinateArrays.push(outputSpace.coordinateArrays[d]);
  }
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) {
    throw new Error(
      `The transformation's output dimension ${JSON.stringify(duplicate)} ` +
        "is also one of the source's other dimensions",
    );
  }
  // Linear coefficients relate physical units; translations are in output
  // coordinates.
  const transform = new Float64Array((rank + 1) ** 2);
  for (let i = 0; i < rank; ++i) {
    for (let j = 0; j < rank; ++j) {
      transform[j * (rank + 1) + i] =
        (rows[i][j] * scales[i]) / inputSpace.scales[j];
    }
    transform[rank * (rank + 1) + i] = rows[i][rank];
  }
  transform[(rank + 1) ** 2 - 1] = 1;
  return {
    rank,
    sourceRank,
    inputSpace,
    outputSpace: getOutputSpaceWithTransformedBoundingBoxes(
      inputSpace,
      transform,
      makeCoordinateSpace({
        names,
        units,
        scales: Float64Array.from(scales),
        coordinateArrays,
      }),
    ),
    transform,
  };
}

/**
 * Applies a transform source to a data source whose `modelTransform` places
 * it before the transform source. The result's `modelTransform` is the part
 * of the transform source applied after any displacement field (the default
 * of the layer's transform).
 */
export async function applyTransformSource(
  registry: DataSourceRegistry,
  chunkManager: ChunkManager,
  source: DataSource,
  resolved: ResolvedTransformSource,
  options: GetDisplacementFieldOptions,
): Promise<{ source: DataSource; messages: string[] }> {
  const placed = source.modelTransform;
  if (resolved.kind === "field") {
    // A field alone: the source warped into the field's output space.
    const field = await getDisplacementField(registry, resolved.spec, options);
    return getWarpedDataSourceFactory()(chunkManager, source, field);
  }
  const { chain } = resolved;
  const inputDims = matchChainAxes(chain.inputAxes, placed.outputSpace);
  const inputScales = chainDimensions(chain.inputAxes).map((d) => d.scale);
  const outputDims = chainDimensions(chain.outputAxes);
  if (chain.field === undefined) {
    return {
      source: {
        ...source,
        modelTransform: composeChainAffine(
          placed,
          inputDims,
          inputScales,
          omeTransformChainLinear(chain),
          outputDims,
        ),
      },
      messages: [],
    };
  }
  // The field in its own coordinates, its dimensions named after the output
  // axes; its own units.
  const { spaceAxes } = chain.field;
  const n = spaceAxes.length;
  const placement = {
    affine: spaceAxes.map((_, r) =>
      Array.from({ length: n + 1 }, (_, c) => (c === r ? 1 : 0)),
    ),
    axes: spaceAxes.map((i) => ({ name: outputDims[i].name })),
  };
  const stored = await getDisplacementField(
    registry,
    { url: chain.field.url, placement },
    options,
  );
  // A bijection's other field moves points directly (else its inverse is
  // derived from the field, see `makeWarpedDataSource`), placed in this
  // field's coordinates.
  const inverseField = chain.field.inverse;
  if (inverseField !== undefined) {
    const m = inverseField.placement;
    const rank = chain.outputAxes.length;
    stored.inverse = await getStoredInverseField(
      registry,
      {
        url: inverseField.url,
        placement: {
          affine: spaceAxes.map((r) => [
            ...spaceAxes.map((c) => m[c * (rank + 1) + r]),
            m[rank * (rank + 1) + r],
          ]),
          axes: placement.axes,
        },
      },
      options,
    );
  }
  // A field that maps the other way is drawn with its derived inverse.
  let field = stored;
  if (chain.field.derive) {
    if (stored.deriveInverse === undefined) {
      throw new Error(
        `warp: ${chain.field.url} maps the other way, and its inverse can ` +
          "only be derived for an OME-Zarr displacement field",
      );
    }
    field = await stored.deriveInverse(options);
  }
  const fieldDims = outputDims.map((d, i) => {
    if (!spaceAxes.includes(i)) return d;
    const f = field.outputNames.indexOf(d.name);
    return {
      name: d.name,
      unit: field.outputUnits[f],
      scale: field.outputScales[f],
    };
  });
  // pre: the source into the field's coordinates; then the warp.
  const warped = await getWarpedDataSourceFactory()(
    chunkManager,
    {
      ...source,
      modelTransform: composeChainAffine(
        placed,
        inputDims,
        inputScales,
        chain.pre,
        fieldDims,
      ),
    },
    field,
  );
  // post: the warped source (in the field's coordinates) to the output.
  const model = warped.source.modelTransform;
  const warpedDims = fieldDims.map((d) => {
    const i = model.outputSpace.names.indexOf(d.name);
    if (i === -1) {
      throw new Error(`warp: the warped source lacks dimension ${d.name}`);
    }
    return i;
  });
  return {
    source: {
      ...warped.source,
      modelTransform: composeChainAffine(
        model,
        warpedDims,
        fieldDims.map((d) => d.scale),
        chain.post,
        outputDims,
      ),
    },
    messages: warped.messages,
  };
}
