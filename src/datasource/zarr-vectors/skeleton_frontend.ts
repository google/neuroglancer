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

import type { Borrowed } from "#src/util/disposable.js";
import {
  ZarrVectorsObjectKeyedSkeletonSourceParameters,
  ZarrVectorsSpatiallyIndexedSkeletonSourceParameters,
  type ZarrVectorsAttributeDtype,
  type ZarrVectorsSkeletonGeometryKind,
} from "#src/datasource/zarr-vectors/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  DEFAULT_STREAMLINE_FRAGMENT_MAIN,
  buildVertexAttributeMap,
} from "#src/datasource/zarr-vectors/skeleton_shader_bridge.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { VertexAttributeInfo } from "#src/skeleton/base.js";
import {
  MultiscaleSpatiallyIndexedSkeletonSource,
  SkeletonSource,
  SPATIAL_SKELETON_SOURCE_OPTIONS,
  SpatiallyIndexedSkeletonSource,
  type SpatiallyIndexedSkeletonChunkSpecification,
} from "#src/skeleton/frontend.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import { DataType } from "#src/util/data_type.js";
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
 * Deviates from `SpatiallyIndexedSkeletonSource`'s baked-in
 * `[position, segment]` shape: we have no per-vertex segment-ID column
 * in the on-disk format, so the render layer's `segmentAttributeIndex`
 * ends up `undefined` and the per-segment colouring shader path is
 * gracefully skipped (TODO in `skeleton/frontend.ts:344-349` already
 * anticipates this).
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
  if (
    parameters.geometryKind === "streamline" ||
    parameters.geometryKind === "polyline"
  ) {
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

  constructor(...args: ConstructorParameters<typeof SpatiallyIndexedSkeletonSource>) {
    super(...args);
    // `SpatiallyIndexedSkeletonSource`'s constructor bakes in
    // `[position, segment]` for `vertexAttributes`.  zarr-vectors stores
    // have no per-vertex segment column, but they may carry a
    // synthesised tangent plus user-declared per-vertex attributes — so
    // we replace the baked-in shape with one that matches what the
    // backend's `download()` actually packs into `chunk.vertexAttributes`
    // (mirroring `skeleton_backend.ts:ZarrVectorsSpatiallyIndexedSkeletonSourceBackend`).
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
   * Preferred default shader text.  For streamline geometries returns
   * the RGB-by-tangent shader; for skeleton / polyline geometries
   * returns `undefined` (the segmentation layer's existing default of
   * `emitDefault()` — segment-coloured — is the right fallback).
   *
   * The integration point that consumes this is a follow-up to slice
   * 4d (segmentation-layer mount-time hook); for now the getter is
   * available for documentation tools and tests.
   */
  get defaultFragmentMain(): string | undefined {
    if (this.parameters.geometryKind === "streamline") {
      return DEFAULT_STREAMLINE_FRAGMENT_MAIN;
    }
    return undefined;
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
    if (this.parameters.geometryKind === "streamline") {
      return DEFAULT_STREAMLINE_FRAGMENT_MAIN;
    }
    return undefined;
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
  /** Per-level chunk-source parameter blobs in finest-first order. */
  readonly levels: ReadonlyArray<ZarrVectorsSkeletonSpatialLevel>;
  /** Shared grid info — all levels share the same chunk-grid in zarr-vectors. */
  readonly chunkShape: Float32Array;
  /** World-space lower bound of the data; can be negative. */
  readonly lowerBounds: Float32Array;
  /** World-space upper bound of the data. */
  readonly upperBounds: Float32Array;
  /**
   * Per-level synthetic spacing multiplier reported to neuroglancer's
   * grid-resolution picker.  See
   * `frontend.ts:computeLevelSpacingFactors` for derivation rules.
   * Finest-first, length == `levels.length`.
   */
  readonly levelSpacingFactors: Float32Array;

  get rank(): number {
    return 3;
  }

  /**
   * Exposes per-level grid sizes to the segmentation layer's grid-level
   * picker UI.  zarr-vectors uses a uniform chunk grid across pyramid
   * levels (the pyramid stores fewer fragments per chunk at coarser
   * levels, not a coarser grid), so every entry is identical — but the
   * render layer still needs one entry per level so its grid-level
   * watchable maps cleanly to `parameters.gridIndex`.
   */
  override getSpatialSkeletonGridSizes(): { x: number; y: number; z: number }[] {
    const { chunkShape, levelSpacingFactors } = this;
    return this.levels.map((_, k) => {
      const f = levelSpacingFactors[k];
      return {
        x: chunkShape[0] * f,
        y: chunkShape[1] * f,
        z: chunkShape[2] * f,
      };
    });
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
      chunkShape: Float32Array;
      lowerBounds: Float32Array;
      upperBounds: Float32Array;
      levelSpacingFactors: Float32Array;
    },
  ) {
    super(chunkManager);
    this.levels = options.levels;
    this.chunkShape = options.chunkShape;
    this.lowerBounds = options.lowerBounds;
    this.upperBounds = options.upperBounds;
    this.levelSpacingFactors = options.levelSpacingFactors;
  }

  getSources(
    _options: SliceViewSourceOptions,
  ): SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[][] {
    const sources: SliceViewSingleResolutionSource<SpatiallyIndexedSkeletonSource>[] =
      [];
    const { chunkShape, lowerBounds, upperBounds } = this;

    for (const level of this.levels) {
      // zarr-vectors chunks are indexed around world origin (chunk
      // `(i,j,k)` covers world `[i*chunkShape, (i+1)*chunkShape]`),
      // and chunk indices can be negative.  Both chunkLayout and
      // chunkToMultiscaleTransform are identity — vertex world coords
      // come straight off disk in NGFF physical units.
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
