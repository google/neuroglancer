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

import {ProjectionParameters} from 'neuroglancer/projection_parameters';
import {forEachVisibleVolumetricChunk, MultiscaleVolumetricDataRenderLayer, SliceViewChunkSource, SliceViewChunkSpecification, TransformedSource} from 'neuroglancer/sliceview/base';
import {getViewFrustrumVolume, mat3, mat3FromMat4, prod3} from 'neuroglancer/util/geom';

export const ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID = 'annotation.MetadataChunkSource';
export const ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID = 'annotation.GeometryChunkSource';
export const ANNOTATION_SUBSET_GEOMETRY_CHUNK_SOURCE_RPC_ID =
    'annotation.SubsetGeometryChunkSource';
export const ANNOTATION_REFERENCE_ADD_RPC_ID = 'annotation.reference.add';
export const ANNOTATION_REFERENCE_DELETE_RPC_ID = 'annotation.reference.delete';
export const ANNOTATION_COMMIT_UPDATE_RPC_ID = 'annotation.commit';
export const ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID = 'annotation.commit';

export interface AnnotationGeometryChunkSpecification extends SliceViewChunkSpecification {
  /**
   * Must equal the `chunkToMultiscaleTransform` in the `SliceViewSingleResolutionSource`.
   */
  chunkToMultiscaleTransform: Float32Array;

  /**
   * Specifies the maximum density of annotations provided by this chunk source, as `limit` per the
   * chunk volume.  The higher the value, the sooner chunks from this source will be subsampled.  To
   * disable subsampling completely, set `limit` to 0.
   */
  limit: number;
}

export const ANNOTATION_SPATIALLY_INDEXED_RENDER_LAYER_RPC_ID =
    'annotation/SpatiallyIndexedRenderLayer';
export const ANNOTATION_PERSPECTIVE_RENDER_LAYER_UPDATE_SOURCES_RPC_ID =
    'annotation/PerspectiveRenderLayer:updateSources';
export const ANNOTATION_RENDER_LAYER_RPC_ID = 'annotation/RenderLayer';
export const ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID =
    'annotation/RenderLayer.updateSegmentation';

const tempMat3 = mat3.create();

export function
forEachVisibleAnnotationChunk<RLayer extends MultiscaleVolumetricDataRenderLayer, Source extends
                                  SliceViewChunkSource<AnnotationGeometryChunkSpecification>,
                                  Transformed extends TransformedSource<RLayer, Source>>(
    projectionParameters: ProjectionParameters, localPosition: Float32Array,
    renderScaleTarget: number, transformedSources: readonly Transformed[],
    beginScale: (source: Transformed, index: number) => void,
    callback: (
        source: Transformed, index: number, drawFraction: number, physicalSpacing: number,
        pixelSpacing: number) => void) {
  const {displayDimensionRenderInfo, viewMatrix, projectionMat, width, height} =
      projectionParameters;
  const {voxelPhysicalScales} = displayDimensionRenderInfo;
  const viewDet = Math.abs(mat3.determinant(mat3FromMat4(tempMat3, viewMatrix)));
  const canonicalToPhysicalScale = prod3(voxelPhysicalScales);
  const viewFrustrumVolume =
      getViewFrustrumVolume(projectionMat) / viewDet * canonicalToPhysicalScale;

  if (transformedSources.length === 0) return;
  const baseSource = transformedSources[0];
  let sourceVolume = Math.abs(baseSource.chunkLayout.detTransform) * canonicalToPhysicalScale;
  const {lowerClipDisplayBound, upperClipDisplayBound} = baseSource;
  for (let i = 0; i < 3; ++i) {
    sourceVolume *= (upperClipDisplayBound[i] - lowerClipDisplayBound[i]);
  }

  const effectiveVolume = Math.min(sourceVolume, viewFrustrumVolume);
  const viewportArea = width * height;
  const targetNumAnnotations = viewportArea / (renderScaleTarget ** 2);
  const physicalDensityTarget = targetNumAnnotations / effectiveVolume;

  // Target density in annotations per physical volume.
  let totalPhysicalDensity = 0;
  for (let scaleIndex = transformedSources.length - 1;
       scaleIndex >= 0 && totalPhysicalDensity < physicalDensityTarget; --scaleIndex) {
    const transformedSource = transformedSources[scaleIndex];
    const spec = transformedSource.source.spec as AnnotationGeometryChunkSpecification;
    const {chunkLayout} = transformedSource;
    const physicalVolume =
        prod3(chunkLayout.size) * Math.abs(chunkLayout.detTransform) * canonicalToPhysicalScale;
    const {limit, rank} = spec;
    const {nonDisplayLowerClipBound, nonDisplayUpperClipBound} = transformedSource;
    let sliceFraction = 1;
    for (let i = 0; i < rank; ++i) {
      const b = (nonDisplayUpperClipBound[i] - nonDisplayLowerClipBound[i]);
      if (Number.isFinite(b)) sliceFraction /= b;
    }
    const physicalDensity = limit * sliceFraction / physicalVolume;

    let firstChunk = true;
    const newTotalPhysicalDensity = totalPhysicalDensity + physicalDensity;
    const totalPhysicalSpacing = Math.pow(1 / newTotalPhysicalDensity, 1 / 3);
    const totalPixelSpacing = Math.sqrt(viewportArea / (newTotalPhysicalDensity * effectiveVolume));
    const desiredCount =
        (physicalDensityTarget - totalPhysicalDensity) * physicalVolume / sliceFraction;
    const drawFraction = Math.min(1, desiredCount / spec.limit);
    forEachVisibleVolumetricChunk(projectionParameters, localPosition, transformedSource, () => {
      if (firstChunk) {
        beginScale(transformedSource, scaleIndex);
        firstChunk = false;
      }
      callback(
          transformedSource, scaleIndex, drawFraction, totalPhysicalSpacing, totalPixelSpacing);
    });
    totalPhysicalDensity = newTotalPhysicalDensity;
  }
}
