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

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type {
  SkeletonSpatialIndexLevel,
  SkeletonSpatialIndexMetadata,
} from "#src/skeleton/api.js";
import type {
  SliceViewChunkSource,
  SliceViewChunkSpecification,
  TransformedSource,
} from "#src/sliceview/base.js";
import {
  forEachVisibleVolumetricChunk,
  makeSliceViewChunkSpecification,
} from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import {
  getViewFrustumVolume,
  mat3,
  mat3FromMat4,
  mat4,
  prod3,
  vec3,
} from "#src/util/geom.js";

export const SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID =
  "skeleton/SpatiallyIndexedSkeletonRenderLayer";
export const SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID =
  "skeleton/SpatiallyIndexedSkeletonRenderLayer.updateSources";

export interface SpatiallyIndexedSkeletonChunkSpecification
  extends SliceViewChunkSpecification {
  chunkLayout: any;
  limit: number;
}

const tempMat3 = mat3.create();

export interface SpatialSkeletonSourceDensityContext<
  Transformed extends TransformedSource<any, SliceViewChunkSource>,
> {
  sourceDensityInputs: SpatialSkeletonSourceDensityInput<Transformed>[];
  physicalDensityTarget: number;
  effectiveVolume: number;
  viewportArea: number;
}

function getSpatialSkeletonSliceFraction(transformedSource: TransformedSource) {
  const spec = transformedSource.source
    .spec as SpatiallyIndexedSkeletonChunkSpecification;
  const { rank } = spec;
  const { nonDisplayLowerClipBound, nonDisplayUpperClipBound } =
    transformedSource;
  let sliceFraction = 1;
  for (let i = 0; i < rank; ++i) {
    const b = nonDisplayUpperClipBound[i] - nonDisplayLowerClipBound[i];
    if (Number.isFinite(b)) sliceFraction /= b;
  }
  return sliceFraction;
}

function getSpatialSkeletonChunkPhysicalVolume(
  transformedSource: TransformedSource,
  canonicalToPhysicalScale: number,
) {
  const { chunkLayout } = transformedSource;
  return (
    prod3(chunkLayout.size) *
    Math.abs(chunkLayout.detTransform) *
    canonicalToPhysicalScale
  );
}

export function getSpatialSkeletonSourceDensityContext<
  Transformed extends TransformedSource<any, SliceViewChunkSource>,
>(
  projectionParameters: ProjectionParameters,
  spacingTarget: number,
  transformedSources: readonly Transformed[],
): SpatialSkeletonSourceDensityContext<Transformed> | undefined {
  if (transformedSources.length === 0) return undefined;

  const {
    displayDimensionRenderInfo,
    viewMatrix,
    projectionMat,
    width,
    height,
  } = projectionParameters;
  const { voxelPhysicalScales } = displayDimensionRenderInfo;
  const viewDet = Math.abs(
    mat3.determinant(mat3FromMat4(tempMat3, viewMatrix)),
  );
  const canonicalToPhysicalScale = prod3(voxelPhysicalScales);
  const viewFrustumVolume =
    (getViewFrustumVolume(projectionMat) / viewDet) * canonicalToPhysicalScale;

  const sourceDensityInputs = transformedSources.map((tsource, index) => {
    const spec = tsource.source
      .spec as SpatiallyIndexedSkeletonChunkSpecification;
    return {
      source: tsource,
      index,
      physicalVolume: getSpatialSkeletonChunkPhysicalVolume(
        tsource,
        canonicalToPhysicalScale,
      ),
      limit: spec.limit,
      sliceFraction: getSpatialSkeletonSliceFraction(tsource),
    };
  });
  const baseSource = sourceDensityInputs[0].source;
  let sourceVolume =
    Math.abs(baseSource.chunkLayout.detTransform) * canonicalToPhysicalScale;
  const { lowerClipDisplayBound, upperClipDisplayBound } = baseSource;
  for (let i = 0; i < 3; ++i) {
    sourceVolume *= upperClipDisplayBound[i] - lowerClipDisplayBound[i];
  }

  const effectiveVolume = Math.min(sourceVolume, viewFrustumVolume);
  const viewportArea = width * height;
  const targetNumNodes = viewportArea / spacingTarget ** 2;
  const physicalDensityTarget = targetNumNodes / effectiveVolume;
  return {
    sourceDensityInputs,
    physicalDensityTarget,
    effectiveVolume,
    viewportArea,
  };
}

export function forEachSpatialSkeletonSourceScale<
  Transformed extends TransformedSource<any, SliceViewChunkSource>,
>(
  projectionParameters: ProjectionParameters,
  spacingTarget: number,
  transformedSources: readonly Transformed[],
  callback: (
    source: Transformed,
    index: number,
    physicalSpacing: number,
    pixelSpacing: number,
    selected: boolean,
  ) => void,
) {
  const densityContext = getSpatialSkeletonSourceDensityContext(
    projectionParameters,
    spacingTarget,
    transformedSources,
  );
  if (densityContext === undefined) return;
  const {
    sourceDensityInputs,
    physicalDensityTarget,
    effectiveVolume,
    viewportArea,
  } = densityContext;
  const selection = selectSpatialSkeletonSourceByLimit(
    sourceDensityInputs,
    physicalDensityTarget,
    effectiveVolume,
    viewportArea,
  );
  if (selection === undefined) return;
  for (const scale of getSpatialSkeletonSourceScalesByLimit(
    sourceDensityInputs,
    effectiveVolume,
    viewportArea,
  )) {
    callback(
      scale.source,
      scale.index,
      scale.physicalSpacing,
      scale.pixelSpacing,
      scale.source === selection.source,
    );
  }
}

export function forEachVisibleSpatialSkeletonChunk<
  Transformed extends TransformedSource<any, SliceViewChunkSource>,
>(
  projectionParameters: ProjectionParameters,
  localPosition: Float32Array,
  spacingTarget: number,
  transformedSources: readonly Transformed[],
  beginScale: (source: Transformed, index: number) => void,
  callback: (
    source: Transformed,
    index: number,
    physicalSpacing: number,
    pixelSpacing: number,
  ) => void,
) {
  const densityContext = getSpatialSkeletonSourceDensityContext(
    projectionParameters,
    spacingTarget,
    transformedSources,
  );
  if (densityContext === undefined) return;
  const {
    sourceDensityInputs,
    physicalDensityTarget,
    effectiveVolume,
    viewportArea,
  } = densityContext;

  const selection = selectSpatialSkeletonSourceByLimit(
    sourceDensityInputs,
    physicalDensityTarget,
    effectiveVolume,
    viewportArea,
  );
  if (selection === undefined) return;

  const { source: tsource, index, physicalSpacing, pixelSpacing } = selection;
  let firstChunk = true;
  forEachVisibleVolumetricChunk(
    projectionParameters,
    localPosition,
    tsource,
    () => {
      if (firstChunk) {
        beginScale(tsource, index);
        firstChunk = false;
      }
      callback(tsource, index, physicalSpacing, pixelSpacing);
    },
  );
}

export interface SpatialSkeletonSourceLimitInput {
  limit: number;
}

export interface SpatialSkeletonSourceDensityInput<T>
  extends SpatialSkeletonSourceLimitInput {
  source: T;
  index: number;
  physicalVolume: number;
  sliceFraction: number;
}

export interface SpatialSkeletonSourceDensitySelection<T>
  extends SpatialSkeletonSourceDensityInput<T> {
  physicalDensity: number;
  totalPhysicalDensity: number;
  physicalSpacing: number;
  pixelSpacing: number;
}

export const SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR =
  "Spatial skeleton limit: 0 is only supported on the finest source level.";

function validateSpatialSkeletonLimitZeroOnlyFinalSource<
  T extends SpatialSkeletonSourceLimitInput,
>(sources: readonly T[]) {
  for (let i = 0; i < sources.length - 1; ++i) {
    if (sources[i].limit === 0) {
      throw new Error(SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR);
    }
  }
}

function makeSpatialSkeletonSourceSelection<T>(
  source: SpatialSkeletonSourceDensityInput<T>,
  physicalDensity: number,
  effectiveVolume: number,
  viewportArea: number,
): SpatialSkeletonSourceDensitySelection<T> {
  const hasKnownDensity = physicalDensity > 0;
  return {
    ...source,
    physicalDensity,
    totalPhysicalDensity: physicalDensity,
    physicalSpacing: hasKnownDensity
      ? (1 / physicalDensity) ** (1 / 3)
      : Number.POSITIVE_INFINITY,
    pixelSpacing: hasKnownDensity
      ? Math.sqrt(viewportArea / (physicalDensity * effectiveVolume))
      : Number.POSITIVE_INFINITY,
  };
}

export function selectSpatialSkeletonSourceByLimit<T>(
  sources: readonly SpatialSkeletonSourceDensityInput<T>[],
  physicalDensityTarget: number,
  effectiveVolume: number,
  viewportArea: number,
): SpatialSkeletonSourceDensitySelection<T> | undefined {
  if (sources.length === 0) return undefined;
  validateSpatialSkeletonLimitZeroOnlyFinalSource(sources);

  for (const source of sources) {
    if (source.limit === 0) {
      continue;
    }
    const physicalDensity =
      (source.limit * source.sliceFraction) / source.physicalVolume;
    if (physicalDensity >= physicalDensityTarget) {
      return makeSpatialSkeletonSourceSelection(
        source,
        physicalDensity,
        effectiveVolume,
        viewportArea,
      );
    }
  }

  const finestSource = sources[sources.length - 1];
  if (finestSource.limit === 0) {
    return makeSpatialSkeletonSourceSelection(
      finestSource,
      Number.POSITIVE_INFINITY,
      effectiveVolume,
      viewportArea,
    );
  }
  const physicalDensity =
    (finestSource.limit * finestSource.sliceFraction) /
    finestSource.physicalVolume;
  return makeSpatialSkeletonSourceSelection(
    finestSource,
    physicalDensity,
    effectiveVolume,
    viewportArea,
  );
}

export function getSpatialSkeletonSourceScalesByLimit<T>(
  sources: readonly SpatialSkeletonSourceDensityInput<T>[],
  effectiveVolume: number,
  viewportArea: number,
): SpatialSkeletonSourceDensitySelection<T>[] {
  validateSpatialSkeletonLimitZeroOnlyFinalSource(sources);
  return sources.map((source) => {
    const physicalDensity =
      source.limit === 0
        ? Number.POSITIVE_INFINITY
        : (source.limit * source.sliceFraction) / source.physicalVolume;
    return makeSpatialSkeletonSourceSelection(
      source,
      physicalDensity,
      effectiveVolume,
      viewportArea,
    );
  });
}

/** From coarsest to finest, like the levels. */
export function getSpatialSkeletonLevelSpecs(
  metadata: SkeletonSpatialIndexMetadata,
): SpatiallyIndexedSkeletonChunkSpecification[] {
  if (metadata.modelSpace.rank !== 3) {
    throw new Error(
      `Spatial skeleton coordinate space must have rank 3, not ${metadata.modelSpace.rank}.`,
    );
  }
  const { lowerBounds, upperBounds } = metadata.modelSpace.bounds;
  if (![...lowerBounds, ...upperBounds].every(Number.isFinite)) {
    throw new Error("Spatial skeleton coordinate space bounds must be finite.");
  }
  validateSpatialSkeletonLimitZeroOnlyFinalSource(metadata.levels);
  const { modelSpace, levels } = metadata;
  return levels.map((level) => makeSpatialSkeletonLevelSpec(modelSpace, level));
}

function makeSpatialSkeletonLevelSpec(
  modelSpace: CoordinateSpace,
  level: SkeletonSpatialIndexLevel,
): SpatiallyIndexedSkeletonChunkSpecification {
  const { scales, bounds } = modelSpace;
  const chunkDataSize = Float32Array.from(level.chunkSize);
  const chunkLayout = new ChunkLayout(
    vec3.fromValues(chunkDataSize[0], chunkDataSize[1], chunkDataSize[2]),
    mat4.fromScaling(
      mat4.create(),
      vec3.fromValues(scales[0], scales[1], scales[2]),
    ),
    3,
  );
  return {
    ...makeSliceViewChunkSpecification({
      rank: 3,
      chunkDataSize,
      lowerVoxelBound: Float32Array.from(bounds.lowerBounds),
      upperVoxelBound: Float32Array.from(bounds.upperBounds),
    }),
    chunkLayout,
    limit: level.limit,
  };
}
