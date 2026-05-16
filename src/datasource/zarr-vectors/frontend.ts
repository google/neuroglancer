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

import type { AnnotationGeometryChunkSpecification } from "#src/annotation/base.js";
import {
  AnnotationGeometryChunkSource,
  MultiscaleAnnotationSource,
} from "#src/annotation/frontend_source.js";
import type { AnnotationPropertySpec } from "#src/annotation/index.js";
import {
  AnnotationType,
  parseAnnotationPropertySpecs,
} from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import {
  type DataSource,
  type DataSourceLookupResult,
  type GetKvStoreBasedDataSourceOptions,
  type KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import type {
  ZarrVectorsAttributeDtype,
  ZarrVectorsPyramidMode,
} from "#src/datasource/zarr-vectors/base.js";
import {
  ZarrVectorsAnnotationSourceParameters,
  ZarrVectorsAnnotationSpatialIndexSourceParameters,
} from "#src/datasource/zarr-vectors/base.js";
import type { AutoDetectRegistry } from "#src/kvstore/auto_detect.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import {
  joinBaseUrlAndPath,
  kvstoreEnsureDirectoryPipelineUrl,
  parseUrlSuffix,
  pipelineUrlJoin,
} from "#src/kvstore/url.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { allSiPrefixes, supportedUnits } from "#src/util/si_units.js";

// ---------------------------------------------------------------
// Chunk source classes
// ---------------------------------------------------------------

class ZarrVectorsAnnotationSpatialIndexSource extends WithParameters(
  WithSharedKvStoreContext(AnnotationGeometryChunkSource),
  ZarrVectorsAnnotationSpatialIndexSourceParameters,
) {}

const MultiscaleAnnotationSourceBase = WithParameters(
  WithSharedKvStoreContext(MultiscaleAnnotationSource),
  ZarrVectorsAnnotationSourceParameters,
);

interface ZarrVectorsAnnotationSourceOptions {
  metadata: AnnotationMetadata;
  parameters: ZarrVectorsAnnotationSourceParameters;
  sharedKvStoreContext: SharedKvStoreContext;
}

export class ZarrVectorsAnnotationSource extends MultiscaleAnnotationSourceBase {
  declare key: unknown;
  metadata: AnnotationMetadata;
  declare OPTIONS: ZarrVectorsAnnotationSourceOptions;
  constructor(
    chunkManager: ChunkManager,
    options: ZarrVectorsAnnotationSourceOptions,
  ) {
    const { parameters } = options;
    super(chunkManager, {
      rank: parameters.rank,
      relationships: [],
      properties: parameters.properties,
      sharedKvStoreContext: options.sharedKvStoreContext,
      parameters,
    } as any);
    this.readonly = true;
    this.metadata = options.metadata;
  }

  getSources() {
    return [
      this.metadata.spatialIndices.map((level) => ({
        chunkSource: this.chunkManager.getChunkSource(
          ZarrVectorsAnnotationSpatialIndexSource,
          {
            sharedKvStoreContext: this.sharedKvStoreContext,
            parent: this,
            spec: level.spec,
            parameters: level.parameters,
          },
        ),
        chunkToMultiscaleTransform: level.spec.chunkToMultiscaleTransform,
      })),
    ];
  }
}

// ---------------------------------------------------------------
// Metadata parsing
// ---------------------------------------------------------------

// NGFF long-form unit strings → base SI letter + decimal exponent.
// Built from neuroglancer's known SI prefix table so any prefix
// understood elsewhere in the codebase round-trips correctly.
const OME_LONG_UNITS = (() => {
  const m = new Map<string, { unit: string; exponent: number }>();
  for (const baseUnit of ["meter", "second"]) {
    for (const p of allSiPrefixes) {
      if (p.longPrefix === undefined) continue;
      m.set(`${p.longPrefix}${baseUnit}`, {
        unit: baseUnit[0],
        exponent: p.exponent,
      });
    }
  }
  // Common irregular forms.
  m.set("micron", { unit: "m", exponent: -6 });
  m.set("microns", { unit: "m", exponent: -6 });
  return m;
})();

/**
 * Translate a (scale, unit) pair from user-facing form to the
 * normalised form neuroglancer's coordinate space expects: unit is one
 * of the base SI letters ("m", "s", "Hz", "rad/s", "") and any SI
 * prefix is folded into scale.  Returns {unit: "", scale} when the
 * unit string isn't recognised.
 */
function normalizeUnitScale(
  rawScale: number,
  rawUnit: unknown,
): { unit: string; scale: number } {
  if (typeof rawUnit !== "string" || rawUnit === "") {
    return { unit: "", scale: rawScale };
  }
  const longForm = OME_LONG_UNITS.get(rawUnit);
  if (longForm !== undefined) {
    return {
      unit: longForm.unit,
      scale: rawScale * 10 ** longForm.exponent,
    };
  }
  const shortForm = supportedUnits.get(rawUnit);
  if (shortForm !== undefined) {
    return {
      unit: shortForm.unit,
      scale: rawScale * 10 ** shortForm.exponent,
    };
  }
  return { unit: "", scale: rawScale };
}

const ATTR_DTYPE_TO_NG_TYPE: Record<string, AnnotationPropertySpec["type"]> = {
  float32: "float32",
  uint8: "uint8",
  uint16: "uint16",
  uint32: "uint32",
  int8: "int8",
  int16: "int16",
  int32: "int32",
};

interface AnnotationSpatialIndexLevelMetadata {
  parameters: ZarrVectorsAnnotationSpatialIndexSourceParameters;
  spec: AnnotationGeometryChunkSpecification;
}

interface AnnotationMetadata {
  rank: number;
  coordinateSpace: ReturnType<typeof makeCoordinateSpace>;
  parameters: ZarrVectorsAnnotationSourceParameters;
  spatialIndices: AnnotationSpatialIndexLevelMetadata[];
}

function buildCoordinateSpaceFromHints(
  hints: any,
  lowerBounds: Float64Array,
  upperBounds: Float64Array,
) {
  const names: string[] = hints.names.map((n: unknown) => String(n));
  const rawScales: number[] = hints.scales.map((s: unknown) => Number(s));
  const units: string[] = new Array(names.length);
  const scales = new Float64Array(names.length);
  for (let i = 0; i < names.length; ++i) {
    const normalized = normalizeUnitScale(rawScales[i], hints.units?.[i]);
    units[i] = normalized.unit;
    scales[i] = normalized.scale;
  }
  return makeCoordinateSpace({
    rank: names.length,
    names,
    units,
    scales,
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({ lowerBounds, upperBounds }),
    ],
  });
}

function buildCoordinateSpaceFromMultiscales(
  multiscales: any,
  lowerBounds: Float64Array,
  upperBounds: Float64Array,
  rank: number,
) {
  const entry = Array.isArray(multiscales) ? multiscales[0] : undefined;
  const axes: any[] = entry?.axes ?? [];
  let names = axes.map((a, i) => (a?.name ? String(a.name) : `d${i}`));
  while (names.length < rank) names.push(`d${names.length}`);
  names = names.slice(0, rank);

  const dataset = entry?.datasets?.[0];
  const scaleXform = dataset?.coordinateTransformations?.find(
    (t: any) => t?.type === "scale",
  );
  const scaleArr: number[] = scaleXform?.scale ?? [];
  const units: string[] = new Array(rank);
  const scales = new Float64Array(rank);
  for (let i = 0; i < rank; ++i) {
    const rawScale = scaleArr[i] !== undefined ? Number(scaleArr[i]) : 1.0;
    const normalized = normalizeUnitScale(rawScale, axes[i]?.unit);
    units[i] = normalized.unit;
    scales[i] = normalized.scale;
  }
  return makeCoordinateSpace({
    rank,
    names,
    units,
    scales,
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({ lowerBounds, upperBounds }),
    ],
  });
}

async function listAttributeNames(
  sharedKvStoreContext: SharedKvStoreContext,
  levelUrl: string,
  options: Partial<ProgressOptions>,
): Promise<string[]> {
  const attributesUrl = joinBaseUrlAndPath(levelUrl, "vertex_attributes/");
  const response = await sharedKvStoreContext.kvStoreContext
    .list(attributesUrl, {
      responseKeys: "suffix",
      ...options,
    })
    .catch(() => undefined);
  if (response === undefined) return [];
  // Each subdirectory under vertex_attributes/ is one property.  Strip the
  // trailing "/" if present.
  return response.directories
    .map((d) => (d.endsWith("/") ? d.slice(0, -1) : d))
    .filter((d) => d.length > 0)
    .sort();
}

async function getJsonResource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  description: string,
  options: Partial<ProgressOptions>,
): Promise<any | undefined> {
  return sharedKvStoreContext.chunkManager.memoize.getAsync(
    { type: "zarr-vectors:json", url },
    options,
    async (progressOptions) => {
      using _span = new ProgressSpan(progressOptions.progressListener, {
        message: `Reading ${description} from ${url}`,
      });
      const response = await sharedKvStoreContext.kvStoreContext.read(
        url,
        progressOptions,
      );
      if (response === undefined) return undefined;
      return await response.response.json();
    },
  );
}

async function buildPropertySpecsAndDtypes(
  sharedKvStoreContext: SharedKvStoreContext,
  levelUrl: string,
  hints: any,
  options: Partial<ProgressOptions>,
): Promise<{
  properties: AnnotationPropertySpec[];
  attributeNames: string[];
  attributeDtypes: ZarrVectorsAttributeDtype[];
}> {
  const declaredHints: any[] = Array.isArray(hints?.properties)
    ? hints.properties
    : [];
  const declaredByName = new Map<string, any>(
    declaredHints.map((p) => [String(p.identifier), p]),
  );

  const names = await listAttributeNames(sharedKvStoreContext, levelUrl, options);

  // Stable order: declared properties first (in their declared order),
  // then any remaining listed attributes in alphabetical order.
  const orderedNames: string[] = [];
  for (const p of declaredHints) {
    const id = String(p.identifier);
    if (names.includes(id) && !orderedNames.includes(id)) {
      orderedNames.push(id);
    }
  }
  for (const n of names) {
    if (!orderedNames.includes(n)) orderedNames.push(n);
  }

  const attributeNames: string[] = [];
  const attributeDtypes: ZarrVectorsAttributeDtype[] = [];
  const rawPropertyJson: any[] = [];

  for (const name of orderedNames) {
    let dtype: string | undefined;
    let arrayMeta: any | undefined;
    try {
      arrayMeta = await getJsonResource(
        sharedKvStoreContext,
        joinBaseUrlAndPath(levelUrl, `vertex_attributes/${name}/zarr.json`),
        `attribute ${JSON.stringify(name)} metadata`,
        options,
      );
      dtype =
        arrayMeta?.attributes?.dtype ?? arrayMeta?.data_type ?? undefined;
    } catch {
      dtype = undefined;
    }
    if (dtype === undefined || ATTR_DTYPE_TO_NG_TYPE[dtype] === undefined) {
      // Skip attributes we can't represent.
      continue;
    }
    attributeNames.push(name);
    attributeDtypes.push(dtype as ZarrVectorsAttributeDtype);

    // Dictionary-encoded (categorical/enum) attributes: surface as a
    // numeric annotation property with enum_values + enum_labels so
    // shaders see category names, not raw codes.  The on-disk
    // convention is documented in zarr-vectors:
    // ``encoding: "dictionary"`` + ``categories: [...]`` lives in the
    // attribute array's metadata block.
    let enumValues: number[] | undefined;
    let enumLabels: string[] | undefined;
    if (arrayMeta?.attributes?.encoding === "dictionary") {
      const categories = arrayMeta.attributes.categories;
      if (Array.isArray(categories)) {
        enumLabels = categories.map((c: unknown) => String(c));
        enumValues = enumLabels.map((_, i) => i);
      }
    }

    const hint = declaredByName.get(name);
    if (hint !== undefined) {
      rawPropertyJson.push({
        ...hint,
        type: hint.type ?? dtype,
        // Hints win for enum metadata; only fill in from the on-disk
        // dictionary when the user didn't already specify it.
        enum_values: hint.enum_values ?? enumValues,
        enum_labels: hint.enum_labels ?? enumLabels,
      });
    } else {
      rawPropertyJson.push({
        id: name,
        type: ATTR_DTYPE_TO_NG_TYPE[dtype],
        enum_values: enumValues,
        enum_labels: enumLabels,
      });
    }
  }

  // parseAnnotationPropertySpecs expects "id" — normalise from
  // "identifier" if hints used that key.
  const normalized = rawPropertyJson.map((p) => {
    if (p.id !== undefined) return p;
    if (p.identifier !== undefined) {
      const { identifier, ...rest } = p;
      return { id: identifier, ...rest };
    }
    return p;
  });

  let properties: AnnotationPropertySpec[];
  try {
    properties = parseAnnotationPropertySpecs(normalized);
  } catch (e) {
    throw new Error(
      `Failed to parse annotation property specs from zarr-vectors hints: ${(e as Error).message}`,
    );
  }
  return { properties, attributeNames, attributeDtypes };
}

const FALLBACK_LEVEL_LIMIT = 1_000_000;

function parsePyramidMode(raw: unknown): ZarrVectorsPyramidMode {
  if (raw === "additive" || raw === "replace") return raw;
  // Default: "replace" — see plan §"Context (v2)".  Safe for
  // metanode-style pyramids (no double-count) and matches the
  // image-style mental model of resolution alternatives.  A single
  // level falls through both branches identically.
  return "replace";
}

function enumerateLevelPaths(multiscales: any): string[] {
  const entry = Array.isArray(multiscales) ? multiscales[0] : undefined;
  const datasets = entry?.datasets;
  if (Array.isArray(datasets) && datasets.length > 0) {
    const paths: string[] = [];
    for (const d of datasets) {
      if (typeof d?.path === "string" && d.path.length > 0) {
        paths.push(d.path);
      }
    }
    if (paths.length > 0) return paths;
  }
  // No multiscales metadata → assume a single level "0".  This
  // preserves v1 behavior for stores written before pyramid support.
  return ["0"];
}

function computeLevelLimit(
  levelAttrs: any,
  numChunks: number,
  level0Limit: number,
  rank: number,
): number {
  const vertexCount = Number(levelAttrs?.vertex_count);
  if (Number.isFinite(vertexCount) && vertexCount > 0 && numChunks > 0) {
    return Math.max(1, Math.ceil(vertexCount / numChunks));
  }
  const binRatio = levelAttrs?.bin_ratio;
  if (Array.isArray(binRatio) && binRatio.length === rank) {
    let prod = 1;
    for (const v of binRatio) prod *= Math.max(1, Number(v) || 1);
    if (prod > 1) return Math.max(1, Math.round(level0Limit / prod));
  }
  return level0Limit;
}

async function buildAnnotationMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  storeUrl: string,
  rootAttrs: any,
  options: Partial<ProgressOptions>,
): Promise<AnnotationMetadata> {
  const zv = rootAttrs?.zarr_vectors;
  if (zv === undefined) {
    throw new Error(
      "Not a zarr-vectors store: root attributes lack a 'zarr_vectors' block",
    );
  }
  const geometryTypes: string[] = Array.isArray(zv.geometry_types)
    ? zv.geometry_types
    : [];
  if (!geometryTypes.includes("point_cloud")) {
    throw new Error(
      `zarr-vectors datasource: only 'point_cloud' geometry is supported ` +
        `(found: ${JSON.stringify(geometryTypes)})`,
    );
  }
  const bounds = zv.bounds;
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 2 ||
    !Array.isArray(bounds[0]) ||
    !Array.isArray(bounds[1])
  ) {
    throw new Error(
      "zarr-vectors store: 'bounds' must be [[lower...], [upper...]]",
    );
  }
  const rank = bounds[0].length;
  if (bounds[1].length !== rank) {
    throw new Error("zarr-vectors store: bounds[0] and bounds[1] have different rank");
  }
  const chunkShape = zv.chunk_shape;
  if (!Array.isArray(chunkShape) || chunkShape.length !== rank) {
    throw new Error(
      `zarr-vectors store: 'chunk_shape' must have rank ${rank}`,
    );
  }

  const lowerBounds = Float64Array.from(bounds[0], Number);
  const upperBounds = Float64Array.from(bounds[1], Number);

  // Build coordinate space: prefer neuroglancer hints, fall back to
  // NGFF multiscales.
  const ngHints = rootAttrs.neuroglancer ?? {};
  let coordinateSpace: ReturnType<typeof makeCoordinateSpace>;
  if (
    ngHints.coordinate_space &&
    Array.isArray(ngHints.coordinate_space.names) &&
    ngHints.coordinate_space.names.length === rank
  ) {
    coordinateSpace = buildCoordinateSpaceFromHints(
      ngHints.coordinate_space,
      lowerBounds,
      upperBounds,
    );
  } else {
    coordinateSpace = buildCoordinateSpaceFromMultiscales(
      rootAttrs.multiscales,
      lowerBounds,
      upperBounds,
      rank,
    );
  }

  const pyramidMode = parsePyramidMode(ngHints.pyramid_mode);
  const levelPaths = enumerateLevelPaths(rootAttrs.multiscales);

  // Property discovery runs once against level 0 — per the
  // zarr-vectors spec, attribute dtypes don't vary across levels.
  const level0Url = kvstoreEnsureDirectoryPipelineUrl(
    pipelineUrlJoin(storeUrl, levelPaths[0]),
  );
  const { properties, attributeNames, attributeDtypes } =
    await buildPropertySpecsAndDtypes(
      sharedKvStoreContext,
      level0Url,
      ngHints,
      options,
    );

  // Shared per-level geometry: all levels share the same physical
  // chunk grid on disk in zarr-vectors.
  const chunkShapeF32 = new Float32Array(rank);
  const gridShape = new Float32Array(rank);
  const gridShapeInVoxels = new Float32Array(rank);
  let numChunks = 1;
  for (let i = 0; i < rank; ++i) {
    const cs = Number(chunkShape[i]);
    chunkShapeF32[i] = cs;
    const extent = upperBounds[i] - lowerBounds[i];
    const g = Math.max(1, Math.ceil(extent / cs));
    gridShape[i] = g;
    gridShapeInVoxels[i] = g * cs;
    numChunks *= g;
  }
  const chunkToMultiscaleTransform = matrix.createIdentity(
    Float32Array,
    rank + 1,
  );
  for (let i = 0; i < rank; ++i) {
    chunkToMultiscaleTransform[(rank + 1) * rank + i] = lowerBounds[i];
  }

  // Build one spatial-index level per zarr-vectors level.  Order:
  // finest first (level 0 first), which is the order
  // forEachVisibleAnnotationChunk expects (it iterates length-1 → 0).
  const spatialIndices: AnnotationSpatialIndexLevelMetadata[] = [];
  let level0Limit = FALLBACK_LEVEL_LIMIT;
  for (let k = 0; k < levelPaths.length; ++k) {
    const levelPath = levelPaths[k];
    const levelUrl = kvstoreEnsureDirectoryPipelineUrl(
      pipelineUrlJoin(storeUrl, levelPath),
    );
    let levelAttrs: any;
    try {
      const levelJson = await getJsonResource(
        sharedKvStoreContext,
        joinBaseUrlAndPath(levelUrl, "zarr.json"),
        `zarr-vectors level ${JSON.stringify(levelPath)} metadata`,
        options,
      );
      levelAttrs = levelJson?.attributes?.zarr_vectors_level;
    } catch {
      levelAttrs = undefined;
    }
    const limit = computeLevelLimit(levelAttrs, numChunks, level0Limit, rank);
    if (k === 0) level0Limit = limit;

    const spec: AnnotationGeometryChunkSpecification = {
      limit,
      chunkToMultiscaleTransform,
      pyramidMode,
      ...makeSliceViewChunkSpecification({
        rank,
        chunkDataSize: chunkShapeF32,
        upperVoxelBound: gridShapeInVoxels,
      }),
    };
    spec.upperChunkBound = gridShape;

    const spatialParams =
      new ZarrVectorsAnnotationSpatialIndexSourceParameters();
    spatialParams.baseUrl = levelUrl;
    spatialParams.rank = rank;
    spatialParams.attributeNames = attributeNames;
    spatialParams.attributeDtypes = attributeDtypes;

    spatialIndices.push({ parameters: spatialParams, spec });
  }

  const parameters = new ZarrVectorsAnnotationSourceParameters();
  parameters.rank = rank;
  parameters.type = AnnotationType.POINT;
  parameters.properties = properties;
  parameters.pyramidMode = pyramidMode;

  const meta: AnnotationMetadata = {
    rank,
    coordinateSpace,
    parameters,
    spatialIndices,
  };
  return meta;
}

function getAnnotationDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  metadata: AnnotationMetadata,
): DataSource {
  return {
    modelTransform: makeIdentityTransform(metadata.coordinateSpace),
    subsources: [
      {
        id: "default",
        default: true,
        subsource: {
          annotation: sharedKvStoreContext.chunkManager.getChunkSource(
            ZarrVectorsAnnotationSource,
            {
              sharedKvStoreContext,
              metadata,
              parameters: metadata.parameters,
            },
          ),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------
// Provider
// ---------------------------------------------------------------

function resolveUrl(options: GetKvStoreBasedDataSourceOptions) {
  const { authorityAndPath, query, fragment } = parseUrlSuffix(
    options.url.suffix,
  );
  if (query) {
    throw new Error(
      `Invalid URL ${JSON.stringify(options.url.url)}: query parameters not supported`,
    );
  }
  if (fragment) {
    throw new Error(
      `Invalid URL ${JSON.stringify(options.url.url)}: fragment not supported`,
    );
  }
  return {
    kvStoreUrl: kvstoreEnsureDirectoryPipelineUrl(options.kvStoreUrl),
    additionalPath: authorityAndPath ?? "",
  };
}

export class ZarrVectorsDataSource implements KvStoreBasedDataSourceProvider {
  get scheme() {
    return "zarr-vectors";
  }
  get expectsDirectory() {
    return true;
  }
  get description() {
    return "Zarr Vectors (experimental) data source";
  }

  async get(
    options: GetKvStoreBasedDataSourceOptions,
  ): Promise<DataSourceLookupResult> {
    let { kvStoreUrl, additionalPath } = resolveUrl(options);
    kvStoreUrl = kvstoreEnsureDirectoryPipelineUrl(
      pipelineUrlJoin(kvStoreUrl, additionalPath),
    );
    return options.registry.chunkManager.memoize.getAsync(
      { type: "zarr-vectors:get", url: kvStoreUrl },
      options,
      async (progressOptions) => {
        const { sharedKvStoreContext } = options.registry;
        const rootJson = await getJsonResource(
          sharedKvStoreContext,
          joinBaseUrlAndPath(kvStoreUrl, "zarr.json"),
          "zarr-vectors root metadata",
          progressOptions,
        );
        if (rootJson === undefined) {
          throw new Error(
            `No zarr.json found at ${kvStoreUrl} — is this a zarr v3 store?`,
          );
        }
        if (rootJson.node_type && rootJson.node_type !== "group") {
          throw new Error(
            `zarr-vectors expected a zarr v3 group, got node_type=${JSON.stringify(rootJson.node_type)}`,
          );
        }
        const attrs = rootJson.attributes ?? {};
        const meta = await buildAnnotationMetadata(
          sharedKvStoreContext,
          kvStoreUrl,
          attrs,
          progressOptions,
        );
        const dataSource = getAnnotationDataSource(sharedKvStoreContext, meta);
        dataSource.canonicalUrl = `${kvStoreUrl}|${options.url.scheme}:`;
        return dataSource;
      },
    );
  }
}

export function registerAutoDetect(_registry: AutoDetectRegistry) {
  // Auto-detect is intentionally omitted in v1: a zarr-vectors store
  // is also a valid zarr v3 group, and we don't want to shadow the
  // existing zarr datasource by default.  Users opt in explicitly via
  // the "zarr-vectors://" scheme.
}
