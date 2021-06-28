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

import {DisplayDimensionRenderInfo} from 'neuroglancer/navigation_state';
import {ProjectionParameters} from 'neuroglancer/projection_parameters';
import {getChunkPositionFromCombinedGlobalLocalPositions} from 'neuroglancer/render_coordinate_transform';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {WatchableValueChangeInterface, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {Disposable} from 'neuroglancer/util/disposable';
import {getFrustrumPlanes, getViewFrustrumDepthRange, isAABBIntersectingPlane, isAABBVisible, mat4, vec3} from 'neuroglancer/util/geom';
import * as matrix from 'neuroglancer/util/matrix';
import * as vector from 'neuroglancer/util/vector';
import {SharedObject} from 'neuroglancer/worker_rpc';

export {DATA_TYPE_BYTES, DataType};

const DEBUG_VISIBLE_SOURCES = false;
const DEBUG_CHUNK_VISIBILITY = false;

const tempMat4 = mat4.create();

/**
 * Average cross-sectional area contained within a chunk of the specified size and rotation.
 *
 * This is estimated by taking the total volume of the chunk and dividing it by the total length of
 * the chunk along the z axis.
 */
export function estimateSliceAreaPerChunk(chunkLayout: ChunkLayout, viewMatrix: mat4) {
  // Compute the length of the projection of the chunk along the z axis in view space.
  //
  // Each chunk dimension `i` can independently affect the z projection by the dot product of column
  // `i` of `chunkLayout.transform` and row 2 of `viewMatrix`.
  let viewZProjection = 0;
  let chunkVolume = Math.abs(chunkLayout.detTransform);
  const {transform, size} = chunkLayout;
  for (let i = 0; i < 3; ++i) {
    let sum = 0;
    for (let j = 0; j < 3; ++j) {
      sum += viewMatrix[j * 4 + 2] * transform[4 * i + j];
    }
    const s = size[i];
    viewZProjection += Math.abs(sum) * s;
    chunkVolume *= s;
  }
  return chunkVolume / viewZProjection;
}

export interface MultiscaleVolumetricDataRenderLayer {
  localPosition: WatchableValueInterface<Float32Array>;
  renderScaleTarget: WatchableValueInterface<number>;
}

export interface TransformedSource<
    RLayer extends MultiscaleVolumetricDataRenderLayer = SliceViewRenderLayer,
                   Source extends SliceViewChunkSource = SliceViewChunkSource> {
  renderLayer: RLayer;

  source: Source;

  /**
   * Approximate voxel size in each of the display dimensions.
   */
  effectiveVoxelSize: vec3;

  chunkLayout: ChunkLayout;

  /**
   * Arrays of length `rank` specifying the clip bounds (in voxels) for dimensions not in
   * `chunkDisplayDimensionIndices` and not channel dimensions.  The values for display/channel
   * dimensions are set to -/+infinity.
   */
  nonDisplayLowerClipBound: Float32Array;
  nonDisplayUpperClipBound: Float32Array;

  /**
   * Arrays of length `rank` specifying the clip bounds (in voxels) for all dimensions.
   */
  lowerClipBound: Float32Array;
  upperClipBound: Float32Array;

  // Lower clip bound (in voxels) in the "display" subspace of the chunk coordinate space.
  lowerClipDisplayBound: vec3;
  // Upper clip bound (in voxels) in the "display" subspace of the chunk coordinate space.
  upperClipDisplayBound: vec3;


  // Lower bound (in chunks) within the "display" subspace of the chunk coordinate space.
  lowerChunkDisplayBound: vec3;
  // Upper bound (in chunks) within the "display" subspace of the chunk coordinate space.
  upperChunkDisplayBound: vec3;

  /**
   * Dimensions of the chunk corresponding to the 3 display dimensions of the slice view.
   */
  chunkDisplayDimensionIndices: number[];

  /**
   * Rank of "layer" space and the "chunk clip" space, which is >= rank of chunk space.
   */
  layerRank: number;

  /**
   * Transform from dimensions of layer space to dimensions of chunk space.
   *
   * Matrix has dimensions `(globalRank + localRank + 1) * layerRank`.
   *
   * Input space is `[global dimensions, local dimensions]`.  Output space is the "chunk clip"
   * coordinate space, in units of voxels.
   *
   */
  combinedGlobalLocalToChunkTransform: Float32Array;

  /**
   * Transform from non-display dimensions of layer space to non-display dimensions of chunk space.
   *
   * Same as `combinedGlobalLocalToChunkTransform`, except that rows corresponding to "display"
   * chunk dimensions are all 0.
   *
   * Matrix has dimensions `(globalRank + localRank + 1) * layerRank`.
   *
   * Input space is `[global dimensions, local dimensions]`.  Output space is the "chunk clip"
   * coordinate space, in units of voxels.
   */
  fixedLayerToChunkTransform: Float32Array;

  /**
   * When `computeVisibleChunks` invokes the `addChunk` callback, this is set to the position of the
   * chunk.
   */
  curPositionInChunks: Float32Array;

  fixedPositionWithinChunk: Uint32Array;
}

export interface SliceViewRenderLayer {
  /**
   * Current position of non-global layer dimensions.
   */
  localPosition: WatchableValueInterface<Float32Array>;
  renderScaleTarget: WatchableValueInterface<number>;

  filterVisibleSources(
      sliceView: SliceViewBase<SliceViewChunkSource, SliceViewRenderLayer>,
      sources: readonly TransformedSource[]): Iterable<TransformedSource>;
}

function updateFixedCurPositionInChunks<RLayer extends MultiscaleVolumetricDataRenderLayer>(
    tsource: TransformedSource<RLayer, SliceViewChunkSource>, globalPosition: Float32Array,
    localPosition: Float32Array): boolean {
  const {curPositionInChunks, fixedPositionWithinChunk} = tsource;
  const {nonDisplayLowerClipBound, nonDisplayUpperClipBound} = tsource;
  const {rank, chunkDataSize} = tsource.source.spec;
  if (!getChunkPositionFromCombinedGlobalLocalPositions(
          curPositionInChunks, globalPosition, localPosition, tsource.layerRank,
          tsource.fixedLayerToChunkTransform)) {
    return false;
  }
  for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
    const x = curPositionInChunks[chunkDim];
    if (x < nonDisplayLowerClipBound[chunkDim] || x >= nonDisplayUpperClipBound[chunkDim]) {
      if (DEBUG_VISIBLE_SOURCES) {
        console.log(
            'excluding source', tsource, `because of chunkDim=${chunkDim}, sum=${x}`,
            nonDisplayLowerClipBound, nonDisplayUpperClipBound, tsource.fixedLayerToChunkTransform);
      }
      return false;
    }
    const chunkSize = chunkDataSize[chunkDim];
    const chunk = curPositionInChunks[chunkDim] = Math.floor(x / chunkSize);
    fixedPositionWithinChunk[chunkDim] = x - chunk * chunkSize;
  }
  return true;
}

function pickBestAlternativeSource<
    RLayer extends MultiscaleVolumetricDataRenderLayer, Source extends
        SliceViewChunkSource, Transformed extends TransformedSource<RLayer, Source>>(
    viewMatrix: mat4, alternatives: Transformed[]) {
  let numAlternatives = alternatives.length;
  let bestAlternativeIndex = 0;
  if (DEBUG_VISIBLE_SOURCES) {
    console.log(alternatives);
  }
  if (numAlternatives > 1) {
    let bestSliceArea = 0;
    for (let alternativeIndex = 0; alternativeIndex < numAlternatives; ++alternativeIndex) {
      let alternative = alternatives[alternativeIndex];
      const {chunkLayout} = alternative;
      let sliceArea = estimateSliceAreaPerChunk(chunkLayout, viewMatrix);
      if (DEBUG_VISIBLE_SOURCES) {
        console.log(`chunksize = ${chunkLayout.size}, sliceArea = ${sliceArea}`);
      }
      if (sliceArea > bestSliceArea) {
        bestSliceArea = sliceArea;
        bestAlternativeIndex = alternativeIndex;
      }
    }
  }
  return bestAlternativeIndex;
}

export interface VisibleLayerSources<
    RLayer extends MultiscaleVolumetricDataRenderLayer, Source extends
        SliceViewChunkSource, Transformed extends TransformedSource<RLayer, Source>> {
  allSources: Transformed[][];
  visibleSources: Transformed[];
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
}

const tempChunkLayout = new ChunkLayout(vec3.create(), mat4.create(), 0);

export class SliceViewProjectionParameters extends ProjectionParameters {
  /**
   * Normal vector of cross section in (non-isotropic) global voxel coordinates.
   */
  viewportNormalInGlobalCoordinates = vec3.create();

  /**
   * Normal vector of cross section in isotropic global canonical voxel coordinates.
   */
  viewportNormalInCanonicalCoordinates = vec3.create();

  centerDataPosition = vec3.create();

  /**
   * Size in physical units of a single pixel.
   */
  pixelSize: number = 0;
}

function visibleSourcesInvalidated(
    oldValue: SliceViewProjectionParameters, newValue: SliceViewProjectionParameters) {
  if (oldValue.displayDimensionRenderInfo !== newValue.displayDimensionRenderInfo) return true;
  if (oldValue.pixelSize !== newValue.pixelSize) return true;
  const {viewMatrix: oldViewMatrix} = oldValue;
  const {viewMatrix: newViewMatrix} = newValue;
  for (let i = 0; i < 12; ++i) {
    if (oldViewMatrix[i] !== newViewMatrix[i]) return true;
  }
  return false;
}

export class SliceViewBase<
    Source extends SliceViewChunkSource = SliceViewChunkSource,
                   RLayer extends SliceViewRenderLayer = SliceViewRenderLayer, Transformed extends
        TransformedSource<RLayer, Source> = TransformedSource<RLayer, Source>> extends
    SharedObject {
  visibleLayers = new Map<RLayer, VisibleLayerSources<RLayer, Source, Transformed>>();
  visibleSourcesStale = true;

  constructor(public projectionParameters:
                  WatchableValueChangeInterface<SliceViewProjectionParameters>) {
    super();
    this.registerDisposer(projectionParameters.changed.add((oldValue, newValue) => {
      if (visibleSourcesInvalidated(oldValue, newValue)) {
        this.invalidateVisibleSources();
      }
      this.invalidateVisibleChunks();
    }));
  }

  invalidateVisibleSources() {
    this.visibleSourcesStale = true;
  }

  invalidateVisibleChunks() {}

  /**
   * Computes the list of sources to use for each visible layer, based on the
   * current pixelSize.
   */
  updateVisibleSources() {
    if (!this.visibleSourcesStale) {
      return;
    }
    this.visibleSourcesStale = false;
    const curDisplayDimensionRenderInfo =
        this.projectionParameters.value.displayDimensionRenderInfo;

    const {visibleLayers} = this;
    for (const [renderLayer, {allSources, visibleSources, displayDimensionRenderInfo}] of
             visibleLayers) {
      visibleSources.length = 0;
      if (displayDimensionRenderInfo !== curDisplayDimensionRenderInfo || allSources.length === 0) {
        continue;
      }
      const preferredOrientationIndex = pickBestAlternativeSource(
          this.projectionParameters.value.viewMatrix, allSources.map(x => x[0]));

      const sources = allSources[preferredOrientationIndex];

      for (const source of renderLayer.filterVisibleSources(this, sources)) {
        visibleSources.push(source as Transformed);
      }
      // Reverse visibleSources list since we added sources from coarsest to finest resolution, but
      // we want them ordered from finest to coarsest.
      visibleSources.reverse();
      if (DEBUG_VISIBLE_SOURCES) {
        console.log('visible sources chosen', visibleSources);
      }
    }
  }
}

/**
 * By default, choose a chunk size with at most 2^18 = 262144 voxels.
 */
export const DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2 = 18;

/**
 * Specifies common options for getNearIsotropicBlockSize and getTwoDimensionalBlockSize.
 */
export interface BaseChunkLayoutOptions {
  /**
   * Number of chunk dimensions.
   */
  rank: number;

  /**
   * This, together with upperVoxelBound, specifies the total volume dimensions, which serves as a
   * bound on the maximum chunk size.  If not specified, defaults to a zero vector.
   */
  lowerVoxelBound?: Float32Array;

  /**
   * Upper voxel bound.  If not specified, the total volume dimensions are not used to bound the
   * chunk size.
   */
  upperVoxelBound?: Float32Array;

  /**
   * Base 2 logarithm of the maximum number of voxels per chunk.  Defaults to
   * DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2.
   */
  maxVoxelsPerChunkLog2?: number;

  /**
   * Linear (not affine) transformation matrix with `rank` columns and `displayRank` rows in
   * column-major order.  Specifies the transformation from chunk space to an isotropic "camera view
   * space".  Note that only relative scales of input dimensions are relevant, any rotations applied
   * are irrelevant.
   */
  chunkToViewTransform: Float32Array;
  displayRank: number;

  minBlockSize?: Uint32Array;
  maxBlockSize?: Uint32Array;
}

export interface GetNearIsotropicBlockSizeOptions extends BaseChunkLayoutOptions {}

/**
 * Determines a near-isotropic (in camera view space) block size.  All dimensions will be
 * powers of 2, and will not exceed upperVoxelBound - lowerVoxelBound.  The total number of voxels
 * will not exceed maxVoxelsPerChunkLog2.
 */
export function getNearIsotropicBlockSize(options: GetNearIsotropicBlockSizeOptions): Uint32Array {
  let {
    rank,
    upperVoxelBound,
    maxVoxelsPerChunkLog2 = DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2,
    chunkToViewTransform,
    displayRank,
    minBlockSize,
    maxBlockSize,
  } = options;

  const {lowerVoxelBound = new Uint32Array(rank)} = options;

  // Adjust voxelSize by effective scaling factor.
  const effectiveVoxelSize = new Float32Array(rank);
  for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
    let factor = 0;
    for (let displayDim = 0; displayDim < displayRank; ++displayDim) {
      const c = chunkToViewTransform[chunkDim * displayRank + displayDim];
      factor += c * c;
    }
    effectiveVoxelSize[chunkDim] = Math.sqrt(factor);
  }

  const chunkDataSize = new Uint32Array(rank);
  if (minBlockSize !== undefined) {
    chunkDataSize.set(minBlockSize);
  } else {
    chunkDataSize.fill(1);
  }
  const chunkDataSizeUpperBound = new Array<number>(rank);
  for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
    let bound = Number.POSITIVE_INFINITY;
    if (effectiveVoxelSize[chunkDim] === 0) {
      bound = chunkDataSize[chunkDim];
    } else {
      if (upperVoxelBound !== undefined) {
        bound = Math.pow(
            2, Math.floor(Math.log2(upperVoxelBound[chunkDim] - lowerVoxelBound[chunkDim])));
      }
      if (maxBlockSize !== undefined) {
        bound = Math.min(bound, maxBlockSize[chunkDim]);
      }
    }
    chunkDataSizeUpperBound[chunkDim] = bound;
  }

  // Determine the dimension in which chunkDataSize should be increased.  This is the smallest
  // dimension (in nanometers) that is < maxChunkDataSize (in voxels).
  //
  // Returns -1 if there is no such dimension.
  function findNextDimension() {
    let minSize = Infinity;
    let minDimension = -1;
    for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
      if (chunkDataSize[chunkDim] >= chunkDataSizeUpperBound[chunkDim]) {
        continue;
      }
      let size = chunkDataSize[chunkDim] * effectiveVoxelSize[chunkDim];
      if (size < minSize) {
        minSize = size;
        minDimension = chunkDim;
      }
    }
    return minDimension;
  }

  maxVoxelsPerChunkLog2 -= Math.log2(vector.prod(chunkDataSize));
  for (let i = 0; i < maxVoxelsPerChunkLog2; ++i) {
    let nextDim = findNextDimension();
    if (nextDim === -1) {
      break;
    }
    chunkDataSize[nextDim] *= 2;
  }
  return chunkDataSize;
}

/**
 * Returns an array of [xy, yz, xz] 2-dimensional block sizes, where [x, y, z] refer to the view
 * dimensions.
 */
export function getTwoDimensionalBlockSizes(options: BaseChunkLayoutOptions) {
  const chunkDataSizes: Uint32Array[] = [];
  const {displayRank, chunkToViewTransform, rank} = options;
  if (displayRank > 3) {
    throw new Error('Unsupported view transform');
  }
  if (displayRank < 3) {
    return [getNearIsotropicBlockSize(options)];
  }
  for (let i = 0; i < 3; ++i) {
    const excludedDim = (i + 2) % 3;
    const restrictedTransform = new Float32Array(chunkToViewTransform);
    for (let j = 0; j < rank; ++j) {
      restrictedTransform[j * displayRank + excludedDim] = 0;
    }
    chunkDataSizes[i] =
        getNearIsotropicBlockSize({...options, chunkToViewTransform: restrictedTransform});
  }
  return chunkDataSizes;
}

export enum ChunkLayoutPreference {
  /**
   * Indicates that isotropic chunks are desired.
   */
  ISOTROPIC = 0,

  /**
   * Indicates that 2-D chunks are desired.
   */
  FLAT = 1,
}

export interface SliceViewSourceOptions {
  /**
   * Transform from the multiscale source coordinate space to a "view" coordinate space that
   * reflects the relative scales.  This is a *linear* (not affine) transformation matrix with
   * `rank` columns and `displayRank` rows in column-major order, where `rank` is the rank of the
   * multiscale source.
   */
  multiscaleToViewTransform: Float32Array;
  displayRank: number;
  modelChannelDimensionIndices: readonly number[];
}

export function getCombinedTransform(
    rank: number, bToC: Float32Array, aToB: Float32Array|undefined) {
  if (aToB === undefined) {
    return bToC;
  } else {
    return matrix.multiply(
        new Float32Array((rank + 1) * (rank + 1)), rank + 1, bToC, rank + 1, aToB, rank + 1,
        rank + 1, rank + 1, rank + 1);
  }
}

/**
 * Specifies parameters for getChunkDataSizes.
 */
export interface ChunkLayoutOptions {
  /**
   * Chunk sizes in voxels.
   */
  chunkDataSizes?: Uint32Array[];

  /**
   * Preferred chunk layout, which determines chunk sizes to use if chunkDataSizes is not
   * specified.
   */
  chunkLayoutPreference?: ChunkLayoutPreference;
}

export function getChunkDataSizes(options: ChunkLayoutOptions&BaseChunkLayoutOptions) {
  if (options.chunkDataSizes !== undefined) {
    return options.chunkDataSizes;
  }
  const {chunkLayoutPreference = ChunkLayoutPreference.ISOTROPIC} = options;
  switch (chunkLayoutPreference) {
    case ChunkLayoutPreference.ISOTROPIC:
      return [getNearIsotropicBlockSize(options)];
    case ChunkLayoutPreference.FLAT:
      return getTwoDimensionalBlockSizes(options);
  }
}

/**
 * Generic specification for SliceView chunks specifying a layout and voxel size.
 */
export interface SliceViewChunkSpecification<ChunkDataSize extends Uint32Array|Float32Array =
                                                                       Uint32Array | Float32Array> {
  rank: number;

  /**
   * Size of chunk in voxels.
   */
  chunkDataSize: ChunkDataSize;

  /**
   * All valid chunks are in the range [lowerChunkBound, upperChunkBound).
   *
   * These are specified in units of chunks (not voxels).
   */
  lowerChunkBound: Float32Array;
  upperChunkBound: Float32Array;

  lowerVoxelBound: Float32Array;
  upperVoxelBound: Float32Array;
}

export function makeSliceViewChunkSpecification<ChunkDataSize extends Uint32Array|Float32Array>(
    options: SliceViewChunkSpecificationOptions<ChunkDataSize>):
    SliceViewChunkSpecification<ChunkDataSize> {
  const {
    rank,
    chunkDataSize,
    upperVoxelBound,
  } = options;
  const {
    lowerVoxelBound = new Float32Array(rank),
  } = options;
  const lowerChunkBound = new Float32Array(rank);
  const upperChunkBound = new Float32Array(rank);
  for (let i = 0; i < rank; ++i) {
    lowerChunkBound[i] = Math.floor(lowerVoxelBound[i] / chunkDataSize[i]);
    upperChunkBound[i] = Math.floor((upperVoxelBound[i] - 1) / chunkDataSize[i] + 1);
  }
  return {
    rank,
    chunkDataSize,
    lowerChunkBound,
    upperChunkBound,
    lowerVoxelBound,
    upperVoxelBound,
  };
}

export function*
    filterVisibleSources(
        sliceView: SliceViewBase, renderLayer: SliceViewRenderLayer,
        sources: readonly TransformedSource[]): Iterable<TransformedSource> {
  // Increase pixel size by a small margin.
  const pixelSize = sliceView.projectionParameters.value.pixelSize * 1.1;
  // At the smallest scale, all alternative sources must have the same voxel size, which is
  // considered to be the base voxel size.
  const smallestVoxelSize = sources[0].effectiveVoxelSize;

  const renderScaleTarget = renderLayer.renderScaleTarget.value;

  /**
   * Determines whether we should continue to look for a finer-resolution source *after* one
   * with the specified voxelSize.
   */
  const canImproveOnVoxelSize = (voxelSize: vec3) => {
    const targetSize = pixelSize * renderScaleTarget;
    for (let i = 0; i < 3; ++i) {
      const size = voxelSize[i];
      // If size <= pixelSize, no need for improvement.
      // If size === smallestVoxelSize, also no need for improvement.
      if (size > targetSize && size > 1.01 * smallestVoxelSize[i]) {
        return true;
      }
    }
    return false;
  };

  const improvesOnPrevVoxelSize = (voxelSize: vec3, prevVoxelSize: vec3) => {
    const targetSize = pixelSize * renderScaleTarget;
    for (let i = 0; i < 3; ++i) {
      const size = voxelSize[i];
      const prevSize = prevVoxelSize[i];
      if (Math.abs(targetSize - size) < Math.abs(targetSize - prevSize) && size < 1.01 * prevSize) {
        return true;
      }
    }
    return false;
  };
  let scaleIndex = sources.length - 1;
  let prevVoxelSize: vec3|undefined;
  while (true) {
    const transformedSource = sources[scaleIndex];
    if (prevVoxelSize !== undefined &&
        !improvesOnPrevVoxelSize(transformedSource.effectiveVoxelSize, prevVoxelSize)) {
      break;
    }
    yield transformedSource;

    if (scaleIndex === 0 || !canImproveOnVoxelSize(transformedSource.effectiveVoxelSize)) {
      break;
    }
    prevVoxelSize = transformedSource.effectiveVoxelSize;
    --scaleIndex;
  }
}

/**
 * Common parameters for SliceView Chunks.
 */
export interface SliceViewChunkSpecificationBaseOptions {
  rank: number;

  /**
   * If not specified, defaults to an all-zero vector.  This determines lowerChunkBound.  If this is
   * not a multiple of chunkDataSize, then voxels at lower positions may still be requested.
   */
  lowerVoxelBound?: Float32Array;

  /**
   * Exclusive upper bound in "chunk" coordinate space, in voxels.  This determines upperChunkBound.
   */
  upperVoxelBound: Float32Array;
}

export interface SliceViewChunkSpecificationOptions<
    ChunkDataSize extends Uint32Array|Float32Array = Uint32Array | Float32Array> extends
    SliceViewChunkSpecificationBaseOptions {
  chunkDataSize: ChunkDataSize;
}


export interface SliceViewChunkSource<
    Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification> extends Disposable {
  spec: Spec;
}

export const SLICEVIEW_RPC_ID = 'SliceView';
export const SLICEVIEW_RENDERLAYER_RPC_ID = 'sliceview/RenderLayer';
export const SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID = 'SliceView.addVisibleLayer';
export const SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID = 'SliceView.removeVisibleLayer';

const tempVisibleVolumetricChunkLower = new Float32Array(3);
const tempVisibleVolumetricChunkUpper = new Float32Array(3);
const tempVisibleVolumetricModelViewProjection = mat4.create();
const tempVisibleVolumetricClippingPlanes = new Float32Array(24);

function forEachVolumetricChunkWithinFrustrum<RLayer extends MultiscaleVolumetricDataRenderLayer>(
    clippingPlanes: Float32Array, transformedSource: TransformedSource<RLayer>,
    callback: (positionInChunks: vec3, clippingPlanes: Float32Array) => void,
    predicate: (
        xLower: number, yLower: number, zLower: number, xUpper: number, yUpper: number,
        zUpper: number, clippingPlanes: Float32Array) => boolean) {
  const lower = tempVisibleVolumetricChunkLower;
  const upper = tempVisibleVolumetricChunkUpper;
  const {lowerChunkDisplayBound, upperChunkDisplayBound} = transformedSource;
  for (let i = 0; i < 3; ++i) {
    lower[i] = Math.max(lower[i], lowerChunkDisplayBound[i]);
    upper[i] = Math.min(upper[i], upperChunkDisplayBound[i]);
  }
  const {curPositionInChunks, chunkDisplayDimensionIndices} = transformedSource;

  function recurse() {
    if (!predicate(lower[0], lower[1], lower[2], upper[0], upper[1], upper[2], clippingPlanes)) {
      return;
    }

    let splitDim = 0;
    let splitSize = Math.max(0, upper[0] - lower[0]);
    let volume = splitSize;
    for (let i = 1; i < 3; ++i) {
      const size = Math.max(0, upper[i] - lower[i]);
      volume *= size;
      if (size > splitSize) {
        splitSize = size;
        splitDim = i;
      }
    }
    if (volume === 0) return;
    if (volume === 1) {
      curPositionInChunks[chunkDisplayDimensionIndices[0]] = lower[0];
      curPositionInChunks[chunkDisplayDimensionIndices[1]] = lower[1];
      curPositionInChunks[chunkDisplayDimensionIndices[2]] = lower[2];
      callback(lower as vec3, clippingPlanes);
      return;
    }
    const prevLower = lower[splitDim];
    const prevUpper = upper[splitDim];
    const splitPoint = Math.floor(0.5 * (prevLower + prevUpper));
    upper[splitDim] = splitPoint;
    recurse();
    upper[splitDim] = prevUpper;
    lower[splitDim] = splitPoint;
    recurse();
    lower[splitDim] = prevLower;
  }
  recurse();
}

export function forEachVisibleVolumetricChunk<RLayer extends MultiscaleVolumetricDataRenderLayer>(
    projectionParameters: ProjectionParameters, localPosition: Float32Array,
    transformedSource: TransformedSource<RLayer>,
    callback: (positionInChunks: vec3, clippingPlanes: Float32Array) => void) {
  if (!updateFixedCurPositionInChunks(
          transformedSource, projectionParameters.globalPosition, localPosition)) {
    return;
  }
  const {size: chunkSize} = transformedSource.chunkLayout;
  const modelViewProjection = mat4.multiply(
      tempVisibleVolumetricModelViewProjection, projectionParameters.viewProjectionMat,
      transformedSource.chunkLayout.transform);
  for (let i = 0; i < 3; ++i) {
    const s = chunkSize[i];
    for (let j = 0; j < 4; ++j) {
      modelViewProjection[4 * i + j] *= s;
    }
  }

  const clippingPlanes = tempVisibleVolumetricClippingPlanes;
  getFrustrumPlanes(clippingPlanes, modelViewProjection);
  const lower = tempVisibleVolumetricChunkLower;
  const upper = tempVisibleVolumetricChunkUpper;
  lower.fill(Number.NEGATIVE_INFINITY);
  upper.fill(Number.POSITIVE_INFINITY);
  forEachVolumetricChunkWithinFrustrum(clippingPlanes, transformedSource, callback, isAABBVisible);
}

export function
forEachPlaneIntersectingVolumetricChunk<RLayer extends MultiscaleVolumetricDataRenderLayer>(
    projectionParameters: ProjectionParameters, localPosition: Float32Array,
    transformedSource: TransformedSource<RLayer>, chunkLayout: ChunkLayout,
    callback: (positionInChunks: vec3) => void) {
  if (!updateFixedCurPositionInChunks(
          transformedSource, projectionParameters.globalPosition, localPosition)) {
    return;
  }
  const {size: chunkSize} = chunkLayout;
  const modelViewProjection = mat4.multiply(
      tempVisibleVolumetricModelViewProjection, projectionParameters.viewProjectionMat,
      chunkLayout.transform);
  for (let i = 0; i < 3; ++i) {
    const s = chunkSize[i];
    for (let j = 0; j < 4; ++j) {
      modelViewProjection[4 * i + j] *= s;
    }
  }

  const invModelViewProjection = tempMat4;
  mat4.invert(invModelViewProjection, modelViewProjection);
  const lower = tempVisibleVolumetricChunkLower;
  const upper = tempVisibleVolumetricChunkUpper;
  const epsilon = 1e-3;
  for (let i = 0; i < 3; ++i) {
    // Add small offset of `epsilon` voxels to bias towards the higher coordinate if very close to a
    // voxel boundary.
    const c = invModelViewProjection[12 + i] + epsilon / chunkSize[i];
    const xCoeff = Math.abs(invModelViewProjection[i]);
    const yCoeff = Math.abs(invModelViewProjection[4 + i]);
    lower[i] = Math.floor(c - xCoeff - yCoeff);
    upper[i] = Math.floor(c + xCoeff + yCoeff + 1);
  }

  const clippingPlanes = tempVisibleVolumetricClippingPlanes;
  for (let i = 0; i < 3; ++i) {
    const xCoeff = modelViewProjection[4 * i];
    const yCoeff = modelViewProjection[4 * i + 1];
    const zCoeff = modelViewProjection[4 * i + 2];
    clippingPlanes[i] = xCoeff;
    clippingPlanes[4 + i] = -xCoeff;
    clippingPlanes[8 + i] = +yCoeff;
    clippingPlanes[12 + i] = -yCoeff;
    clippingPlanes[16 + i] = +zCoeff;
    clippingPlanes[20 + i] = -zCoeff;
  }
  {
    const i = 3;
    const xCoeff = modelViewProjection[4 * i];
    const yCoeff = modelViewProjection[4 * i + 1];
    const zCoeff = modelViewProjection[4 * i + 2];
    clippingPlanes[i] = 1 + xCoeff;
    clippingPlanes[4 + i] = 1 - xCoeff;
    clippingPlanes[8 + i] = 1 + yCoeff;
    clippingPlanes[12 + i] = 1 - yCoeff;
    clippingPlanes[16 + i] = zCoeff;
    clippingPlanes[20 + i] = -zCoeff;
  }
  if (DEBUG_CHUNK_VISIBILITY) {
    console.log('clippingPlanes', clippingPlanes);
    console.log('modelViewProjection', modelViewProjection.join(','));
    console.log(`lower=${lower.join(',')}, upper=${upper.join(',')}`);
  }
  forEachVolumetricChunkWithinFrustrum(
      clippingPlanes, transformedSource, callback, isAABBIntersectingPlane);
}

/**
 * For chunk layouts with finiteRank < 3, returns an adjusted chunk layout where chunk 0 in each
 * non-finite dimension is guaranteed to cover the viewport.
 */
export function getNormalizedChunkLayout(
    projectionParameters: ProjectionParameters, chunkLayout: ChunkLayout): ChunkLayout {
  const {finiteRank} = chunkLayout;
  if (finiteRank === 3) return chunkLayout;
  tempChunkLayout.finiteRank = finiteRank;
  vec3.copy(tempChunkLayout.size, chunkLayout.size);
  const transform = mat4.copy(tempChunkLayout.transform, chunkLayout.transform);
  const invTransform = mat4.copy(tempChunkLayout.invTransform, chunkLayout.invTransform);
  tempChunkLayout.detTransform = chunkLayout.detTransform;
  const {invViewMatrix, width, height} = projectionParameters;
  const depth = getViewFrustrumDepthRange(projectionParameters.projectionMat);
  for (let chunkRenderDim = finiteRank; chunkRenderDim < 3; ++chunkRenderDim) {
    // we want to ensure chunk [0] fully covers the viewport
    const offset = invViewMatrix[12 + chunkRenderDim];
    let lower = offset, upper = offset;
    const xc = Math.abs(invViewMatrix[chunkRenderDim] * width);
    lower -= xc;
    upper += xc;
    const yc = Math.abs(invViewMatrix[chunkRenderDim + 4] * height);
    lower -= yc;
    upper += yc;
    const zc = Math.abs(invViewMatrix[chunkRenderDim + 8] * depth);
    lower -= zc;
    upper += zc;
    const scaleFactor = Math.max(1, upper - lower);
    transform[12 + chunkRenderDim] = lower;
    transform[5 * chunkRenderDim] = scaleFactor;
  }
  mat4.invert(invTransform, transform);
  return tempChunkLayout;
}
