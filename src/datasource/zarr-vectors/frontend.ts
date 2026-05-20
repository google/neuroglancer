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
  ZarrVectorsObjectKeyedSkeletonSourceParameters,
  ZarrVectorsSpatiallyIndexedSkeletonSourceParameters,
} from "#src/datasource/zarr-vectors/base.js";
import {
  ZarrVectorsMultiscaleSpatiallyIndexedSkeletonSource,
  ZarrVectorsObjectKeyedSkeletonSource,
} from "#src/datasource/zarr-vectors/skeleton_frontend.js";
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

  const names = await listAttributeNames(
    sharedKvStoreContext,
    levelUrl,
    options,
  );

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
      dtype = arrayMeta?.attributes?.dtype ?? arrayMeta?.data_type ?? undefined;
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
  // Geometry-type validation lives at the dispatch layer
  // (`ZarrVectorsDataSource.get`) — by the time `buildAnnotationMetadata`
  // is called, the dispatcher has already verified that `geometry_types`
  // is `["point_cloud"]`.  Re-validate defensively here so a direct
  // caller (e.g. tests) gets a clear error.
  const geometryTypes: string[] = Array.isArray(zv.geometry_types)
    ? zv.geometry_types
    : [];
  if (!geometryTypes.includes("point_cloud")) {
    throw new Error(
      `buildAnnotationMetadata: called for a non-point_cloud store ` +
        `(geometry_types=${JSON.stringify(geometryTypes)})`,
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
    throw new Error(
      "zarr-vectors store: bounds[0] and bounds[1] have different rank",
    );
  }
  const chunkShape = zv.chunk_shape;
  if (!Array.isArray(chunkShape) || chunkShape.length !== rank) {
    throw new Error(`zarr-vectors store: 'chunk_shape' must have rank ${rank}`);
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
// Skeleton / polyline / streamline path
// ---------------------------------------------------------------

interface SkeletonMetadata {
  rank: number;
  coordinateSpace: ReturnType<typeof makeCoordinateSpace>;
  /** Parameters for the per-segment (pass-2) chunk source. */
  pass2Params: ZarrVectorsObjectKeyedSkeletonSourceParameters;
  /**
   * Per-level parameter blobs for the spatially-indexed (pass-1) chunk
   * sources, finest-first.  Together with `spatialGrid` they let the
   * multiscale source build the per-level chunk specs.
   *
   * `undefined` when the store's rank is not 3 (neuroglancer's
   * spatially-indexed skeleton machinery hardcodes vec3 position
   * texture format) — the dispatch falls back to pass-2 only in that
   * case.
   */
  pass1Levels?: ReadonlyArray<{
    parameters: ZarrVectorsSpatiallyIndexedSkeletonSourceParameters;
  }>;
  /** Grid info shared across all pass-1 levels.  Co-defined with `pass1Levels`. */
  spatialGrid?: {
    /**
     * Per-level chunk shape in world units.  Length == pass1Levels.length.
     * Each entry comes from the level's ``zarr_vectors_level.chunk_shape``
     * override if present, otherwise from root chunk_shape.  Writers
     * that want the spatial grid-resolution picker to expose multiple
     * LOD levels should set ``chunk_scale_factors`` so each level's
     * chunk_shape is monotonically distinct — that's the same pattern
     * CATMAID's per-level ``chunkSize`` follows
     * (`src/datasource/catmaid/frontend.ts:386-390`).  Sparsity-only
     * pyramids without per-level chunk-shape changes still load, but
     * adjacent levels with identical chunk_shape will collapse into a
     * single picker entry.
     */
    perLevelChunkShape: Float32Array[];
    /**
     * World-space lower bound of the data.  Can be negative — zarr-vectors
     * chunks are indexed around world origin `(0,0,0)`, NOT around
     * `lowerBounds`.  `makeSliceViewChunkSpecification` consumes this as
     * `lowerVoxelBound` and computes negative chunk indices accordingly.
     */
    lowerBounds: Float32Array;
    /** World-space upper bound of the data. */
    upperBounds: Float32Array;
  };
}

const SKELETON_LIKE_GEOM = new Set<string>(["skeleton", "polyline", "streamline"]);

/**
 * Read store metadata for a skeleton / polyline / streamline store and
 * assemble the parameter blob needed to construct chunk sources.
 *
 * Layout assumptions (per the zarr-vectors spec):
 *
 * - `zarr_vectors.geometry_types` contains exactly one of
 *   `"skeleton"`, `"polyline"`, `"streamline"`.
 * - `zarr_vectors.object_index_convention === "standard"` (the only
 *   value that maps to the segmentation-layer pathway).
 * - Level-0 metadata lives under `multiscales[0].datasets[0].path`.
 * - `links/0/.zattrs.dtype` (or `data_type` fallback) declares the
 *   on-disk link dtype; absent for `implicit_sequential` stores.
 */
async function buildSkeletonMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  storeUrl: string,
  rootAttrs: any,
  options: Partial<ProgressOptions>,
): Promise<SkeletonMetadata> {
  const zv = rootAttrs?.zarr_vectors;
  if (zv === undefined) {
    throw new Error(
      "Not a zarr-vectors store: root attributes lack a 'zarr_vectors' block",
    );
  }
  const geometryTypes: string[] = Array.isArray(zv.geometry_types)
    ? zv.geometry_types
    : [];
  const skeletonKindsPresent = geometryTypes.filter((g) =>
    SKELETON_LIKE_GEOM.has(g),
  );
  if (skeletonKindsPresent.length !== 1) {
    throw new Error(
      `buildSkeletonMetadata: expected exactly one skeleton-like ` +
        `geometry type (got ${JSON.stringify(skeletonKindsPresent)})`,
    );
  }
  const geometryKind = skeletonKindsPresent[0] as
    | "skeleton"
    | "polyline"
    | "streamline";

  // Bounds + rank — identical idiom to the annotation path.
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
    throw new Error(
      "zarr-vectors store: bounds[0] and bounds[1] have different rank",
    );
  }
  const lowerBounds = Float64Array.from(bounds[0], Number);
  const upperBounds = Float64Array.from(bounds[1], Number);

  // Coordinate space — prefer NGFF multiscales axes / scales.
  const ngHints = rootAttrs.neuroglancer ?? {};
  const coordinateSpace =
    ngHints.coordinate_space &&
    Array.isArray(ngHints.coordinate_space.names) &&
    ngHints.coordinate_space.names.length === rank
      ? buildCoordinateSpaceFromHints(
          ngHints.coordinate_space,
          lowerBounds,
          upperBounds,
        )
      : buildCoordinateSpaceFromMultiscales(
          rootAttrs.multiscales,
          lowerBounds,
          upperBounds,
          rank,
        );

  // Resolve level 0 — the per-segment manifest lookup operates at one
  // fixed level (the v1 dispatch always uses level 0).  Multi-level
  // pass-1 spatial rendering will use `levelPaths` more broadly in
  // slice 4c-step2.
  const levelPaths = enumerateLevelPaths(rootAttrs.multiscales);
  const level0Url = kvstoreEnsureDirectoryPipelineUrl(
    pipelineUrlJoin(storeUrl, levelPaths[0]),
  );

  // Per-vertex attribute discovery — reuse the annotation-path machinery
  // verbatim; the resulting (attributeNames, attributeDtypes) feed the
  // skeleton render layer's `prop_<name>()` shader bridge.
  const { attributeNames, attributeDtypes } = await buildPropertySpecsAndDtypes(
    sharedKvStoreContext,
    level0Url,
    ngHints,
    options,
  );

  // Links convention — drives whether explicit `links/0/<chunk>` edges
  // are read in addition to the implicit sequential ones synthesised
  // from fragment ranges.
  const linksConventionRaw = zv.links_convention;
  let linksConvention: "implicit_sequential" | "implicit_sequential_with_branches" | "explicit";
  if (linksConventionRaw === undefined) {
    // Spec default per geometry: streamline / polyline → implicit_sequential,
    // skeleton → implicit_sequential_with_branches.
    linksConvention =
      geometryKind === "skeleton"
        ? "implicit_sequential_with_branches"
        : "implicit_sequential";
  } else if (
    linksConventionRaw === "implicit_sequential" ||
    linksConventionRaw === "implicit_sequential_with_branches" ||
    linksConventionRaw === "explicit"
  ) {
    linksConvention = linksConventionRaw;
  } else {
    throw new Error(
      `zarr-vectors links_convention=${JSON.stringify(linksConventionRaw)}: ` +
        `expected 'implicit_sequential', 'implicit_sequential_with_branches', or 'explicit'`,
    );
  }

  // Link dtype: read `links/0/zarr.json`'s declared dtype if the
  // convention has explicit edges.  Default to int64 (universally safe)
  // when no links array exists.
  let linkDtype:
    | "uint8" | "uint16" | "uint32" | "int8" | "int16" | "int32" | "int64";
  if (linksConvention === "implicit_sequential") {
    linkDtype = "int64";
  } else {
    let linksZarrJson: any | undefined;
    try {
      linksZarrJson = await getJsonResource(
        sharedKvStoreContext,
        joinBaseUrlAndPath(level0Url, "links/0/zarr.json"),
        "zarr-vectors links/0 metadata",
        options,
      );
    } catch {
      linksZarrJson = undefined;
    }
    const raw =
      linksZarrJson?.attributes?.dtype ??
      linksZarrJson?.data_type ??
      "int64";
    if (
      raw !== "uint8" &&
      raw !== "uint16" &&
      raw !== "uint32" &&
      raw !== "int8" &&
      raw !== "int16" &&
      raw !== "int32" &&
      raw !== "int64"
    ) {
      throw new Error(
        `zarr-vectors links/0 dtype=${JSON.stringify(raw)}: expected an integer dtype`,
      );
    }
    linkDtype = raw;
  }

  const pass2Params = new ZarrVectorsObjectKeyedSkeletonSourceParameters();
  pass2Params.baseUrl = level0Url;
  pass2Params.rank = rank;
  pass2Params.attributeNames = attributeNames;
  pass2Params.attributeDtypes = attributeDtypes;
  pass2Params.linksConvention = linksConvention;
  pass2Params.geometryKind = geometryKind;
  pass2Params.linkDtype = linkDtype;

  // Pass-1 (spatially-indexed) wiring — only when the store is 3-D.
  // Neuroglancer's spatially-indexed skeleton machinery hardcodes a
  // vec3 position texture format (`skeleton/frontend.ts:1706-1709`); 2-D
  // or higher-rank stores fall back to pass-2 only.
  let pass1Levels:
    | ReadonlyArray<{ parameters: ZarrVectorsSpatiallyIndexedSkeletonSourceParameters }>
    | undefined;
  let spatialGrid:
    | {
        perLevelChunkShape: Float32Array[];
        lowerBounds: Float32Array;
        upperBounds: Float32Array;
      }
    | undefined;
  if (rank === 3) {
    const chunkShape = zv.chunk_shape;
    if (!Array.isArray(chunkShape) || chunkShape.length !== rank) {
      throw new Error(`zarr-vectors store: 'chunk_shape' must have rank ${rank}`);
    }
    // Root chunk_shape is the default per-level chunk size.  When a
    // level stamps its own ``zarr_vectors_level.chunk_shape`` on disk
    // (writers using ``chunk_scale_factors`` to grow chunks at coarser
    // levels), that overrides the root for that level.
    const rootChunkShapeF32 = new Float32Array(rank);
    for (let i = 0; i < rank; ++i) {
      rootChunkShapeF32[i] = Number(chunkShape[i]);
    }
    const lowerBoundsF32 = Float32Array.from(lowerBounds);
    const upperBoundsF32 = Float32Array.from(upperBounds);

    // Fetch each level's zarr.json in parallel to read its optional
    // per-level chunk_shape override.  Reuses kvstore caching: the
    // same files are read again below by the chunk-source download
    // path with zero net traffic.
    const perLevelChunkShape: Float32Array[] = await Promise.all(
      levelPaths.map(async (levelPath) => {
        const levelUrl = kvstoreEnsureDirectoryPipelineUrl(
          pipelineUrlJoin(storeUrl, levelPath),
        );
        try {
          const levelJson = await getJsonResource(
            sharedKvStoreContext,
            joinBaseUrlAndPath(levelUrl, "zarr.json"),
            `zarr-vectors level ${JSON.stringify(levelPath)} metadata`,
            options,
          );
          const override = levelJson?.attributes?.zarr_vectors_level?.chunk_shape;
          if (Array.isArray(override) && override.length === rank) {
            const arr = new Float32Array(rank);
            for (let i = 0; i < rank; ++i) arr[i] = Number(override[i]);
            return arr;
          }
        } catch {
          // fall through to default
        }
        return new Float32Array(rootChunkShapeF32);
      }),
    );

    // Per-level parameter blobs.  Each level gets its own chunkShape
    // (may differ when the writer used ``chunk_scale_factors``).
    const levels: { parameters: ZarrVectorsSpatiallyIndexedSkeletonSourceParameters }[] =
      [];
    for (let k = 0; k < levelPaths.length; ++k) {
      const levelUrl = kvstoreEnsureDirectoryPipelineUrl(
        pipelineUrlJoin(storeUrl, levelPaths[k]),
      );
      const params = new ZarrVectorsSpatiallyIndexedSkeletonSourceParameters();
      params.baseUrl = levelUrl;
      params.rank = rank;
      params.attributeNames = attributeNames;
      params.attributeDtypes = attributeDtypes;
      params.linksConvention = linksConvention;
      params.geometryKind = geometryKind;
      params.linkDtype = linkDtype;
      // gridIndex must match the framework's `spatialSkeletonGridLevels`
      // ordering, which is sorted DESCENDING by spacing (largest first).
      // Our `levelPaths[0]` is the FINEST pyramid level (smallest spacing),
      // so it should land at the END of the sorted list:
      //   levelPaths[0]  (finest)   → gridIndex = numLevels - 1
      //   levelPaths[N-1] (coarsest) → gridIndex = 0
      // See `findClosestSpatialSkeletonGridLevelBySpacing` in
      // `src/layer/segmentation/index.ts:588-603` for the picker that
      // then looks up sources by `gridIndex`.
      params.gridIndex = levelPaths.length - 1 - k;
      levels.push({ parameters: params });
    }

    pass1Levels = levels;
    spatialGrid = {
      perLevelChunkShape,
      lowerBounds: lowerBoundsF32,
      upperBounds: upperBoundsF32,
    };
  }

  return { rank, coordinateSpace, pass2Params, pass1Levels, spatialGrid };
}

/**
 * Construct a segmentation-shaped `DataSource` from skeleton metadata.
 *
 * The data source exposes up to **two** chunk sources under
 * `subsource.mesh`, each in its own subsource entry:
 *
 *   - `"skeleton-spatial"` — the multiscale spatially-indexed source
 *     that drives **pass 1** (camera-relative chunk loading).  Only
 *     emitted when the store is 3-D (the spatially-indexed skeleton
 *     render layer in neuroglancer assumes vec3 positions).
 *   - `"skeleton"` — the per-segment source that drives **pass 2**
 *     (user-typed object IDs in the segments-list UI).
 *
 * Neuroglancer's `SegmentationUserLayer.renderLayers` dispatches by
 * `instanceof` on `subsource.mesh`:
 *
 *   - `MultiscaleSpatiallyIndexedSkeletonSource` → mounts the
 *     spatially-indexed render layer.
 *   - `SkeletonSource` → mounts the per-segment render layer.
 *
 * Both render layers can coexist on the same segmentation layer, which
 * is how the two passes compose visually.
 */
function getSkeletonDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  metadata: SkeletonMetadata,
): DataSource {
  const subsources: DataSource["subsources"] = [];

  if (metadata.pass1Levels !== undefined && metadata.spatialGrid !== undefined) {
    subsources.push({
      id: "skeleton-spatial",
      default: true,
      subsource: {
        mesh: new ZarrVectorsMultiscaleSpatiallyIndexedSkeletonSource(
          sharedKvStoreContext.chunkManager,
          sharedKvStoreContext,
          {
            levels: metadata.pass1Levels,
            perLevelChunkShape: metadata.spatialGrid.perLevelChunkShape,
            lowerBounds: metadata.spatialGrid.lowerBounds,
            upperBounds: metadata.spatialGrid.upperBounds,
          },
        ),
      },
    });
  }

  // Pass-2 (per-segment) source is opt-in.  The segmentation layer's
  // standard subsource toggle lets the user enable it when they want the
  // visible-segments-set to drive a second render layer drawn on top of
  // pass 1.  Matches catmaid's default-flag convention.
  subsources.push({
    id: "skeleton",
    default: false,
    subsource: {
      mesh: sharedKvStoreContext.chunkManager.getChunkSource(
        ZarrVectorsObjectKeyedSkeletonSource,
        {
          sharedKvStoreContext,
          parameters: metadata.pass2Params,
        },
      ),
    },
  });

  return {
    modelTransform: makeIdentityTransform(metadata.coordinateSpace),
    subsources,
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
        // Dispatch by geometry_types: point_cloud → annotation layer
        // (existing path); skeleton / polyline / streamline → segmentation
        // layer (slice 4c).  Validation (unknown types, mixed-geometry,
        // wrong object_index_convention) happens here so the failure
        // surface is consistent across geometries.
        const zv = attrs.zarr_vectors;
        if (zv === undefined) {
          throw new Error(
            "Not a zarr-vectors store: root attributes lack a 'zarr_vectors' block",
          );
        }
        const geometryTypes: string[] = Array.isArray(zv.geometry_types)
          ? zv.geometry_types
          : [];
        const supportedGeom = new Set<string>([
          "point_cloud",
          "skeleton",
          "polyline",
          "streamline",
        ]);
        const unsupported = geometryTypes.filter((g) => !supportedGeom.has(g));
        if (unsupported.length > 0) {
          throw new Error(
            `zarr-vectors datasource: unsupported geometry types ` +
              `${JSON.stringify(unsupported)}.  Supported: ` +
              `${JSON.stringify(Array.from(supportedGeom))}`,
          );
        }
        const hasSkeletonLike = geometryTypes.some((g) =>
          SKELETON_LIKE_GEOM.has(g),
        );
        const hasPointCloud = geometryTypes.includes("point_cloud");
        if (hasSkeletonLike && hasPointCloud) {
          throw new Error(
            `zarr-vectors datasource: stores with both point_cloud and ` +
              `skeleton/polyline/streamline geometry are not yet supported ` +
              `(found: ${JSON.stringify(geometryTypes)})`,
          );
        }
        if (!hasSkeletonLike && !hasPointCloud) {
          throw new Error(
            `zarr-vectors datasource: no recognised geometry type in ` +
              `${JSON.stringify(geometryTypes)}; expected 'point_cloud' or ` +
              `one of ${JSON.stringify(Array.from(SKELETON_LIKE_GEOM))}`,
          );
        }

        let dataSource: DataSource;
        if (hasSkeletonLike) {
          const objectIndexConvention = zv.object_index_convention;
          if (
            objectIndexConvention !== "standard" &&
            objectIndexConvention !== undefined
          ) {
            throw new Error(
              `zarr-vectors datasource: skeleton/polyline/streamline geometry ` +
                `requires object_index_convention='standard' (got ` +
                `${JSON.stringify(objectIndexConvention)})`,
            );
          }
          const skelMeta = await buildSkeletonMetadata(
            sharedKvStoreContext,
            kvStoreUrl,
            attrs,
            progressOptions,
          );
          dataSource = getSkeletonDataSource(sharedKvStoreContext, skelMeta);
        } else {
          const meta = await buildAnnotationMetadata(
            sharedKvStoreContext,
            kvStoreUrl,
            attrs,
            progressOptions,
          );
          dataSource = getAnnotationDataSource(sharedKvStoreContext, meta);
        }
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
