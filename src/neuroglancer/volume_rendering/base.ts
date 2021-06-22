/**
 * @license
 * Copyright 2020 Google Inc.
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
import {forEachVisibleVolumetricChunk, MultiscaleVolumetricDataRenderLayer, TransformedSource} from 'neuroglancer/sliceview/base';
import {VolumeChunkSource} from 'neuroglancer/sliceview/volume/base';
import {getViewFrustrumDepthRange, mat3, mat3FromMat4, prod3, vec3} from 'neuroglancer/util/geom';

export const VOLUME_RENDERING_RENDER_LAYER_RPC_ID = 'volume_rendering/VolumeRenderingRenderLayer';
export const VOLUME_RENDERING_RENDER_LAYER_UPDATE_SOURCES_RPC_ID =
    'volume_rendering/VolumeRenderingRenderLayer/update';

// FIXME: make this variable
export const volumeRenderingDepthSamples = 64;

const tempMat3 = mat3.create();
// const tempMat4 = mat4.create();
// const tempVisibleVolumetricClippingPlanes = new Float32Array(24);

export function getVolumeRenderingNearFarBounds(
    clippingPlanes: Float32Array, displayLowerBound: Float32Array,
    displayUpperBound: Float32Array) {
  let volumeMinZ = 0, volumeMaxZ = 0;
  for (let i = 0; i < 3; ++i) {
    const planeCoeff = clippingPlanes[16 + i];
    const a = planeCoeff * displayLowerBound[i], b = planeCoeff * displayUpperBound[i];
    volumeMinZ += Math.min(a, b);
    volumeMaxZ += Math.max(a, b);
  }
  const near = -clippingPlanes[19];
  const adjustedNear = Math.max(near, volumeMinZ);
  const far = clippingPlanes[23];
  const adjustedFar = Math.min(far, volumeMaxZ);
  return {near, far, adjustedNear, adjustedFar};
}

// Returns target volume in "world" space.
// function getTargetVolume(
//     tsource: TransformedSource<MultiscaleVolumetricDataRenderLayer>,
//     projectionParameters: ProjectionParameters) {
//   const modelViewProjection = mat4.multiply(
//       tempMat4, projectionParameters.viewProjectionMat, tsource.chunkLayout.transform);
//   const clippingPlanes = tempVisibleVolumetricClippingPlanes;
//   getFrustrumPlanes(clippingPlanes, modelViewProjection);
//   const {near, far} = getVolumeRenderingNearFarBounds(
//       clippingPlanes, tsource.lowerClipDisplayBound, tsource.upperClipDisplayBound);
//   if (near === far) return -1;
//   const depthRange = (far - near);
//   const targetSpacing = depthRange / volumeRenderingDepthSamples;
//   const targetVolume = targetSpacing ** 3;
//   return targetVolume * tsource.chunkLayout.detTransform;
// }

export function forEachVisibleVolumeRenderingChunk<
    RLayer extends MultiscaleVolumetricDataRenderLayer, Source extends
        VolumeChunkSource, Transformed extends TransformedSource<RLayer, Source>>(
    projectionParameters: ProjectionParameters, localPosition: Float32Array,
    renderScaleTarget: number, transformedSources: readonly Transformed[],
    beginScale: (
        source: Transformed, index: number, physicalSpacing: number, pixelSpacing: number,
        clippingPlanes: Float32Array) => void,
    callback: (source: Transformed, index: number, positionInChunks: vec3) => void) {
  renderScaleTarget;
  if (transformedSources.length === 0) return;
  const {viewMatrix, projectionMat, displayDimensionRenderInfo} = projectionParameters;
  const {voxelPhysicalScales} = displayDimensionRenderInfo;
  const canonicalToPhysicalScale = prod3(voxelPhysicalScales);

  // Target voxel spacing in view space.
  const targetViewSpacing = getViewFrustrumDepthRange(projectionMat) / volumeRenderingDepthSamples;
  // Target voxel volume in view space.
  const targetViewVolume = targetViewSpacing ** 3;
  const viewDet = mat3.determinant(mat3FromMat4(tempMat3, viewMatrix));

  // Target voxel volume in view space.
  // const targetViewVolume = getTargetVolume(transformedSources[0], projectionParameters) *
  // viewDet;

  // Returns volume of a single voxel of source `scaleIndex` in "view" space.
  const getViewVolume = (scaleIndex: number) => {
    const tsource = transformedSources[scaleIndex];
    return Math.abs(tsource.chunkLayout.detTransform * viewDet);
  };
  // Index of source with voxel volume that is closest to `targetViewVolume`.
  let bestScaleIndex = transformedSources.length - 1;
  // Voxel volume in "view" space of source `bestScaleIndex`.
  let bestViewVolume = getViewVolume(bestScaleIndex);
  for (let scaleIndex = bestScaleIndex - 1; scaleIndex >= 0; --scaleIndex) {
    const viewVolume = getViewVolume(scaleIndex);
    if (Math.abs(viewVolume - targetViewVolume) < Math.abs(bestViewVolume - targetViewVolume)) {
      bestViewVolume = viewVolume;
      bestScaleIndex = scaleIndex;
    } else {
      break;
    }
  }

  const physicalSpacing = Math.pow(bestViewVolume * canonicalToPhysicalScale / viewDet, 1 / 3);
  const pixelSpacing =
      Math.pow(bestViewVolume, 1 / 3) * projectionParameters.width / (2 * projectionMat[0]);
  let firstChunk = true;
  const tsource = transformedSources[bestScaleIndex];
  forEachVisibleVolumetricChunk(
      projectionParameters, localPosition, tsource, (positionInChunks, clippingPlanes) => {
        if (firstChunk) {
          beginScale(tsource, bestScaleIndex, physicalSpacing, pixelSpacing, clippingPlanes);
          firstChunk = false;
        }
        callback(tsource, bestScaleIndex, positionInChunks);
      });
}
