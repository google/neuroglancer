/**
 * @license
 * Copyright 2019 Google Inc.
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

import {CoordinateSpace, CoordinateSpaceTransform, emptyValidCoordinateSpace, homogeneousTransformSubmatrix} from 'neuroglancer/coordinate_transform';
import {DisplayDimensionRenderInfo} from 'neuroglancer/navigation_state';
import {CachedWatchableValue, constantWatchableValue, makeCachedDerivedWatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual, scatterUpdate} from 'neuroglancer/util/array';
import {ValueOrError} from 'neuroglancer/util/error';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {getDependentTransformInputDimensions} from 'neuroglancer/util/geom';
import * as matrix from 'neuroglancer/util/matrix';
import * as vector from 'neuroglancer/util/vector';
import {prod} from 'neuroglancer/util/vector';

/**
 * Specifies coordinate transform information for a RenderLayer.
 */
export interface RenderLayerTransform {
  /**
   * Rank of chunk/model/layer subspace used by this RenderLayer, including any additional `[0,1)`
   * padding dimensions.
   */
  rank: number;

  /**
   * Rank of chunk/model/layer space, excluding any padding dimensions.
   */
  unpaddedRank: number;

  /**
   * Specifies for each local user layer dimension the corresponding "render layer" dimension.  A
   * value of `-1` indicates there is no corresponding "render layer" dimension.  The combined
   * values of `localToRenderLayerDimensions` and `globalToRenderLayerDimensions` that are not `-1`
   * must be distinct and partition `[0, ..., rank)`, where `rank` is the rank of the "model"
   * coordinate space.
   */
  localToRenderLayerDimensions: readonly number[];

  /**
   * Specifies for each global dimension the corresponding "render layer" dimension.  A value of
   * `-1` indicates there is no corresponding "render layer" dimension.
   */
  globalToRenderLayerDimensions: readonly number[];

  /**
   * Specifies for each channel dimension the corresponding "render layer" dimension.  A value of
   * `-1` indicates there is no corresponding "render layer" dimension.
   */
  channelToRenderLayerDimensions: readonly number[];

  channelToModelDimensions: readonly number[];

  channelSpaceShape: Uint32Array;

  /**
   * Homogeneous transform from "model" coordinate space to "render layer" coordinate space.
   */
  modelToRenderLayerTransform: Float32Array;

  modelDimensionNames: readonly string[];
  layerDimensionNames: readonly string[];
}

export interface ChannelSpace {
  channelCoordinateSpace: CoordinateSpace;
  // Shape of multi-dimensional channel space.
  shape: Uint32Array;
  // Total number of channels, equal to product of `shape`.
  numChannels: number;
  // Row-major array of shape `[count, rank]` specifying the coordinates for each flattened channel.
  // Channels are ordered in Fortran order.
  coordinates: Uint32Array;
}

export const zeroRankChannelSpace: ChannelSpace = {
  channelCoordinateSpace: emptyValidCoordinateSpace,
  shape: new Uint32Array(0),
  numChannels: 1,
  coordinates: new Uint32Array(0),
};

export function getChannelSpace(channelCoordinateSpace: CoordinateSpace): ChannelSpace {
  const {rank} = channelCoordinateSpace;
  const {bounds: {lowerBounds, upperBounds}} = channelCoordinateSpace;
  if (lowerBounds.some(x => x !== 0)) {
    throw new Error('Lower bounds of channel coordinate space must all be 0');
  }
  if (upperBounds.some(x => !Number.isInteger(x) || x <= 0 || x >= 2 ** 32)) {
    throw new Error('Upper bounds of channel coordinate space must all be positive integers');
  }
  const shape = new Uint32Array(upperBounds);
  const numChannels = prod(shape);
  const coordinates = new Uint32Array(numChannels * rank);
  for (let flatIndex = 0; flatIndex < numChannels; ++flatIndex) {
    let remainder = flatIndex;
    for (let dim = 0; dim < rank; ++dim) {
      const coordinate = remainder % shape[dim];
      remainder = (remainder - coordinate) / shape[dim];
      coordinates[flatIndex * rank + dim] = coordinate;
    }
  }
  return {channelCoordinateSpace, shape, numChannels, coordinates};
}

export type RenderLayerTransformOrError = ValueOrError<RenderLayerTransform>;
export type WatchableRenderLayerTransform = WatchableValueInterface<RenderLayerTransformOrError>;

function scaleTransformSubmatrix(
    transform: Float32Array, rank: number, baseInputSpace: CoordinateSpace,
    inputToBaseDimensions: readonly number[], baseOutputSpace: CoordinateSpace,
    baseToOutputDimensions: readonly number[]) {
  const {scales: baseInputScales} = baseInputSpace;
  const {scales: baseOutputScales, rank: baseOutputRank} = baseOutputSpace;
  const stride = rank + 1;
  for (let baseOutputDim = 0; baseOutputDim < baseOutputRank; ++baseOutputDim) {
    const outputDim = baseToOutputDimensions[baseOutputDim];
    if (outputDim === -1) continue;
    const baseOutputScale = baseOutputScales[baseOutputDim];
    for (let inputDim = 0; inputDim < rank; ++inputDim) {
      const baseInputDim = inputToBaseDimensions[inputDim];
      const baseInputScale = baseInputScales[baseInputDim];
      transform[stride * inputDim + outputDim] *= (baseInputScale / baseOutputScale);
    }
  }
}

export function getRenderLayerTransform(
    globalCoordinateSpace: CoordinateSpace, localCoordinateSpace: CoordinateSpace,
    modelToLayerTransform: CoordinateSpaceTransform, subsourceEntry: {
      subsourceToModelSubspaceTransform: Float32Array,
      modelSubspaceDimensionIndices: readonly number[]
    }|undefined,
    channelCoordinateSpace: CoordinateSpace =
        emptyValidCoordinateSpace): RenderLayerTransformOrError {
  const {
    inputSpace: modelSpace,
    rank: fullRank,
    sourceRank,
    outputSpace: layerSpace,
    transform: oldTransform
  } = modelToLayerTransform;
  const {names: modelDimensionNames} = modelSpace;
  const {names: transformOutputDimensions} = layerSpace;
  let requiredInputDims: number[];
  if (subsourceEntry !== undefined) {
    requiredInputDims = Array.from(subsourceEntry.modelSubspaceDimensionIndices);
  } else {
    requiredInputDims = [];
    for (let i = 0; i < sourceRank; ++i) {
      requiredInputDims[i] = i;
    }
  }
  const unpaddedRank = requiredInputDims.length;
  for (let i = sourceRank; i < fullRank; ++i) {
    requiredInputDims.push(i);
  }
  const requiredOutputDims = getDependentTransformInputDimensions(
      modelToLayerTransform.transform, fullRank, requiredInputDims, true);
  const subspaceRank = requiredInputDims.length;
  const modelSubspaceDimensionNames = requiredInputDims.map(i => modelDimensionNames[i] || `${i}`);
  const layerSubspaceDimensionNames = requiredOutputDims.map(i => transformOutputDimensions[i]);
  if (subspaceRank !== requiredOutputDims.length) {
    return {
      error: 'Rank mismatch between model subspace dimensions (' +
          modelSubspaceDimensionNames.join(', ') + ') and corresponding layer/global dimensions (' +
          layerSubspaceDimensionNames.join(', ') + ')',
    };
  }
  let newTransform = homogeneousTransformSubmatrix(
      Float32Array, oldTransform, fullRank, requiredOutputDims, requiredInputDims);
  const renderLayerDimensions = requiredOutputDims.map(i => transformOutputDimensions[i]);
  const localToRenderLayerDimensions =
      localCoordinateSpace.names.map(x => renderLayerDimensions.indexOf(x));
  const globalToRenderLayerDimensions =
      globalCoordinateSpace.names.map(x => renderLayerDimensions.indexOf(x));
  scaleTransformSubmatrix(
      newTransform, subspaceRank, modelSpace, requiredInputDims, globalCoordinateSpace,
      globalToRenderLayerDimensions);
  scaleTransformSubmatrix(
      newTransform, subspaceRank, modelSpace, requiredInputDims, localCoordinateSpace,
      localToRenderLayerDimensions);
  const channelToRenderLayerDimensions =
      channelCoordinateSpace.names.map(x => renderLayerDimensions.indexOf(x));
  scaleTransformSubmatrix(
      newTransform, subspaceRank, modelSpace, requiredInputDims, channelCoordinateSpace,
      channelToRenderLayerDimensions);
  const channelToModelSubspaceDimensions: number[] = [];
  const channelRank = channelCoordinateSpace.rank;
  if (subsourceEntry !== undefined) {
    let {subsourceToModelSubspaceTransform} = subsourceEntry;
    if (unpaddedRank !== subspaceRank) {
      subsourceToModelSubspaceTransform = matrix.extendHomogeneousTransform(
          new Float32Array((subspaceRank + 1) ** 2), subspaceRank,
          subsourceToModelSubspaceTransform, unpaddedRank);
    }
    newTransform = matrix.multiply(
        new Float32Array((subspaceRank + 1) ** 2), subspaceRank + 1, newTransform, subspaceRank + 1,
        subsourceToModelSubspaceTransform, subspaceRank + 1, subspaceRank + 1, subspaceRank + 1,
        subspaceRank + 1);
  }
  const channelSpaceShape = new Uint32Array(channelRank);
  const {
    lowerBounds: channelLowerBounds,
    upperBounds: channelUpperBounds,
    voxelCenterAtIntegerCoordinates: channelVoxelCenterAtIntegerCoordinates
  } = channelCoordinateSpace.bounds;
  for (let channelDim = 0; channelDim < channelRank; ++channelDim) {
    let lower = channelLowerBounds[channelDim];
    let upper = channelUpperBounds[channelDim];
    if (channelVoxelCenterAtIntegerCoordinates[channelDim]) {
      lower += 0.5;
      upper += 0.5;
    }
    if (lower !== 0 || !Number.isInteger(upper) || upper <= 0 || upper >= 2 ** 32) {
      return {
        error: `Channel dimension ${channelCoordinateSpace.names[channelDim]} must have ` +
            `lower bound of 0 and positive integer upper bound; current bounds are [${lower}, ${
                   upper}]`,
      };
    }
    channelSpaceShape[channelDim] = upper;
    const layerDim = channelToRenderLayerDimensions[channelDim];
    let correspondingModelSubspaceDim = -1;
    if (layerDim !== -1) {
      for (let chunkDim = 0; chunkDim < subspaceRank; ++chunkDim) {
        const coeff = newTransform[layerDim + chunkDim * (subspaceRank + 1)];
        if (coeff === 0) continue;
        if (coeff !== 1 || correspondingModelSubspaceDim !== -1) {
          return {
            error: `Channel dimension ${layerSubspaceDimensionNames[layerDim]} ` +
                `must map to a single source dimension`
          };
        }
        correspondingModelSubspaceDim = chunkDim;
      }
    }
    channelToModelSubspaceDimensions[channelDim] = correspondingModelSubspaceDim;
  }
  return {
    rank: subspaceRank,
    unpaddedRank,
    modelDimensionNames: modelSubspaceDimensionNames,
    layerDimensionNames: layerSubspaceDimensionNames,
    localToRenderLayerDimensions,
    globalToRenderLayerDimensions,
    channelToRenderLayerDimensions,
    modelToRenderLayerTransform: newTransform,
    channelToModelDimensions: channelToModelSubspaceDimensions,
    channelSpaceShape,
  };
}

export function renderLayerTransformsEqual(
    a: RenderLayerTransformOrError, b: RenderLayerTransformOrError) {
  if (a === b) return true;
  if (a.error !== undefined || b.error !== undefined) return false;
  return (
      arraysEqual(a.modelDimensionNames, b.modelDimensionNames) &&
      arraysEqual(a.layerDimensionNames, b.layerDimensionNames) &&
      arraysEqual(a.globalToRenderLayerDimensions, b.globalToRenderLayerDimensions) &&
      arraysEqual(a.localToRenderLayerDimensions, b.localToRenderLayerDimensions) &&
      arraysEqual(a.channelToRenderLayerDimensions, b.channelToRenderLayerDimensions) &&
      arraysEqual(a.modelToRenderLayerTransform, b.modelToRenderLayerTransform) &&
      arraysEqual(a.channelSpaceShape, b.channelSpaceShape));
}

export function getWatchableRenderLayerTransform(
    globalCoordinateSpace: WatchableValueInterface<CoordinateSpace>,
    localCoordinateSpace: WatchableValueInterface<CoordinateSpace>,
    modelToLayerTransform: WatchableValueInterface<CoordinateSpaceTransform>, subsourceEntry: {
      subsourceToModelSubspaceTransform: Float32Array,
      modelSubspaceDimensionIndices: readonly number[]
    }|undefined,
    channelCoordinateSpace?: WatchableValueInterface<CoordinateSpace|undefined>):
    CachedWatchableValue<RenderLayerTransformOrError> {
  return makeCachedDerivedWatchableValue(
      (globalCoordinateSpace: CoordinateSpace, localCoordinateSpace: CoordinateSpace,
       modelToLayerTransform: CoordinateSpaceTransform,
       channelCoordinateSpace: CoordinateSpace|undefined) =>
          getRenderLayerTransform(
              globalCoordinateSpace, localCoordinateSpace, modelToLayerTransform, subsourceEntry,
              channelCoordinateSpace),
      [
        globalCoordinateSpace,
        localCoordinateSpace,
        modelToLayerTransform,
        channelCoordinateSpace === undefined ? constantWatchableValue(undefined) :
                                               channelCoordinateSpace,
      ],
      renderLayerTransformsEqual);
}

export interface LayerDisplayDimensionMapping {
  /**
   * List of indices of layer dimensions that correspond to display dimensions.
   */
  layerDisplayDimensionIndices: number[];

  /**
   * Maps each display dimension index to the corresponding layer dimension index, or `-1`.
   */
  displayToLayerDimensionIndices: number[];
}

export interface ChunkChannelAccessParameters {
  channelSpaceShape: Uint32Array;

  /**
   * Equal to the values in `channelToChunkDimensionIndices` not equal to `-1`.
   */
  chunkChannelDimensionIndices: readonly number[];

  /**
   * Product of `modelTransform.channelSpaceShape`.
   */
  numChannels: number;

  /**
   * Row-major array of shape `[numChannels, chunkChannelDimensionIndices.length]`, specifies the
   * coordinates within the chunk channel dimensions corresponding to each flat channel index.
   */
  chunkChannelCoordinates: Uint32Array;
}

export interface ChunkTransformParameters extends ChunkChannelAccessParameters {
  modelTransform: RenderLayerTransform;
  chunkToLayerTransform: Float32Array;
  layerToChunkTransform: Float32Array;
  chunkToLayerTransformDet: number;
  /**
   * Maps channel dimension indices in the layer channel coordinate space to the corresponding chunk
   * dimension index, or `-1` if there is no correpsonding chunk dimension.
   */
  channelToChunkDimensionIndices: readonly number[];
  combinedGlobalLocalToChunkTransform: Float32Array;
  combinedGlobalLocalRank: number;
  layerRank: number;
}

export function layerToDisplayCoordinates(
    displayPosition: vec3, layerPosition: Float32Array, modelTransform: RenderLayerTransform,
    displayDimensionIndices: Int32Array) {
  const {globalToRenderLayerDimensions} = modelTransform;
  for (let displayDim = 0; displayDim < 3; ++displayDim) {
    let v = 0;
    const globalDim = displayDimensionIndices[displayDim];
    if (globalDim !== -1) {
      const layerDim = globalToRenderLayerDimensions[globalDim];
      if (layerDim !== -1) {
        v = layerPosition[layerDim];
      }
    }
    displayPosition[displayDim] = v;
  }
}

export function displayToLayerCoordinates(
    layerPosition: Float32Array, displayPosition: vec3, modelTransform: RenderLayerTransform,
    displayDimensionIndices: Int32Array) {
  const {globalToRenderLayerDimensions} = modelTransform;
  for (let displayDim = 0; displayDim < 3; ++displayDim) {
    const globalDim = displayDimensionIndices[displayDim];
    if (globalDim !== -1) {
      const layerDim = globalToRenderLayerDimensions[globalDim];
      if (layerDim !== -1) {
        layerPosition[layerDim] = displayPosition[displayDim];
      }
    }
  }
}

export function chunkToDisplayCoordinates(
    displayPosition: vec3, chunkPosition: Float32Array, chunkTransform: ChunkTransformParameters,
    displayDimensionIndices: Int32Array): vec3 {
  const {globalToRenderLayerDimensions} = chunkTransform.modelTransform;
  const {layerRank, chunkToLayerTransform} = chunkTransform;
  const stride = layerRank + 1;
  for (let displayDim = 0; displayDim < 3; ++displayDim) {
    let sum = 0;
    const globalDim = displayDimensionIndices[displayDim];
    if (globalDim !== -1) {
      const layerDim = globalToRenderLayerDimensions[globalDim];
      if (layerDim !== -1) {
        sum = chunkToLayerTransform[stride * layerRank + layerDim];
        for (let chunkDim = 0; chunkDim < layerRank; ++chunkDim) {
          sum += chunkToLayerTransform[stride * chunkDim + layerDim] * chunkPosition[chunkDim];
        }
      }
    }
    displayPosition[displayDim] = sum;
  }
  return displayPosition;
}

export interface ChunkDisplayTransformParameters {
  modelTransform: RenderLayerTransform;
  chunkTransform: ChunkTransformParameters;
  displaySubspaceModelMatrix: mat4;
  displaySubspaceInvModelMatrix: mat4;
  chunkDisplayDimensionIndices: number[];
  numChunkDisplayDims: number;
}

export function getChunkTransformParameters(
    modelTransform: RenderLayerTransform,
    chunkToModelTransform?: Float32Array): ChunkTransformParameters {
  const layerRank = modelTransform.rank;
  const unpaddedRank = modelTransform.unpaddedRank;
  let chunkToLayerTransform: Float32Array;
  if (unpaddedRank !== layerRank && chunkToModelTransform !== undefined) {
    chunkToModelTransform = matrix.extendHomogeneousTransform(
        new Float32Array((layerRank + 1) ** 2), layerRank, chunkToModelTransform, unpaddedRank);
  }
  if (chunkToModelTransform !== undefined) {
    chunkToLayerTransform = new Float32Array((layerRank + 1) * (layerRank + 1));
    matrix.multiply(
        chunkToLayerTransform, layerRank + 1, modelTransform.modelToRenderLayerTransform,
        layerRank + 1, chunkToModelTransform, layerRank + 1, layerRank + 1, layerRank + 1,
        layerRank + 1);
  } else {
    chunkToLayerTransform = modelTransform.modelToRenderLayerTransform;
  }
  const layerToChunkTransform = new Float32Array((layerRank + 1) * (layerRank + 1));
  const det = matrix.inverse(
      layerToChunkTransform, layerRank + 1, chunkToLayerTransform, layerRank + 1, layerRank + 1);
  if (det === 0) {
    throw new Error(`Transform is singular`);
  }
  const {
    globalToRenderLayerDimensions,
    localToRenderLayerDimensions,
    channelToRenderLayerDimensions
  } = modelTransform;
  const globalRank = globalToRenderLayerDimensions.length;
  const localRank = localToRenderLayerDimensions.length;
  const combinedGlobalLocalRank = globalRank + localRank;

  // Compute `combinedGlobalLocalToChunkTransform`.
  const combinedGlobalLocalToChunkTransform =
      new Float32Array((combinedGlobalLocalRank + 1) * layerRank);
  for (let chunkDim = 0; chunkDim < layerRank; ++chunkDim) {
    for (let globalDim = 0; globalDim < globalRank; ++globalDim) {
      const layerDim = globalToRenderLayerDimensions[globalDim];
      if (layerDim === -1) continue;
      combinedGlobalLocalToChunkTransform[chunkDim + globalDim * layerRank] =
          layerToChunkTransform[chunkDim + layerDim * (layerRank + 1)];
    }
    for (let localDim = 0; localDim < localRank; ++localDim) {
      const layerDim = localToRenderLayerDimensions[localDim];
      if (layerDim === -1) continue;
      combinedGlobalLocalToChunkTransform[chunkDim + (globalRank + localDim) * layerRank] =
          layerToChunkTransform[chunkDim + layerDim * (layerRank + 1)];
    }
    combinedGlobalLocalToChunkTransform[chunkDim + combinedGlobalLocalRank * layerRank] =
        layerToChunkTransform[chunkDim + layerRank * (layerRank + 1)];
  }

  const channelRank = channelToRenderLayerDimensions.length;
  let channelToChunkDimensionIndices = new Array<number>(channelRank);
  const chunkChannelDimensionIndices: number[] = [];
  for (let channelDim = 0; channelDim < channelRank; ++channelDim) {
    const layerDim = channelToRenderLayerDimensions[channelDim];
    let correspondingChunkDim = -1;
    if (layerDim !== -1) {
      for (let chunkDim = 0; chunkDim < layerRank; ++chunkDim) {
        const coeff = chunkToLayerTransform[layerDim + chunkDim * (layerRank + 1)];
        if (coeff === 0) continue;
        if (coeff !== 1 || correspondingChunkDim !== -1) {
          throw new Error(
              `Channel dimension ${modelTransform.layerDimensionNames[layerDim]} ` +
              `must map with stride 1 to a single data chunk dimensions`);
        }
        correspondingChunkDim = chunkDim;
      }
      if (correspondingChunkDim !== -1) {
        const offset = chunkToLayerTransform[layerDim + layerRank * (layerRank + 1)];
        if (offset !== 0 && offset !== -0.5) {
          throw new Error(
              `Channel dimension ${modelTransform.layerDimensionNames[layerDim]} ` +
              `must have an offset of 0 in the chunk coordinate space; current offset is ${offset}`);
        }
        chunkChannelDimensionIndices.push(correspondingChunkDim);
      }
    }
    channelToChunkDimensionIndices[channelDim] = correspondingChunkDim;
  }
  const {channelSpaceShape} = modelTransform;
  const numChannels = vector.prod(channelSpaceShape);
  const chunkChannelRank = chunkChannelDimensionIndices.length;
  const chunkChannelCoordinates = new Uint32Array(numChannels * chunkChannelRank);
  for (let channelIndex = 0; channelIndex < numChannels; ++channelIndex) {
    let remainder = channelIndex;
    let chunkChannelDim = 0;
    for (let channelDim = 0; channelDim < channelRank; ++channelDim) {
      const coordinate = remainder % channelSpaceShape[channelDim];
      remainder = (remainder -  coordinate) / channelSpaceShape[channelDim];
      const chunkDim = channelToChunkDimensionIndices[channelDim];
      if (chunkDim !== -1) {
        chunkChannelCoordinates[channelIndex * chunkChannelRank + chunkChannelDim] = coordinate;
        ++chunkChannelDim;
      }
    }
  }
  return {
    layerRank: layerRank,
    modelTransform,
    chunkToLayerTransform,
    layerToChunkTransform,
    chunkToLayerTransformDet: det,
    combinedGlobalLocalRank,
    combinedGlobalLocalToChunkTransform,
    channelToChunkDimensionIndices,
    chunkChannelDimensionIndices,
    numChannels,
    chunkChannelCoordinates,
    channelSpaceShape,
  };
}

export function getLayerDisplayDimensionMapping(
    transform: RenderLayerTransform,
    displayDimensionIndices: Int32Array): LayerDisplayDimensionMapping {
  const {globalToRenderLayerDimensions} = transform;

  // List of layer dimension indices corresponding to global display dimensions.
  const layerDisplayDimensionIndices: number[] = [];

  // Maps global display dimension (in {0, 1, 2}) to the corresponding layer dimension index, or
  // `-1`.
  const displayToLayerDimensionIndices: number[] = [];

  for (let displayDim = 0; displayDim < 3; ++displayDim) {
    const globalDim = displayDimensionIndices[displayDim];
    if (globalDim == -1) continue;
    const layerDim = globalToRenderLayerDimensions[globalDim];
    displayToLayerDimensionIndices.push(layerDim);
    if (layerDim === -1) continue;
    layerDisplayDimensionIndices.push(layerDim);
  }
  for (let i = displayToLayerDimensionIndices.length; i < 3; ++i) {
    displayToLayerDimensionIndices[i] = -1;
  }
  return {layerDisplayDimensionIndices, displayToLayerDimensionIndices};
}

export function getChunkDisplayTransformParameters(
    chunkTransform: ChunkTransformParameters,
    layerDisplayDimensionMapping: LayerDisplayDimensionMapping): ChunkDisplayTransformParameters {
  const {chunkToLayerTransform, modelTransform} = chunkTransform;
  const rank = modelTransform.rank;
  const {layerDisplayDimensionIndices, displayToLayerDimensionIndices} =
      layerDisplayDimensionMapping;
  const numLayerDisplayDims = layerDisplayDimensionIndices.length;
  const chunkDisplayDimensionIndices = getDependentTransformInputDimensions(
      chunkToLayerTransform, rank, layerDisplayDimensionIndices);
  if (chunkDisplayDimensionIndices.length !== numLayerDisplayDims) {
    const {modelDimensionNames, layerDimensionNames} = modelTransform;
    throw new Error(
        `Rank mismatch between displayed layer dimensions ` +
        `(${
            Array.from(layerDisplayDimensionIndices, i => layerDimensionNames[i])
                .join(',\u00a0')}) ` +
        `and corresponding chunk dimensions ` +
        `(${
            Array.from(chunkDisplayDimensionIndices, i => modelDimensionNames[i])
                .join(',\u00a0')})`);
  }
  // Compute "model matrix" (transform from the displayed subspace of the chunk space) to the global
  // display coordinate space.
  const displaySubspaceModelMatrix = mat4.create();
  for (let displayDim = 0; displayDim < 3; ++displayDim) {
    const layerDim = displayToLayerDimensionIndices[displayDim];
    if (layerDim === -1) continue;
    for (let chunkDisplayDimIndex = 0; chunkDisplayDimIndex < numLayerDisplayDims;
         ++chunkDisplayDimIndex) {
      const chunkDim = chunkDisplayDimensionIndices[chunkDisplayDimIndex];
      displaySubspaceModelMatrix[chunkDisplayDimIndex * 4 + displayDim] =
          chunkToLayerTransform[chunkDim * (rank + 1) + layerDim];
    }
    displaySubspaceModelMatrix[12 + displayDim] =
        chunkToLayerTransform[rank * (rank + 1) + layerDim];
  }
  const displaySubspaceInvModelMatrix = mat4.create();
  mat4.invert(displaySubspaceInvModelMatrix, displaySubspaceModelMatrix);

  for (let i = chunkDisplayDimensionIndices.length; i < 3; ++i) {
    chunkDisplayDimensionIndices[i] = -1;
  }
  return {
    modelTransform: chunkTransform.modelTransform,
    chunkTransform,
    displaySubspaceModelMatrix,
    displaySubspaceInvModelMatrix,
    chunkDisplayDimensionIndices,
    numChunkDisplayDims: numLayerDisplayDims,
  };
}

export function getChunkPositionFromCombinedGlobalLocalPositions(
    chunkPosition: Float32Array, globalPosition: Float32Array, localPosition: Float32Array,
    layerRank: number, combinedGlobalLocalToChunkTransform: Float32Array) {
  const globalRank = globalPosition.length;
  const localRank = localPosition.length;
  const rank = chunkPosition.length;
  let valid = true;
  for (let chunkDim = 0; chunkDim < layerRank; ++chunkDim) {
    let off = chunkDim;
    let sum = 0;
    for (let globalDim = 0; globalDim < globalRank; ++globalDim) {
      sum += combinedGlobalLocalToChunkTransform[off + globalDim * layerRank] *
          globalPosition[globalDim];
    }
    off += globalRank * layerRank;
    for (let localDim = 0; localDim < localRank; ++localDim) {
      sum +=
          combinedGlobalLocalToChunkTransform[off + localDim * layerRank] * localPosition[localDim];
    }
    sum += combinedGlobalLocalToChunkTransform[off + localRank * layerRank];
    if (chunkDim < rank) {
      chunkPosition[chunkDim] = sum;
    } else {
      // Handle clipping
      if (sum < 0 || sum >= 1) {
        valid = false;
      }
    }
  }
  return valid;
}

export function getLayerPositionFromCombinedGlobalLocalPositions(
    layerPosition: Float32Array, globalPosition: Float32Array, localPosition: Float32Array,
    modelTransform: RenderLayerTransform) {
  scatterUpdate(layerPosition, globalPosition, modelTransform.globalToRenderLayerDimensions);
  scatterUpdate(layerPosition, localPosition, modelTransform.localToRenderLayerDimensions);
  return layerPosition;
}

export function get3dModelToDisplaySpaceMatrix(
    out: mat4, displayDimensionRenderInfo: DisplayDimensionRenderInfo,
    transform: RenderLayerTransform) {
  out.fill(0);
  out[15] = 1;
  let fullRank = true;
  const {displayDimensionIndices} = displayDimensionRenderInfo;
  const {globalToRenderLayerDimensions, modelToRenderLayerTransform} = transform;
  const layerRank = transform.rank;
  for (let displayDim = 0; displayDim < 3; ++displayDim) {
    const globalDim = displayDimensionIndices[displayDim];
    if (globalDim === -1) {
      fullRank = false;
      continue;
    }
    const layerDim = globalToRenderLayerDimensions[globalDim];
    if (layerDim === -1) {
      fullRank = false;
      continue;
    }
    out[displayDim + 12] = modelToRenderLayerTransform[layerDim + layerRank * (layerRank + 1)];
    for (let modelDim = 0; modelDim < 3; ++modelDim) {
      out[displayDim + 4 * modelDim] =
          modelToRenderLayerTransform[layerDim + (layerRank + 1) * modelDim];
    }
  }
  if (!fullRank) {
    const {globalDimensionNames} = displayDimensionRenderInfo;
    const displayDimDesc =
        Array.from(displayDimensionIndices.filter(i => i !== -1), i => globalDimensionNames[i])
            .join(',\u00a0');
    throw new Error(
        `Transform from model dimensions (${transform.modelDimensionNames.join(',\u00a0')}) ` +
        `to display dimensions (${displayDimDesc}) does not have full rank`);
  }
}
