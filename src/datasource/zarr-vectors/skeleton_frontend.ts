/**
 * @license
 * Copyright 2026 Allen Institute for Brain Science
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Frontend-side chunk source classes for zarr-vectors skeleton /
 * polyline / streamline rendering.  Each one is paired with a backend
 * class in `./skeleton_backend.ts` via a matching ``RPC_ID`` on the
 * parameter type.
 *
 * - `ZarrVectorsSpatiallyIndexedSkeletonSource` — the **pass-1** chunk
 *   source.  Subclass of neuroglancer's
 *   `SpatiallyIndexedSkeletonSource`; the backend pairs with
 *   `ZarrVectorsSpatiallyIndexedSkeletonSourceBackend` and downloads one
 *   chunk per `(chunkGridPosition, lod)` pair.
 *
 * - `ZarrVectorsObjectKeyedSkeletonSource` — the **pass-2** chunk source
 *   (intentionally **stubbed** in this slice).  Will subclass
 *   `SkeletonSource` and resolve object IDs via the
 *   `object_index/manifests` zarr-vlen-bytes array; that decoder lands
 *   in slice 4b.
 *
 * The synthesised `prop_tangent()` vertex-attribute exposure for the
 * default streamline shader is wired in slice 4d.  Here, both sources
 * keep neuroglancer's default `[vertexPositionAttribute, segmentAttribute]`
 * shape so the file compiles in isolation.
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  ZarrVectorsObjectKeyedSkeletonSourceParameters,
  ZarrVectorsSpatiallyIndexedSkeletonSourceParameters,
  type ZarrVectorsAttributeDtype,
  type ZarrVectorsSkeletonGeometryKind,
} from "#src/datasource/zarr-vectors/base.js";
import {
  KIND_CAPABILITIES,
  hasSynthesisedTangent,
} from "#src/datasource/zarr-vectors/geometry_kind.js";
import { buildVertexAttributeMap } from "#src/datasource/zarr-vectors/skeleton_shader_bridge.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import type { VertexAttributeInfo } from "#src/skeleton/base.js";
import {
  MultiscaleSpatiallyIndexedSkeletonSource,
  SkeletonSource,
  SPATIAL_SKELETON_SOURCE_OPTIONS,
  SpatiallyIndexedSkeletonSource,
  type SpatiallyIndexedSkeletonChunkSpecification,
} from "#src/skeleton/frontend.js";
import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import { DataType } from "#src/util/data_type.js";
import type { Borrowed } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { getShaderType } from "#src/webgl/shader_lib.js";
import {
  TextureFormat,
  computeTextureFormat,
} from "#src/webgl/texture_access.js";

// Re-export for callers (e.g. UI code) that need these without
// importing the heavy WebGL-coupled symbols from `skeleton/frontend.js`.
export {
  DEFAULT_STREAMLINE_FRAGMENT_MAIN,
  buildVertexAttributeMap,
} from "#src/datasource/zarr-vectors/skeleton_shader_bridge.js";

/**
 * One entry in the array shape `SpatiallyIndexedSkeletonSource`
 * exposes to the render layer.  The fields after `numComponents` exist
 * because the existing skeleton render layer pulls
 * `webglDataType` / `glslDataType` directly off this struct when
 * building shaders.
 */
interface ZvVertexAttributeRenderInfo {
  name: string;
  dataType: DataType;
  numComponents: number;
  webglDataType: number;
  glslDataType: string;
}

const ATTR_DTYPE_TO_DATA_TYPE: Record<ZarrVectorsAttributeDtype, DataType> = {
  float32: DataType.FLOAT32,
  uint8: DataType.UINT8,
  uint16: DataType.UINT16,
  uint32: DataType.UINT32,
  int8: DataType.INT8,
  int16: DataType.INT16,
  int32: DataType.INT32,
};

/**
 * Map every zarr-vectors attribute dtype to a WebGL2 scalar type enum.
 * The standard `skeleton/frontend.ts` helper only handles
 * FLOAT32/INT32/UINT32 (it throws for 8/16-bit widths), so we keep our
 * own table here covering all the dtypes zarr-vectors emits.
 */
function zvWebglDataType(dt: DataType): number {
  switch (dt) {
    case DataType.FLOAT32:
      return WebGL2RenderingContext.FLOAT;
    case DataType.UINT8:
      return WebGL2RenderingContext.UNSIGNED_BYTE;
    case DataType.INT8:
      return WebGL2RenderingContext.BYTE;
    case DataType.UINT16:
      return WebGL2RenderingContext.UNSIGNED_SHORT;
    case DataType.INT16:
      return WebGL2RenderingContext.SHORT;
    case DataType.UINT32:
      return WebGL2RenderingContext.UNSIGNED_INT;
    case DataType.INT32:
      return WebGL2RenderingContext.INT;
    default:
      throw new Error(`Unsupported attribute DataType for WebGL: ${dt}`);
  }
}

/**
 * Build the `VertexAttributeRenderInfo[]` shape the existing
 * spatially-indexed skeleton render layer expects.  Mirrors how the
 * backend (`skeleton_backend.ts:ZarrVectorsSpatiallyIndexedSkeletonSourceBackend
 * .download`) packs `chunk.vertexAttributes`: position (implicit, slot
 * 0), then synthesised `tangent` (streamline / polyline only), then
 * user-declared attributes in declaration order.
 *
 * Extends `SpatiallyIndexedSkeletonSource`'s baked-in `[position,
 * segment]` shape: we keep a `"segment"` column (so the render layer's
 * `segmentAttributeIndex` resolves and per-segment colouring works) but
 * also slot in a synthesised `tangent` (streamline / polyline / graph /
 * skeleton) and the user-declared attributes.  The on-disk format has no
 * *per-vertex* segment column, so the backend synthesises one from the
 * per-fragment `fragment_attributes/segment_id` (truncated to uint32),
 * falling back to the fragment's chunk-local index.
 */
function buildZvSpatialVertexAttributes(parameters: {
  attributeNames: string[];
  attributeDtypes: ZarrVectorsAttributeDtype[];
  geometryKind: ZarrVectorsSkeletonGeometryKind;
}): ZvVertexAttributeRenderInfo[] {
  const out: ZvVertexAttributeRenderInfo[] = [
    {
      name: "",
      dataType: DataType.FLOAT32,
      numComponents: 3,
      webglDataType: WebGL2RenderingContext.FLOAT,
      glslDataType: "vec3",
    },
  ];
  if (hasSynthesisedTangent(parameters.geometryKind)) {
    out.push({
      name: "tangent",
      dataType: DataType.FLOAT32,
      numComponents: 3,
      webglDataType: WebGL2RenderingContext.FLOAT,
      glslDataType: "vec3",
    });
  }
  for (let i = 0; i < parameters.attributeNames.length; ++i) {
    const dt = ATTR_DTYPE_TO_DATA_TYPE[parameters.attributeDtypes[i]];
    out.push({
      name: parameters.attributeNames[i],
      dataType: dt,
      numComponents: 1,
      webglDataType: zvWebglDataType(dt),
      glslDataType: getShaderType(dt, 1),
    });
  }
  // Synthesised per-vertex `"segment"` column (last slot — mirrors the
  // backend's `download()` packing).  Naming it `"segment"` is what makes
  // the render layer wire `segmentAttributeIndex` and colour each fragment
  // by its owning segment via `segmentColorHash`.  Two uint32 components
  // (`uvec2`) carry the FULL uint64 flywire id `[lo, hi]`, so dense
  // fragments colour identically to the flat segmentation's voxels for the
  // same id (the render layer hashes the full uint64 with the shared
  // `segmentColorHash`) and a picked fragment surfaces the global id.  The
  // backend always synthesises this column (per-fragment `segment_id`, or
  // the fragment's chunk-local index as a fallback), so it is unconditional.
  out.push({
    name: "segment",
    dataType: DataType.UINT64,
    numComponents: 1,
    webglDataType: WebGL2RenderingContext.UNSIGNED_INT,
    glslDataType: getShaderType(DataType.UINT64, 1),
  });
  return out;
}

/**
 * Frontend chunk source backing the spatially-indexed (pass-1) render
 * layer.  Paired with `ZarrVectorsSpatiallyIndexedSkeletonSourceBackend`
 * via `RPC_ID` on the parameter class.
 *
 * One instance per resolution level.  The render layer enumerates
 * visible chunks via the inherited `SpatiallyIndexedSkeletonSource`
 * frustum-culling machinery and the matching backend's `download()`
 * fetches + decodes zarr-vectors chunks.
 */
export class ZarrVectorsSpatiallyIndexedSkeletonSource extends WithParameters(
  WithSharedKvStoreContext(SpatiallyIndexedSkeletonSource),
  ZarrVectorsSpatiallyIndexedSkeletonSourceParameters,
) {
  private zvAttributeTextureFormats_?: TextureFormat[];

  constructor(
    ...args: ConstructorParameters<typeof SpatiallyIndexedSkeletonSource>
  ) {
    super(...args);
    // `SpatiallyIndexedSkeletonSource`'s constructor bakes in
    // `[position, segment]` for `vertexAttributes`.  We replace it with a
    // shape that matches what the backend's `download()` actually packs
    // into `chunk.vertexAttributes`: position, then a synthesised tangent
    // (streamline / polyline / graph / skeleton), then user-declared
    // attributes, then a synthesised `"segment"` column last (mirroring
    // `skeleton_backend.ts:ZarrVectorsSpatiallyIndexedSkeletonSourceBackend`).
    this.vertexAttributes = buildZvSpatialVertexAttributes(this.parameters);
  }

  /**
   * Texture-format array indexed in lock-step with `vertexAttributes`
   * and the `vertexAttributeOffsets` produced by
   * `serializeSkeletonChunkData`.  Returning the right number of entries
   * here is what stops the runtime crash described at
   * `skeleton/frontend.ts:1593` ("`Cannot destructure property
   * 'arrayConstructor' of 'format' as it is undefined`").
   *
   * Overrides the parent's cached `[position, segment]` formats — see
   * `skeleton/frontend.ts:1716-1734`.
   */
  get attributeTextureFormats(): TextureFormat[] {
    let cached = this.zvAttributeTextureFormats_;
    if (cached === undefined) {
      cached = this.zvAttributeTextureFormats_ = this.vertexAttributes.map(
        ({ dataType, numComponents }) =>
          computeTextureFormat(new TextureFormat(), dataType, numComponents),
      );
    }
    return cached;
  }

  /**
   * Map driving the `prop_<name>()` shader bridge.  The order here
   * must match how `ZarrVectorsSpatiallyIndexedSkeletonSourceBackend.download()`
   * populates `chunk.vertexAttributes`: tangent (streamline / polyline only)
   * first, then user-declared attributes in declaration order.
   */
  get zvVertexAttributeMap(): Map<string, VertexAttributeInfo> {
    return buildVertexAttributeMap(this.parameters);
  }

  /**
   * Preferred default shader text, looked up from the per-kind
   * capability table in `geometry_kind.ts`.  Streamlines auto-apply
   * the RGB-by-tangent shader; polylines, skeletons, and graphs fall
   * through to the segmentation layer's segment-coloured default
   * (`undefined` here).
   *
   * The integration point that consumes this is a follow-up to slice
   * 4d (segmentation-layer mount-time hook); for now the getter is
   * available for documentation tools and tests.
   */
  get defaultFragmentMain(): string | undefined {
    return KIND_CAPABILITIES[this.parameters.geometryKind].defaultFragmentMain;
  }
}

/**
 * Frontend chunk source backing the object-keyed (pass-2) render layer.
 * Paired with `ZarrVectorsObjectKeyedSkeletonSourceBackend` (to be
 * implemented in slice 4b once the `object_index/manifests` zarr-vlen-
 * bytes reader exists).
 *
 * Today this class is a thin shell so the RPC parameter type is
 * referenced in at least one frontend module and `tsgo` keeps it in the
 * dependency graph; the backend's `download()` is not yet implemented.
 */
export class ZarrVectorsObjectKeyedSkeletonSource extends WithParameters(
  WithSharedKvStoreContext(SkeletonSource),
  ZarrVectorsObjectKeyedSkeletonSourceParameters,
) {
  /**
   * Vertex positions are physical coordinates (NGFF
   * `multiscales[0].axes` units), NOT voxel indices.  The render layer
   * uses this flag to skip the implicit voxel→world transform.
   */
  get skeletonVertexCoordinatesInVoxels() {
    return false;
  }

  /**
   * Map driving the `prop_<name>()` shader bridge.  Same ordering
   * convention as the spatially-indexed source — the backend's
   * `download()` packs `chunk.vertexAttributes` in this order.
   */
  get vertexAttributes(): Map<string, VertexAttributeInfo> {
    return buildVertexAttributeMap(this.parameters);
  }

  /**
   * Preferred default shader text for streamline stores.  See the
   * matching getter on `ZarrVectorsSpatiallyIndexedSkeletonSource` for
   * design notes.
   */
  get defaultFragmentMain(): string | undefined {
    return KIND_CAPABILITIES[this.parameters.geometryKind].defaultFragmentMain;
  }
}

// ---------------------------------------------------------------------------
// Multiscale spatially-indexed source (pass-1 wrapper)
// ---------------------------------------------------------------------------

/**
 * One pyramid-level entry for the spatially-indexed (pass-1) source.
 * Each level owns its own chunk-source parameter blob (`baseUrl`,
 * `attributeNames`, etc.); the parent multiscale source builds the
 * per-level `SpatiallyIndexedSkeletonChunkSpecification` from shared
 * grid info (`chunkShape`, `gridShapeInVoxels`) since zarr-vectors
 * keeps the chunk grid uniform across levels.
 */
export interface ZarrVectorsSkeletonSpatialLevel {
  readonly parameters: ZarrVectorsSpatiallyIndexedSkeletonSourceParameters;
}

/**
 * Multiscale wrapper that hands out per-level `SpatiallyIndexedSkeletonSource`
 * chunk sources to the segmentation layer's pass-1 spatial render path.
 * Mirrors the catmaid template at
 * `src/datasource/catmaid/frontend.ts:202-307` but without credentials
 * (we use a shared kvstore context) and reads its grid info from the
 * zarr-vectors store metadata.
 *
 * Constraint: positions are 3-D.  Neuroglancer's
 * `spatiallyIndexedSkeletonTextureAttributeSpecs` hardcodes
 * `position: float32×3` (see `skeleton/frontend.ts:1706-1709`), so 2-D
 * or higher-rank zarr-vectors stores fall back to pass-2 only.  The
 * caller (`buildSkeletonMetadata`) must enforce this.
 */
export class ZarrVectorsMultiscaleSpatiallyIndexedSkeletonSource extends MultiscaleSpatiallyIndexedSkeletonSource {
  /**
   * Opt in to camera-driven LOD picking: zarr-vectors stores publish
   * synthetic per-level spacings via `getSpatialSkeletonGridSizes()`,
   * so the picker can pick a meaningful level for the current camera
   * zoom.  See `src/skeleton/frontend.ts:maybeUpdateAutoSpatialSkeletonGridResolutionTarget`.
   */
  override get prefersAutoSpatialSkeletonGridLevel(): boolean {
    return true;
  }

  /** Per-level chunk-source parameter blobs in finest-first order. */
  readonly levels: ReadonlyArray<ZarrVectorsSkeletonSpatialLevel>;
  /**
   * Per-level chunk shape in world units, finest-first.  Length ==
   * `levels.length`.  Each entry comes from the level's own
   * ``zarr_vectors_level.chunk_shape`` if present, otherwise from the
   * root chunk_shape.  Writers should use ``chunk_scale_factors`` to
   * make this monotonically distinct across levels — that's what makes
   * the spatial grid-resolution picker show multiple positions and
   * what makes auto-LOD level switching meaningful (matches the
   * CATMAID per-level chunk-size pattern at
   * `src/datasource/catmaid/frontend.ts:386-390`).  Sparsity-only
   * pyramids without per-level chunk-shape changes still load, but
   * adjacent levels collapse into one widget entry.
   */
  readonly perLevelChunkShape: Float32Array[];
  /**
   * Meters per coordinate unit, per axis (from the store's NGFF
   * scale + unit).  Used to report grid sizes in physical meters so the
   * resolution widget + auto-LOD picker are unit-consistent regardless of
   * the global coordinate space's voxel size.
   */
  readonly metersPerUnit: Float64Array;
  /** World-space lower bound of the data; can be negative. */
  readonly lowerBounds: Float32Array;
  /** World-space upper bound of the data. */
  readonly upperBounds: Float32Array;

  get rank(): number {
    return 3;
  }

  /**
   * Returns each level's chunk shape verbatim as the grid spacing the
   * picker UI matches against.  Mirrors CATMAID's per-level
   * ``chunkSize`` extraction — no synthetic factors, no inference.
   * Writers that want distinct picker entries set
   * ``chunk_scale_factors`` so each level's chunk_shape is monotonically
   * different.
   */
  override getSpatialSkeletonGridSizes(): {
    x: number;
    y: number;
    z: number;
  }[] {
    // Report in physical meters (chunk_shape × meters-per-unit) so the
    // resolution widget reads in real units and the auto-LOD target
    // (also meters) compares correctly, independent of the global
    // coordinate space's voxel size.
    const m = this.metersPerUnit;
    return this.perLevelChunkShape.map((cs) => ({
      x: cs[0] * m[0],
      y: cs[1] * m[1],
      z: cs[2] * m[2],
    }));
  }

  /**
   * Expose every pyramid level to the render layer.  The default
   * implementation on `MultiscaleSpatiallyIndexedSkeletonSource` returns
   * `scales[0][0]` per group — i.e. only the first source.  Because we
   * put all levels in a single scale group (see `getSources` below),
   * the default would drop two of our three levels on the floor.  Match
   * the catmaid datasource's `getPerspectiveSources` override which
   * returns the full first group.
   */
  override getPerspectiveSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] {
    const sources = this.getSources(SPATIAL_SKELETON_SOURCE_OPTIONS);
    return sources.length > 0 ? sources[0] : [];
  }

  override getSliceViewPanelSources(): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] {
    return this.getPerspectiveSources();
  }

  constructor(
    chunkManager: Borrowed<ChunkManager>,
    private readonly sharedKvStoreContext: SharedKvStoreContext,
    options: {
      levels: ReadonlyArray<ZarrVectorsSkeletonSpatialLevel>;
      perLevelChunkShape: Float32Array[];
      metersPerUnit: Float64Array;
      lowerBounds: Float32Array;
      upperBounds: Float32Array;
    },
  ) {
    super(chunkManager);
    this.levels = options.levels;
    this.perLevelChunkShape = options.perLevelChunkShape;
    this.metersPerUnit = options.metersPerUnit;
    this.lowerBounds = options.lowerBounds;
    this.upperBounds = options.upperBounds;
  }

  getSources(
    _options: SliceViewSourceOptions,
  ): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[][] {
    const sources: SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] =
      [];
    const { perLevelChunkShape, lowerBounds, upperBounds } = this;

    for (let k = 0; k < this.levels.length; ++k) {
      const level = this.levels[k];
      const chunkShape = perLevelChunkShape[k];
      // zarr-vectors chunks are indexed around world origin (chunk
      // `(i,j,k)` covers world `[i*chunkShape, (i+1)*chunkShape]`),
      // and chunk indices can be negative.  Both chunkLayout and
      // chunkToMultiscaleTransform are identity — vertex world coords
      // come straight off disk in NGFF physical units.  Per-level
      // `chunkShape` may differ when the writer used
      // `chunk_scale_factors`.
      const chunkLayoutTransform = mat4.create();
      const chunkLayout = new ChunkLayout(
        vec3.fromValues(chunkShape[0], chunkShape[1], chunkShape[2]),
        chunkLayoutTransform,
        3,
      );

      const chunkDataSize = new Uint32Array([
        chunkShape[0],
        chunkShape[1],
        chunkShape[2],
      ]);
      // lowerVoxelBound / upperVoxelBound encode the data extent in
      // world (= chunk-layout) units; `makeSliceViewChunkSpecification`
      // floors / ceils these to chunk-index bounds, which handle
      // negative chunk indices fine.
      const spec: SpatiallyIndexedSkeletonChunkSpecification = {
        ...makeSliceViewChunkSpecification({
          rank: 3,
          chunkDataSize,
          lowerVoxelBound: lowerBounds,
          upperVoxelBound: upperBounds,
        }),
        chunkLayout,
      };

      const chunkSource = this.chunkManager.getChunkSource(
        ZarrVectorsSpatiallyIndexedSkeletonSource,
        {
          sharedKvStoreContext: this.sharedKvStoreContext,
          spec,
          parameters: level.parameters,
        },
      );

      // Identity chunk-to-multiscale transform — chunks already live in
      // the same coordinate frame as the rest of the layer.  See the
      // chunk-grid comment above.
      const chunkToMultiscaleTransform = mat4.create();

      sources.push({ chunkSource, chunkToMultiscaleTransform });
    }

    // Single scale group — all levels are alternative representations
    // of the same data at decreasing fidelity.  The render layer picks
    // levels per the layer's pyramid-mode setting.
    return [sources];
  }
}
