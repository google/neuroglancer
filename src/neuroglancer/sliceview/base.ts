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

import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {prod3, Vec3, vec3, vec4, mat4, Mat4} from 'neuroglancer/util/geom';
import {approxEqual} from 'neuroglancer/util/compare';
import {partitionArray} from 'neuroglancer/util/array';
import {SharedObject} from 'neuroglancer/worker_rpc';
import {kZeroVec, kAxes} from 'neuroglancer/util/geom';

const DEBUG_CHUNK_INTERSECTIONS = false;

/**
 * Heuristic estimate of the slice area contained within a chunk of the
 * specified size.
 */
function estimateSliceAreaPerChunk(xAxis: Vec3, yAxis: Vec3, chunkSize: Vec3) {
  let w = 0;
  let h = w;
  for (let i = 0; i < 3; ++i) {
    let chunkSizeValue = chunkSize[i];
    w = Math.max(w, chunkSizeValue * Math.abs(xAxis[i]));
    h = Math.max(h, chunkSizeValue * Math.abs(yAxis[i]));
  }
  return w * h;
}

/**
 * All valid chunks are in the range [lowerBound, upperBound).
 *
 * @param lowerBound Output parameter for lowerBound.
 * @param upperBound Output parameter for upperBound.
 * @param sources Sources for which to compute the chunk bounds.
 */
function computeSourcesChunkBounds(
    lowerBound: Vec3, upperBound: Vec3, sources: Iterable<VolumeChunkSource>) {
  for (let i = 0; i < 3; ++i) {
    lowerBound[i] = Number.POSITIVE_INFINITY;
    upperBound[i] = Number.NEGATIVE_INFINITY;
  }

  for (let source of sources) {
    let {spec} = source;
    let {lowerChunkBound, upperChunkBound} = spec;
    for (let i = 0; i < 3; ++i) {
      lowerBound[i] = Math.min(lowerBound[i], lowerChunkBound[i]);
      upperBound[i] = Math.max(upperBound[i], upperChunkBound[i]);
    }
  }
}

enum BoundsComparisonResult {
  // Needle is fully outside haystack.
  FULLY_OUTSIDE,
  // Needle is fully inside haystack.
  FULLY_INSIDE,
  // Needle is partially inside haystack.
  PARTIALLY_INSIDE
}

function compareBoundsSingleDimension(
    needleLower: number, needleUpper: number, haystackLower: number,
    haystackUpper: number) {
  if (needleLower >= haystackUpper || needleUpper <= haystackLower) {
    return BoundsComparisonResult.FULLY_OUTSIDE;
  }
  if (needleLower >= haystackLower && needleUpper <= haystackUpper) {
    return BoundsComparisonResult.FULLY_INSIDE;
  }
  return BoundsComparisonResult.PARTIALLY_INSIDE;
}

function compareBounds(
    needleLowerBound: Vec3, needleUpperBound: Vec3, haystackLowerBound: Vec3,
    haystackUpperBound: Vec3) {
  let curResult = BoundsComparisonResult.FULLY_INSIDE;
  for (let i = 0; i < 3; ++i) {
    let newResult = compareBoundsSingleDimension(
        needleLowerBound[i], needleUpperBound[i], haystackLowerBound[i],
        haystackUpperBound[i]);
    switch (newResult) {
      case BoundsComparisonResult.FULLY_OUTSIDE:
        return newResult;
      case BoundsComparisonResult.PARTIALLY_INSIDE:
        curResult = newResult;
        break;
    }
  }
  return curResult;
}

export interface RenderLayer {
  sources: VolumeChunkSource[][];
};

function pickBestAlternativeSource(xAxis: Vec3, yAxis: Vec3, alternatives: VolumeChunkSource[]) {
  let numAlternatives = alternatives.length;
  let bestAlternativeIndex = 0;
  if (numAlternatives > 1) {
    let bestSliceArea = 0;
    for (let alternativeIndex = 0; alternativeIndex < numAlternatives; ++alternativeIndex) {
      let alternative = alternatives[alternativeIndex];
      let sliceArea = estimateSliceAreaPerChunk(xAxis, yAxis, alternative.spec.chunkLayout.size);
      // console.log(`scaleIndex = ${scaleIndex}, xAxis = ${xAxis}, yAxis
      // = ${yAxis}, chunksize = ${alternative.spec.chunkLayout.size},
      // sliceArea = ${sliceArea}`);
      if (sliceArea > bestSliceArea) {
        bestSliceArea = sliceArea;
        bestAlternativeIndex = alternativeIndex;
      }
    }
  }
  return alternatives[bestAlternativeIndex];
}

export class SliceViewBase extends SharedObject {
  width: number|null = null;
  height: number|null = null;
  hasViewportToData = false;
  /**
   * Specifies whether width, height, and viewportToData are valid.
   */
  hasValidViewport = false;

  // Transforms (x,y) viewport coordinates in the range:
  //
  // x=[left: -width/2, right: width/2] and
  //
  // y=[top: -height/2, bottom: height/2],
  //
  // to data coordinates.
  viewportToData = mat4.create();

  // Normalized x, y, and z viewport axes in data coordinate space.
  viewportAxes = [vec4.create(), vec4.create(), vec4.create()];

  // Viewport axes used for selecting visible sources.
  previousViewportAxes = [vec3.create(), vec3.create()];

  centerDataPosition = vec3.create();

  viewportPlaneDistanceToOrigin: number = null;

  /**
   * For each visible ChunkLayout, maps each visible VolumeChunkSource to its priority index.
   */
  visibleChunkLayouts = new Map<ChunkLayout, Map<VolumeChunkSource, number>>();

  visibleLayers = new Map<RenderLayer, VolumeChunkSource[]>();

  visibleSourcesStale = true;

  pixelSize: number = null;

  constructor() {
    super();
    mat4.identity(this.viewportToData);
  }

  /**
   * Called when hasValidViewport == true and the viewport width/height or data transform matrix
   * changes.
   */
  onViewportChanged() {}
  maybeSetHasValidViewport() {
    if (!this.hasValidViewport && this.width !== null && this.height !== null &&
        this.hasViewportToData) {
      this.hasValidViewport = true;
      this.onHasValidViewport();
    }
    if (this.hasValidViewport) {
      this.onViewportChanged();
    }
  }
  onHasValidViewport() {}
  setViewportSize(width: number, height: number) {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.maybeSetHasValidViewport();
      return true;
    }
    return false;
  }
  setViewportToDataMatrix(mat: Mat4) {
    if (this.hasViewportToData && mat4.equals(this.viewportToData, mat)) {
      return false;
    }

    this.hasViewportToData = true;

    mat4.copy(this.viewportToData, mat);
    vec3.transformMat4(this.centerDataPosition, kZeroVec, mat);

    let newPixelSize: number;

    // Swap previousViewportAxes with viewportAxes.
    let viewportAxes = this.viewportAxes;
    let previousViewportAxes = this.previousViewportAxes;

    // Compute axes.
    for (var i = 0; i < 3; ++i) {
      let a = viewportAxes[i];
      vec4.transformMat4(a, kAxes[i], mat);
      // a[3] is guaranteed to be 0.
      if (i === 0) {
        newPixelSize = vec3.length(a);
      }
      vec4.normalize(a, a);
    }

    this.viewportAxes = viewportAxes;
    this.previousViewportAxes = previousViewportAxes;

    if (!approxEqual(newPixelSize, this.pixelSize) ||
        (vec3.dot(viewportAxes[0], previousViewportAxes[0]) < 0.95) ||
        (vec3.dot(viewportAxes[1], previousViewportAxes[1]) < 0.95)) {
      vec3.copy(previousViewportAxes[0], viewportAxes[0]);
      vec3.copy(previousViewportAxes[1], viewportAxes[1]);
      this.visibleSourcesStale = true;
      this.pixelSize = newPixelSize;
    }

    // Compute viewport plane distance to origin.
    this.viewportPlaneDistanceToOrigin =
      vec3.dot(this.centerDataPosition, this.viewportAxes[2]);
    this.onViewportToDataMatrixChanged();
    this.maybeSetHasValidViewport();
    return true;
  }

  onViewportToDataMatrixChanged() {}

  /**
   * Computes the list of sources to use for each visible layer, based on the
   * current pixelSize.
   */
  updateVisibleSources() {
    if (!this.visibleSourcesStale) {
      return;
    }
    this.visibleSourcesStale = false;
    // Increase pixel size by a small margin.
    let pixelSize = this.pixelSize * 1.1;
    // console.log("pixelSize", pixelSize);

    let visibleChunkLayouts = this.visibleChunkLayouts;
    let [xAxis, yAxis] = this.viewportAxes;

    let visibleLayers = this.visibleLayers;
    visibleChunkLayouts.clear();
    for (let [renderLayer, visibleSources] of visibleLayers) {
      visibleSources.length = 0;
      let sources = renderLayer.sources;
      let numSources = sources.length;
      let scaleIndex: number;

      // At the smallest scale, all alternative sources must have the same voxel size, which is
      // considered to be the base voxel size.
      let smallestVoxelSize = sources[0][0].spec.voxelSize;

      /**
       * Determines whether we should continue to look for a finer-resolution source *after* one
       * with the specified voxelSize.
       */
      const canImproveOnVoxelSize = (voxelSize: Vec3) => {
        for (let i = 0; i < 3; ++i) {
          let size = voxelSize[i];
          // If size <= pixelSize, no need for improvement.
          // If size === smallestVoxelSize, also no need for improvement.
          if (size > pixelSize && size > smallestVoxelSize[i]) {
            return true;
          }
        }
        return false;
      };

      /**
       * Registers a source as being visible.  This should be called with consecutively decreasing
       * values of scaleIndex.
       */
      const addVisibleSource = (source: VolumeChunkSource, scaleIndex: number) => {
        // Add to end of visibleSources list.  We will reverse the list after all sources are added.
        visibleSources[visibleSources.length++] = source;
        let chunkLayout = source.spec.chunkLayout;
        let existingSources = visibleChunkLayouts.get(chunkLayout);
        if (existingSources === undefined) {
          existingSources = new Map<VolumeChunkSource, number>();
          visibleChunkLayouts.set(chunkLayout, existingSources);
        }
        existingSources.set(source, numSources - scaleIndex - 1);
      };

      scaleIndex = numSources - 1;
      while (true) {
        let source = pickBestAlternativeSource(xAxis, yAxis, sources[scaleIndex]);
        addVisibleSource(source, scaleIndex);
        if (scaleIndex === 0 || !canImproveOnVoxelSize(source.spec.voxelSize)) {
          break;
        }
        --scaleIndex;
      }
      // Reverse visibleSources list since we added sources from coarsest to finest resolution, but
      // we want them ordered from finest to coarsest.
      visibleSources.reverse();
    }
  }
  computeVisibleChunks<T>(
      getLayoutObject: (chunkLayout: ChunkLayout) => T,
      addChunk:
          (chunkLayout: ChunkLayout, layoutObject: T, lowerBound: Vec3,
           fullyVisibleSources: VolumeChunkSource[]) => void) {
    this.updateVisibleSources();

    var center = this.centerDataPosition;

    // Lower and upper bound in global data coordinates.
    var dataLowerBound = vec3.clone(center);
    var dataUpperBound = vec3.clone(center);
    var corner = vec3.create();
    for (var xScalar of [-this.width / 2, this.width / 2]) {
      for (var yScalar of [-this.height / 2, this.height / 2]) {
        vec3.scale(corner, kAxes[0], xScalar);
        vec3.scaleAndAdd(corner, corner, kAxes[1], yScalar);
        vec3.transformMat4(corner, corner, this.viewportToData);
        vec3.min(dataLowerBound, dataLowerBound, corner);
        vec3.max(dataUpperBound, dataUpperBound, corner);
      }
    }
    // console.log("data bounds", dataLowerBound, dataUpperBound);

    var lowerBound = vec3.create();
    var upperBound = vec3.create();

    // Vertex with maximal dot product with the positive viewport plane normal.
    // Implicitly, negativeVertex = 1 - positiveVertex.
    var positiveVertex = vec3.create();

    var planeNormal = this.viewportAxes[2];
    for (let i = 0; i < 3; ++i) {
      if (planeNormal[i] > 0) {
        positiveVertex[i] = 1;
      }
    }

    // Sources whose bounds partially contain the current bounding box.
    let partiallyVisibleSources = new Array<VolumeChunkSource>();

    // Sources whose bounds fully contain the current bounding box.
    let fullyVisibleSources = new Array<VolumeChunkSource>();

    this.visibleChunkLayouts.forEach((visibleSources, chunkLayout) => {
      let layoutObject = getLayoutObject(chunkLayout);

      let chunkSize = chunkLayout.size;
      let offset = chunkLayout.offset;

      let planeDistanceToOrigin =
          this.viewportPlaneDistanceToOrigin - vec3.dot(offset, this.viewportAxes[2]);

      computeSourcesChunkBounds(lowerBound, upperBound, visibleSources.keys());
      if (DEBUG_CHUNK_INTERSECTIONS) {
        console.log(`Initial sources chunk bounds: ${vec3.str(lowerBound)}, ${vec3.str(upperBound)}, data bounds: ${vec3.str(dataLowerBound)}, ${vec3.str(dataUpperBound)}, offset = ${vec3.str(offset)}, chunkSize = ${vec3.str(chunkSize)}`);
      }

      for (let i = 0; i < 3; ++i) {
        lowerBound[i] = Math.max(lowerBound[i], Math.floor((dataLowerBound[i] - offset[i]) / chunkSize[i]));
        // 
        upperBound[i] = Math.min(upperBound[i], Math.floor((dataUpperBound[i] - offset[i]) / chunkSize[i] + 1));
      }

      // console.log('chunkBounds', lowerBound, upperBound);

      // Checks whether [lowerBound, upperBound) intersects the viewport plane.
      //
      // positiveVertexDistanceToOrigin = dot(planeNormal, lowerBound +
      // positiveVertex * (upperBound - lowerBound)) - planeDistanceToOrigin;
      // negativeVertexDistanceToOrigin = dot(planeNormal, lowerBound +
      // negativeVertex * (upperBound - lowerBound)) - planeDistanceToOrigin;
      //
      // positive vertex must have positive distance, and negative vertex must
      // have negative distance.
      function intersectsPlane() {
        var positiveVertexDistanceToOrigin = 0;
        var negativeVertexDistanceToOrigin = 0;
        // Check positive vertex.
        for (let i = 0; i < 3; ++i) {
          let chunkSizeValue = chunkSize[i];
          let normalValue = planeNormal[i];
          let lowerValue = lowerBound[i];
          let upperValue = upperBound[i];
          let diff = upperValue - lowerValue;
          let positiveOffset = positiveVertex[i] * diff;
          // console.log(
          //     normalValue, lowerValue, upperValue, diff, positiveOffset,
          //     positiveVertexDistanceToOrigin, negativeVertexDistanceToOrigin);
          positiveVertexDistanceToOrigin +=
              normalValue * chunkSizeValue * (lowerValue + positiveOffset);
          negativeVertexDistanceToOrigin += normalValue * chunkSizeValue *
              (lowerValue + diff - positiveOffset);
        }
        // console.log("{positive,negative}VertexDistanceToOrigin: ",
        // positiveVertexDistanceToOrigin, negativeVertexDistanceToOrigin,
        // planeDistanceToOrigin);
        // console.log("intersectsPlane:", negativeVertexDistanceToOrigin,
        //             planeDistanceToOrigin, positiveVertexDistanceToOrigin);
        if (positiveVertexDistanceToOrigin < planeDistanceToOrigin) {
          return false;
        }

        return negativeVertexDistanceToOrigin <= planeDistanceToOrigin;
      }

      fullyVisibleSources.length = 0;
      partiallyVisibleSources.length = 0;
      for (let source of visibleSources.keys()) {
        let spec = source.spec;
        let result = compareBounds(
          lowerBound, upperBound, spec.lowerChunkBound, spec.upperChunkBound);
        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(`Comparing source bounds lowerBound=${vec3.str(lowerBound)}, upperBound=${vec3.str(upperBound)}, lowerChunkBound=${vec3.str(spec.lowerChunkBound)}, upperChunkBound=${vec3.str(spec.upperChunkBound)}, got ${BoundsComparisonResult[result]}`, spec, source);
        }
        switch (result) {
          case BoundsComparisonResult.FULLY_INSIDE:
            fullyVisibleSources.push(source);
            break;
          case BoundsComparisonResult.PARTIALLY_INSIDE:
            partiallyVisibleSources.push(source);
            break;
        }
      }
      let partiallyVisibleSourcesLength = partiallyVisibleSources.length;

      // Mutates lowerBound and upperBound while running, but leaves them the
      // same once finished.
      function checkBounds (nextSplitDim: number) {
        if (fullyVisibleSources.length === 0 && partiallyVisibleSourcesLength === 0) {
          if (DEBUG_CHUNK_INTERSECTIONS) {
            console.log('  no visible sources');
          }
          return;
        }

        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(`Check bounds: [ ${vec3.str(lowerBound)}, ${vec3.str(upperBound)} ]`);
        }
        var volume = 1;
        for (let i = 0; i < 3; ++i) {
          volume *= Math.max(0, upperBound[i] - lowerBound[i]);
        }

        if (volume === 0) {
          if (DEBUG_CHUNK_INTERSECTIONS) {
            console.log('  volume == 0');
          }
          return;
        }

        if (!intersectsPlane()) {
          if (DEBUG_CHUNK_INTERSECTIONS) {
            console.log('  doesn\'t intersect plane');
          }
          return;
        }

        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log('Within bounds: [' + vec3.str(lowerBound) + ", " + vec3.str(upperBound) + "]");
        }

        if (volume === 1) {
          addChunk(chunkLayout, layoutObject, lowerBound, fullyVisibleSources);
          return;
        }

        var dimLower: number, dimUpper: number, diff: number;
        while (true) {
          dimLower = lowerBound[nextSplitDim];
          dimUpper = upperBound[nextSplitDim];
          diff = dimUpper - dimLower;
          if (diff === 1) {
            nextSplitDim = (nextSplitDim + 1) % 3;
          } else {
            break;
          }
        }

        let splitPoint = dimLower + Math.floor(0.5 * diff);
        let newNextSplitDim = (nextSplitDim + 1) % 3;
        let fullyVisibleSourcesLength = fullyVisibleSources.length;

        upperBound[nextSplitDim] = splitPoint;

        let oldPartiallyVisibleSourcesLength = partiallyVisibleSourcesLength;
        function adjustSources() {
          partiallyVisibleSourcesLength = partitionArray(
              partiallyVisibleSources, 0, oldPartiallyVisibleSourcesLength,
              source => {
                let spec = source.spec;
                let result = compareBoundsSingleDimension(
                    lowerBound[nextSplitDim], upperBound[nextSplitDim],
                    spec.lowerChunkBound[nextSplitDim],
                    spec.upperChunkBound[nextSplitDim]);
                switch (result) {
                  case BoundsComparisonResult.PARTIALLY_INSIDE:
                    return true;
                  case BoundsComparisonResult.FULLY_INSIDE:
                    fullyVisibleSources.push(source);
                  default:
                    return false;
                }
              });
        }

        adjustSources();
        checkBounds(newNextSplitDim);

        upperBound[nextSplitDim] = dimUpper;
        lowerBound[nextSplitDim] = splitPoint;

        adjustSources();
        checkBounds(newNextSplitDim);

        lowerBound[nextSplitDim] = dimLower;

        // Truncate list of fully visible sources.
        fullyVisibleSources.length = fullyVisibleSourcesLength;

        // Restore partiallyVisibleSources.
        partiallyVisibleSourcesLength = oldPartiallyVisibleSourcesLength;
      }
      checkBounds(0);
    });
  }
};

/**
 * If this is updated, DATA_TYPE_BYTES must also be updated.
 */
export enum DataType {
  UINT8 = 0,
  UINT16 = 1,
  UINT32 = 2,
  UINT64 = 3,
  FLOAT32 = 4,
}

interface DataTypeBytes {
  [index: number]: number;
}

export const DATA_TYPE_BYTES: DataTypeBytes = [];
DATA_TYPE_BYTES[DataType.UINT8] = 1;
DATA_TYPE_BYTES[DataType.UINT16] = 2;
DATA_TYPE_BYTES[DataType.UINT32] = 4;
DATA_TYPE_BYTES[DataType.UINT64] = 8;
DATA_TYPE_BYTES[DataType.FLOAT32] = 4;

/**
 * Specifies the interpretation of volumetric data.
 */
export enum VolumeType {
  UNKNOWN,
  IMAGE,
  SEGMENTATION,
}


export const DEFAULT_CHUNK_DATA_SIZES  = [
  vec3.fromValues(64, 64, 64)
];

/**
 * Specifies a chunk layout and voxel size.
 */
export class VolumeChunkSpecification {
  chunkBytes: number;
  voxelSize: Vec3;

  // All valid chunks are in the range [lowerChunkBound, upperChunkBound).
  lowerChunkBound: Vec3;
  upperChunkBound: Vec3;

  constructor(
      public chunkLayout: ChunkLayout, public chunkDataSize: Vec3,
      public numChannels: number, public dataType: DataType,
      public lowerVoxelBound: Vec3, public upperVoxelBound: Vec3,
      public compressedSegmentationBlockSize?: Vec3|undefined) {
    this.chunkBytes =
        prod3(chunkDataSize) * DATA_TYPE_BYTES[dataType] * numChannels;
    let voxelSize = this.voxelSize =
        vec3.divide(vec3.create(), this.chunkLayout.size, this.chunkDataSize);
    let lowerChunkBound = this.lowerChunkBound = vec3.create();
    let upperChunkBound = this.upperChunkBound = vec3.create();
    let chunkSize = chunkLayout.size;
    let chunkOffset = chunkLayout.offset;
    for (let i = 0; i < 3; ++i) {
      lowerChunkBound[i] = Math.floor(
          (lowerVoxelBound[i] * voxelSize[i] - chunkOffset[i]) / chunkSize[i]);
      upperChunkBound[i] = Math.floor(
          ((upperVoxelBound[i] - 1) * voxelSize[i] - chunkOffset[i]) /
              chunkSize[i] +
          1);
    }
    // console.log(`voxelBound = [${vec3.str(lowerVoxelBound)},${vec3.str(upperVoxelBound)}), chunkBound = [${vec3.str(lowerChunkBound)},${vec3.str(upperChunkBound)}]`);
    this.compressedSegmentationBlockSize = compressedSegmentationBlockSize;
  }
  static fromObject(msg: any) {
    return new VolumeChunkSpecification(
        ChunkLayout.fromObject(msg['chunkLayout']), msg['chunkDataSize'],
        msg['numChannels'], msg['dataType'], msg['lowerVoxelBound'],
        msg['upperVoxelBound'], msg['compressedSegmentationBlockSize']);
  }
  toObject(msg: any) {
    this.chunkLayout.toObject(msg['chunkLayout'] = {});
    msg['chunkDataSize'] = this.chunkDataSize;
    msg['numChannels'] = this.numChannels;
    msg['dataType'] = this.dataType;
    msg['lowerVoxelBound'] = this.lowerVoxelBound;
    msg['upperVoxelBound'] = this.upperVoxelBound;
    msg['compressedSegmentationBlockSize'] =
        this.compressedSegmentationBlockSize;
  }

  static * getDefaults(options: {
    voxelSize: Vec3,
    lowerVoxelBound: Vec3,
    upperVoxelBound: Vec3,
    volumeType: VolumeType,
    dataType: DataType, numChannels?: number, chunkDataSizes?: Vec3[],
    compressedSegmentationBlockSize?: Vec3|null
  }) {
    let {voxelSize,       dataType,
         lowerVoxelBound, chunkDataSizes = DEFAULT_CHUNK_DATA_SIZES,
         numChannels = 1, compressedSegmentationBlockSize} = options;
    let chunkOffset = vec3.multiply(vec3.create(), lowerVoxelBound, voxelSize);
    if (compressedSegmentationBlockSize === undefined &&
        options.volumeType === VolumeType.SEGMENTATION &&
        (dataType === DataType.UINT32 || dataType === DataType.UINT64)) {
      compressedSegmentationBlockSize = vec3.fromValues(8, 8, 8);
    }
    for (let chunkDataSize of chunkDataSizes) {
      let chunkSize = vec3.create();
      vec3.multiply(chunkSize, voxelSize, chunkDataSize);
      let chunkLayout = ChunkLayout.get(chunkSize, chunkOffset);
      yield new VolumeChunkSpecification(
          chunkLayout, chunkDataSize, numChannels, dataType, lowerVoxelBound,
          options.upperVoxelBound, compressedSegmentationBlockSize);
    }
  }
};

export interface VolumeChunkSource { spec: VolumeChunkSpecification; }
