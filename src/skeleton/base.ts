/**
 * @license
 * Copyright 2016 Google Inc.
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

import type { ProjectionParameters } from "#src/projection_parameters.js";
import {
  getSpatialSkeletonSourceScalesByLimit,
  selectSpatialSkeletonSourceByLimit,
  type SpatialSkeletonSourceDensityInput,
} from "#src/skeleton/source_selection.js";
import type {
  SliceViewChunkSource,
  SliceViewChunkSpecification,
  TransformedSource,
} from "#src/sliceview/base.js";
import { forEachVisibleVolumetricChunk } from "#src/sliceview/base.js";
import type { DataType } from "#src/util/data_type.js";
import {
  getViewFrustumVolume,
  mat3,
  mat3FromMat4,
  prod3,
} from "#src/util/geom.js";

export const SKELETON_LAYER_RPC_ID = "skeleton/SkeletonLayer";

export const SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_RPC_ID =
  "skeleton/SpatiallyIndexedSkeletonRenderLayer";
export const SPATIALLY_INDEXED_SKELETON_RENDER_LAYER_UPDATE_SOURCES_RPC_ID =
  "skeleton/SpatiallyIndexedSkeletonRenderLayer.updateSources";

export interface VertexAttributeInfo {
  dataType: DataType;
  numComponents: number;
}

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
